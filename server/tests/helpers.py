"""測試 helper（對應 tests/helpers/db.ts、auth.ts）。"""

from __future__ import annotations

import itertools
import json
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient

from server.app.app import create_app
from server.app.db import Database, create_db, run_migrations, run_seed
from server.app.link_preview import PreviewError
from server.app.security import hash_password

TEST_PASSWORD = "test-password-123"
MIN = 60_000

_seq = itertools.count(1)


def create_test_db(seed: bool = True) -> Database:
    """建立已 migration + seed 的記憶體 DB"""
    db = create_db(":memory:")
    run_migrations(db)
    if seed:
        run_seed(db)
    return db


class FakeClock:
    """假時鐘：預設固定於 2026-01-05 09:00 (+08:00)，可 advance()"""

    def __init__(self, start: int | None = None):
        if start is None:
            start = int(datetime(2026, 1, 5, 9, 0, tzinfo=timezone(timedelta(hours=8))).timestamp() * 1000)
        self.t = start

    def now(self) -> int:
        return self.t

    def advance(self, ms: int) -> None:
        self.t += ms

    def set(self, ms: int) -> None:
        self.t = ms


class OfflineFetcher:
    """測試用：不連網的連結預覽抓取器"""

    def fetch(self, url: str):
        raise PreviewError("測試環境不連網")


class TestApp:
    __test__ = False

    def __init__(self, now=None, settings: dict[str, Any] | None = None, db: Database | None = None):
        self.db = db or create_test_db()
        self.app = create_app(self.db, now=now, settings=settings)
        # 附件寫到暫存目錄；連結預覽預設停用且不連網（個別測試可開啟並覆寫 app.state.link_fetcher）
        self.app.state.attachments_dir = tempfile.mkdtemp(prefix="ts-attach-")
        self.app.state.link_preview_enabled = False
        self.app.state.link_fetcher = OfflineFetcher()
        self.http = TestClient(self.app, base_url="http://localhost", raise_server_exceptions=False)


def create_test_app(now=None, settings: dict[str, Any] | None = None) -> TestApp:
    return TestApp(now=now, settings=settings)


def create_test_user(db: Database, password: str = TEST_PASSWORD, **overrides: Any) -> dict[str, Any]:
    """建立測試使用者（直接寫 DB）；回傳 DB 欄位（snake_case）＋ password"""
    n = next(_seq)
    values = {
        "username": f"user{n}",
        "display_name": f"測試使用者 {n}",
        "password_hash": hash_password(password),
        "role": "user",
        "is_active": 1,
        "must_change_password": 0,
        "created_at": 1,
        "updated_at": 1,
    }
    values.update(overrides)
    with db.tx() as conn:
        cols = ", ".join(values)
        cur = conn.execute(f"INSERT INTO users ({cols}) VALUES ({', '.join('?' * len(values))})", tuple(values.values()))
        row = conn.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {**dict(row), "password": password}


class Client:
    """送出 JSON 請求（自動帶 cookie、Content-Type 與同源 Origin）；cookie 為空字串時即未登入"""

    def __init__(self, app: TestApp, cookie: str = ""):
        self.app = app
        self.cookie = cookie

    def request(self, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None):
        h: dict[str, str] = {}
        if self.cookie:
            h["cookie"] = self.cookie
        if method != "GET":
            h["content-type"] = "application/json"
            h["origin"] = "http://localhost"
        h.update(headers or {})
        http = self.app.http
        http.cookies.clear()
        res = http.request(method, path, headers=h, content=None if body is None else json.dumps(body))
        http.cookies.clear()
        return res

    def get(self, path: str):
        return self.request("GET", path)


def client(app: TestApp, cookie: str = "") -> Client:
    return Client(app, cookie)


def login(app: TestApp, username: str, password: str = TEST_PASSWORD, headers: dict[str, str] | None = None):
    return client(app).request("POST", "/api/auth/login", {"username": username, "password": password}, headers)


def login_as(app: TestApp, user: dict[str, Any]) -> Client:
    res = login(app, user["username"], user.get("password", TEST_PASSWORD))
    if res.status_code != 200:
        raise AssertionError(f"登入失敗：{res.status_code} {res.text}")
    set_cookie = res.headers.get("set-cookie", "")
    return client(app, set_cookie.split(";")[0])
