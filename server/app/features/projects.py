"""/api/projects（含封存專案，由前端過濾）與 /api/statuses。

權限（server/app/permissions.py）：建立專案全員可用（projects.create）；專案改名 / 改色 / 排序 / 封存
需 projects.manage；狀態的新增 / 修改 / 刪除需 statuses.manage（皆 manager 以上）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..changes import record_change
from ..context import Ctx, get_ctx
from ..db import next_sort_order, row_to_dict, rows_to_dicts
from ..errors import conflict, not_found
from ..permissions import require
from ..schemas import ProjectCreateInput, ProjectUpdateInput, StatusCreateInput, StatusUpdateInput
from ..validate import parse_id, present, read_json

router = APIRouter()
statuses_router = APIRouter()

_PROJECT_COLUMNS = {"name": "name", "color": "color", "isArchived": "is_archived", "sortOrder": "sort_order"}


@router.get("")
async def list_projects(request: Request):
    return rows_to_dicts(get_ctx(request).db.all("SELECT * FROM projects ORDER BY sort_order, id"))


@router.post("")
async def create_project(request: Request):
    ctx = get_ctx(request)
    data = await read_json(request, ProjectCreateInput)
    with ctx.db.tx() as conn:
        t = ctx.now()
        cur = conn.execute(
            "INSERT INTO projects (name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (data.name, data.color or "blue", next_sort_order(conn, "projects"), t, t),
        )
        pid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "project", pid, "create", ctx.user["id"], t)
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    return JSONResponse(row_to_dict(row), status_code=201)


@router.patch("/{id}")
async def update_project(request: Request, id: str, ctx: Ctx = Depends(require("projects.manage"))):
    pid = parse_id(id)
    data = await read_json(request, ProjectUpdateInput)
    fields = {_PROJECT_COLUMNS[k]: v for k, v in present(data).items()}
    t = ctx.now()
    fields["updated_at"] = t
    with ctx.db.tx() as conn:
        sets = ", ".join(f"{col} = ?" for col in fields)
        cur = conn.execute(f"UPDATE projects SET {sets} WHERE id = ?", (*fields.values(), pid))
        if cur.rowcount == 0:
            raise not_found("找不到專案")
        record_change(conn, "project", pid, "update", ctx.user["id"], t)
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    return row_to_dict(row)


@statuses_router.get("")
async def list_statuses(request: Request):
    return rows_to_dicts(get_ctx(request).db.all("SELECT * FROM statuses ORDER BY sort_order, id"))


_STATUS_COLUMNS = {"name": "name", "color": "color", "category": "category", "sortOrder": "sort_order"}
_STATUS_NOT_FOUND = "找不到狀態"


@statuses_router.post("")
async def create_status(request: Request, ctx: Ctx = Depends(require("statuses.manage"))):
    data = await read_json(request, StatusCreateInput)
    with ctx.db.tx() as conn:
        t = ctx.now()
        sort = data.sortOrder if data.sortOrder is not None else next_sort_order(conn, "statuses")
        cur = conn.execute(
            "INSERT INTO statuses (name, color, category, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (data.name, data.color or "gray", data.category or "todo", sort, t, t),
        )
        sid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "status", sid, "create", ctx.user["id"], t)
        row = conn.execute("SELECT * FROM statuses WHERE id = ?", (sid,)).fetchone()
    return JSONResponse(row_to_dict(row), status_code=201)


@statuses_router.patch("/{id}")
async def update_status(request: Request, id: str, ctx: Ctx = Depends(require("statuses.manage"))):
    sid = parse_id(id)
    data = await read_json(request, StatusUpdateInput)
    fields = {_STATUS_COLUMNS[k]: v for k, v in present(data).items()}
    t = ctx.now()
    fields["updated_at"] = t
    with ctx.db.tx() as conn:
        sets = ", ".join(f"{col} = ?" for col in fields)
        cur = conn.execute(f"UPDATE statuses SET {sets} WHERE id = ?", (*fields.values(), sid))
        if cur.rowcount == 0:
            raise not_found(_STATUS_NOT_FOUND)
        record_change(conn, "status", sid, "update", ctx.user["id"], t)
        row = conn.execute("SELECT * FROM statuses WHERE id = ?", (sid,)).fetchone()
    return row_to_dict(row)


@statuses_router.delete("/{id}")
async def delete_status(id: str, ctx: Ctx = Depends(require("statuses.manage"))):
    """刪除狀態：仍有任務（含已刪除、可還原的任務）使用時 409；至少保留一個狀態"""
    sid = parse_id(id)
    with ctx.db.tx() as conn:
        if conn.execute("SELECT 1 FROM statuses WHERE id = ?", (sid,)).fetchone() is None:
            raise not_found(_STATUS_NOT_FOUND)
        used = conn.execute("SELECT count(*) FROM tasks WHERE status_id = ?", (sid,)).fetchone()[0]
        if used:
            raise conflict(f"仍有 {used} 筆任務使用此狀態（含已刪除的任務），請先將這些任務改為其他狀態再刪除")
        if conn.execute("SELECT count(*) FROM statuses").fetchone()[0] <= 1:
            raise conflict("至少需保留一個狀態")
        conn.execute("DELETE FROM statuses WHERE id = ?", (sid,))
        record_change(conn, "status", sid, "delete", ctx.user["id"], ctx.now())
    return {"ok": True}
