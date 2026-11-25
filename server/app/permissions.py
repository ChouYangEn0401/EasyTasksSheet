"""角色與權限（唯一來源；對照表見 docs/permissions.md）。

三層角色：root（超級管理員）> manager（管理者）> user（成員）；高層角色擁有低層的全部權限。
- `can(user, capability)`：判斷登入者是否具備某權限
- `require(capability)`：FastAPI dependency，不具備時 403（訊息一致）
- `capabilities_of(user)`：/api/auth/me 與登入回應的 `capabilities`（前端據此顯示 / 隱藏）
"""

from __future__ import annotations

from typing import Any, Literal, Mapping

from fastapi import Request

from .context import Ctx, get_ctx
from .errors import HttpError, forbidden

Role = Literal["root", "manager", "user"]
ROLES: tuple[Role, ...] = ("root", "manager", "user")
#: 階層：數字越大權限越高
ROLE_RANK: dict[str, int] = {"user": 1, "manager": 2, "root": 3}
ROLE_LABELS: dict[str, str] = {"root": "超級管理員", "manager": "管理者", "user": "成員"}

#: 每個權限所需的最低角色
CAPABILITIES: dict[str, Role] = {
    # ── user：一般協作（全員）──
    "tasks.edit": "user",  # 任務 CRUD（全員可互改，含軟刪除）
    "feedback.edit": "user",  # 回饋
    "personal.edit": "user",  # 個人清單
    "eng.edit": "user",  # 問題與 worktree 紀錄（含 GitHub 同步 / 匯入 / 建立 issue）
    "projects.create": "user",  # 建立專案
    "properties.edit": "user",  # 自訂欄位（property）
    "profile.edit": "user",  # 自己的個人資料與密碼
    # ── manager（danger-command）──
    "members.manage": "manager",  # 成員新增 / 停用 / 啟用 / 重設密碼 / 解鎖 / 編輯（角色限 user ↔ manager）
    "statuses.manage": "manager",  # 狀態新增 / 改名 / 改色 / 排序 / 刪除
    "projects.manage": "manager",  # 專案改名 / 改色 / 排序 / 封存
    "github.manage": "manager",  # GitHub 連動（專案 ↔ repo 設定）
    "data.export_json": "manager",  # JSON 匯出
    "data.import_merge": "manager",  # 匯入（合併模式：預覽與套用）
    # ── root（damageable-command）──
    "data.backup_db": "root",  # 完整資料庫 .db 備份下載（含密碼雜湊與 session）
    "data.import_replace": "root",  # 匯入「取代全部」模式
    "roles.assign_root": "root",  # 指派 / 撤銷 root，以及管理 root 帳號（停用、重設密碼、編輯）
}

FORBIDDEN_MESSAGE = "沒有權限執行此操作"


def role_rank(role: str | None) -> int:
    return ROLE_RANK.get(role or "", 0)


def _role_of(user: Any) -> str | None:
    if user is None:
        return None
    if isinstance(user, Mapping):
        return user.get("role")  # type: ignore[no-any-return]
    try:
        return user["role"]  # type: ignore[no-any-return]
    except (KeyError, IndexError, TypeError):
        return getattr(user, "role", None)


def role_can(role: str | None, capability: str) -> bool:
    need = CAPABILITIES.get(capability)
    if need is None:
        raise KeyError(f"未知的權限：{capability}")
    return role_rank(role) >= ROLE_RANK[need]


def can(user: Any, capability: str) -> bool:
    """user：sqlite3.Row / dict（含 role）或 None"""
    return role_can(_role_of(user), capability)


def capabilities_of(user: Any) -> list[str]:
    role = _role_of(user)
    return [c for c in CAPABILITIES if role_can(role, c)]


def denied() -> HttpError:
    return forbidden(FORBIDDEN_MESSAGE)


def check(ctx: Ctx, capability: str) -> Ctx:
    """handler 內檢查（需視請求內容決定權限時用，例如匯入的取代模式）"""
    if not can(ctx.user, capability):
        raise denied()
    return ctx


def require(capability: str):  # type: ignore[no-untyped-def]
    """FastAPI dependency：`dependencies=[Depends(require("members.manage"))]`"""
    if capability not in CAPABILITIES:
        raise KeyError(f"未知的權限：{capability}")

    def dependency(request: Request) -> Ctx:
        return check(get_ctx(request), capability)

    dependency.__name__ = f"require_{capability.replace('.', '_')}"
    return dependency
