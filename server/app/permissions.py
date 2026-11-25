"""角色與權限（唯一來源；對照表見 docs/permissions.md）。

三層角色：root（超級管理員）> manager（管理者）> user（成員）。
- `CAPABILITIES`：每個權限的「預設」最低角色（程式碼為預設值來源）
- 有效矩陣 = 預設 + root 在「權限設定」頁的覆寫（`role_permissions` 表，只存與預設不同的格子）
- `can(user, capability, db)`：判斷登入者是否具備某權限（傳入 db 才會套用覆寫；未傳入時為預設矩陣）
- `require(capability)`：FastAPI dependency，不具備時 403（訊息一致；一律套用有效矩陣）
- `capabilities_of(user, db)`：/api/auth/me 與登入回應的 `capabilities`（前端據此顯示 / 隱藏）

保護規則：
- root 恆擁有全部權限，不可被覆寫（避免把自己鎖在外面）
- `PROTECTED_CAPABILITIES` 只允許 root，不可授予 manager / user

快取：覆寫在記憶體中依 Database 快取，寫入後 `invalidate(db)` 立即失效。
系統為單一 worker（單一行程），不處理多行程間的快取同步。
"""

from __future__ import annotations

import re
import sqlite3
import weakref
from typing import Any, Literal, Mapping

from fastapi import Request

from .context import Ctx, get_ctx
from .db import Database
from .errors import HttpError, forbidden

Role = Literal["root", "manager", "user"]
ROLES: tuple[Role, ...] = ("root", "manager", "user")
#: 階層：數字越大權限越高
ROLE_RANK: dict[str, int] = {"user": 1, "manager": 2, "root": 3}
ROLE_LABELS: dict[str, str] = {"root": "超級管理員", "manager": "管理者", "user": "成員"}
#: 可在權限設定中調整的角色（root 恆擁有全部權限）
CONFIGURABLE_ROLES: tuple[Role, ...] = ("manager", "user")

#: 每個權限的預設最低角色
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
    "sync.manage": "manager",  # 多台電腦同步：建立 / 停用同步來源與金鑰（docs/sync.md）
    "sync.resolve": "manager",  # 多台電腦同步：處理待確認衝突、檢視同步紀錄
    # ── root（damageable-command）──
    "data.backup_db": "root",  # 完整資料庫 .db 備份下載（含密碼雜湊與 session）
    "data.import_replace": "root",  # 匯入「取代全部」模式
    "roles.assign_root": "root",  # 指派 / 撤銷 root，以及管理 root 帳號（停用、重設密碼、編輯）
    "permissions.configure": "root",  # 權限設定（調整各角色的權限）
}

#: 受保護權限：只允許 root，不可在權限設定中授予 manager / user
PROTECTED_CAPABILITIES: frozenset[str] = frozenset(
    {"roles.assign_root", "data.backup_db", "data.import_replace", "permissions.configure"}
)

#: 權限設定頁的分組（依序顯示）
CAPABILITY_GROUPS: tuple[tuple[str, str], ...] = (
    ("work", "任務與專案"),
    ("statuses", "狀態"),
    ("eng", "工程追蹤"),
    ("members", "成員"),
    ("data", "資料"),
    ("system", "系統"),
    ("other", "其他"),
)

#: 權限設定頁的中文名稱、一句說明與分組。未列出的 capability 以代碼為名稱、歸入「其他」。
CAPABILITY_INFO: dict[str, tuple[str, str, str]] = {
    "tasks.edit": ("編輯任務", "新增、編輯、刪除任務（可修改他人的任務）", "work"),
    "projects.create": ("建立專案", "新增專案", "work"),
    "projects.manage": ("管理專案", "專案改名、改色、排序與封存", "work"),
    "properties.edit": ("自訂欄位", "新增與編輯任務的自訂欄位", "work"),
    "feedback.edit": ("問題回饋", "新增與編輯問題回饋", "work"),
    "personal.edit": ("個人清單", "使用自己的個人清單", "work"),
    "statuses.manage": ("管理狀態", "狀態新增、改名、改色、排序與刪除", "statuses"),
    "eng.edit": ("工程追蹤紀錄", "問題與 worktree 紀錄，含 GitHub 同步與建立 issue", "eng"),
    "github.manage": ("GitHub 連動設定", "設定專案與 GitHub repo 的對應", "eng"),
    "members.manage": ("管理成員", "新增、停用、重設密碼與調整角色（限成員 ↔ 管理者）", "members"),
    "roles.assign_root": ("指派超級管理員", "指派或撤銷超級管理員，並管理其帳號", "members"),
    "profile.edit": ("個人資料", "修改自己的個人資料與密碼", "members"),
    "data.export_json": ("JSON 匯出", "下載全部資料的 JSON 匯出檔", "data"),
    "data.import_merge": ("匯入（合併）", "預覽並以合併模式匯入資料", "data"),
    "data.import_replace": ("匯入（取代全部）", "刪除本機資料後改為匯入檔內容", "data"),
    "data.backup_db": ("完整備份下載", "下載含密碼雜湊的資料庫備份檔", "data"),
    "sync.manage": ("同步來源管理", "建立、停用、刪除同步來源並產生各台電腦的同步金鑰", "data"),
    "sync.resolve": ("處理同步衝突", "決定兩邊幾乎同時修改的資料要保留哪一份，並檢視處理紀錄", "data"),
    "permissions.configure": ("權限設定", "調整各角色可執行的操作", "system"),
}

FORBIDDEN_MESSAGE = "沒有權限執行此操作"


def capability_info(capability: str) -> dict[str, str]:
    label, description, group = CAPABILITY_INFO.get(capability, (capability, "", "other"))
    return {"label": label, "description": description, "group": group}


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


def _need(capability: str) -> Role:
    need = CAPABILITIES.get(capability)
    if need is None:
        raise KeyError(f"未知的權限：{capability}")
    return need


def role_can(role: str | None, capability: str) -> bool:
    """預設矩陣（不含覆寫）"""
    return role_rank(role) >= ROLE_RANK[_need(capability)]


# ── 覆寫（role_permissions）與快取 ──

Overrides = dict[tuple[str, str], bool]
_cache: "weakref.WeakKeyDictionary[Database, Overrides]" = weakref.WeakKeyDictionary()


def load_overrides(db: Database) -> Overrides:
    """目前的覆寫（快取）。忽略已不存在的 capability、受保護權限與不可調整的角色。"""
    cached = _cache.get(db)
    if cached is not None:
        return cached
    try:
        rows = db.all("SELECT role, capability, allowed FROM role_permissions")
    except sqlite3.OperationalError:  # 尚未套用 0010 migration
        rows = []
    out: Overrides = {}
    for r in rows:
        role, cap = r["role"], r["capability"]
        if role in CONFIGURABLE_ROLES and cap in CAPABILITIES and cap not in PROTECTED_CAPABILITIES:
            out[(role, cap)] = bool(r["allowed"])
    _cache[db] = out
    return out


def invalidate(db: Database) -> None:
    """覆寫寫入後呼叫：下一個請求即重新讀取"""
    _cache.pop(db, None)


def effective_role_can(role: str | None, capability: str, db: Database | None) -> bool:
    """有效矩陣：root 恆為 True；受保護權限固定預設；其餘有覆寫用覆寫，否則用預設"""
    _need(capability)
    if role == "root":
        return True
    if role not in ROLE_RANK:
        return False
    default = role_can(role, capability)
    if db is None or capability in PROTECTED_CAPABILITIES:
        return default
    return load_overrides(db).get((role, capability), default)


def can(user: Any, capability: str, db: Database | None = None) -> bool:
    """user：sqlite3.Row / dict（含 role）或 None；db：套用權限設定的覆寫（None = 預設矩陣）"""
    return effective_role_can(_role_of(user), capability, db)


def capabilities_of(user: Any, db: Database | None = None) -> list[str]:
    role = _role_of(user)
    return [c for c in CAPABILITIES if effective_role_can(role, c, db)]


def denied() -> HttpError:
    return forbidden(FORBIDDEN_MESSAGE)


# ── 一般協作權限的寫入守門（全域 middleware，見 app.py）──
# 這些端點原本「登入即可」，沒有個別 require()；為讓權限設定能實際收回，於 middleware 依路徑檢查。
# 只管寫入（POST / PUT / PATCH / DELETE），讀取不受影響。已有 require() 的端點（狀態、專案管理、
# GitHub 連動、成員、資料）不在此表。

_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
WRITE_GUARDS: tuple[tuple[frozenset[str], re.Pattern[str], str], ...] = (
    (_WRITE_METHODS, re.compile(r"^/api/tasks(/|$)"), "tasks.edit"),
    (_WRITE_METHODS, re.compile(r"^/api/feedback(/|$)"), "feedback.edit"),
    (_WRITE_METHODS, re.compile(r"^/api/personal(/|$)"), "personal.edit"),
    (_WRITE_METHODS, re.compile(r"^/api/eng/(issues|worktree-records)(/|$)"), "eng.edit"),
    (_WRITE_METHODS, re.compile(r"^/api/properties(/|$)"), "properties.edit"),
    (frozenset({"POST"}), re.compile(r"^/api/projects/?$"), "projects.create"),
    (_WRITE_METHODS, re.compile(r"^/api/auth/password$"), "profile.edit"),
)


def write_capability(method: str, path: str) -> str | None:
    """寫入請求對應的一般協作權限（無對應時 None）"""
    for methods, pattern, capability in WRITE_GUARDS:
        if method in methods and pattern.search(path):
            return capability
    return None


def guard_write(user: Any, method: str, path: str, db: Database) -> HttpError | None:
    """middleware 用：不具對應權限時回傳 403 錯誤。
    被要求改密碼（must_change_password）的帳號一律可改密碼，避免收回 profile.edit 後無法登入。"""
    capability = write_capability(method, path)
    if capability is None or can(user, capability, db):
        return None
    if capability == "profile.edit" and user is not None and user["must_change_password"]:
        return None
    return denied()


def check(ctx: Ctx, capability: str) -> Ctx:
    """handler 內檢查（需視請求內容決定權限時用，例如匯入的取代模式）"""
    if not can(ctx.user, capability, ctx.db):
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
