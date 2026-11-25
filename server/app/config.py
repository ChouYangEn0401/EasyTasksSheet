"""環境變數設定（名稱與預設值見 .env.example；為唯一的設定來源）。"""

from __future__ import annotations

import os
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
    NODE_ENV: str = "development"
    HOST: str = "127.0.0.1"
    PORT: int = 3000
    WEB_PORT: int = 5173
    APP_ORIGIN: str | None = None
    DATABASE_PATH: str = "data/app.db"
    STATIC_DIR: str = "dist/web"
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

    CHANGES_RETENTION_DAYS: float = 30
    #: 備份目錄（CLI backup 與匯入前自動備份共用）
    BACKUP_DIR: str = "backups"
    #: 資料匯入檔大小上限（MB）
    DATA_IMPORT_MAX_MB: float = 50

    GITHUB_TOKEN: str | None = None
    GITHUB_API_URL: str = "https://api.github.com"
    #: 前端載入問題列表時，距上次同步超過幾分鐘就自動同步一次
    GITHUB_SYNC_MINUTES: float = 5
    ISSUE_CACHE_MINUTES: float = 5
    WORKTREE_STALE_DAYS: float = 7
    WORKTREE_REPORT_TOKEN: str | None = None
    GIT_TIMEOUT_MS: int = 10_000

    @property
    def is_production(self) -> bool:
        return self.NODE_ENV == "production"

    @property
    def cookie_secure(self) -> bool:
        return self.is_production if self.COOKIE_SECURE is None else self.COOKIE_SECURE


_INT = {"PORT", "WEB_PORT", "LOGIN_MAX_FAILS_PER_USER", "LOGIN_MAX_FAILS_PER_IP", "GIT_TIMEOUT_MS"}
_POSITIVE_FLOAT = {
    "SESSION_MAX_HOURS",
    "SESSION_IDLE_MINUTES",
    "LOGIN_WINDOW_MINUTES",
    "LOGIN_LOCK_MINUTES",
    "CHANGES_RETENTION_DAYS",
    "DATA_IMPORT_MAX_MB",
    "ISSUE_CACHE_MINUTES",
    "GITHUB_SYNC_MINUTES",
    "WORKTREE_STALE_DAYS",
}
_POSITIVE_INT = {"LOGIN_MAX_FAILS_PER_USER", "LOGIN_MAX_FAILS_PER_IP", "GIT_TIMEOUT_MS"}


def load_config(env: Mapping[str, str] | None = None) -> Config:
    """由環境變數建立設定；空字串視同未設定（.env.example 直接複製時許多值為空）。"""
    env = os.environ if env is None else env
    values: dict[str, object] = {}
    for name in Config.__dataclass_fields__:
        raw = env.get(name)
        if raw is None or raw == "":
            continue
        try:
            if name == "NODE_ENV":
                if raw not in ("development", "production", "test"):
                    raise ValueError(raw)
                values[name] = raw
            elif name in ("COOKIE_SECURE", "TRUSTED_PROXY"):
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
            raise ConfigError(f"環境變數 {name} 的值無效：{raw!r}") from e
    return Config(**values)  # type: ignore[arg-type]


config = load_config()
