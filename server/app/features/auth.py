"""/api/auth：login、logout 為公開路由，其餘經全域 session 檢查。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from ..changes import record_change
from ..context import Ctx, get_ctx
from ..errors import HttpError, bad_request, unauthorized
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
from ..validate import read_json
from .users import to_public_user

router = APIRouter()

LOGIN_FAILED = "帳號或密碼不正確"


def client_ip(request: Request) -> str:
    """用戶端 IP：反向代理（Caddy）會覆寫 X-Forwarded-For，取第一段；直連時取 socket 位址"""
    fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if fwd:
        return fwd
    return request.client.host if request.client else "unknown"


def me(ctx: Ctx, user: Any, session: SessionRow) -> dict[str, Any]:
    return {"user": to_public_user(user), "session": session_info(session, ctx.settings)}


@router.post("/login")
async def login(request: Request, response: Response) -> dict[str, Any]:
    ctx = get_ctx(request)
    data = await read_json(request, LoginInput)
    ip = client_ip(request)
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


@router.post("/password")
async def change_password(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    data = await read_json(request, ChangePasswordInput)
    user = ctx.user
    if not await run_in_threadpool(verify_password, user["password_hash"], data.currentPassword):
        raise bad_request("目前密碼不正確")
    if data.newPassword == data.currentPassword:
        raise bad_request("新密碼不可與目前密碼相同")
    password_hash = await run_in_threadpool(hash_password, data.newPassword)
    t = ctx.now()
    with ctx.db.tx() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?",
            (password_hash, t, user["id"]),
        )
        revoke_other_sessions(conn, user["id"], ctx.session.id)
        record_change(conn, "user", user["id"], "update", user["id"], t)
        updated = conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone()
    return me(ctx, updated, ctx.session)
