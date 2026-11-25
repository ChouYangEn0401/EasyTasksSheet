"""認證相關設定（毫秒為單位）；由 Config 轉換，測試可直接覆寫。"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from .config import Config

MINUTE = 60_000


@dataclass(frozen=True)
class AuthSettings:
    session_max_ms: int
    idle_timeout_ms: int
    cookie_secure: bool
    #: 允許的 Origin；未設定時以請求 Host 判斷同源
    app_origin: str | None
    login_window_ms: int
    login_max_fails_per_user: int
    login_lock_ms: int
    login_max_fails_per_ip: int
    #: 是否信任反向代理附加的 X-Forwarded-For（預設否：一律用 socket 位址）
    trusted_proxy: bool = False
    #: 預設管理員帳號（ADMIN_USERNAME）：此帳號在 must_change_password 時須同時改帳號與密碼
    bootstrap_admin_username: str = "admin"
    #: session cookie 的 Path（BASE_PATH；空 = "/"），避免與同網域其他服務（Gitea、pyDMS）互相干擾
    cookie_path: str = "/"

    def with_overrides(self, **overrides: Any) -> "AuthSettings":
        return replace(self, **overrides) if overrides else self


def auth_settings_from(config: Config) -> AuthSettings:
    return AuthSettings(
        session_max_ms=round(config.SESSION_MAX_HOURS * 60 * MINUTE),
        idle_timeout_ms=round(config.SESSION_IDLE_MINUTES * MINUTE),
        cookie_secure=config.cookie_secure,
        app_origin=config.APP_ORIGIN,
        login_window_ms=round(config.LOGIN_WINDOW_MINUTES * MINUTE),
        login_max_fails_per_user=config.LOGIN_MAX_FAILS_PER_USER,
        login_lock_ms=round(config.LOGIN_LOCK_MINUTES * MINUTE),
        login_max_fails_per_ip=config.LOGIN_MAX_FAILS_PER_IP,
        trusted_proxy=config.TRUSTED_PROXY,
        bootstrap_admin_username=config.ADMIN_USERNAME,
        cookie_path=config.BASE_PATH or "/",
    )
