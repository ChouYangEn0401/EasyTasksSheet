"""core-shell.spec.ts 的 Python 版：core/shell 冒煙（登入、強制改密碼、走訪導覽、快速新增、多人可見、登出、閒置逾時、寬度）。"""

from __future__ import annotations

import os
import re
import time
from urllib.parse import parse_qs, quote, urlparse

import pytest
from playwright.sync_api import Browser, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# core/shell 冒煙：登入 → 強制改密碼 → 逐一走訪導覽 → 快速新增任務 → 多人可見 → 登出；另測閒置逾時
# （原檔 serial：pytest 同檔內本來就照順序跑）

NEW_PASSWORD = "e2e-newbie-changed-1"

# 走訪只確認 URL 與頁面標題（h1）存在；頁面內容由各功能軌道實作，不在此假設
NAV_PAGES = [
    {"link": "總覽", "url": re.compile(r"/$")},
    {"link": "問題回饋", "url": re.compile(r"/feedback$")},
    {"link": "個人清單", "url": re.compile(r"/me$")},
    {"link": "工程追蹤", "url": re.compile(r"/eng$")},
]

TASK_VIEWS = [
    {"link": "清單", "url": re.compile(r"/tasks/list")},
    {"link": "看板", "url": re.compile(r"/tasks/kanban")},
    {"link": "甘特圖", "url": re.compile(r"/tasks/gantt")},
]


def expect_page_title(page: Page) -> None:
    h1 = page.locator("h1").first
    expect(h1).to_be_visible()
    expect(h1).not_to_have_text("")


def _query_param(page: Page, name: str):
    return parse_qs(urlparse(page.url).query).get(name, [None])[0]


def _poll_eq(fn, expected, timeout_ms: int = 5000):
    """對應 expect.poll(fn).toBe(expected)。"""
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        value = fn()
        if value == expected:
            return
        if time.monotonic() > deadline:
            raise AssertionError(f"poll 逾時：期望 {expected!r}，實際 {value!r}")
        time.sleep(0.1)


def test_login_force_change_nav_quick_add_other_browser_logout(page: Page, browser: Browser, base_url: str):
    """登入 → 強制改密碼 → 走訪導覽 → 快速新增 → 另一瀏覽器可見 → 登出"""
    # 原檔 test.setTimeout(120_000)：含等待另一瀏覽器的 30 秒輪詢
    errors = collect_errors(page)

    # 未登入 → 導向登入頁並帶 next
    page.goto("/tasks/kanban")
    expect(page).to_have_url(re.compile(r"/login\?next=%2Ftasks%2Fkanban"))
    expect(page.get_by_role("heading", name="登入")).to_be_visible()

    # 錯誤密碼
    page.get_by_label("帳號").fill(E2E_USERS["newbie"]["username"])
    page.get_by_label("密碼", exact=True).fill("wrong-password")
    page.get_by_role("button", name="登入").click()
    expect(page.get_by_role("alert")).to_have_text("帳號或密碼不正確")
    expect(page.get_by_label("密碼", exact=True)).to_have_value("")

    # 首次登入 → 強制改密碼
    page.get_by_label("密碼", exact=True).fill(E2E_USERS["newbie"]["password"])
    page.get_by_role("button", name="登入").click()
    expect(page.get_by_role("heading", name="請先設定新密碼")).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.get_by_role("heading", name="請先設定新密碼")).to_be_visible()
    submit = page.get_by_role("button", name="更新密碼")
    page.get_by_label("目前密碼", exact=True).fill(E2E_USERS["newbie"]["password"])
    page.get_by_label("新密碼", exact=True).fill(NEW_PASSWORD)
    page.get_by_label("確認新密碼", exact=True).fill(NEW_PASSWORD + "x")
    expect(page.get_by_text("兩次輸入的新密碼不一致")).to_be_visible()
    expect(submit).to_be_disabled()
    page.get_by_label("確認新密碼", exact=True).fill(NEW_PASSWORD)
    submit.click()

    # 進入 shell，回到原本要去的頁面
    nav = page.get_by_role("navigation", name="主要導覽")
    expect(nav).to_be_visible()
    expect(page).to_have_url(re.compile(r"/tasks/kanban$"))
    expect_page_title(page)
    # 一般成員看不到成員管理
    expect(nav.get_by_role("link", name="成員管理")).to_have_count(0)
    # 登入前的 401（/api/auth/me 探測、錯誤密碼）屬預期，之後不得再有 console error
    errors.clear()

    # 任務計數只看本次執行專屬標題前綴（?q=），不假設全域任務清單為空，也不依賴其他 spec 的清理
    P = f"E2E 任務 {int(time.time() * 1000)}"
    list_url = f"/tasks/list?q={quote(P, safe='')}"

    # 另一個瀏覽器（admin）先停在任務 List，之後應在輪詢週期內看到新任務
    ctx_b = browser.new_context(base_url=base_url)
    page_b = ctx_b.new_page()
    login_via_ui(page_b, E2E_USERS["admin"], list_url)
    expect(
        page_b.get_by_role("navigation", name="主要導覽").get_by_role("link", name="成員管理")
    ).to_be_visible()
    expect(page_b.get_by_text("共 0 筆")).to_be_visible()

    # 逐一走訪導覽
    for p in NAV_PAGES:
        nav.get_by_role("link", name=p["link"], exact=True).click()
        expect(page).to_have_url(p["url"])
        expect_page_title(page)
    # 任務群組：進入上次使用的檢視（Kanban），再走訪三個子項
    nav.get_by_role("link", name="任務", exact=True).click()
    expect(page).to_have_url(re.compile(r"/tasks/kanban$"))
    for v in TASK_VIEWS:
        nav.get_by_role("link", name=v["link"], exact=True).click()
        expect(page).to_have_url(v["url"])
        expect_page_title(page)
    # ViewTabs 切換保留 query
    page.goto("/tasks/list?status=1")
    page.get_by_role("navigation", name="任務檢視").get_by_role("link", name="甘特圖").click()
    expect(page).to_have_url(re.compile(r"/tasks/gantt\?status=1$"))
    expect(page.get_by_role("button", name=re.compile(r"狀態：待辦"))).to_be_visible()
    page.get_by_role("search").get_by_role("button", name="清除篩選").click()
    expect(page).to_have_url(re.compile(r"/tasks/gantt$"))

    # 404
    page.goto("/no-such-page")
    expect(page.get_by_text("找不到頁面", exact=True).last).to_be_visible()
    page.get_by_role("button", name="回到總覽").click()
    expect(page).to_have_url(re.compile(r"/$"))

    # 快速新增：N 聚焦 → Enter 建立 → 保持 focus 連續新增
    page.goto(list_url)
    expect(page.get_by_text("共 0 筆")).to_be_visible()
    page.locator("#main").click(position={"x": 5, "y": 200})
    page.keyboard.press("n")
    quick_add = page.get_by_role("textbox", name="快速新增任務")
    expect(quick_add).to_be_focused()
    title = P
    quick_add.fill(title)
    quick_add.press("Enter")
    expect(page.get_by_text("已建立")).to_be_visible()
    expect(quick_add).to_have_value("")
    expect(quick_add).to_be_focused()
    quick_add.fill(f"{title} 第二筆")
    quick_add.press("Enter")
    expect(quick_add).to_have_value("")
    quick_add.press("Escape")
    expect(quick_add).not_to_be_focused()
    # 不需重整即更新（FilterBar 結果數與任務清單共用查詢）
    expect(page.get_by_text("共 2 筆")).to_be_visible()

    res = page.request.get(f"/api/tasks?q={quote(P, safe='')}")
    tasks = res.json()
    created = next((t for t in tasks if t["title"] == title), None)
    assert created

    # FilterBar：搜尋寫入 URL（debounce）
    page.keyboard.press("/")
    search = page.get_by_role("textbox", name="搜尋任務")
    expect(search).to_be_focused()
    search.fill(f"{P} 第二筆")
    _poll_eq(lambda: _query_param(page, "q"), f"{P} 第二筆")
    expect(page.get_by_text("共 1 筆")).to_be_visible()
    page.get_by_role("search").get_by_role("button", name="清除篩選").click()
    _poll_eq(lambda: _query_param(page, "q"), None)
    search.fill(P)
    expect(page.get_by_text("共 2 筆")).to_be_visible()

    # TaskDrawer：?task=<id> 開啟，Esc 關閉
    page.goto(f"/tasks/list?task={created['id']}")
    drawer = page.get_by_role("dialog", name=title)
    expect(drawer).to_be_visible()
    expect(drawer.get_by_text("待辦", exact=True)).to_be_visible()
    expect(drawer.get_by_text(re.compile(r"更新於"))).to_be_visible()
    page.keyboard.press("Escape")
    expect(drawer).to_have_count(0)
    expect(page).to_have_url(re.compile(r"/tasks/list$"))

    # 另一個瀏覽器在 30 秒輪詢內看到新任務（不重整）
    expect(page_b.get_by_text("共 2 筆")).to_be_visible(timeout=35_000)
    ctx_b.close()

    # 登出
    page.get_by_role("button", name=re.compile(r"使用者選單")).click()
    page.get_by_role("menuitem", name="登出").click()
    expect(page).to_have_url(re.compile(r"/login$"))
    expect(page.get_by_role("heading", name="登入")).to_be_visible()
    # 登出後再進入受保護頁面會被導回登入頁
    page.goto("/eng")
    expect(page).to_have_url(re.compile(r"/login\?next=%2Feng"))

    # 以新密碼可登入
    page.get_by_label("帳號").fill(E2E_USERS["newbie"]["username"])
    page.get_by_label("密碼", exact=True).fill(NEW_PASSWORD)
    page.get_by_role("button", name="登入").click()
    expect(page).to_have_url(re.compile(r"/eng$"))

    assert [e for e in errors if not re.search(r"status of 401", e)] == []


def test_bootstrap_admin_must_reset_username_and_password(page: Page):
    """預設管理員首次登入須重設帳號與密碼，之後改用新帳號登入"""
    boot = E2E_USERS["bootstrap"]
    NEW_USERNAME = "e2e-owner"
    NEW_PW = "e2e-owner-pass-1"

    page.goto("/login")
    page.get_by_label("帳號").fill(boot["username"])
    page.get_by_label("密碼", exact=True).fill(boot["password"])
    page.get_by_role("button", name="登入").click()

    expect(page.get_by_role("heading", name="請設定新帳號與新密碼")).to_be_visible()
    username = page.get_by_label("新帳號", exact=True)
    expect(username).to_have_value(boot["username"])
    submit = page.get_by_role("button", name="更新帳號與密碼")

    page.get_by_label("目前密碼", exact=True).fill(boot["password"])
    page.get_by_label("新密碼", exact=True).fill(NEW_PW)
    page.get_by_label("確認新密碼", exact=True).fill(NEW_PW)
    # 帳號未改 → 不可送出
    expect(page.get_by_text(f"請改成 {boot['username']} 以外的帳號")).to_be_visible()
    expect(submit).to_be_disabled()
    # 與既有帳號重複 → 後端 409 顯示在帳號欄位
    username.fill(E2E_USERS["member"]["username"])
    submit.click()
    expect(page.get_by_text("此帳號已被使用")).to_be_visible()

    username.fill(NEW_USERNAME)
    submit.click()
    nav = page.get_by_role("navigation", name="主要導覽")
    expect(nav).to_be_visible()

    # 舊帳號無法登入，新帳號可以
    page.get_by_role("button", name=re.compile(r"使用者選單")).click()
    page.get_by_role("menuitem", name="登出").click()
    expect(page).to_have_url(re.compile(r"/login$"))
    page.get_by_label("帳號").fill(boot["username"])
    page.get_by_label("密碼", exact=True).fill(boot["password"])
    page.get_by_role("button", name="登入").click()
    expect(page.get_by_role("alert")).to_have_text("帳號或密碼不正確")
    page.get_by_label("帳號").fill(NEW_USERNAME)
    page.get_by_label("密碼", exact=True).fill(NEW_PW)
    page.get_by_role("button", name="登入").click()
    expect(nav).to_be_visible()


def test_idle_timeout_returns_to_login(page: Page):
    """閒置逾時後前端自動回到登入頁"""
    page.clock.install()
    login_via_ui(page, E2E_USERS["admin"], "/feedback")
    expect(page).to_have_url(re.compile(r"/feedback$"))
    # 沒有任何操作，快轉超過 60 分鐘閒置門檻
    page.clock.fast_forward(61 * 60_000)
    expect(page).to_have_url(re.compile(r"/login\?reason=expired&next=%2Ffeedback"))
    expect(page.get_by_role("alert")).to_have_text("登入已逾時，請重新登入")


def test_no_horizontal_scrollbar_at_1280_1024_768(page: Page):
    """1280 / 1024 / 768 寬度不產生水平捲軸"""
    login_via_ui(page, E2E_USERS["admin"])
    shots = os.environ.get("SHOTS_DIR")
    for width in [1280, 1024, 768]:
        page.set_viewport_size({"width": width, "height": 800})
        for path in ["/", "/tasks/list", "/tasks/kanban?status=1", "/feedback", "/admin/users"]:
            page.goto(path)
            expect(page.get_by_role("navigation", name="主要導覽")).to_be_visible()
            overflow = page.evaluate(
                "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            assert overflow <= 0, f"{width}px {path}"
            if shots:
                page.screenshot(path=f"{shots}/{width}{re.sub(r'[/?=]', '_', path)}.png")
