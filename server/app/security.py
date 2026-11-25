"""密碼雜湊、session、登入失敗限制、CSRF 檢查。"""

from __future__ import annotations

import base64
import hashlib
import math
import re
import secrets
import sqlite3
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error, InvalidHashError
from starlette.requests import Request
from starlette.responses import Response

from .db import Database
from .errors import forbidden, unauthorized
from .settings import AuthSettings
from .timeutil import DAY_MS

SESSION_COOKIE = "sid"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
#: 非 GET 但「不算使用者操作」、不刷新閒置計時的路徑（presence 回報；見 features/presence.py）
IDLE_EXEMPT_PATHS = frozenset({"/api/presence"})

# ── 密碼（argon2id；參數同 @node-rs/argon2 預設：m=19456 KiB, t=2, p=1，可驗證既有雜湊）──
_hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1, hash_len=32, salt_len=16)


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (Argon2Error, InvalidHashError, ValueError):
        return False


_dummy_hash: str | None = None


def dummy_hash() -> str:
    """帳號不存在時用來比對的假雜湊，使回應時間與帳號存在時相近"""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hash_password(secrets.token_hex(16))
    return _dummy_hash


# ── session ──


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class SessionRow:
    id: str
    user_id: int
    created_at: int
    expires_at: int
    last_active_at: int


def create_session(db: Database, settings: AuthSettings, user_id: int, t: int, response: Response) -> SessionRow:
    """建立 session 並設定 cookie；DB 只存 token 的 SHA-256"""
    token = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    row = SessionRow(hash_token(token), user_id, t, t + settings.session_max_ms, t)
    with db.tx() as conn:
        # 順手清掉此人已過期的 session
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?", (user_id, t))
        conn.execute(
            "INSERT INTO sessions (id, user_id, created_at, expires_at, last_active_at) VALUES (?, ?, ?, ?, ?)",
            (row.id, row.user_id, row.created_at, row.expires_at, row.last_active_at),
        )
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_max_ms // 1000,
        path="/",
        httponly=True,
        samesite="Lax",  # type: ignore[arg-type]
        secure=settings.cookie_secure,
    )
    return row


def destroy_session(db: Database, settings: AuthSettings, request: Request, response: Response) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        db.execute("DELETE FROM sessions WHERE id = ?", (hash_token(token),))
    response.delete_cookie(SESSION_COOKIE, path="/", secure=settings.cookie_secure)


def revoke_other_sessions(conn: sqlite3.Connection, user_id: int, keep_id: str) -> None:
    conn.execute("DELETE FROM sessions WHERE user_id = ? AND id <> ?", (user_id, keep_id))


def session_info(session: SessionRow, settings: AuthSettings) -> dict[str, Any]:
    return {
        "expiresAt": session.expires_at,
        "lastActiveAt": session.last_active_at,
        "idleTimeoutMs": settings.idle_timeout_ms,
    }


def require_session(db: Database, settings: AuthSettings, request: Request, t: int) -> tuple[sqlite3.Row, SessionRow]:
    """需要有效 session。絕對期限與閒置逾時皆在此判斷；只有非 GET 請求刷新 last_active_at
    （IDLE_EXEMPT_PATHS 例外：presence 回報不算操作）。"""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise unauthorized()
    sid = hash_token(token)
    with db.tx() as conn:
        s = conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
        if s is None:
            raise_after = unauthorized()
        elif t >= s["expires_at"] or t - s["last_active_at"] >= settings.idle_timeout_ms:
            conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
            raise_after = unauthorized("登入已逾時，請重新登入")
        else:
            user = conn.execute("SELECT * FROM users WHERE id = ?", (s["user_id"],)).fetchone()
            if user is None or not user["is_active"]:
                conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
                raise_after = unauthorized()
            else:
                session = SessionRow(s["id"], s["user_id"], s["created_at"], s["expires_at"], s["last_active_at"])
                if request.method not in SAFE_METHODS and request.url.path not in IDLE_EXEMPT_PATHS:
                    conn.execute("UPDATE sessions SET last_active_at = ? WHERE id = ?", (t, sid))
                    session.last_active_at = t
                return user, session
    # 在 transaction 外丟出，確保刪除已 commit
    raise raise_after


# ── CSRF ──


#: 允許 multipart/form-data 的上傳端點（只限 POST）。multipart 是跨站表單也能送出的「簡單請求」，
#: 因此這些端點「必須」帶 Origin 且同源（不像 JSON 端點只在有帶時檢查）
MULTIPART_UPLOAD_PATHS = re.compile(r"^/api/eng/issues/[0-9]+/attachments$")


def csrf_check(request: Request, settings: AuthSettings) -> None:
    """修改類請求若帶 Origin 必須同源；POST / PUT / PATCH 必須是 application/json
    （例外：MULTIPART_UPLOAD_PATHS 的 POST 可用 multipart/form-data，但必須帶同源 Origin）。"""
    if request.method in SAFE_METHODS:
        return
    origin = request.headers.get("origin")
    if origin and not _is_allowed_origin(origin, request, settings):
        raise forbidden("來源不被允許")
    content_type = request.headers.get("content-type", "").lower()
    if (
        request.method == "POST"
        and content_type.startswith("multipart/form-data")
        and MULTIPART_UPLOAD_PATHS.match(request.url.path)
    ):
        if not origin:
            raise forbidden("上傳檔案須帶同源的 Origin 標頭")
        return
    if request.method != "DELETE" and not content_type.startswith("application/json"):
        raise forbidden("Content-Type 須為 application/json")


def _is_allowed_origin(origin: str, request: Request, settings: AuthSettings) -> bool:
    if settings.app_origin:
        return origin == settings.app_origin.rstrip("/")
    try:
        parts = urlsplit(origin)
        if not parts.scheme or not parts.netloc:
            return False
        host = request.headers.get("host") or request.url.netloc
        return _normalize_host(parts.scheme, parts.netloc) == _normalize_host(request.url.scheme, host)
    except ValueError:
        return False


def _normalize_host(scheme: str, netloc: str) -> str:
    """WHATWG URL 的 host 會省略預設埠"""
    netloc = netloc.lower()
    default = {"http": ":80", "https": ":443"}.get(scheme.lower())
    if default and netloc.endswith(default):
        netloc = netloc[: -len(default)]
    return netloc


# ── 登入失敗限制 ──


def login_blocked_for(db: Database, s: AuthSettings, username: str, ip: str, t: int) -> int:
    """回傳仍需等待的毫秒數（0 = 可嘗試）。
    - 同帳號：最近一次成功之後、在 window 內累積 maxFailsPerUser 次失敗 → 自最後一次失敗起鎖 lockMs。
    - 同 IP：window 內失敗達 maxFailsPerIp 次 → 暫拒至最舊那筆滑出 window。
    """
    recent = db.all(
        "SELECT success, created_at FROM login_attempts WHERE username = ? AND created_at > ? "
        "ORDER BY created_at DESC, id DESC LIMIT ?",
        (username, t - s.login_window_ms - s.login_lock_ms, s.login_max_fails_per_user),
    )
    if len(recent) == s.login_max_fails_per_user and all(not r["success"] for r in recent):
        newest = recent[0]["created_at"]
        oldest = recent[-1]["created_at"]
        if newest - oldest < s.login_window_ms and t < newest + s.login_lock_ms:
            return newest + s.login_lock_ms - t

    ip_fails = db.all(
        "SELECT created_at FROM login_attempts WHERE ip = ? AND success = 0 AND created_at > ? "
        "ORDER BY created_at DESC LIMIT ?",
        (ip, t - s.login_window_ms, s.login_max_fails_per_ip),
    )
    if len(ip_fails) >= s.login_max_fails_per_ip:
        return ip_fails[-1]["created_at"] + s.login_window_ms - t
    return 0


def record_login_attempt(db: Database, username: str, ip: str, success: bool, t: int) -> None:
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO login_attempts (username, ip, success, created_at) VALUES (?, ?, ?, ?)",
            (username, ip, 1 if success else 0, t),
        )
        # 清除一天前的紀錄，避免表無限成長
        conn.execute("DELETE FROM login_attempts WHERE created_at < ?", (t - DAY_MS,))


def retry_after_seconds(wait_ms: int) -> int:
    return math.ceil(wait_ms / 1000)
