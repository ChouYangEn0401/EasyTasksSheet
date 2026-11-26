"""環境變數設定（名稱與預設值見 .env.example；為唯一的設定來源）。"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from dotenv import load_dotenv

# 載入專案根目錄（目前工作目錄）的 .env；已存在的環境變數不會被覆寫
if Path(".env").exists():
    load_dotenv(".env", override=False)


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Config:
    #: 執行模式：development / production / test。舊名 NODE_ENV 仍可用（APP_ENV 優先）。
    APP_ENV: str = "development"
    HOST: str = "127.0.0.1"
    PORT: int = 3000
    APP_ORIGIN: str | None = None
    DATABASE_PATH: str = "data/app.db"
    #: 掛在反向代理的子路徑底下時的網址前綴，例如 /easytasks（nginx 轉發時去掉前綴）；空 = 掛在網站根目錄。
    #: 影響 cookie 路徑、後端產生的附件網址；前端的 index.html 由伺服器在每次請求時代入同一個值，改了只要重啟。
    BASE_PATH: str = ""
    TZ: str = "Asia/Taipei"

    SESSION_MAX_HOURS: float = 9
    SESSION_IDLE_MINUTES: float = 60
    COOKIE_SECURE: bool | None = None
    LOGIN_WINDOW_MINUTES: float = 15
    LOGIN_MAX_FAILS_PER_USER: int = 5
    LOGIN_LOCK_MINUTES: float = 15
    LOGIN_MAX_FAILS_PER_IP: int = 20
    #: 前面有反向代理（Caddy/nginx）時設 true，才採用 X-Forwarded-For；直連時必須維持 false
    TRUSTED_PROXY: bool = False
    #: 首次啟動（尚無帳號）建立的預設管理員；首次登入強制重設帳號與密碼
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "password"

    #: 變更流水（changes）保留天數（啟動時與每日修剪；設定檔須 > 0，與其他保留天數一致）。即時同步補漏用，過舊的 since 會回 reset
    CHANGES_RETENTION_DAYS: float = 30
    #: 稽核紀錄保留天數（啟動時與每日修剪；docs/design/audit-log.md）
    AUDIT_RETENTION_DAYS: float = 365
    #: 備份目錄（CLI backup 與匯入前自動備份共用）
    BACKUP_DIR: str = "backups"
    #: 資料匯入檔大小上限（MB）
    DATA_IMPORT_MAX_MB: float = 50
    #: 整站搬家包（.etpack）上傳還原的大小上限（MB）；反向代理的上傳上限也要放寬到此值以上
    PACK_MAX_MB: float = 2048
    #: 多台電腦同步：兩邊更新時間差距超過此分鐘數才自動採較新者，否則列為待確認衝突（docs/sync.md）
    SYNC_AUTO_RESOLVE_MINUTES: float = 10

    GITHUB_TOKEN: str | None = None
    GITHUB_API_URL: str = "https://api.github.com"
    #: 前端載入問題列表時，距上次同步超過幾分鐘就自動同步一次
    GITHUB_SYNC_MINUTES: float = 5
    #: 電腦超過幾天沒有回報，工作樹頁面就標示「未回報（最後看到 N 天前）」（資料不會因此刪除）
    WORKTREE_STALE_DAYS: float = 2
    WORKTREE_REPORT_TOKEN: str | None = None
    #: 網頁「掃描本機專案」允許的資料夾（逗號分隔；未設定 = 功能停用）。只掃描這些資料夾內（以真實路徑比對）
    WORKTREE_SCAN_ROOTS: str | None = None
    GIT_TIMEOUT_MS: int = 10_000

    #: 附件（工程問題等）：檔案存放目錄（檔名為隨機 id）、單檔上限、影片單檔上限、每筆項目的檔案數上限
    ATTACHMENTS_DIR: str = "data/attachments"
    ATTACHMENT_MAX_MB: float = 25
    ATTACHMENT_VIDEO_MAX_MB: float = 200
    ATTACHMENT_MAX_PER_ITEM: int = 10
    #: 連結預覽（抓取網頁 metadata）；ALLOW_PRIVATE 允許抓取內網位址（有 SSRF 風險，預設關）
    LINK_PREVIEW_ENABLED: bool = True
    LINK_PREVIEW_ALLOW_PRIVATE: bool = False

    @property
    def is_production(self) -> bool:
        return self.APP_ENV == "production"

    @property
    def cookie_secure(self) -> bool:
        return self.is_production if self.COOKIE_SECURE is None else self.COOKIE_SECURE


_INT = {
    "PORT",
    "LOGIN_MAX_FAILS_PER_USER",
    "LOGIN_MAX_FAILS_PER_IP",
    "GIT_TIMEOUT_MS",
    "ATTACHMENT_MAX_PER_ITEM",
}
_BOOL = {"COOKIE_SECURE", "TRUSTED_PROXY", "LINK_PREVIEW_ENABLED", "LINK_PREVIEW_ALLOW_PRIVATE"}
_POSITIVE_FLOAT = {
    "ATTACHMENT_MAX_MB",
    "ATTACHMENT_VIDEO_MAX_MB",
    "SESSION_MAX_HOURS",
    "SESSION_IDLE_MINUTES",
    "LOGIN_WINDOW_MINUTES",
    "LOGIN_LOCK_MINUTES",
    "CHANGES_RETENTION_DAYS",
    "AUDIT_RETENTION_DAYS",
    "DATA_IMPORT_MAX_MB",
    "PACK_MAX_MB",
    "SYNC_AUTO_RESOLVE_MINUTES",
    "GITHUB_SYNC_MINUTES",
    "WORKTREE_STALE_DAYS",
}
_POSITIVE_INT = {"LOGIN_MAX_FAILS_PER_USER", "LOGIN_MAX_FAILS_PER_IP", "GIT_TIMEOUT_MS", "ATTACHMENT_MAX_PER_ITEM"}


_BASE_PATH_RE = re.compile(r"^(/[A-Za-z0-9._~-]+)+$")


def normalize_base_path(raw: str) -> str:
    """"/easytasks/"、"easytasks" → "/easytasks"；"/" 或空白 → ""（根目錄）。只允許安全的路徑字元。"""
    v = raw.strip().strip("/")
    if not v:
        return ""
    v = "/" + v
    if not _BASE_PATH_RE.match(v) or any(seg in (".", "..") for seg in v.split("/")):
        raise ValueError(raw)
    return v


def load_config(env: Mapping[str, str] | None = None) -> Config:
    """由環境變數建立設定；空字串視同未設定（.env.example 直接複製時許多值為空）。"""
    env = os.environ if env is None else env
    values: dict[str, object] = {}
    for name in Config.__dataclass_fields__:
        raw = env.get(name)
        shown = name
        if name == "APP_ENV" and (raw is None or raw == ""):
            # 向下相容：舊版 .env 與部署腳本寫的是 NODE_ENV
            raw = env.get("NODE_ENV")
            shown = "NODE_ENV"
        if raw is None or raw == "":
            continue
        try:
            if name == "APP_ENV":
                if raw not in ("development", "production", "test"):
                    raise ValueError(raw)
                values[name] = raw
            elif name == "BASE_PATH":
                values[name] = normalize_base_path(raw)
            elif name in _BOOL:
                if raw not in ("true", "false"):
                    raise ValueError(raw)
                values[name] = raw == "true"
            elif name in _INT:
                v = int(raw)
                if name in _POSITIVE_INT and v <= 0:
                    raise ValueError(raw)
                values[name] = v
            elif name in _POSITIVE_FLOAT:
                f = float(raw)
                if f <= 0:
                    raise ValueError(raw)
                values[name] = f
            else:
                values[name] = raw
        except ValueError as e:
            raise ConfigError(f"環境變數 {shown} 的值無效：{raw!r}") from e
    return Config(**values)  # type: ignore[arg-type]


config = load_config()
