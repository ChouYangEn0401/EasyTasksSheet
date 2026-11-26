"""task-discussion.spec.ts 的 Python 版：任務抽屜的討論區（討論串、@提及、未讀）與描述鎖定。docs/design/task-discussion.md"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

import pytest
from playwright.sync_api import Browser, Page, expect

from .helpers import E2E_USERS, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# feat/task-discussion：任務抽屜的討論區（討論串、@提及、未讀）與描述鎖定。docs/design/task-discussion.md
# （原檔 serial：pytest 同檔內本來就照順序跑）

# 設定 DISCUSSION_SHOTS=<資料夾> 時輸出版面截圖（人工檢查用）
SHOTS = os.environ.get("DISCUSSION_SHOTS")


def shot(page: Page, name: str) -> None:
    if not SHOTS:
        return
    Path(SHOTS).mkdir(parents=True, exist_ok=True)
    page.wait_for_timeout(250)
    page.screenshot(path=str(Path(SHOTS) / f"{name}.png"))


@pytest.fixture(scope="module")
def disc_browser(browser, browser_type, browser_type_launch_args):
    """截圖時顯示捲軸（headless 預設隱藏捲軸，看不到捲軸設計）：另開一個不帶 --hide-scrollbars 的瀏覽器。"""
    if not SHOTS:
        yield browser
        return
    b = browser_type.launch(**{**browser_type_launch_args, "ignore_default_args": ["--hide-scrollbars"]})
    yield b
    b.close()


SYNC = 5_000


def _to_pass(fn, timeout_ms: int = 5000) -> None:
    """對應 expect(async () => {...}).toPass()：重試到不再丟 AssertionError。"""
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        try:
            fn()
            return
        except AssertionError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.1)


def open_as(browser: Browser, base_url: str, user: dict, path: str, width: int = 1280) -> Page:
    context = browser.new_context(base_url=base_url, viewport={"width": width, "height": 800})
    page = context.new_page()
    login_via_ui(page, user, path)
    return page


def create_task(page: Page, data: dict) -> dict:
    res = page.request.post("/api/tasks", data=data)
    assert res.ok, res.text()
    return res.json()


def comment(page: Page, task_id: int, data: dict) -> dict:
    res = page.request.post(f"/api/tasks/{task_id}/comments", data=data)
    assert res.ok, res.text()
    return res.json()


def drawer_of(page: Page):
    return page.locator(".task-drawer")


def disc_of(page: Page):
    return page.locator("section.disc")


def msg_of(page: Page, text):
    """討論區中內容含 text 的訊息"""
    return disc_of(page).locator(".disc-body").filter(has_text=text)


def row_of(page: Page, title: str):
    return page.locator(".tl-row--task", has_text=title)


def test_lock_description_thread_realtime_resolve_mention(disc_browser: Browser, base_url: str):
    """鎖定描述 → 成員被擋並看到提示 → 討論串、即時同步、已解決、@提及未讀"""
    browser = disc_browser
    P = f"DISC-{int(time.time() * 1000)}"
    mgr = open_as(browser, base_url, E2E_USERS["manager"], f"/tasks/list?q={P}")
    task = create_task(
        mgr,
        {
            "title": f"{P} 報表模組測試",
            "description": "報表生成模組需要再測一次。\n確認 (1) feature (2) pipeline 可用。",
        },
    )

    # 管理者在詳情鎖定描述
    mgr.goto(f"/tasks/list?q={P}&task={task['id']}")
    m_drawer = drawer_of(mgr)
    expect(m_drawer.get_by_text("建立於")).to_be_visible()
    expect(disc_of(mgr).get_by_text("還沒有討論")).to_be_visible()
    shot(mgr, "1280-empty")
    m_drawer.get_by_role("button", name="鎖定（避免誤改）").click()
    expect(m_drawer.get_by_role("note").get_by_text("描述已鎖定")).to_be_visible()
    expect(m_drawer.get_by_role("button", name="解除鎖定")).to_have_attribute("aria-pressed", "true")
    # 有權限者仍可編輯描述
    expect(m_drawer.get_by_role("textbox", name="描述")).not_to_have_attribute("readonly", re.compile(".*"))

    # 成員：描述唯讀、看到提示條；API 直接改也被擋
    mem = open_as(browser, base_url, E2E_USERS["member"], f"/tasks/list?q={P}&task={task['id']}")
    u_drawer = drawer_of(mem)
    banner = u_drawer.get_by_role("note")
    expect(banner).to_contain_text("描述已鎖定")
    expect(banner).to_contain_text("有補充或筆記，歡迎寫在下方討論區")
    expect(u_drawer.get_by_role("textbox", name="描述")).to_have_attribute("readonly", "")
    expect(u_drawer.get_by_role("button", name="鎖定（避免誤改）")).to_have_count(0)
    banner.scroll_into_view_if_needed()
    shot(mem, "1280-lock-banner")
    denied = mem.request.patch(f"/api/tasks/{task['id']}", data={"description": "亂改"})
    assert denied.status == 403
    assert denied.json()["error"]["message"] == "描述已由管理者鎖定，請把補充寫在討論區"
    # 其他欄位不受影響
    assert mem.request.patch(f"/api/tasks/{task['id']}", data={"progress": 20}).ok

    # 成員在討論區發表（Enter 送出）
    u_input = disc_of(mem).get_by_role("combobox", name="討論區訊息")
    u_input.fill("請問 pipeline 要跑哪個分支？")
    u_input.press("Enter")
    expect(msg_of(mem, "請問 pipeline 要跑哪個分支？")).to_be_visible()
    expect(u_input).to_have_value("")

    # 管理者即時看到並回覆，形成討論串；@ 選單提及成員
    m_disc = disc_of(mgr)
    expect(msg_of(mgr, "請問 pipeline 要跑哪個分支？")).to_be_visible(timeout=SYNC)
    # 成員先關閉抽屜（之後的提及才會顯示為未讀）
    u_drawer.get_by_role("button", name="關閉任務詳情").click()
    expect(u_drawer).to_have_count(0)

    # 回覆 / 標記已解決在滑鼠移入訊息時出現
    msg_of(mgr, "請問 pipeline 要跑哪個分支？").hover()
    m_disc.get_by_role("button", name="回覆", exact=True).first.click()
    expect(m_disc.get_by_text("回覆 @一般成員 的訊息")).to_be_visible()
    m_input = m_disc.get_by_role("combobox", name="討論區訊息")
    m_input.press_sequentially("@mem")
    option = m_disc.get_by_role("option", name=re.compile(r"一般成員"))
    expect(option).to_be_visible()
    m_input.press("Enter")
    expect(m_input).to_have_value("@member ")
    m_input.press_sequentially("跑 main 就好")
    m_input.press("Enter")
    expect(msg_of(mgr, "跑 main 就好")).to_be_visible()
    expect(m_disc.locator(".disc-replies .disc-mention").first).to_have_text("@一般成員")
    shot(mgr, "1280-thread-expanded")

    # @提及：成員的清單徽章出現未讀
    badge = row_of(mem, task["title"]).locator(".task-badge--comments")
    expect(badge).to_be_visible(timeout=SYNC)
    expect(badge).to_have_attribute("data-unread", "true", timeout=SYNC)
    expect(row_of(mem, task["title"]).locator(".task-badge--lock")).to_be_visible()
    shot(mem, "1280-list-badges")

    # 開啟後：串預設收合（未讀在回覆中會自動展開）、看得到未讀分隔線；已讀後徽章不再強調
    mem.goto(f"/tasks/list?q={P}&task={task['id']}")
    u_disc = disc_of(mem)
    expect(msg_of(mem, "跑 main 就好")).to_be_visible()
    expect(u_disc.get_by_role("separator", name="以下為未讀訊息")).to_be_visible()
    expect(badge).not_to_have_attribute("data-unread", "true", timeout=SYNC)
    # 收合 / 展開回覆
    u_disc.get_by_role("button", name="收合回覆").click()
    expect(msg_of(mem, "跑 main 就好")).to_have_count(0)
    u_disc.get_by_role("button", name="1 則回覆").click()
    expect(msg_of(mem, "跑 main 就好")).to_be_visible()

    # 管理者標記已解決 → 雙方看到「已解決」並淡化收合
    msg_of(mgr, "請問 pipeline 要跑哪個分支？").hover()
    m_disc.get_by_role("button", name="標記為已解決").click()
    expect(m_disc.locator(".disc-resolved-tag")).to_be_visible()
    expect(u_disc.locator(".disc-resolved-tag")).to_be_visible(timeout=SYNC)
    expect(u_disc.locator('.disc-thread[data-resolved="true"]')).to_have_count(1)
    u_disc.get_by_role("button", name="未解決", exact=True).click()
    expect(u_disc.get_by_text("目前沒有未解決的討論。")).to_be_visible()
    u_disc.get_by_role("button", name="全部", exact=True).click()

    # 看板卡片也有徽章
    mem.goto(f"/tasks/kanban?q={P}")
    card = mem.locator(".kanban-card", has_text=task["title"])
    expect(card.locator(".task-badge--comments")).to_contain_text("2")
    expect(card.locator(".task-badge--lock")).to_be_visible()
    shot(mem, "1280-kanban-badges")

    # 一般成員不能切換鎖（API）
    toggle = mem.request.patch(f"/api/tasks/{task['id']}", data={"descriptionLocked": False})
    assert toggle.status == 403

    mgr.context.close()
    mem.context.close()


def test_bulk_messages_fixed_height_load_older_focus_mode(disc_browser: Browser, base_url: str):
    """大量訊息：討論區高度固定、不撐開抽屜，可載入更早的討論；聚焦模式與 Esc 還原"""
    browser = disc_browser
    P = f"DISC-BULK-{int(time.time() * 1000)}"
    admin = open_as(browser, base_url, E2E_USERS["admin"], f"/tasks/list?q={P}")
    peer = open_as(browser, base_url, E2E_USERS["peer"], f"/tasks/list?q={P}")
    task = create_task(admin, {"title": f"{P} 很多討論"})
    # 速率限制為每人每分鐘 30 則：兩位成員各建 30 則
    roots = []
    for i in range(30):
        roots.append(comment(admin, task["id"], {"body": f"管理員的討論 {i + 1}"}))
    for i in range(30):
        body = (
            "很長的訊息\n" + "\n".join(f"第 {k + 1} 行：補充說明" for k in range(12))
            if i == 29
            else f"晴恩的回覆 {i + 1}"
        )
        data = {"body": body}
        if i < 12:
            data["parentId"] = roots[29]["id"]
        comment(peer, task["id"], data)
    too_many = admin.request.post(f"/api/tasks/{task['id']}/comments", data={"body": "第 31 則"})
    assert too_many.status == 429

    # 先標記已讀：沒有未讀時進入會捲到最新、回覆全部收合（未讀分隔線在第一個測試驗證）
    assert admin.request.post(f"/api/tasks/{task['id']}/comments/read", data={}).ok
    admin.goto(f"/tasks/list?q={P}&task={task['id']}")
    drawer = drawer_of(admin)
    disc = disc_of(admin)
    expect(disc.get_by_text("展開全文")).to_be_visible()
    scroll = disc.locator(".disc-scroll")

    # 高度固定：clamp(240px, 42vh, 460px)；800 高 → 336px。抽屜本身不捲動、不超出視窗
    disc_box = disc.bounding_box()
    assert round(disc_box["height"]) == 336
    drawer_box = drawer.bounding_box()
    assert drawer_box["y"] + drawer_box["height"] <= 800 + 1
    overflow = scroll.evaluate("(el) => el.scrollHeight > el.clientHeight")
    assert overflow is True
    # 輸入框固定在底部（不在捲動區內）
    expect(disc.locator(".disc-scroll .disc-composer")).to_have_count(0)
    expect(disc.get_by_role("combobox", name="討論區訊息")).to_be_in_viewport()

    # 進入時捲到最新（貼底）
    at_bottom = scroll.evaluate("(el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60")
    assert at_bottom is True
    # 串內回覆預設收合
    expect(disc.get_by_role("button", name=re.compile(r"^12 則回覆"))).to_be_visible()
    disc.get_by_role("button", name=re.compile(r"^12 則回覆")).click()
    expect(disc.get_by_role("button", name=re.compile(r"顯示更早的回覆（7）"))).to_be_visible()
    disc.get_by_role("button", name=re.compile(r"顯示更早的回覆")).click()
    expect(disc.get_by_role("button", name=re.compile(r"顯示更早的回覆（2）"))).to_be_visible()
    disc.get_by_role("button", name=re.compile(r"顯示更早的回覆")).click()
    expect(msg_of(admin, re.compile(r"^晴恩的回覆 1$"))).to_be_visible()
    expect(disc.get_by_role("button", name=re.compile(r"顯示更早的回覆"))).to_have_count(0)

    # 頂端有「載入更早的討論」（60 則 → 超過 20 串）
    scroll.evaluate("(el) => (el.scrollTop = 0)")
    older = disc.get_by_role("button", name="載入更早的討論")
    expect(older).to_be_visible()
    expect(msg_of(admin, re.compile(r"^管理員的討論 1$"))).to_have_count(0)
    older.click()
    # 依最新活動排序：第二頁為較早的 20 串
    expect(msg_of(admin, re.compile(r"^管理員的討論 9$"))).to_be_attached()
    expect(msg_of(admin, re.compile(r"^管理員的討論 8$"))).to_have_count(0)

    # 不在底部時他人的新訊息 → 顯示「有新訊息」，不強制捲動
    scroll.evaluate("(el) => (el.scrollTop = 0)")
    # 兩位成員都已達速率上限 → 由第三人（member）發新訊息
    member = open_as(browser, base_url, E2E_USERS["member"], f"/tasks/list?q={P}")
    comment(member, task["id"], {"body": "成員的新訊息"})
    jump = disc.get_by_role("button", name="有新訊息")
    expect(jump).to_be_visible(timeout=10_000)
    assert scroll.evaluate("(el) => el.scrollTop") < 50
    # 捲軸 hover 狀態截圖
    scroll.hover()
    shot(admin, "1280-scrollbar-hover")
    jump.click()
    expect(msg_of(admin, "成員的新訊息")).to_be_in_viewport()

    # 聚焦模式：討論區佔滿抽屜，內容區隱藏；Esc 還原
    disc.get_by_role("button", name="展開討論區").click()
    expect(drawer.locator(".task-drawer-body")).to_be_hidden()
    focus_box = disc.bounding_box()
    assert focus_box["height"] > 600
    shot(admin, "1280-focus-mode")
    scroll.click(position={"x": 5, "y": 5})
    admin.keyboard.press("Escape")
    expect(drawer.locator(".task-drawer-body")).to_be_visible()
    expect(drawer).to_be_visible()

    # 768 寬：版面仍可用
    admin.set_viewport_size({"width": 768, "height": 800})
    expect(disc.get_by_role("combobox", name="討論區訊息")).to_be_in_viewport()
    shot(admin, "768-bulk")
    disc.get_by_role("button", name="展開討論區").click()
    shot(admin, "768-focus-mode")
    disc.get_by_role("button", name="還原討論區大小").click()

    admin.context.close()
    peer.context.close()
    member.context.close()


# 斷言一律執行；設定 DISCUSSION_SHOTS 時才額外輸出截圖
def test_768_empty_lock_banner_list_badges(disc_browser: Browser, base_url: str):
    """768 寬：空狀態、鎖定提示與清單徽章"""
    browser = disc_browser
    P = f"DISC-768-{int(time.time() * 1000)}"
    mgr = open_as(browser, base_url, E2E_USERS["manager"], f"/tasks/list?q={P}", 768)
    t1 = create_task(mgr, {"title": f"{P} 有討論", "description": "說明", "descriptionLocked": True})
    create_task(mgr, {"title": f"{P} 沒有討論"})
    comment(mgr, t1["id"], {"body": "第一則：請大家把測試結果補在這裡 https://example.com/report"})
    mem = open_as(browser, base_url, E2E_USERS["member"], f"/tasks/list?q={P}", 768)
    # 768 寬時標題欄放不下徽章，會收成「+N」（aria-label 列出被收合的項目，含留言徽章）
    more_chip = row_of(mem, f"{P} 有討論").locator(".tl-tbadge-more")
    badge = row_of(mem, f"{P} 有討論").locator(".task-badge--comments")

    def check():
        shown = badge.is_visible()
        collapsed = more_chip.count() > 0 and bool(re.search(r"討論", more_chip.get_attribute("aria-label") or ""))
        assert shown or collapsed

    _to_pass(check)
    shot(mem, "768-list-badges")
    mem.goto(f"/tasks/list?q={P}&task={t1['id']}")
    expect(drawer_of(mem).get_by_role("note")).to_be_visible()
    drawer_of(mem).get_by_role("note").scroll_into_view_if_needed()
    shot(mem, "768-lock-banner")
    t2 = create_task(mgr, {"title": f"{P} 空的"})
    mem.goto(f"/tasks/list?q={P}&task={t2['id']}")
    expect(disc_of(mem).get_by_text("還沒有討論")).to_be_visible()
    shot(mem, "768-empty")
    mgr.context.close()
    mem.context.close()
