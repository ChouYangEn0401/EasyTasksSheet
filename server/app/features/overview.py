"""/api/overview：每人進行中任務、未完成預估工時、各狀態數量、逾期、未指派、本週完成（依 completed_at）。
/api/overview/activity：近三週大家大概做了多少事（完成 / 處理件數、有填估時者的預估工時）。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from ..config import config
from ..context import get_ctx
from ._overview_compute import activity_weeks, compute_activity, compute_overview

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
            for r in conn.execute("SELECT id, username, display_name, is_active FROM users WHERE in_overview = 1")
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


@router.get("/activity")
async def get_activity(request: Request):
    """近 N 週（預設 3，範圍 1–4）每位啟用成員大概做了多少事；定義見 compute_activity"""
    ctx = get_ctx(request)
    try:
        weeks = int(request.query_params.get("weeks", "3"))
    except ValueError:
        weeks = 3
    weeks = max(1, min(4, weeks))
    now = ctx.now()
    window = activity_weeks(now, config.TZ, weeks)
    since, until = window[0]["startMs"], window[-1]["endMs"]
    with ctx.db.lock:
        conn = ctx.db.conn
        statuses = [
            {"id": r[0], "category": r[1]} for r in conn.execute("SELECT id, category FROM statuses")
        ]
        users = [
            {"id": r[0], "isActive": bool(r[1]), "inOverview": bool(r[2])}
            for r in conn.execute("SELECT id, is_active, in_overview FROM users")
        ]
        tasks = [
            {
                "id": r[0],
                "title": r[1],
                "statusId": r[2],
                "assigneeId": r[3],
                "estimateHours": r[4],
                "completedAt": r[5],
            }
            for r in conn.execute(
                "SELECT id, title, status_id, assignee_id, estimate_hours, completed_at FROM tasks "
                "WHERE deleted_at IS NULL AND ((completed_at >= ? AND completed_at < ?) OR id IN ("
                "SELECT entity_id FROM changes WHERE entity_type = 'task' AND created_at >= ? AND created_at < ?))",
                (since, until, since, until),
            )
        ]
        changes = [
            {"entityId": r[0], "actorId": r[1], "createdAt": r[2]}
            for r in conn.execute(
                "SELECT entity_id, actor_id, created_at FROM changes WHERE entity_type = 'task' "
                "AND action IN ('create', 'update') AND created_at >= ? AND created_at < ?",
                (since, until),
            )
        ]
    return compute_activity(
        statuses=statuses,
        users=users,
        tasks=tasks,
        changes=changes,
        now=now,
        time_zone=config.TZ,
        weeks=weeks,
        retention_days=config.CHANGES_RETENTION_DAYS,
    )
