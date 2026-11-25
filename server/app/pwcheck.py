"""已登入狀態下驗證「目前密碼」：失敗計入既有登入失敗限制（避免被盜用的 session 暴力猜密碼）。"""

from __future__ import annotations

import sqlite3

from fastapi import Request
from starlette.concurrency import run_in_threadpool

from .context import Ctx
from .errors import HttpError, bad_request
from .security import login_blocked_for, record_login_attempt, retry_after_seconds, verify_password

WRONG_CURRENT_PASSWORD = "目前密碼不正確"


async def verify_current_password(ctx: Ctx, request: Request, user: sqlite3.Row, password: str) -> None:
    """驗證目前密碼；已被鎖定回 429，密碼錯誤記為該帳號的一次登入失敗並回 400。"""
    from .features.auth import client_ip  # 延遲載入，避免循環 import

    ip = client_ip(request, ctx.settings.trusted_proxy)
    t = ctx.now()
    wait_ms = login_blocked_for(ctx.db, ctx.settings, user["username"], ip, t)
    if wait_ms > 0:
        secs = retry_after_seconds(wait_ms)
        raise HttpError(
            429,
            "TOO_MANY_REQUESTS",
            "嘗試次數過多，請稍後再試",
            {"retryAfterSeconds": secs},
            headers={"Retry-After": str(secs)},
        )
    if not await run_in_threadpool(verify_password, user["password_hash"], password):
        record_login_attempt(ctx.db, user["username"], ip, False, t)
        raise bad_request(WRONG_CURRENT_PASSWORD, {"field": "currentPassword"})
