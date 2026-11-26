"""presence.spec.ts 的 Python 版：三位使用者同時在線（docs/design/presence.md、docs/multi-user.md）。"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import pytest
from playwright.sync_api import Browser, Page, expect

from .helpers import E2E_USERS, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# feat/presence：三位使用者同時在線（docs/design/presence.md、docs/multi-user.md）
# E2E 伺服器以 PRESENCE_ONLINE_SECONDS=10、PRESENCE_IDLE_SECONDS=25 啟動（tests/e2e/conftest.py）
# （原檔 serial：pytest 同檔內本來就照順序跑）

SHOTS = os.environ.get("SHOTS_DIR")



def shot(page: Page, name: str) -> None:
    if not SHOTS:
        return
    Path(SHOTS).mkdir(parents=True, exist_ok=True)
    page.wait_for_timeout(300)  # 等進場動畫結束
    page.screenshot(path=str(Path(SHOTS) / f"{name}.png"))


def open_as(browser: Browser, base_url: str, user: dict, path: str, width: int = 1280) -> Page:
    context = browser.new_context(base_url=base_url, viewport={"width": width, "height": 800})
    page = context.new_page()
    login_via_ui(page, user, path)
    return page


def stack_of(page: Page):
    return page.get_by_role("group", name="在線成員")


def row_of(page: Page, title: str):
    return page.locator(".tl-row--task", has_text=title)


def test_three_users_online(browser: Browser, base_url: str):
    """三人同時在線：頭像堆疊、hover 卡片、抽屜提示、清單小頭像、關閉後轉離線"""
    P = f"PR-{int(time.time() * 1000)}"
    width = int(os.environ.get("PRESENCE_SHOT_WIDTH") or 1280)

    # A：甘特圖
    a = open_as(browser, base_url, E2E_USERS["admin"], "/tasks/gantt", width)
    created = a.request.post("/api/tasks", data={"title": f"{P} ntu ranking new workflow"})
    task = created.json()

    # B：開啟任務抽屜
    b = open_as(browser, base_url, E2E_USERS["member"], f"/tasks/list?q={P}&task={task['id']}", width)
    expect(b.locator(".task-drawer").get_by_text("建立於")).to_be_visible()

    # C：在清單就地編輯同一任務的標題（尚未送出）
    c = open_as(browser, base_url, E2E_USERS["peer"], f"/tasks/list?q={P}", width)
    # 以 id 定位列（編輯中時列文字會變成輸入框）
    row = c.locator(f'.tl-row--task[data-task-id="{task["id"]}"]')
    expect(row).to_be_visible()
    # C 的清單列：B 正在看 → 小頭像
    expect(row.locator(".pr-dots")).to_be_visible(timeout=10_000)
    expect(row.locator(".pr-dots")).to_have_attribute("aria-label", "一般成員 也正在看這個任務")
    shot(c, f"{width}-list-mini-avatars")

    row.locator(".tl-field--title .tl-title-text").click()
    inp = row.locator(".tl-field--title input")
    expect(inp).to_be_focused()
    inp.fill(f"{P} 晴恩改的標題")

    # A：頂欄堆疊出現 B、C，hover C 顯示「正在編輯」
    stack = stack_of(a)
    peer_btn = stack.get_by_role("button", name=re.compile(r"^晴恩，"))
    member_btn = stack.get_by_role("button", name=re.compile(r"^一般成員，"))
    expect(peer_btn).to_be_visible(timeout=10_000)
    expect(member_btn).to_be_visible()
    a.mouse.move(10, 400)
    shot(a, f"{width}-header-stack")
    peer_btn.hover()
    card = a.locator(".pr-card")
    expect(card).to_contain_text("晴恩")
    expect(card).to_contain_text(f"正在編輯「{task['title']}」", timeout=10_000)
    shot(a, f"{width}-hover-card-editing")
    member_btn.hover()
    expect(card).to_contain_text(f"看「{task['title']}」")
    shot(a, f"{width}-hover-card-viewing")

    # B：抽屜提示條「晴恩 正在編輯」；B 的清單列也有 C 的小頭像
    hint = b.locator(".task-drawer .pr-hint")
    expect(hint.locator(".pr-hint-text")).to_have_text("晴恩 正在編輯", timeout=10_000)
    expect(row_of(b, task["title"]).locator('.pr-mini[data-mode="editing"]')).to_be_visible()
    shot(b, f"{width}-drawer-hint")

    # A：全部成員面板
    a.mouse.move(10, 400)
    stack.get_by_role("button", name=re.compile(r"^全部成員")).click()
    panel = a.get_by_role("dialog", name="全部成員")
    expect(panel).to_be_visible()
    expect(panel.locator(".pr-row", has_text="晴恩")).to_contain_text("正在編輯")
    expect(panel.locator(".pr-row", has_text="一般成員")).to_contain_text(task["title"])
    expect(panel.get_by_role("checkbox", name="隱藏我的動態")).to_be_visible()
    shot(a, f"{width}-panel")

    # C 送出 → B 的抽屜即時更新標題；提示條回到「也正在看」或消失
    inp.press("Enter")
    new_title = f"{P} 晴恩改的標題"
    expect(b.locator(".task-drawer h2")).to_contain_text(new_title, timeout=5_000)
    expect(b.locator(".task-drawer .pr-hint", has_text="正在編輯")).to_have_count(0, timeout=10_000)

    # C：看得到 A 在甘特圖
    stack_of(c).get_by_role("button", name=re.compile(r"^全部成員")).click()
    expect(c.get_by_role("dialog", name="全部成員").locator(".pr-row", has_text="管理員")).to_contain_text("甘特圖")

    # C 關閉 → A 的面板在 60 秒內顯示晴恩離線，並帶「最後看的是」
    c.context.close()
    offline = panel.locator('.pr-row[data-status="offline"]', has_text="晴恩")
    expect(offline).to_be_visible(timeout=60_000)
    expect(offline).to_contain_text("最後上線")
    expect(offline).to_contain_text("最後看的是 清單")
    shot(a, f"{width}-panel-offline")

    a.context.close()
    b.context.close()


def test_kanban_card_shows_mini_avatar(browser: Browser, base_url: str):
    """看板卡片：他人開啟中的任務顯示小頭像"""
    P = f"PRK-{int(time.time() * 1000)}"
    width = int(os.environ.get("PRESENCE_SHOT_WIDTH") or 1280)
    a = open_as(browser, base_url, E2E_USERS["admin"], f"/tasks/kanban?q={P}", width)
    task = a.request.post("/api/tasks", data={"title": f"{P} 看板任務"}).json()
    c = open_as(browser, base_url, E2E_USERS["peer"], f"/tasks/kanban?q={P}&task={task['id']}", width)
    expect(c.locator(".task-drawer").get_by_text("建立於")).to_be_visible()
    card = a.locator(f'.kanban-card[data-task-id="{task["id"]}"]')
    expect(card.locator(".pr-dots")).to_have_attribute("aria-label", "晴恩 也正在看這個任務", timeout=10_000)
    shot(a, f"{width}-kanban-sticker")
    a.context.close()
    c.context.close()


def test_hide_my_activity(browser: Browser, base_url: str):
    """隱藏我的動態：別人只看到在線，看不到在看什麼"""
    a = open_as(browser, base_url, E2E_USERS["admin"], "/feedback")
    c = open_as(browser, base_url, E2E_USERS["peer"], "/feedback")
    stack = stack_of(a)
    expect(stack.get_by_role("button", name=re.compile(r"^晴恩，"))).to_have_accessible_name(
        re.compile(r"問題回饋"), timeout=10_000
    )

    stack_of(c).get_by_role("button", name=re.compile(r"^全部成員")).click()
    c.get_by_role("checkbox", name="隱藏我的動態").check()
    expect(c.get_by_text("大家只會看到你在線上，不會看到你在看什麼")).to_be_visible()
    expect(stack.get_by_role("button", name=re.compile(r"^晴恩，"))).to_have_accessible_name(
        re.compile(r"^晴恩，(在線，在線上|閒置，暫時離開一下)$"), timeout=10_000
    )
    # 還原（localStorage 屬於 C 的 context，關閉即清除；仍明確取消）
    c.get_by_role("checkbox", name="隱藏我的動態").uncheck()
    a.context.close()
    c.context.close()


def test_presence_does_not_extend_idle_logout(page: Page):
    """presence 不延長閒置登出（page.clock）"""
    presence_puts: list[str] = []

    def on_request(r):
        if r.method == "PUT" and urlparse(r.url).path == "/api/presence":
            presence_puts.append(r.url)

    page.on("request", on_request)
    page.clock.install()
    login_via_ui(page, E2E_USERS["member"], "/feedback")
    expect(page).to_have_url(re.compile(r"/feedback$"))
    before = page.request.get("/api/auth/me").json()

    # 持續移動滑鼠（presence 視為活動、會送 keepalive；閒置計時只認點擊 / 鍵盤 / 滾輪）
    for i in range(3):
        page.mouse.move(200 + i * 10, 300)
        page.clock.fast_forward("05:00")
    # 事件要在呼叫 Playwright API 時才會派送：以 wait_for_timeout 輪詢
    deadline = time.monotonic() + 5
    while len(presence_puts) < 3 and time.monotonic() < deadline:
        page.wait_for_timeout(100)
    assert len(presence_puts) >= 3
    # 伺服器端：presence 回報不刷新 last_active_at
    mid = page.request.get("/api/auth/me").json()
    assert mid["session"]["lastActiveAt"] == before["session"]["lastActiveAt"]

    for i in range(10):
        page.mouse.move(300 + i * 10, 320)
        page.clock.fast_forward("05:00")
    expect(page).to_have_url(re.compile(r"/login\?reason=expired"))
    assert len(presence_puts) >= 5
