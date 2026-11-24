"""每個請求可取得的依賴（同 TS 版的 c.var）：db、now、settings、user、session。

各 feature 路由以 `ctx = get_ctx(request)` 取用；user / session 由全域 session 檢查設定
（公開路由 health、login、logout 等沒有）。
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Callable

from starlette.requests import Request

from .db import Database
from .security import SessionRow
from .settings import AuthSettings


@dataclass
class Ctx:
    db: Database
    now: Callable[[], int]
    settings: AuthSettings
    user: sqlite3.Row
    session: SessionRow


def get_ctx(request: Request) -> Ctx:
    state = request.app.state
    return Ctx(
        db=state.db,
        now=state.now,
        settings=state.settings,
        user=getattr(request.state, "user", None),  # type: ignore[arg-type]
        session=getattr(request.state, "session", None),  # type: ignore[arg-type]
    )
