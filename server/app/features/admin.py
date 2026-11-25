"""/api/admin：成員管理（行為同 src/server/features/admin/）。

全部端點需 members.manage（manager 以上，其餘 403）；操作 root 帳號或指派 root 需 roles.assign_root
（僅 root）。權限定義見 server/app/permissions.py。所有寫入皆 record_change(entity = user)。
臨時密碼由後端產生，只在新增 / 重設密碼的回應中回傳一次。
"""

from __future__ import annotations

import re
import secrets
import sqlite3
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import AfterValidator, BaseModel, StringConstraints
from starlette.concurrency import run_in_threadpool

from .. import audit_events
from ..changes import record_change
from ..context import Ctx
from ..db import Database
from ..errors import HttpError, conflict, not_found
from ..permissions import check, require
from ..security import hash_password, login_blocked_for
from ..settings import AuthSettings
from ..stub import ALL_METHODS
from ..validate import parse_id, present, read_json
from .users import create_user, to_public_user

router = APIRouter()

NOT_FOUND = "找不到此成員"
USERNAME_TAKEN_MESSAGE = "此帳號已被使用"
LAST_ROOT_MESSAGE = "至少需保留一位超級管理員"

#: 帳號：3–32 個小寫英文字母、數字或 . _ -，以字母或數字開頭（輸入先 trim、轉小寫）
_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")


def check_username(v: str) -> str:
    """帳號格式檢查（trim、轉小寫）；不符時拋 ValueError（訊息可直接顯示）"""
    v = v.strip().lower()
    if not v:
        raise ValueError("請輸入帳號")
    if not _USERNAME_RE.fullmatch(v):
        raise ValueError("帳號須為 3–32 個英文字母、數字或 . _ -，且以字母或數字開頭")
    return v


AdminUsername = Annotated[str, AfterValidator(check_username)]
DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Role = Literal["root", "manager", "user"]


class AdminUserCreateInput(BaseModel):
    model_config = {"extra": "ignore"}
    username: AdminUsername
    displayName: DisplayName
    role: Role = "user"
    inOverview: bool | None = None  # 未指定：root 預設 false，其餘 true


class AdminUserUpdateInput(BaseModel):
    """只送改動欄位；帳號建立後不可修改（未知欄位 400）"""

    model_config = {"extra": "forbid"}
    displayName: DisplayName = None  # type: ignore[assignment]
    role: Role = None  # type: ignore[assignment]
    isActive: bool = None  # type: ignore[assignment]
    inOverview: bool = None  # type: ignore[assignment]


# ── service ──

#: 臨時密碼字元集：去除易混淆的 0 O 1 l I
TEMP_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_temp_password() -> str:
    """3 組 4 碼，以 - 連接（如 k7Qm-2xRt-9vLp），約 70 bits 熵"""
    return "-".join("".join(secrets.choice(TEMP_ALPHABET) for _ in range(4)) for _ in range(3))


#: 只看「同帳號」鎖定：以不存在的 IP 查詢，讓 IP 條件永遠不成立
_NO_IP = "\u0000admin-lock-check"


def locked_until(db: Database, settings: AuthSettings, username: str, t: int) -> int | None:
    wait = login_blocked_for(db, settings, username, _NO_IP, t)
    return t + wait if wait > 0 else None


def to_admin_user(ctx: Ctx, u: sqlite3.Row, t: int | None = None) -> dict[str, Any]:
    t = ctx.now() if t is None else t
    return {**to_public_user(u), "lockedUntil": locked_until(ctx.db, ctx.settings, u["username"], t)}


def clear_login_failures(conn: sqlite3.Connection, username: str) -> None:
    conn.execute("DELETE FROM login_attempts WHERE username = ? AND success = 0", (username,))


def revoke_sessions(conn: sqlite3.Connection, user_id: int, keep_id: str | None = None) -> None:
    if keep_id:
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND id <> ?", (user_id, keep_id))
    else:
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


def is_last_active_root(target: dict[str, Any], all_users: list[dict[str, Any]]) -> bool:
    """目標是否為唯一啟用中的 root（同 src/shared/admin.ts isLastActiveRoot）"""
    if target["role"] != "root" or not target["isActive"]:
        return False
    return not any(u["id"] != target["id"] and u["role"] == "root" and u["isActive"] for u in all_users)


def assert_keeps_root(conn: sqlite3.Connection, target: sqlite3.Row, patch: dict[str, Any]) -> None:
    """停用或降級前檢查：不可使系統沒有啟用中的 root"""
    demoting = "role" in patch and patch["role"] != "root"
    disabling = patch.get("isActive") is False
    if not demoting and not disabling:
        return
    rows = conn.execute("SELECT id, role, is_active FROM users").fetchall()
    all_users = [{"id": r["id"], "role": r["role"], "isActive": bool(r["is_active"])} for r in rows]
    me = {"id": target["id"], "role": target["role"], "isActive": bool(target["is_active"])}
    if is_last_active_root(me, all_users):
        raise conflict(LAST_ROOT_MESSAGE)


def assert_can_touch(ctx: Ctx, target_role: str | None = None, new_role: str | None = None) -> None:
    """操作 root 帳號、或把任何人設為 root，皆需 roles.assign_root（manager 只能在 user ↔ manager 間調整）"""
    if "root" in (target_role, new_role):
        check(ctx, "roles.assign_root")


# ── routes ──

_members = Depends(require("members.manage"))


def _load_target(ctx: Ctx, id: str) -> sqlite3.Row:
    row = ctx.db.one("SELECT * FROM users WHERE id = ?", (parse_id(id),))
    if row is None:
        raise not_found(NOT_FOUND)
    return row


def _username_taken() -> HttpError:
    return HttpError(409, "CONFLICT", USERNAME_TAKEN_MESSAGE, {"field": "username"})


@router.get("/users")
async def list_admin_users(ctx: Ctx = _members) -> list[dict[str, Any]]:
    t = ctx.now()
    return [to_admin_user(ctx, u, t) for u in ctx.db.all("SELECT * FROM users ORDER BY id")]


@router.post("/users")
async def create_admin_user(request: Request, ctx: Ctx = _members):
    data = await read_json(request, AdminUserCreateInput)
    assert_can_touch(ctx, new_role=data.role)
    if ctx.db.one("SELECT id FROM users WHERE username = ?", (data.username,)):
        raise _username_taken()
    temp = generate_temp_password()
    t = ctx.now()
    try:
        row = await run_in_threadpool(
            lambda: create_user(
                ctx.db,
                username=data.username,
                display_name=data.displayName,
                role=data.role,
                in_overview=data.inOverview,
                password=temp,
                must_change_password=True,
                actor_id=ctx.user["id"],
                now=t,
            )
        )
    except sqlite3.IntegrityError:
        # 並行建立同帳號：由 DB unique 約束擋下
        raise _username_taken() from None
    # 同名帳號先前的登入失敗紀錄不延續到新帳號
    with ctx.db.tx() as conn:
        clear_login_failures(conn, row["username"])
        audit_events.user_created(conn, ctx.user, row, t)
    return JSONResponse({"user": to_admin_user(ctx, row), "tempPassword": temp}, status_code=201)


_UPDATE_COLUMNS = {"displayName": "display_name", "role": "role", "isActive": "is_active", "inOverview": "in_overview"}


@router.patch("/users/{id}")
async def update_admin_user(request: Request, id: str, ctx: Ctx = _members):
    target = _load_target(ctx, id)
    data = await read_json(request, AdminUserUpdateInput)
    assert_can_touch(ctx, target["role"], present(data).get("role"))
    current = {
        "displayName": target["display_name"],
        "role": target["role"],
        "isActive": bool(target["is_active"]),
        "inOverview": bool(target["in_overview"]),
    }
    given = present(data)
    # 改為 root 時（未明確指定）一併不列入總覽統計；改為非 root 不自動變更
    if given.get("role") == "root" and "inOverview" not in given:
        given["inOverview"] = False
    patch = {k: v for k, v in given.items() if v != current[k]}
    if not patch:
        return to_admin_user(ctx, target)
    t = ctx.now()
    with ctx.db.tx() as conn:
        assert_keeps_root(conn, target, patch)
        sets: dict[str, Any] = {_UPDATE_COLUMNS[k]: (int(v) if k in ("isActive", "inOverview") else v) for k, v in patch.items()}
        sets["updated_at"] = t
        conn.execute(
            f"UPDATE users SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?", (*sets.values(), target["id"])
        )
        # 停用：既有 session 立即失效（含停用自己）
        if patch.get("isActive") is False:
            revoke_sessions(conn, target["id"])
        record_change(conn, "user", target["id"], "update", ctx.user["id"], t)
        row = conn.execute("SELECT * FROM users WHERE id = ?", (target["id"],)).fetchone()
        audit_events.user_updated(conn, ctx.user, target, row, t)
    return to_admin_user(ctx, row)


@router.post("/users/{id}/reset-password")
async def reset_password(id: str, ctx: Ctx = _members):
    target = _load_target(ctx, id)
    assert_can_touch(ctx, target["role"])
    if not target["is_active"]:
        raise conflict("已停用的成員無法重設密碼，請先啟用")
    temp = generate_temp_password()
    password_hash = await run_in_threadpool(hash_password, temp)
    t = ctx.now()
    with ctx.db.tx() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?",
            (password_hash, t, target["id"]),
        )
        # 原密碼立即失效：該成員其他裝置的登入一併登出（重設自己時保留目前這個 session）
        revoke_sessions(conn, target["id"], ctx.session.id if target["id"] == ctx.user["id"] else None)
        clear_login_failures(conn, target["username"])
        record_change(conn, "user", target["id"], "update", ctx.user["id"], t)
        row = conn.execute("SELECT * FROM users WHERE id = ?", (target["id"],)).fetchone()
        audit_events.user_password_reset(conn, ctx.user, row, t)
    return {"user": to_admin_user(ctx, row), "tempPassword": temp}


@router.post("/users/{id}/unlock")
async def unlock_user(id: str, ctx: Ctx = _members):
    target = _load_target(ctx, id)
    assert_can_touch(ctx, target["role"])
    with ctx.db.tx() as conn:
        clear_login_failures(conn, target["username"])
        t = ctx.now()
        record_change(conn, "user", target["id"], "update", ctx.user["id"], t)
        row = conn.execute("SELECT * FROM users WHERE id = ?", (target["id"],)).fetchone()
        audit_events.user_unlocked(conn, ctx.user, row, t)
    return to_admin_user(ctx, row)


async def _fallback(ctx: Ctx = _members) -> None:
    """其餘 /api/admin/* 路徑：無 members.manage 一律 403，有則 404"""
    raise not_found("找不到此 API")


router.add_api_route("", _fallback, methods=ALL_METHODS, include_in_schema=False)
router.add_api_route("/{rest:path}", _fallback, methods=ALL_METHODS, include_in_schema=False)
