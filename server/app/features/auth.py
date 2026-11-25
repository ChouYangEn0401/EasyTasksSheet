"""/api/auth：login、logout 為公開路由，其餘經全域 session 檢查。"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from ..changes import record_change
from ..context import Ctx, get_ctx
from ..errors import HttpError, bad_request, unauthorized
from ..permissions import capabilities_of
from ..schemas import ChangePasswordInput, LoginInput
from ..security import (
    SessionRow,
    create_session,
    destroy_session,
    dummy_hash,
    hash_password,
    login_blocked_for,
    record_login_attempt,
    retry_after_seconds,
    revoke_other_sessions,
    session_info,
    verify_password,
)
from ..pwcheck import verify_current_password
from ..validate import read_json
from .admin import USERNAME_TAKEN_MESSAGE, check_username, clear_login_failures
from .users import DEFAULT_ADMIN_PASSWORD, to_public_user

router = APIRouter()

LOGIN_FAILED = "帳號或密碼不正確"


def client_ip(request: Request, trusted_proxy: bool) -> str:
    """用戶端 IP（登入失敗的 IP 限制用）。

    - trusted_proxy=False：一律用 socket 位址，忽略 X-Forwarded-For（直連時標頭可任意偽造）。
    - trusted_proxy=True：視為單層反向代理，取 X-Forwarded-For「最右邊」一段——那是代理自己
      附加的對端位址；左側各段可能是用戶端偽造的前綴，不採用。
    """
    socket_ip = request.client.host if request.client else "unknown"
    if not trusted_proxy:
        return socket_ip
    values = ",".join(request.headers.getlist("x-forwarded-for"))
    parts = [p.strip() for p in values.split(",") if p.strip()]
    return parts[-1] if parts else socket_ip


def must_change_username(ctx: Ctx, user: Any) -> bool:
    """預設管理員（ADMIN_USERNAME）尚未完成首次重設：須同時設定新帳號與新密碼"""
    return bool(user["must_change_password"]) and user["username"] == ctx.settings.bootstrap_admin_username


def me(ctx: Ctx, user: Any, session: SessionRow) -> dict[str, Any]:
    return {
        "user": to_public_user(user),
        # 前端依此顯示 / 隱藏功能（後端仍逐一以 permissions.require 強制）
        # 有效矩陣（預設 + 權限設定的覆寫）
        "capabilities": capabilities_of(user, ctx.db),
        "session": session_info(session, ctx.settings),
        "mustChangeUsername": must_change_username(ctx, user),
    }


@router.post("/login")
async def login(request: Request, response: Response) -> dict[str, Any]:
    ctx = get_ctx(request)
    data = await read_json(request, LoginInput)
    ip = client_ip(request, ctx.settings.trusted_proxy)
    t = ctx.now()
    wait_ms = login_blocked_for(ctx.db, ctx.settings, data.username, ip, t)
    if wait_ms > 0:
        secs = retry_after_seconds(wait_ms)
        raise HttpError(
            429,
            "TOO_MANY_REQUESTS",
            "嘗試次數過多，請稍後再試",
            {"retryAfterSeconds": secs},
            headers={"Retry-After": str(secs)},
        )
    user = ctx.db.one("SELECT * FROM users WHERE username = ?", (data.username,))
    # 帳號不存在時仍做一次雜湊比對，避免以回應時間推測帳號是否存在
    stored = user["password_hash"] if user else await run_in_threadpool(dummy_hash)
    ok = await run_in_threadpool(verify_password, stored, data.password)
    success = ok and user is not None and bool(user["is_active"])
    record_login_attempt(ctx.db, data.username, ip, success, t)
    if not success:
        raise unauthorized(LOGIN_FAILED)

    session = create_session(ctx.db, ctx.settings, user["id"], t, response)
    return me(ctx, user, session)


@router.post("/logout")
async def logout(request: Request, response: Response) -> dict[str, Any]:
    ctx = get_ctx(request)
    destroy_session(ctx.db, ctx.settings, request, response)
    return {"ok": True}


@router.get("/me")
async def get_me(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    return me(ctx, ctx.user, ctx.session)


@router.post("/heartbeat")
async def heartbeat(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    return session_info(ctx.session, ctx.settings)


def _field_error(message: str, field: str) -> HttpError:
    return bad_request(message, {"field": field})


def _new_username(ctx: Ctx, user: Any, raw: str | None) -> str | None:
    """預設管理員首次重設時檢查並回傳新帳號；其他情況不得變更帳號（回傳 None）"""
    if not must_change_username(ctx, user):
        if raw is not None:
            raise _field_error("只有預設管理員首次登入時可以變更帳號", "username")
        return None
    if raw is None or not raw.strip():
        raise _field_error("請設定新帳號", "username")
    try:
        name = check_username(raw)
    except ValueError as e:
        raise _field_error(str(e), "username") from None
    if name == ctx.settings.bootstrap_admin_username:
        raise _field_error(f"新帳號不可為預設的 {name}", "username")
    if ctx.db.one("SELECT id FROM users WHERE username = ? AND id <> ?", (name, user["id"])):
        raise HttpError(409, "CONFLICT", USERNAME_TAKEN_MESSAGE, {"field": "username"})
    return name


@router.post("/password")
async def change_password(request: Request) -> dict[str, Any]:
    """改密碼；預設管理員（ADMIN_USERNAME）首次登入時須一併以 username 設定新帳號。"""
    ctx = get_ctx(request)
    data = await read_json(request, ChangePasswordInput)
    user = ctx.user
    await verify_current_password(ctx, request, user, data.currentPassword)
    new_username = _new_username(ctx, user, data.username)
    if data.newPassword == data.currentPassword:
        raise _field_error("新密碼不可與目前密碼相同", "newPassword")
    if data.newPassword == DEFAULT_ADMIN_PASSWORD:
        raise _field_error("不可使用預設密碼，請設定其他密碼", "newPassword")
    password_hash = await run_in_threadpool(hash_password, data.newPassword)
    t = ctx.now()
    try:
        with ctx.db.tx() as conn:
            if new_username is not None:
                conn.execute("UPDATE users SET username = ? WHERE id = ?", (new_username, user["id"]))
                # 同名帳號先前的登入失敗紀錄不延續
                clear_login_failures(conn, new_username)
            conn.execute(
                "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?",
                (password_hash, t, user["id"]),
            )
            revoke_other_sessions(conn, user["id"], ctx.session.id)
            record_change(conn, "user", user["id"], "update", user["id"], t)
            updated = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    except sqlite3.IntegrityError:
        # 並行建立同帳號：由 DB unique 約束擋下
        raise HttpError(409, "CONFLICT", USERNAME_TAKEN_MESSAGE, {"field": "username"}) from None
    return me(ctx, updated, ctx.session)
