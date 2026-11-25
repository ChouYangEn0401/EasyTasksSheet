"""/api/profile：個人設定（任何已登入角色皆可，只能改自己）。

- GET：自己的資料（含最近登入時間）
- PATCH：改顯示名稱；改帳號須帶 currentPassword（失敗計入登入失敗限制）。role 等其他欄位一律拒絕。
改密碼沿用 POST /api/auth/password（需目前密碼、成功後撤銷其他 session）。
"""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, StringConstraints

from ..changes import record_change
from ..context import Ctx, get_ctx
from ..errors import HttpError, bad_request
from ..pwcheck import verify_current_password
from ..validate import read_json
from .admin import USERNAME_TAKEN_MESSAGE, check_username, clear_login_failures

router = APIRouter()


class ProfileUpdateInput(BaseModel):
    # 不可更動的欄位（role、isActive…）傳入即 400，而非默默忽略
    model_config = {"extra": "forbid"}
    displayName: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] = None  # type: ignore[assignment]
    username: Annotated[str, StringConstraints(max_length=64)] = None  # type: ignore[assignment]
    currentPassword: Annotated[str, StringConstraints(min_length=1, max_length=256)] = None  # type: ignore[assignment]


def _profile(ctx: Ctx, user: sqlite3.Row) -> dict[str, Any]:
    last = ctx.db.scalar("SELECT max(created_at) FROM sessions WHERE user_id = ?", (user["id"],))
    return {
        "id": user["id"],
        "username": user["username"],
        "displayName": user["display_name"],
        "role": user["role"],
        "createdAt": user["created_at"],
        "lastLoginAt": last,
    }


def _field_error(message: str, field: str) -> HttpError:
    return bad_request(message, {"field": field})


@router.get("")
async def get_profile(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    return _profile(ctx, ctx.user)


@router.patch("")
async def update_profile(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    data = await read_json(request, ProfileUpdateInput)
    user = ctx.user
    sets = data.model_fields_set

    new_name: str | None = None
    if "username" in sets:
        try:
            candidate = check_username(data.username)
        except ValueError as e:
            raise _field_error(str(e), "username") from None
        if candidate != user["username"]:
            new_name = candidate
    new_display = data.displayName if "displayName" in sets else None
    if new_display is not None and new_display == user["display_name"]:
        new_display = None

    if new_name is not None:
        if new_name == ctx.settings.bootstrap_admin_username:
            raise _field_error(f"新帳號不可設為 {new_name}", "username")
        if "currentPassword" not in sets:
            raise _field_error("變更帳號需輸入目前密碼", "currentPassword")
        await verify_current_password(ctx, request, user, data.currentPassword)
        if ctx.db.one("SELECT id FROM users WHERE username = ? AND id <> ?", (new_name, user["id"])):
            raise HttpError(409, "CONFLICT", USERNAME_TAKEN_MESSAGE, {"field": "username"})

    if new_name is None and new_display is None:
        return _profile(ctx, user)

    t = ctx.now()
    try:
        with ctx.db.tx() as conn:
            if new_name is not None:
                conn.execute("UPDATE users SET username = ?, updated_at = ? WHERE id = ?", (new_name, t, user["id"]))
                # 新帳號名下殘留的登入失敗紀錄不應鎖住自己
                clear_login_failures(conn, new_name)
            if new_display is not None:
                conn.execute(
                    "UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?", (new_display, t, user["id"])
                )
            record_change(conn, "user", user["id"], "update", user["id"], t)
            updated = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    except sqlite3.IntegrityError:
        raise HttpError(409, "CONFLICT", USERNAME_TAKEN_MESSAGE, {"field": "username"}) from None
    return _profile(ctx, updated)
