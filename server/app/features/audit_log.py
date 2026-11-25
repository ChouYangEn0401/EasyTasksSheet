"""/api/admin/audit（稽核紀錄，只讀＋還原）與 /api/tasks/:id/history（任務活動歷史）。

權限（server/app/permissions.py）：
- GET  /api/admin/audit、/api/admin/audit/:id   audit.view（預設 manager 以上）
- POST /api/admin/audit/:id/revert             audit.revert（預設 manager 以上），另需該項目原本的管理權限
- GET  /api/tasks/:id/history                  audit.view_task_history（預設所有成員）
不提供修改或刪除稽核資料的 API；修剪只依保留期限（AUDIT_RETENTION_DAYS）。docs/design/audit-log.md
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from .. import audit, audit_revert
from ..context import Ctx
from ..errors import HttpError, not_found, validation_error
from ..permissions import can, require
from ..validate import parse_id, read_json

router = APIRouter()
task_router = APIRouter()

_INT = re.compile(r"^[0-9]{1,16}$")
_MAX_LIMIT = 200


def _issue(name: str, message: str) -> HttpError:
    return validation_error([{"path": [name], "message": message, "code": "invalid_string"}])


def _int_param(qp: Any, name: str) -> int | None:
    raw = qp.get(name)
    if raw is None or raw == "":
        return None
    if not _INT.fullmatch(raw):
        raise _issue(name, "須為正整數")
    return int(raw)


def _limit(qp: Any, default: int) -> int:
    n = _int_param(qp, "limit")
    if n is None:
        return default
    if n < 1 or n > _MAX_LIMIT:
        raise _issue("limit", f"須介於 1 到 {_MAX_LIMIT}")
    return n


def _parse_query(request: Request) -> audit.AuditQuery:
    qp = request.query_params
    f = audit.AuditQuery(
        from_ts=_int_param(qp, "from"),
        to_ts=_int_param(qp, "to"),
        actor=_int_param(qp, "actor"),
        task_id=_int_param(qp, "taskId"),
        before=_int_param(qp, "before"),
        limit=_limit(qp, 50),
    )
    et = qp.get("entityType") or None
    if et is not None and et not in audit.ENTITY_TYPES:
        raise _issue("entityType", "未知的類型")
    f.entity_type = et
    action = qp.get("action") or None
    if action is not None and action not in audit.ACTIONS:
        raise _issue("action", "未知的動作")
    f.action = action
    q = (qp.get("q") or "").strip()
    if len(q) > 200:
        raise _issue("q", "最多 200 字")
    f.q = q or None
    rv = qp.get("revertable")
    if rv not in (None, "", "true", "false"):
        raise _issue("revertable", "須為 true 或 false")
    f.revertable = None if rv in (None, "") else rv == "true"
    return f


@router.get("")
async def list_audit(request: Request, ctx: Ctx = Depends(require("audit.view"))) -> dict[str, Any]:
    f = _parse_query(request)
    with ctx.db.lock:
        return audit.query_audit(ctx.db.conn, f)


@router.get("/{id}")
async def get_audit(id: str, ctx: Ctx = Depends(require("audit.view"))) -> dict[str, Any]:
    aid = parse_id(id)
    with ctx.db.lock:
        conn = ctx.db.conn
        row = audit.get_entry(conn, aid)
        if row is None:
            raise not_found("找不到這筆稽核紀錄")
        lab = audit.Labeler(conn)
        out = audit.entry_to_dict(lab, row)
        out["revertPreview"] = audit_revert.plan_revert(conn, row, lab).to_dict()
    return out


class RevertInput(BaseModel):
    model_config = {"extra": "forbid"}
    force: bool = False


@router.post("/{id}/revert")
async def revert(request: Request, id: str, ctx: Ctx = Depends(require("audit.revert"))) -> dict[str, Any]:
    aid = parse_id(id)
    raw = await request.body()
    data = await read_json(request, RevertInput) if raw.strip() else RevertInput()
    try:
        return audit_revert.revert_action(
            ctx.db, aid, ctx.user, data.force, now=ctx.now(), can=lambda cap: can(ctx.user, cap, ctx.db)
        )
    except audit_revert.RevertError as e:
        if e.details is None:
            raise HttpError(e.status, e.code, e.message) from None
        raise HttpError(e.status, e.code, e.message, e.details) from None


@task_router.get("/{id}/history")
async def task_history(
    request: Request, id: str, ctx: Ctx = Depends(require("audit.view_task_history"))
) -> dict[str, Any]:
    """該任務的活動歷史（含已刪除的任務；不存在的任務回傳空列表）。
    留言類紀錄不回傳內容（changes 為空，只留摘要句）；完整內容只在 /api/admin/audit（audit.view）可見。"""
    tid = parse_id(id)
    qp = request.query_params
    f = audit.AuditQuery(task_id=tid, before=_int_param(qp, "before"), limit=_limit(qp, 20), redact_content=True)
    with ctx.db.lock:
        return audit.query_audit(ctx.db.conn, f)
