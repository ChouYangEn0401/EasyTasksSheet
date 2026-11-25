"""/api/overview：每人進行中任務、未完成預估工時、各狀態數量、逾期、未指派、本週完成（依 completed_at）。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from ..config import config
from ..context import get_ctx
from ._overview_compute import compute_overview

router = APIRouter()


@router.get("")
async def get_overview(request: Request):
    ctx = get_ctx(request)
    with ctx.db.lock:
        conn = ctx.db.conn
        statuses = [
            {"id": r[0], "name": r[1], "color": r[2], "category": r[3], "sortOrder": r[4]}
            for r in conn.execute("SELECT id, name, color, category, sort_order FROM statuses")
        ]
        users = [
            {"id": r[0], "username": r[1], "displayName": r[2], "isActive": bool(r[3])}
            for r in conn.execute("SELECT id, username, display_name, is_active FROM users")
        ]
        tasks = [
            {
                "id": r[0],
                "title": r[1],
                "statusId": r[2],
                "assigneeId": r[3],
                "dueDate": r[4],
                "estimateHours": r[5],
                "updatedAt": r[6],
                "updatedBy": r[7],
                "completedAt": r[8],
            }
            for r in conn.execute(
                "SELECT id, title, status_id, assignee_id, due_date, estimate_hours, updated_at, updated_by, completed_at "
                "FROM tasks WHERE deleted_at IS NULL"
            )
        ]
    return compute_overview(statuses=statuses, users=users, tasks=tasks, now=ctx.now(), time_zone=config.TZ)
