"""/api/tasks/:id/checklist：任務待辦清單（結構化、每項可獨立勾選）。

- 讀取：登入即可；寫入：沿用 `/api/tasks` 的 WRITE_GUARDS（tasks.edit）。
- 所有寫入都會更新該任務的 updated_at / updated_by 並 record_change(task, update)，
  讓列表、看板徽章與他人的畫面經 SSE 即時更新。
- 軟刪除的任務清單保留（不可再讀寫）；任務實際刪除時由 FK ON DELETE CASCADE 連動刪除。
- 聚合欄位 checklistTotal / checklistDone 由 with_checklist_counts() 以單一查詢附加到任務回應。
"""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints

from .. import audit_events
from ..changes import record_change
from ..context import get_ctx
from ..db import row_to_dict, rows_to_dicts
from ..errors import bad_request, not_found, validation_error
from ..schemas import _Input
from ..validate import parse_id, present, read_json

router = APIRouter()

#: 單次批次建立上限、單項長度上限、單一任務總項數上限
MAX_BATCH = 100
MAX_TEXT = 500
MAX_PER_TASK = 500

ItemText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_TEXT)]


class _NewItem(BaseModel):
    model_config = {"extra": "ignore"}
    text: ItemText
    isDone: bool = False


class ChecklistCreateInput(_Input):
    text: ItemText = None  # type: ignore[assignment]
    items: Annotated[list[_NewItem], Field(max_length=MAX_BATCH)] = None  # type: ignore[assignment]
    isDone: bool = False
    #: 只在單項（text）建立時有效：指定排序值（插入到指定位置）；未給則排在最後
    sortOrder: float = None  # type: ignore[assignment]


class ChecklistUpdateInput(_Input):
    text: ItemText = None  # type: ignore[assignment]
    isDone: bool = None  # type: ignore[assignment]
    sortOrder: float = None  # type: ignore[assignment]


def _task_exists(conn: sqlite3.Connection, task_id: int) -> None:
    if conn.execute("SELECT 1 FROM tasks WHERE id = ? AND deleted_at IS NULL", (task_id,)).fetchone() is None:
        raise not_found("此任務不存在或已被刪除")


def _find_item(conn: sqlite3.Connection, task_id: int, item_id: int) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM task_checklist_items WHERE id = ? AND task_id = ?", (item_id, task_id)
    ).fetchone()
    if row is None:
        raise not_found("此待辦項目不存在或已被刪除")
    return row


def _touch(conn: sqlite3.Connection, task_id: int, uid: int, t: int) -> None:
    conn.execute("UPDATE tasks SET updated_by = ?, updated_at = ? WHERE id = ?", (uid, t, task_id))
    record_change(conn, "task", task_id, "update", uid, t)


def checklist_counts(conn: sqlite3.Connection, task_ids: list[int] | None = None) -> dict[int, tuple[int, int]]:
    """task_id → (總數, 已完成)；單一聚合查詢（task_ids 為 None 時彙整全部任務）"""
    if task_ids is None:
        rows = conn.execute(
            "SELECT task_id, count(*) AS total, coalesce(sum(is_done), 0) AS done "
            "FROM task_checklist_items GROUP BY task_id"
        ).fetchall()
    else:
        if not task_ids:
            return {}
        rows = conn.execute(
            "SELECT task_id, count(*) AS total, coalesce(sum(is_done), 0) AS done "
            f"FROM task_checklist_items WHERE task_id IN ({','.join('?' * len(task_ids))}) GROUP BY task_id",
            tuple(task_ids),
        ).fetchall()
    return {r["task_id"]: (int(r["total"]), int(r["done"])) for r in rows}


def with_checklist_counts(conn: sqlite3.Connection, tasks: list[dict[str, Any]], *, all_tasks: bool = False) -> list[dict[str, Any]]:
    """替任務回應附加 checklistTotal / checklistDone（既有欄位不變）"""
    counts = checklist_counts(conn, None if all_tasks else [t["id"] for t in tasks])
    for t in tasks:
        total, done = counts.get(t["id"], (0, 0))
        t["checklistTotal"] = total
        t["checklistDone"] = done
    return tasks


def _list(conn: sqlite3.Connection, task_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM task_checklist_items WHERE task_id = ? ORDER BY sort_order, id", (task_id,)
    ).fetchall()
    return rows_to_dicts(rows)


@router.get("/{id}/checklist")
async def list_checklist(request: Request, id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    with ctx.db.lock:
        _task_exists(ctx.db.conn, tid)
        return _list(ctx.db.conn, tid)


@router.post("/{id}/checklist")
async def create_items(request: Request, id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    data = await read_json(request, ChecklistCreateInput)
    fields = present(data)
    if ("text" in fields) == ("items" in fields):
        raise validation_error(
            [{"path": ["text"], "message": "請擇一提供 text 或 items", "code": "invalid_input"}]
        )
    if "text" in fields:
        new = [(data.text, bool(data.isDone))]
        explicit = fields.get("sortOrder")
    else:
        if not data.items:
            raise validation_error([{"path": ["items"], "message": "items 不可為空", "code": "too_short"}])
        new = [(i.text, bool(i.isDone)) for i in data.items]
        explicit = None
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        _task_exists(conn, tid)
        row = conn.execute(
            "SELECT count(*) AS n, max(sort_order) AS m FROM task_checklist_items WHERE task_id = ?", (tid,)
        ).fetchone()
        if row["n"] + len(new) > MAX_PER_TASK:
            raise bad_request(f"每個任務最多 {MAX_PER_TASK} 個待辦項目")
        t = ctx.now()
        order = float(row["m"] or 0)
        ids: list[int] = []
        for text, done in new:
            order = explicit if explicit is not None else order + 1
            cur = conn.execute(
                "INSERT INTO task_checklist_items (task_id, text, is_done, sort_order, done_at, done_by, "
                "created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (tid, text, 1 if done else 0, order, t if done else None, uid if done else None, uid, uid, t, t),
            )
            ids.append(int(cur.lastrowid))  # type: ignore[arg-type]
        _touch(conn, tid, uid, t)
        audit_events.checklist_added(conn, ctx.user, tid, [text for text, _ in new], t)
        rows = conn.execute(
            f"SELECT * FROM task_checklist_items WHERE id IN ({','.join('?' * len(ids))}) ORDER BY sort_order, id",
            tuple(ids),
        ).fetchall()
    return JSONResponse(rows_to_dicts(rows), status_code=201)


@router.patch("/{id}/checklist/{item_id}")
async def update_item(request: Request, id: str, item_id: str):
    ctx = get_ctx(request)
    tid, iid = parse_id(id), parse_id(item_id)
    data = await read_json(request, ChecklistUpdateInput)
    fields = present(data)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        _task_exists(conn, tid)
        current = _find_item(conn, tid, iid)
        t = ctx.now()
        sets: dict[str, Any] = {}
        if "text" in fields:
            sets["text"] = fields["text"]
        if "sortOrder" in fields:
            sets["sort_order"] = fields["sortOrder"]
        if "isDone" in fields and bool(current["is_done"]) != fields["isDone"]:
            sets["is_done"] = 1 if fields["isDone"] else 0
            sets["done_at"] = t if fields["isDone"] else None
            sets["done_by"] = uid if fields["isDone"] else None
        if sets:
            sets["updated_by"] = uid
            sets["updated_at"] = t
            conn.execute(
                f"UPDATE task_checklist_items SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?",
                (*sets.values(), iid),
            )
            _touch(conn, tid, uid, t)
            if "is_done" in sets:
                audit_events.checklist_toggled(conn, ctx.user, tid, bool(sets["is_done"]), t)
        row = conn.execute("SELECT * FROM task_checklist_items WHERE id = ?", (iid,)).fetchone()
    return row_to_dict(row)


@router.post("/{id}/checklist/clear-done")
async def clear_done(request: Request, id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        _task_exists(conn, tid)
        texts = [
            r["text"]
            for r in conn.execute(
                "SELECT text FROM task_checklist_items WHERE task_id = ? AND is_done = 1 ORDER BY sort_order, id",
                (tid,),
            )
        ]
        removed = conn.execute(
            "DELETE FROM task_checklist_items WHERE task_id = ? AND is_done = 1", (tid,)
        ).rowcount
        if removed:
            t = ctx.now()
            _touch(conn, tid, uid, t)
            audit_events.checklist_cleared(conn, ctx.user, tid, texts, t)
    return {"removed": removed}


@router.delete("/{id}/checklist/{item_id}")
async def delete_item(request: Request, id: str, item_id: str):
    ctx = get_ctx(request)
    tid, iid = parse_id(id), parse_id(item_id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        _task_exists(conn, tid)
        item = _find_item(conn, tid, iid)
        conn.execute("DELETE FROM task_checklist_items WHERE id = ?", (iid,))
        t = ctx.now()
        _touch(conn, tid, uid, t)
        audit_events.checklist_item_deleted(conn, ctx.user, tid, item["text"], t)
    return {"ok": True}
