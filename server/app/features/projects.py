"""/api/projects（含封存專案，由前端過濾）與 /api/statuses（唯讀）。"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..changes import record_change
from ..context import get_ctx
from ..db import next_sort_order, row_to_dict, rows_to_dicts
from ..errors import not_found
from ..schemas import ProjectCreateInput, ProjectUpdateInput
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
async def update_project(request: Request, id: str):
    ctx = get_ctx(request)
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
