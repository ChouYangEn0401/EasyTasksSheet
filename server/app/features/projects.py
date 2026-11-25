"""/api/projects（含封存專案，由前端過濾）與 /api/statuses。

權限（server/app/permissions.py）：建立專案需 projects.create（預設 user 以上，root 可在設定頁調整）；專案改名 / 改色 / 排序 / 封存
需 projects.manage；狀態的新增 / 修改 / 刪除需 statuses.manage（皆 manager 以上）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from .. import audit_events
from ..changes import record_change
from ..context import Ctx, get_ctx
from ..db import next_sort_order, row_to_dict, rows_to_dicts
from ..errors import bad_request, conflict, not_found
from ..permissions import require
from ..schemas import ProjectCreateInput, ProjectUpdateInput, StatusCreateInput, StatusMigrateInput, StatusUpdateInput
from ..validate import parse_id, present, read_json

router = APIRouter()
statuses_router = APIRouter()

_PROJECT_COLUMNS = {"name": "name", "color": "color", "isArchived": "is_archived", "sortOrder": "sort_order"}


@router.get("")
async def list_projects(request: Request):
    return rows_to_dicts(get_ctx(request).db.all("SELECT * FROM projects ORDER BY sort_order, id"))


@router.post("")
async def create_project(request: Request, ctx: Ctx = Depends(require("projects.create"))):
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
        audit_events.project_created(conn, ctx.user, row, t)
    return JSONResponse(row_to_dict(row), status_code=201)


@router.patch("/{id}")
async def update_project(request: Request, id: str, ctx: Ctx = Depends(require("projects.manage"))):
    pid = parse_id(id)
    data = await read_json(request, ProjectUpdateInput)
    fields = {_PROJECT_COLUMNS[k]: v for k, v in present(data).items()}
    t = ctx.now()
    fields["updated_at"] = t
    with ctx.db.tx() as conn:
        before = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
        sets = ", ".join(f"{col} = ?" for col in fields)
        cur = conn.execute(f"UPDATE projects SET {sets} WHERE id = ?", (*fields.values(), pid))
        if cur.rowcount == 0:
            raise not_found("找不到專案")
        record_change(conn, "project", pid, "update", ctx.user["id"], t)
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
        audit_events.project_updated(conn, ctx.user, before, row, t)
    return row_to_dict(row)


@statuses_router.get("")
async def list_statuses(request: Request):
    return rows_to_dicts(get_ctx(request).db.all("SELECT * FROM statuses ORDER BY sort_order, id"))


@statuses_router.get("/usage")
async def status_usage(request: Request):
    """各狀態被任務使用的筆數（含已刪除、可還原的任務）；刪除對話框用來提示是否需要改移任務"""
    rows = get_ctx(request).db.all("SELECT status_id, count(*) AS n FROM tasks GROUP BY status_id")
    return {str(r["status_id"]): r["n"] for r in rows}


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
        audit_events.status_created(conn, ctx.user, row, t)
    return JSONResponse(row_to_dict(row), status_code=201)


@statuses_router.patch("/{id}")
async def update_status(request: Request, id: str, ctx: Ctx = Depends(require("statuses.manage"))):
    sid = parse_id(id)
    data = await read_json(request, StatusUpdateInput)
    fields = {_STATUS_COLUMNS[k]: v for k, v in present(data).items()}
    t = ctx.now()
    fields["updated_at"] = t
    with ctx.db.tx() as conn:
        before = conn.execute("SELECT * FROM statuses WHERE id = ?", (sid,)).fetchone()
        sets = ", ".join(f"{col} = ?" for col in fields)
        cur = conn.execute(f"UPDATE statuses SET {sets} WHERE id = ?", (*fields.values(), sid))
        if cur.rowcount == 0:
            raise not_found(_STATUS_NOT_FOUND)
        record_change(conn, "status", sid, "update", ctx.user["id"], t)
        row = conn.execute("SELECT * FROM statuses WHERE id = ?", (sid,)).fetchone()
        audit_events.status_updated(conn, ctx.user, before, row, t)
    return row_to_dict(row)


@statuses_router.delete("/{id}")
async def delete_status(id: str, ctx: Ctx = Depends(require("statuses.manage"))):
    """刪除狀態：仍有任務（含已刪除、可還原的任務）使用時 409；至少保留一個狀態"""
    sid = parse_id(id)
    with ctx.db.tx() as conn:
        before = conn.execute("SELECT * FROM statuses WHERE id = ?", (sid,)).fetchone()
        if before is None:
            raise not_found(_STATUS_NOT_FOUND)
        used = conn.execute("SELECT count(*) FROM tasks WHERE status_id = ?", (sid,)).fetchone()[0]
        if used:
            raise conflict(f"仍有 {used} 筆任務使用此狀態（含已刪除的任務），請先將這些任務改為其他狀態再刪除")
        if conn.execute("SELECT count(*) FROM statuses").fetchone()[0] <= 1:
            raise conflict("至少需保留一個狀態")
        conn.execute("DELETE FROM statuses WHERE id = ?", (sid,))
        t = ctx.now()
        record_change(conn, "status", sid, "delete", ctx.user["id"], t)
        audit_events.status_deleted(conn, ctx.user, before, t)
    return {"ok": True}


@statuses_router.post("/{id}/migrate-and-delete")
async def migrate_and_delete_status(request: Request, id: str, ctx: Ctx = Depends(require("statuses.manage"))):
    """把使用此狀態的所有任務（含已刪除）改移到目標狀態後刪除此狀態；單一 transaction。至少保留一個狀態"""
    sid = parse_id(id)
    data = await read_json(request, StatusMigrateInput)
    target = data.targetStatusId
    if target == sid:
        raise bad_request("目標狀態不可與要刪除的狀態相同")
    with ctx.db.tx() as conn:
        source_row = conn.execute("SELECT * FROM statuses WHERE id = ?", (sid,)).fetchone()
        if source_row is None:
            raise not_found(_STATUS_NOT_FOUND)
        dest = conn.execute("SELECT * FROM statuses WHERE id = ?", (target,)).fetchone()
        if dest is None:
            raise not_found("找不到目標狀態")
        if conn.execute("SELECT count(*) FROM statuses").fetchone()[0] <= 1:
            raise conflict("至少需保留一個狀態")
        t = ctx.now()
        src_done = conn.execute("SELECT category FROM statuses WHERE id = ?", (sid,)).fetchone()["category"] == "done"
        moved = conn.execute("SELECT id, title FROM tasks WHERE status_id = ?", (sid,)).fetchall()
        if moved:
            # 完成時間：非 done → done 設為此刻；done → 非 done 清除；其餘不變
            dest_done = dest["category"] == "done"
            extra = ""
            if dest_done and not src_done:
                extra = ", completed_at = COALESCE(completed_at, :t)"
            elif src_done and not dest_done:
                extra = ", completed_at = NULL"
            conn.execute(
                f"UPDATE tasks SET status_id = :target, updated_at = :t, updated_by = :uid{extra} WHERE status_id = :sid",
                {"target": target, "t": t, "uid": ctx.user["id"], "sid": sid},
            )
            for r in moved:
                record_change(conn, "task", int(r["id"]), "update", ctx.user["id"], t)
        conn.execute("DELETE FROM statuses WHERE id = ?", (sid,))
        record_change(conn, "status", sid, "delete", ctx.user["id"], t)
        if moved:
            audit_events.status_migrated(conn, ctx.user, source_row, dest, moved, t)
        else:
            audit_events.status_deleted(conn, ctx.user, source_row, t)
    return {"ok": True, "moved": len(moved)}
