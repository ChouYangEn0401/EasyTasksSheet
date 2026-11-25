"""/api/tasks：所有成員可讀寫所有任務，刪除為軟刪除。"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import audit_events
from ..changes import record_change
from ..context import get_ctx
from ..db import next_sort_order, row_to_dict, rows_to_dicts
from ..errors import bad_request, forbidden, not_found, validation_error
from ..permissions import can, denied
from ..schemas import TaskCreateInput, TaskUpdateInput
from ..validate import parse_id, present, read_json
from .dependencies import attach_dependency_fields
from .properties import merge_custom_values
from .task_checklist import with_checklist_counts
from .task_comments import comment_stats, with_comment_stats

router = APIRouter()

#: 每個任務的相關任務數（雙向展開後 JOIN 對方任務排除已刪除者）；欄位 task_id、n
RELATION_COUNT_CTE = (
    "rc AS (SELECT x.task_id, count(*) AS n FROM ("
    "SELECT task_a_id AS task_id, task_b_id AS other_id FROM task_relations "
    "UNION ALL SELECT task_b_id, task_a_id FROM task_relations) x "
    "JOIN tasks o ON o.id = x.other_id AND o.deleted_at IS NULL GROUP BY x.task_id)"
)

#: API 欄位 → DB 欄位（custom 另外處理）
_COLUMNS = {
    "title": "title",
    "projectId": "project_id",
    "description": "description",
    "statusId": "status_id",
    "assigneeId": "assignee_id",
    "priority": "priority",
    "startDate": "start_date",
    "dueDate": "due_date",
    "estimateHours": "estimate_hours",
    "progress": "progress",
    "sortOrder": "sort_order",
    "descriptionLocked": "description_locked",
}

#: 描述鎖定時，沒有 tasks.lock 的成員修改描述的訊息（docs/design/task-discussion.md）
LOCKED_MESSAGE = "描述已由管理者鎖定，請把補充寫在討論區"

_ID_LIST = re.compile(r"^[0-9]+(,[0-9]+)*$")
_ASSIGNEE_LIST = re.compile(r"^([0-9]+|none)(,([0-9]+|none))*$")


def _check_refs(conn: sqlite3.Connection, fields: dict[str, Any]) -> None:
    """外鍵欄位需指向存在的資料，否則回 400（而非 DB 約束錯誤的 500）"""
    if "projectId" in fields and not conn.execute(
        "SELECT 1 FROM projects WHERE id = ?", (fields["projectId"],)
    ).fetchone():
        raise bad_request("專案不存在")
    if "statusId" in fields and not conn.execute(
        "SELECT 1 FROM statuses WHERE id = ?", (fields["statusId"],)
    ).fetchone():
        raise bad_request("狀態不存在")
    if fields.get("assigneeId") is not None and not conn.execute(
        "SELECT 1 FROM users WHERE id = ?", (fields["assigneeId"],)
    ).fetchone():
        raise bad_request("負責人不存在")


def _is_done(conn: sqlite3.Connection, status_id: int) -> bool:
    r = conn.execute("SELECT category FROM statuses WHERE id = ?", (status_id,)).fetchone()
    return r is not None and r["category"] == "done"


def _find_task(conn: sqlite3.Connection, task_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL", (task_id,)).fetchone()


def _task_out(conn: sqlite3.Connection, row: sqlite3.Row, user_id: int | None) -> dict[str, Any]:
    """單一任務回應：附上留言數與目前使用者的未讀數、待辦清單進度"""
    out = with_comment_stats(row_to_dict(row), comment_stats(conn, user_id, [row["id"]]))  # type: ignore[arg-type]
    return with_checklist_counts(conn, [out])[0]


def _apply_lock(fields: dict[str, Any], sets: dict[str, Any], uid: int, t: int) -> None:
    """descriptionLocked：鎖定時記錄鎖定者與時間，解鎖時清除"""
    if "descriptionLocked" not in fields:
        return
    locked = bool(fields["descriptionLocked"])
    sets["description_locked"] = 1 if locked else 0
    sets["locked_by"] = uid if locked else None
    sets["locked_at"] = t if locked else None


def _query_issue(name: str, message: str) -> Exception:
    return validation_error([{"path": [name], "message": message, "code": "invalid_string"}])


@router.get("")
async def list_tasks(request: Request):
    """篩選：project / status / assignee 為逗號分隔多值，assignee 可含 none（未指派）；q 為標題關鍵字"""
    qp = request.query_params
    conds = ["deleted_at IS NULL"]
    params: list[Any] = []

    for name, column in (("project", "project_id"), ("status", "status_id")):
        raw = qp.get(name)
        if raw is None:
            continue
        if not _ID_LIST.fullmatch(raw):
            raise _query_issue(name, "格式須為逗號分隔的 id")
        ids = [int(x) for x in raw.split(",")]
        conds.append(f"{column} IN ({','.join('?' * len(ids))})")
        params.extend(ids)

    raw = qp.get("assignee")
    if raw is not None:
        if not _ASSIGNEE_LIST.fullmatch(raw):
            raise _query_issue("assignee", "格式須為逗號分隔的 id 或 none")
        parts = raw.split(",")
        ids = [int(p) for p in parts if p != "none"]
        ors = []
        if ids:
            ors.append(f"assignee_id IN ({','.join('?' * len(ids))})")
            params.extend(ids)
        if "none" in parts:
            ors.append("assignee_id IS NULL")
        conds.append("(" + " OR ".join(ors) + ")")

    q = qp.get("q")
    if q is not None:
        q = q.strip()
        if len(q) > 200:
            raise _query_issue("q", "最多 200 字")
        if q:
            conds.append("instr(lower(title), lower(?)) > 0")
            params.append(q)

    ctx = get_ctx(request)
    with ctx.db.lock:
        # relationCount：每個任務的相關任務數（不含已刪除的對方任務），以單一查詢聚合（task_relations.py）
        rows = ctx.db.all(
            f"WITH {RELATION_COUNT_CTE} SELECT tasks.*, coalesce(rc.n, 0) AS relation_count FROM tasks "
            f"LEFT JOIN rc ON rc.task_id = tasks.id WHERE {' AND '.join(conds)} ORDER BY tasks.sort_order, tasks.id",
            tuple(params),
        )
        # 待辦清單聚合 checklistTotal / checklistDone（單一 GROUP BY 查詢）
        items = with_checklist_counts(ctx.db.conn, rows_to_dicts(rows), all_tasks=True)
        # 留言數與未讀數：單一聚合查詢（不逐筆查詢）
        stats = comment_stats(ctx.db.conn, ctx.user["id"] if ctx.user else None)
    items = [with_comment_stats(t, stats) for t in items]
    # 依賴（阻擋關係）欄位：isBlocked / blockedByCount / blocksCount / delayDays / projectedEnd（單次批次推算）
    return attach_dependency_fields(ctx.db, items, ctx.now())


@router.post("")
async def create_task(request: Request):
    ctx = get_ctx(request)
    data = await read_json(request, TaskCreateInput)
    fields = present(data)
    custom = fields.pop("custom", None)
    uid = ctx.user["id"]
    if "descriptionLocked" in fields and not can(ctx.user, "tasks.lock", ctx.db):
        raise denied()
    with ctx.db.tx() as conn:
        _check_refs(conn, fields)
        if "projectId" not in fields:
            r = conn.execute("SELECT id FROM projects WHERE is_archived = 0 ORDER BY sort_order, id LIMIT 1").fetchone()
            if r:
                fields["projectId"] = r["id"]
        if "statusId" not in fields:
            r = conn.execute("SELECT id FROM statuses ORDER BY sort_order, id LIMIT 1").fetchone()
            if r:
                fields["statusId"] = r["id"]
        if "projectId" not in fields or "statusId" not in fields:
            raise bad_request("尚未建立專案或狀態")
        if "sortOrder" not in fields:
            fields["sortOrder"] = next_sort_order(conn, "tasks")
        merged = merge_custom_values(conn, fields["projectId"], {}, custom) if custom else {}
        t = ctx.now()
        # 以 done 類別狀態建立 → 視為此刻完成
        completed_at = t if _is_done(conn, fields["statusId"]) else None
        lock_sets: dict[str, Any] = {}
        _apply_lock(fields, lock_sets, uid, t)
        fields.pop("descriptionLocked", None)
        cols = [_COLUMNS[k] for k in fields] + [*lock_sets] + [
            "custom",
            "created_by",
            "updated_by",
            "created_at",
            "updated_at",
            "completed_at",
        ]
        values = [*fields.values(), *lock_sets.values(), json.dumps(merged, ensure_ascii=False), uid, uid, t, t, completed_at]
        cur = conn.execute(
            f"INSERT INTO tasks ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", tuple(values)
        )
        tid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "task", tid, "create", uid, t)
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
        audit_events.task_created(conn, ctx.user, row, t)
        out = _task_out(conn, row, uid)
    return JSONResponse(out, status_code=201)


@router.get("/{id}")
async def get_task(request: Request, id: str):
    ctx = get_ctx(request)
    with ctx.db.lock:
        task = _find_task(ctx.db.conn, parse_id(id))
        if task is None:
            raise not_found("此任務不存在或已被刪除")
        return _task_out(ctx.db.conn, task, ctx.user["id"] if ctx.user else None)


@router.patch("/{id}")
async def update_task(request: Request, id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    data = await read_json(request, TaskUpdateInput)
    fields = present(data)
    custom = fields.pop("custom", None)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        current = _find_task(conn, tid)
        if current is None:
            raise not_found("此任務不存在或已被刪除")
        _check_refs(conn, fields)
        # 描述鎖定：切換鎖需 tasks.lock；鎖定中（或本次一併鎖定）改描述也需 tasks.lock（內容未變不擋）
        may_lock = can(ctx.user, "tasks.lock", ctx.db)
        if "descriptionLocked" in fields and not may_lock:
            raise denied()
        if (
            "description" in fields
            and current["description_locked"]
            and fields["description"] != current["description"]
            and not may_lock
        ):
            raise forbidden(LOCKED_MESSAGE)
        # 只更新有送來的欄位（欄位層級後寫入者勝）；custom 逐鍵合併
        t = ctx.now()
        sets = {_COLUMNS[k]: v for k, v in fields.items() if k != "descriptionLocked"}
        _apply_lock(fields, sets, uid, t)
        if custom:
            merged = merge_custom_values(
                conn, fields.get("projectId", current["project_id"]), json.loads(current["custom"]), custom
            )
            sets["custom"] = json.dumps(merged, ensure_ascii=False)
        # 完成時間：非 done → done 設為此刻；done → 非 done 清除；仍為 done（或仍非 done）不變
        if "statusId" in fields:
            was_done = _is_done(conn, current["status_id"])
            now_done = _is_done(conn, fields["statusId"])
            if now_done and not was_done:
                sets["completed_at"] = t
            elif was_done and not now_done:
                sets["completed_at"] = None
        sets["updated_by"] = uid
        sets["updated_at"] = t
        conn.execute(
            f"UPDATE tasks SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?", (*sets.values(), tid)
        )
        record_change(conn, "task", tid, "update", uid, t)
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
        audit_events.task_updated(conn, ctx.user, current, row, t)
        out = _task_out(conn, row, uid)
    return out


@router.delete("/{id}")
async def delete_task(request: Request, id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        current = _find_task(conn, tid)
        if current is None:
            raise not_found("此任務不存在或已被刪除")
        t = ctx.now()
        conn.execute("UPDATE tasks SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?", (t, uid, t, tid))
        record_change(conn, "task", tid, "delete", uid, t)
        audit_events.task_deleted(conn, ctx.user, current, t)
    return {"ok": True}


@router.post("/{id}/restore")
async def restore_task(request: Request, id: str):
    """還原軟刪除的任務（復原 / 重做用，docs/design/undo.md）。
    已存在（未刪除）時冪等回傳目前資料；從未存在 → 404。還原後以 create 事件通知其他人（重新出現）。"""
    ctx = get_ctx(request)
    tid = parse_id(id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
        if row is None:
            raise not_found("此任務不存在")
        if row["deleted_at"] is not None:
            t = ctx.now()
            conn.execute(
                "UPDATE tasks SET deleted_at = NULL, updated_by = ?, updated_at = ? WHERE id = ?", (uid, t, tid)
            )
            record_change(conn, "task", tid, "create", uid, t)
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
            audit_events.task_restored(conn, ctx.user, row, t)
        return _task_out(conn, row, uid)
