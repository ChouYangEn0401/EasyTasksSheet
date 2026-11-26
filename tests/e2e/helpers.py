"""E2E 共用工具（對應以前的 tests/helpers/e2e.ts 與 hygiene.ts）。"""

from __future__ import annotations

from urllib.parse import quote

import pytest
from playwright.sync_api import Page, Playwright, expect

from server.e2e_setup import E2E_USERS

__all__ = ["E2E_USERS", "login_via_ui", "collect_errors", "api_context", "data_hygiene"]


def login_via_ui(page: Page, user: dict, next_path: str = "/") -> None:
    """以登入頁登入並等待進入 shell（next 為登入後要前往的路徑）。"""
    page.goto("/login" if next_path == "/" else f"/login?next={quote(next_path, safe='')}")
    page.get_by_label("帳號").fill(user["username"])
    page.get_by_label("密碼", exact=True).fill(user["password"])
    page.get_by_role("button", name="登入").click()
    expect(page.get_by_role("navigation", name="主要導覽")).to_be_visible()


def collect_errors(page: Page) -> list[str]:
    """收集頁面 console error 與未捕捉例外。"""
    errors: list[str] = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    return errors


def api_context(playwright: Playwright, base_url: str, user: dict):
    """以 API 登入的 request context（None = 登入失敗）。"""
    ctx = playwright.request.new_context(base_url=base_url)
    res = ctx.post("/api/auth/login", data={"username": user["username"], "password": user["password"]})
    if not res.ok:
        ctx.dispose()
        return None
    return ctx


def _max_id(rows) -> int:
    return max((r["id"] for r in rows), default=0)


def _list(ctx, url: str):
    res = ctx.get(url)
    return res.json() if res.ok else []


@pytest.fixture(scope="module")
def data_hygiene(playwright: Playwright, base_url: str):
    """資料衛生：模組開始記水位，結束時把水位之後新增的任務軟刪除、自由待辦刪除（盡力而為）。"""
    users = [E2E_USERS["admin"], E2E_USERS["member"]]
    task_mark = 2**53
    todo_mark: dict[str, int] = {}
    try:
        admin = api_context(playwright, base_url, E2E_USERS["admin"])
        if admin:
            task_mark = _max_id(_list(admin, "/api/tasks"))
            admin.dispose()
        for u in users:
            ctx = api_context(playwright, base_url, u)
            if not ctx:
                continue
            todo_mark[u["username"]] = _max_id(_list(ctx, "/api/personal"))
            ctx.dispose()
    except Exception:
        task_mark = 2**53
    yield
    try:
        admin = api_context(playwright, base_url, E2E_USERS["admin"])
        if admin:
            for _ in range(3):
                left = [t for t in _list(admin, "/api/tasks") if t["id"] > task_mark]
                if not left:
                    break
                for t in left:
                    admin.delete(f"/api/tasks/{t['id']}")
            admin.dispose()
        for u in users:
            ctx = api_context(playwright, base_url, u)
            if not ctx:
                continue
            mark = todo_mark.get(u["username"], 2**53)
            for it in _list(ctx, "/api/personal"):
                if it["id"] > mark:
                    ctx.delete(f"/api/personal/{it['id']}")
            ctx.dispose()
    except Exception:
        pass
