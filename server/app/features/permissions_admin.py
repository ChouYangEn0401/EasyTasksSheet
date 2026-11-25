"""/api/admin/permissions：權限設定（僅 permissions.configure，即 root）。docs/permissions.md

- GET：所有 capability 的中文名稱 / 說明 / 分組、各角色預設值與目前有效值、是否受保護
- PUT：批次設定 manager / user 的 allowed（單一 transaction；與預設相同即移除覆寫）
- POST /reset：還原為預設（可指定單一角色）

寫入後 record_change(entity = permission, id = 0)，前端經 SSE 收到後重抓 /api/auth/me；
並立即使記憶體中的覆寫快取失效（permissions.invalidate）。
"""

from __future__ import annotations

import sqlite3
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from .. import audit_events
from ..changes import record_change
from ..context import Ctx
from ..db import Database
from ..errors import bad_request
from ..permissions import (
    CAPABILITIES,
    CAPABILITY_GROUPS,
    CONFIGURABLE_ROLES,
    PROTECTED_CAPABILITIES,
    ROLE_LABELS,
    ROLES,
    capability_info,
    effective_role_can,
    invalidate,
    load_overrides,
    require,
    role_can,
)
from ..validate import read_json

router = APIRouter()

ROOT_FIXED_MESSAGE = "超級管理員永遠擁有全部權限，無法調整"


class PermissionChange(BaseModel):
    model_config = {"extra": "forbid"}
    role: str
    capability: str
    allowed: bool


class PermissionsUpdateInput(BaseModel):
    model_config = {"extra": "forbid"}
    changes: list[PermissionChange] = Field(max_length=500)


class PermissionsResetInput(BaseModel):
    model_config = {"extra": "forbid"}
    role: Literal["manager", "user"] | None = None


def permission_matrix(db: Database) -> dict[str, Any]:
    """權限設定頁的完整矩陣（capability 依 CAPABILITIES 順序；分組只列出有項目者）"""
    overrides = load_overrides(db)
    caps = []
    for cap in CAPABILITIES:
        caps.append(
            {
                "key": cap,
                **capability_info(cap),
                "protected": cap in PROTECTED_CAPABILITIES,
                "defaults": {r: role_can(r, cap) for r in ROLES},
                "effective": {r: effective_role_can(r, cap, db) for r in ROLES},
                "overridden": {r: (r, cap) in overrides for r in CONFIGURABLE_ROLES},
            }
        )
    used = {c["group"] for c in caps}
    last = db.one(
        "SELECT rp.updated_at, rp.updated_by, u.display_name FROM role_permissions rp "
        "LEFT JOIN users u ON u.id = rp.updated_by ORDER BY rp.updated_at DESC LIMIT 1"
    )
    return {
        "roles": [{"role": r, "label": ROLE_LABELS[r], "configurable": r in CONFIGURABLE_ROLES} for r in ROLES],
        "groups": [{"key": k, "label": label} for k, label in CAPABILITY_GROUPS if k in used],
        "capabilities": caps,
        "lastUpdated": (
            None
            if last is None
            else {"at": last["updated_at"], "userId": last["updated_by"], "displayName": last["display_name"]}
        ),
    }


def _validate(change: PermissionChange) -> None:
    if change.role == "root":
        raise bad_request(ROOT_FIXED_MESSAGE, {"role": change.role, "capability": change.capability})
    if change.role not in CONFIGURABLE_ROLES:
        raise bad_request(f"未知的角色：{change.role}", {"role": change.role})
    if change.capability not in CAPABILITIES:
        raise bad_request(f"未知的權限：{change.capability}", {"capability": change.capability})
    if change.capability in PROTECTED_CAPABILITIES and change.allowed:
        label = capability_info(change.capability)["label"]
        raise bad_request(
            f"「{label}」僅限超級管理員，無法授予{ROLE_LABELS[change.role]}",
            {"role": change.role, "capability": change.capability},
        )


def _write(conn: sqlite3.Connection, change: PermissionChange, actor_id: int, t: int) -> None:
    """與預設相同 → 刪除覆寫；不同 → upsert"""
    if change.allowed == role_can(change.role, change.capability):
        conn.execute(
            "DELETE FROM role_permissions WHERE role = ? AND capability = ?", (change.role, change.capability)
        )
    else:
        conn.execute(
            "INSERT INTO role_permissions (role, capability, allowed, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (role, capability) DO UPDATE SET allowed = excluded.allowed, "
            "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
            (change.role, change.capability, int(change.allowed), t, actor_id),
        )


_configure = Depends(require("permissions.configure"))


@router.get("")
async def get_permissions(ctx: Ctx = _configure) -> dict[str, Any]:
    return permission_matrix(ctx.db)


@router.put("")
async def update_permissions(request: Request, ctx: Ctx = _configure) -> dict[str, Any]:
    data = await read_json(request, PermissionsUpdateInput)
    for change in data.changes:
        _validate(change)
    if data.changes:
        t = ctx.now()
        try:
            with ctx.db.tx() as conn:
                before = audit_events.permission_cells(conn)
                for change in data.changes:
                    _write(conn, change, ctx.user["id"], t)
                record_change(conn, "permission", 0, "update", ctx.user["id"], t)
                audit_events.permissions_changed(conn, ctx.user, before, t)
        finally:
            invalidate(ctx.db)
    return permission_matrix(ctx.db)


@router.post("/reset")
async def reset_permissions(request: Request, ctx: Ctx = _configure) -> dict[str, Any]:
    raw = await request.body()
    data = await read_json(request, PermissionsResetInput) if raw.strip() else PermissionsResetInput()
    t = ctx.now()
    try:
        with ctx.db.tx() as conn:
            before = audit_events.permission_cells(conn)
            if data.role is None:
                conn.execute("DELETE FROM role_permissions")
            else:
                conn.execute("DELETE FROM role_permissions WHERE role = ?", (data.role,))
            record_change(conn, "permission", 0, "update", ctx.user["id"], t)
            audit_events.permissions_changed(conn, ctx.user, before, t, reset=data.role or "all")
    finally:
        invalidate(ctx.db)
    return permission_matrix(ctx.db)
