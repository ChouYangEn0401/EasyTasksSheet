"""冒煙：沒有建置步驟之後的三道基本防線。

1. health 與 SPA 回退（對應以前的 health.spec.ts）。
2. 瀏覽器真的 `import()` 每一個前端模組都成功（取代 tsc --noEmit：抓語法錯誤、循環依賴炸掉、匯出名字不對）。
3. 以 admin 登入後走訪所有路由，console error 與 pageerror 為零。
"""

from __future__ import annotations

import re
from pathlib import Path

from playwright.sync_api import Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

ROOT = Path(__file__).resolve().parents[2]
WEB_JS = ROOT / "web" / "static" / "js"

ROUTES = [
    "/",
    "/feedback",
    "/me",
    "/settings",
    "/eng",
    "/admin/users",
    "/admin/data",
    "/admin/data/sync",
    "/admin/permissions",
    "/admin/audit",
    "/tasks/list",
    "/tasks/kanban",
    "/tasks/gantt",
    "/tasks/delay-link",
    "/no-such-page",
]


def test_health_and_spa_fallback(playwright, base_url):
    ctx = playwright.request.new_context(base_url=base_url)
    health = ctx.get("/api/health")
    assert health.status == 200
    body = health.json()
    assert body["ok"] is True and "version" in body
    assert ctx.get("/api/overview").status == 401
    login = ctx.post(
        "/api/auth/login", data={"username": E2E_USERS["admin"]["username"], "password": E2E_USERS["admin"]["password"]}
    )
    assert login.status == 200
    assert ctx.get("/api/eng/issues").status not in (401, 404)
    page = ctx.get("/some/spa/route")
    assert page.status == 200 and '<div id="root">' in page.text()
    # 靜態檔找不到要 404（不能回 index.html）
    assert ctx.get("/static/js/nope.js").status == 404
    ctx.dispose()


def test_every_module_imports_in_the_browser(page: Page, base_url: str):
    """每個模組都 import 一次；任何一個炸掉都列出來。"""
    page.goto(f"{base_url}/login")
    static_prefix = page.get_attribute('meta[name="ts-static"]', "content")
    assert static_prefix and re.search(r"/static/v/[0-9a-f]+$", static_prefix)
    modules = sorted(
        str(p.relative_to(WEB_JS)).replace("\\", "/") for p in WEB_JS.rglob("*.js") if not p.name.endswith(".test.js")
    )
    assert len(modules) > 100
    failures = page.evaluate(
        """async ([prefix, mods]) => {
            const out = [];
            for (const m of mods) {
                try { await import(`${prefix}/js/${m}`); }
                catch (e) { out.push(`${m}: ${e && e.message ? e.message : e}`); }
            }
            return out;
        }""",
        [static_prefix, modules],
    )
    assert failures == [], "\n".join(failures)


def test_all_routes_render_without_console_errors(page: Page, base_url: str):
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["admin"])
    for route in ROUTES:
        page.goto(f"{base_url}{route}")
        try:
            expect(page.locator("#root")).not_to_be_empty()
            expect(page.locator("h1").first).to_be_visible()
        except AssertionError as e:  # 把 console 錯誤一起印出來，不然只看得到「空的」
            raise AssertionError(f"{route} 沒畫出來；console：\n" + "\n".join(errors)) from e
        page.wait_for_timeout(300)
    # 已知可忽略：瀏覽器對 favicon 的 404
    real = [e for e in errors if "favicon" not in e and "status of 401" not in e]
    assert real == [], "\n".join(real)
