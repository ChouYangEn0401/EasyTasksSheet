"""/api/tasks：所有成員可讀寫所有任務，刪除為軟刪除。"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..changes import record_change
from ..context import get_ctx
from ..db import next_sort_order, row_to_dict, rows_to_dicts
from ..errors import bad_request, not_found, validation_error
from ..schemas import TaskCreateInput, TaskUpdateInput
from ..validate import parse_id, present, read_json
from .properties import merge_custom_values

router = APIRouter()

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
}

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


def _find_task(conn: sqlite3.Connection, task_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL", (task_id,)).fetchone()


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

    rows = get_ctx(request).db.all(
        f"SELECT * FROM tasks WHERE {' AND '.join(conds)} ORDER BY sort_order, id", tuple(params)
    )
    return rows_to_dicts(rows)


@router.post("")
async def create_task(request: Request):
    ctx = get_ctx(request)
    data = await read_json(request, TaskCreateInput)
    fields = present(data)
    custom = fields.pop("custom", None)
    uid = ctx.user["id"]
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
        cols = [_COLUMNS[k] for k in fields] + ["custom", "created_by", "updated_by", "created_at", "updated_at"]
        values = [*fields.values(), json.dumps(merged, ensure_ascii=False), uid, uid, t, t]
        cur = conn.execute(
            f"INSERT INTO tasks ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", tuple(values)
        )
        tid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "task", tid, "create", uid, t)
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
    return JSONResponse(row_to_dict(row), status_code=201)


@router.get("/{id}")
async def get_task(request: Request, id: str):
    ctx = get_ctx(request)
    with ctx.db.lock:
        task = _find_task(ctx.db.conn, parse_id(id))
    if task is None:
        raise not_found("此任務不存在或已被刪除")
    return row_to_dict(task)


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
        # 只更新有送來的欄位（欄位層級後寫入者勝）；custom 逐鍵合併
        t = ctx.now()
        sets = {_COLUMNS[k]: v for k, v in fields.items()}
        if custom:
            merged = merge_custom_values(
                conn, fields.get("projectId", current["project_id"]), json.loads(current["custom"]), custom
            )
            sets["custom"] = json.dumps(merged, ensure_ascii=False)
        sets["updated_by"] = uid
        sets["updated_at"] = t
        conn.execute(
            f"UPDATE tasks SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?", (*sets.values(), tid)
        )
        record_change(conn, "task", tid, "update", uid, t)
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone()
    return row_to_dict(row)


@router.delete("/{id}")
async def delete_task(request: Request, id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        if _find_task(conn, tid) is None:
            raise not_found("此任務不存在或已被刪除")
        t = ctx.now()
        conn.execute("UPDATE tasks SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?", (t, uid, t, tid))
        record_change(conn, "task", tid, "delete", uid, t)
    return {"ok": True}
