"""任務關聯（related）與複製任務（feat/task-relations，docs/design/task-list.md §13）。

路由掛在 /api/tasks 之下；寫入由 WRITE_GUARDS 中介層要求 `tasks.edit`，讀取登入即可。

- related 為對稱關係：寫入時以較小 id 在前正規化（task_a_id < task_b_id，DB CHECK 亦保證），
  UNIQUE(task_a_id, task_b_id, type) 讓重複建立冪等。
- 任務軟刪除時關聯保留：GET relations 仍回傳（`task.deleted = true`，前端顯示為灰字「已刪除」），
  但 `GET /api/tasks` 的 relationCount 不計入已刪除的對方任務。
- 關聯的新增 / 移除會更新兩端（未刪除）任務的 updated_at / updated_by 並各寫一筆 task update 變更，
  讓兩端畫面經 SSE 即時更新。
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import audit_events
from ..changes import record_change
from ..context import get_ctx
from ..db import next_sort_order, row_to_dict
from ..errors import bad_request, not_found
from ..schemas import TaskDuplicateInput, TaskRelationCreateInput
from ..validate import parse_id, read_json
from .tasks import RELATION_COUNT_CTE, _find_task, _is_done

router = APIRouter()

#: 複製任務的預設標題後綴
COPY_SUFFIX = "（複製）"
TITLE_MAX = 500

_NOT_FOUND = "此任務不存在或已被刪除"


def normalize_pair(x: int, y: int) -> tuple[int, int]:
    """對稱關係：較小 id 在前"""
    return (x, y) if x < y else (y, x)


def _relation_view(conn: sqlite3.Connection, rel: sqlite3.Row, self_id: int) -> dict[str, Any]:
    other_id = rel["task_b_id"] if rel["task_a_id"] == self_id else rel["task_a_id"]
    o = conn.execute(
        "SELECT id, title, status_id, assignee_id, project_id, due_date, deleted_at FROM tasks WHERE id = ?",
        (other_id,),
    ).fetchone()
    return {
        "id": rel["id"],
        "type": rel["type"],
        "createdBy": rel["created_by"],
        "createdAt": rel["created_at"],
        "task": {
            "id": o["id"],
            "title": o["title"],
            "statusId": o["status_id"],
            "assigneeId": o["assignee_id"],
            "projectId": o["project_id"],
            "dueDate": o["due_date"],
            "deleted": o["deleted_at"] is not None,
        },
    }


def _touch(conn: sqlite3.Connection, task_ids: tuple[int, ...], uid: int, t: int) -> None:
    """關聯變動：兩端（未刪除）任務的 updated_at / updated_by 與 task update 變更"""
    for tid in task_ids:
        cur = conn.execute(
            "UPDATE tasks SET updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL", (t, uid, tid)
        )
        if cur.rowcount:
            record_change(conn, "task", tid, "update", uid, t)


def insert_relation(
    conn: sqlite3.Connection, x: int, y: int, rel_type: str, uid: int, t: int
) -> tuple[sqlite3.Row, bool]:
    """建立關聯（已存在則回傳既有）；回傳 (row, created)"""
    a, b = normalize_pair(x, y)
    existing = conn.execute(
        "SELECT * FROM task_relations WHERE task_a_id = ? AND task_b_id = ? AND type = ?", (a, b, rel_type)
    ).fetchone()
    if existing is not None:
        return existing, False
    cur = conn.execute(
        "INSERT INTO task_relations (task_a_id, task_b_id, type, created_by, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (a, b, rel_type, uid, t, t),
    )
    row = conn.execute("SELECT * FROM task_relations WHERE id = ?", (cur.lastrowid,)).fetchone()
    return row, True


@router.get("/{id}/relations")
async def list_relations(request: Request, id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    with ctx.db.lock:
        conn = ctx.db.conn
        if _find_task(conn, tid) is None:
            raise not_found(_NOT_FOUND)
        rels = conn.execute(
            "SELECT * FROM task_relations WHERE task_a_id = ? OR task_b_id = ? ORDER BY created_at, id", (tid, tid)
        ).fetchall()
        return [_relation_view(conn, r, tid) for r in rels]


@router.post("/{id}/relations")
async def create_relation(request: Request, id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    data = await read_json(request, TaskRelationCreateInput)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        if _find_task(conn, tid) is None:
            raise not_found(_NOT_FOUND)
        if data.targetId == tid:
            raise bad_request("不能將任務與自己建立關聯")
        if _find_task(conn, data.targetId) is None:
            raise not_found("要關聯的任務不存在或已被刪除")
        t = ctx.now()
        row, created = insert_relation(conn, tid, data.targetId, data.type, uid, t)
        if created:
            _touch(conn, (tid, data.targetId), uid, t)
            audit_events.link_created(conn, ctx.user, "relation", row, t, task_id=tid)
        view = _relation_view(conn, row, tid)
    return JSONResponse(view, status_code=201 if created else 200)


@router.delete("/{id}/relations/{relation_id}")
async def delete_relation(request: Request, id: str, relation_id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    rid = parse_id(relation_id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        rel = conn.execute(
            "SELECT * FROM task_relations WHERE id = ? AND (task_a_id = ? OR task_b_id = ?)", (rid, tid, tid)
        ).fetchone()
        if rel is None:
            raise not_found("此關聯不存在或已被移除")
        conn.execute("DELETE FROM task_relations WHERE id = ?", (rid,))
        t = ctx.now()
        _touch(conn, (rel["task_a_id"], rel["task_b_id"]), uid, t)
        audit_events.link_deleted(conn, ctx.user, "relation", rel, t, task_id=tid)
    return {"ok": True}


def default_copy_title(title: str) -> str:
    """原標題 +「（複製）」，超過上限時截斷原標題"""
    base = title.strip()
    room = TITLE_MAX - len(COPY_SUFFIX)
    if len(base) > room:
        base = base[:room]
    return base + COPY_SUFFIX


def _default_status(conn: sqlite3.Connection) -> int:
    """第一個 category=todo 的狀態（狀態為全域共用）；沒有時取第一個狀態"""
    r = conn.execute("SELECT id FROM statuses WHERE category = 'todo' ORDER BY sort_order, id LIMIT 1").fetchone()
    if r is None:
        r = conn.execute("SELECT id FROM statuses ORDER BY sort_order, id LIMIT 1").fetchone()
    if r is None:
        raise bad_request("尚未建立狀態")
    return int(r["id"])


@router.post("/{id}/duplicate")
async def duplicate_task(request: Request, id: str):
    """複製任務：單一 transaction；新任務 uid 由 trigger 產生；不複製完成時間、附件、個人標記與關聯本身"""
    ctx = get_ctx(request)
    tid = parse_id(id)
    data = await read_json(request, TaskDuplicateInput)
    copy = data.copy_
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        src = _find_task(conn, tid)
        if src is None:
            raise not_found(_NOT_FOUND)
        if data.statusId is not None:
            if not conn.execute("SELECT 1 FROM statuses WHERE id = ?", (data.statusId,)).fetchone():
                raise bad_request("狀態不存在")
            status_id = data.statusId
        else:
            status_id = _default_status(conn)
        t = ctx.now()
        values: dict[str, Any] = {
            "title": data.title if data.title is not None else default_copy_title(src["title"]),
            "project_id": src["project_id"],
            "description": src["description"] if copy.description else "",
            "status_id": status_id,
            "assignee_id": src["assignee_id"] if copy.assignee else None,
            "priority": src["priority"] if copy.priority else "none",
            "start_date": src["start_date"] if copy.dates else None,
            "due_date": src["due_date"] if copy.dates else None,
            "estimate_hours": src["estimate_hours"] if copy.estimate else None,
            "progress": 0,
            # 全域最大 + 1：同時也是同狀態的最後一筆
            "sort_order": next_sort_order(conn, "tasks"),
            # 自訂欄位逐鍵複製（值已依原專案驗證過）
            "custom": json.dumps(json.loads(src["custom"] or "{}"), ensure_ascii=False)
            if copy.customFields
            else "{}",
            "created_by": uid,
            "updated_by": uid,
            "created_at": t,
            "updated_at": t,
            "completed_at": t if _is_done(conn, status_id) else None,
        }
        cur = conn.execute(
            f"INSERT INTO tasks ({', '.join(values)}) VALUES ({', '.join('?' * len(values))})",
            tuple(values.values()),
        )
        new_id = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "task", new_id, "create", uid, t)
        audit_events.task_created(
            conn, ctx.user, conn.execute("SELECT * FROM tasks WHERE id = ?", (new_id,)).fetchone(), t
        )
        if data.relate:
            rel, _created = insert_relation(conn, tid, new_id, "related", uid, t)
            _touch(conn, (tid,), uid, t)
            audit_events.link_created(conn, ctx.user, "relation", rel, t, task_id=new_id)
        row = conn.execute(
            f"WITH {RELATION_COUNT_CTE} SELECT tasks.*, coalesce(rc.n, 0) AS relation_count FROM tasks "
            "LEFT JOIN rc ON rc.task_id = tasks.id WHERE tasks.id = ?",
            (new_id,),
        ).fetchone()
    return JSONResponse(row_to_dict(row), status_code=201)
