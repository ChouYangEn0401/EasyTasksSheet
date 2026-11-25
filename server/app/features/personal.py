"""/api/personal：個人清單。所有成員可唯讀檢視他人清單；只有本人能改自己的清單。

- GET /           自由待辦（依 sortOrder）
- POST /          新增自由待辦（排在最上方）
- PATCH /:id      改標題 / 備註 / 細節 / 狀態 / 到期日 / 完成 / 排序
                  狀態：todo 待處理、doing 進行中、deferred 延後、cancelled 取消、done 完成；
                  done <-> isDone 一致（勾選 = done、取消勾選 = 回 todo）
- DELETE /done    清除已完成（只清 done；延後 / 取消的項目保留）
- DELETE /:id     刪除
- GET /report      匯報報告（見 personal_report.py）
- GET /pins       標記的任務（依標記時間新→舊，排除已刪除任務）
- PUT|DELETE /pins/:taskId  標記 / 取消標記（冪等）
"""

from __future__ import annotations

import sqlite3
from typing import Annotated, Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, StringConstraints

from ..changes import record_change
from ..config import config
from ..context import Ctx, get_ctx
from ..db import row_to_dict, rows_to_dicts
from ..errors import bad_request, forbidden, not_found, validation_error
from ..personal_report import build_report, parse_include, parse_range
from ..schemas import DateString, FiniteFloat, Title
from ..validate import parse_id, parse_positive_int, present, read_json

router = APIRouter()

NOT_FOUND = "此待辦不存在或已被刪除"
FORBIDDEN = "只有本人可以修改自己的清單"

Note = Annotated[str, StringConstraints(max_length=5_000)]
Detail = Annotated[str, StringConstraints(max_length=50_000)]
#: todo 待處理 / doing 進行中 / deferred 延後 / cancelled 取消 / done 完成；done <-> is_done = 1 由本檔維護
PersonalStatus = Literal["todo", "doing", "deferred", "cancelled", "done"]


class PersonalCreateInput(BaseModel):
    """建立自由待辦：只需 title；新項目排在清單最上方"""

    model_config = {"extra": "ignore"}
    title: Title
    note: Note = None  # type: ignore[assignment]
    status: PersonalStatus = None  # type: ignore[assignment]
    dueDate: DateString | None = None
    detail: Detail = None  # type: ignore[assignment]


class PersonalUpdateInput(BaseModel):
    """PATCH 只送改動欄位；sortOrder 由前端以相鄰兩項的中間值計算"""

    model_config = {"extra": "ignore"}
    title: Title = None  # type: ignore[assignment]
    note: Note = None  # type: ignore[assignment]
    isDone: bool = None  # type: ignore[assignment]
    status: PersonalStatus = None  # type: ignore[assignment]
    dueDate: DateString | None = None  # 明確送 null = 清除到期日
    detail: Detail = None  # type: ignore[assignment]
    sortOrder: FiniteFloat = None  # type: ignore[assignment]


_COLUMNS = {
    "title": "title",
    "note": "note",
    "isDone": "is_done",
    "status": "status",
    "dueDate": "due_date",
    "detail": "detail",
    "sortOrder": "sort_order",
}


def _user_query(request: Request) -> int | None:
    """?user=<id>：對應 z.coerce.number().int().positive().optional()"""
    raw = request.query_params.get("user")
    if raw is None:
        return None
    n = parse_positive_int(raw)
    if n is None:
        raise validation_error([{"path": ["user"], "message": "須為正整數", "code": "invalid_type"}])
    return n


def _read_target(request: Request, ctx: Ctx) -> int:
    """讀取的目標成員：?user=<id>（他人須存在且未停用），省略即本人"""
    user = _user_query(request)
    me = ctx.user["id"]
    if user is None or user == me:
        return me
    row = ctx.db.one("SELECT is_active FROM users WHERE id = ?", (user,))
    if row is None or not row["is_active"]:
        raise not_found("找不到這位成員")
    return user


def _assert_self_write(request: Request, ctx: Ctx) -> None:
    """寫入只能針對本人：?user= 指定他人即 403"""
    user = _user_query(request)
    if user is not None and user != ctx.user["id"]:
        raise forbidden(FORBIDDEN)


def _find_own_todo(conn: sqlite3.Connection, item_id: int, me: int) -> sqlite3.Row:
    """取自己的自由待辦；他人的回 403、不存在或為標記列回 404"""
    row = conn.execute("SELECT * FROM personal_items WHERE id = ?", (item_id,)).fetchone()
    if row is None or row["task_id"] is not None:
        raise not_found(NOT_FOUND)
    if row["user_id"] != me:
        raise forbidden(FORBIDDEN)
    return row


def _get(conn: sqlite3.Connection, item_id: int) -> sqlite3.Row:
    return conn.execute("SELECT * FROM personal_items WHERE id = ?", (item_id,)).fetchone()


@router.get("")
async def list_todos(request: Request):
    ctx = get_ctx(request)
    user_id = _read_target(request, ctx)
    rows = ctx.db.all(
        "SELECT * FROM personal_items WHERE user_id = ? AND task_id IS NULL ORDER BY sort_order, id", (user_id,)
    )
    return rows_to_dicts(rows)


@router.get("/report")
async def personal_report(request: Request):
    """匯報報告：?from=&to=（YYYY-MM-DD，含頭尾）&user=&include=doing,deferred,cancelled,created"""
    ctx = get_ctx(request)
    user_id = _read_target(request, ctx)
    start, end = parse_range(request.query_params.get("from"), request.query_params.get("to"))
    include = parse_include(request.query_params.get("include"))
    with ctx.db.lock:
        return build_report(ctx.db.conn, user_id, start, end, include, config.TZ)


@router.post("")
async def create_todo(request: Request):
    ctx = get_ctx(request)
    _assert_self_write(request, ctx)
    data = await read_json(request, PersonalCreateInput)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        top = conn.execute(
            "SELECT min(sort_order) FROM personal_items WHERE user_id = ? AND task_id IS NULL", (uid,)
        ).fetchone()[0]
        t = ctx.now()
        status = data.status or "todo"
        cur = conn.execute(
            "INSERT INTO personal_items (user_id, title, note, status, is_done, due_date, detail, sort_order, "
            "created_at, updated_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                uid,
                data.title,
                data.note if data.note is not None else "",
                status,
                int(status == "done"),
                data.dueDate,
                data.detail if data.detail is not None else "",
                0 if top is None else top - 1,
                t,
                t,
                t if status == "done" else None,
            ),
        )
        pid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "personal", pid, "create", uid, t)
        row = _get(conn, pid)
    return JSONResponse(row_to_dict(row), status_code=201)


@router.get("/pins")
async def list_pins(request: Request):
    ctx = get_ctx(request)
    user_id = _read_target(request, ctx)
    with ctx.db.lock:
        conn = ctx.db.conn
        pins = conn.execute(
            "SELECT p.* FROM personal_items p JOIN tasks t ON t.id = p.task_id "
            "WHERE p.user_id = ? AND p.task_id IS NOT NULL AND t.deleted_at IS NULL "
            "ORDER BY p.created_at DESC, p.id DESC",
            (user_id,),
        ).fetchall()
        result = []
        for pin in pins:
            task = conn.execute("SELECT * FROM tasks WHERE id = ?", (pin["task_id"],)).fetchone()
            result.append({"pin": row_to_dict(pin), "task": row_to_dict(task)})
    return result


@router.put("/pins/{task_id}")
async def pin_task(request: Request, task_id: str):
    ctx = get_ctx(request)
    _assert_self_write(request, ctx)
    tid = parse_id(task_id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        if not conn.execute("SELECT 1 FROM tasks WHERE id = ? AND deleted_at IS NULL", (tid,)).fetchone():
            raise not_found("此任務不存在或已被刪除")
        existing = conn.execute(
            "SELECT * FROM personal_items WHERE user_id = ? AND task_id = ?", (uid, tid)
        ).fetchone()
        if existing is not None:
            return JSONResponse(row_to_dict(existing), status_code=200)
        t = ctx.now()
        cur = conn.execute(
            "INSERT INTO personal_items (user_id, task_id, title, created_at, updated_at) VALUES (?, ?, '', ?, ?)",
            (uid, tid, t, t),
        )
        pid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "personal", pid, "create", uid, t)
        row = _get(conn, pid)
    return JSONResponse(row_to_dict(row), status_code=201)


@router.delete("/pins/{task_id}")
async def unpin_task(request: Request, task_id: str):
    ctx = get_ctx(request)
    _assert_self_write(request, ctx)
    tid = parse_id(task_id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        existing = conn.execute(
            "SELECT id FROM personal_items WHERE user_id = ? AND task_id = ?", (uid, tid)
        ).fetchone()
        if existing is not None:  # 冪等：本來就沒標記則不動作
            conn.execute("DELETE FROM personal_items WHERE id = ?", (existing["id"],))
            record_change(conn, "personal", existing["id"], "delete", uid, ctx.now())
    return {"ok": True}


@router.delete("/done")
async def clear_done(request: Request):
    ctx = get_ctx(request)
    _assert_self_write(request, ctx)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        ids = [
            r[0]
            for r in conn.execute(
                "SELECT id FROM personal_items WHERE user_id = ? AND task_id IS NULL AND is_done = 1 ORDER BY id",
                (uid,),
            )
        ]
        t = ctx.now()
        for pid in ids:
            conn.execute("DELETE FROM personal_items WHERE id = ?", (pid,))
            record_change(conn, "personal", pid, "delete", uid, t)
    return {"ok": True, "deleted": len(ids)}


@router.patch("/{id}")
async def update_todo(request: Request, id: str):
    ctx = get_ctx(request)
    _assert_self_write(request, ctx)
    pid = parse_id(id)
    data = await read_json(request, PersonalUpdateInput)
    fields = present(data)
    if not fields:
        raise bad_request("沒有要修改的欄位")
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        current = _find_own_todo(conn, pid, uid)
        t = ctx.now()
        # status 與 is_done 保持一致：同時送來時 status 為準；只送 isDone 時，勾選 = done、取消勾選 = 回 todo
        if "status" in fields:
            fields["isDone"] = fields["status"] == "done"
        elif "isDone" in fields:
            if fields["isDone"]:
                fields["status"] = "done"
            elif current["status"] == "done":
                fields["status"] = "todo"
        sets = {_COLUMNS[k]: (int(v) if k == "isDone" else v) for k, v in fields.items()}
        sets["updated_at"] = t
        # done_at：變為 done 時寫入現在時間（已是 done 則保留）；從 done 改回其他狀態時清空
        new_done = fields.get("status") == "done" if "status" in fields else None
        if new_done is True and current["status"] != "done":
            sets["done_at"] = t
        elif new_done is False and current["status"] == "done":
            sets["done_at"] = None
        conn.execute(
            f"UPDATE personal_items SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?", (*sets.values(), pid)
        )
        record_change(conn, "personal", pid, "update", uid, t)
        row = _get(conn, pid)
    return row_to_dict(row)


@router.delete("/{id}")
async def delete_todo(request: Request, id: str):
    ctx = get_ctx(request)
    _assert_self_write(request, ctx)
    pid = parse_id(id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        _find_own_todo(conn, pid, uid)
        conn.execute("DELETE FROM personal_items WHERE id = ?", (pid,))
        record_change(conn, "personal", pid, "delete", uid, ctx.now())
    return {"ok": True}
