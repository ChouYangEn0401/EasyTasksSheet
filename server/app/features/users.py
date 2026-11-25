"""/api/users：成員列表（含停用者，由前端決定是否顯示）；以及帳號建立 / 預設管理員。"""

from __future__ import annotations

import sqlite3
from typing import Any, Callable

from fastapi import APIRouter, Request

from ..changes import record_change
from ..context import get_ctx
from ..db import Database, now_ms
from ..security import hash_password

router = APIRouter()


def to_public_user(u: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": u["id"],
        "username": u["username"],
        "displayName": u["display_name"],
        "role": u["role"],
        "isActive": bool(u["is_active"]),
        "mustChangePassword": bool(u["must_change_password"]),
        "createdAt": u["created_at"],
        "updatedAt": u["updated_at"],
    }


@router.get("")
async def list_users(request: Request) -> list[dict[str, Any]]:
    ctx = get_ctx(request)
    return [to_public_user(u) for u in ctx.db.all("SELECT * FROM users ORDER BY id")]


def create_user(
    db: Database,
    *,
    username: str,
    password: str,
    display_name: str | None = None,
    role: str = "user",
    must_change_password: bool = True,
    actor_id: int | None = None,
    now: int | None = None,
) -> sqlite3.Row:
    """建立帳號（雜湊密碼、記錄變更）；帳號重複時由 DB unique 約束拋 sqlite3.IntegrityError"""
    password_hash = hash_password(password)
    t = now_ms() if now is None else now
    with db.tx() as conn:
        cur = conn.execute(
            "INSERT INTO users (username, display_name, password_hash, role, must_change_password, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (username, display_name or username, password_hash, role, 1 if must_change_password else 0, t, t),
        )
        uid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "user", uid, "create", actor_id, t)
        return conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()


#: 預設管理員帳密（可由 ADMIN_USERNAME / ADMIN_PASSWORD 覆寫）
DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "password"


def ensure_admin(
    db: Database,
    username: str | None = None,
    password: str | None = None,
    log: Callable[[str], None] = print,
) -> sqlite3.Row | None:
    """首次啟動（尚無任何帳號）時建立預設管理員（角色 root；預設 admin / password，可由
    ADMIN_USERNAME / ADMIN_PASSWORD 覆寫）。首次登入強制重設帳號與密碼。"""
    if db.scalar("SELECT count(*) FROM users") > 0:
        return None
    name = username or DEFAULT_ADMIN_USERNAME
    pw = password or DEFAULT_ADMIN_PASSWORD
    user = create_user(db, username=name, display_name="管理員", password=pw, role="root")
    if password and password != DEFAULT_ADMIN_PASSWORD:
        log(f"[auth] 已建立預設管理員 {name}（密碼取自 ADMIN_PASSWORD），首次登入須重設帳號與密碼")
    else:
        log(f"[auth] 已建立預設管理員 {name} / {DEFAULT_ADMIN_PASSWORD}，首次登入須重設帳號與密碼")
    return user
