"""review-fixes.spec.ts 的 Python 版：R2 前端審查修正（復原堆疊、拖曳 Esc、標題徽章、討論區、即時同步請求數、矮視窗、依賴圖示）。"""

from __future__ import annotations

import json as _json
import os
import re
import time
from pathlib import Path
from urllib.parse import quote, urlparse

import pytest
from playwright.sync_api import Browser, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# R2 前端審查修正：復原堆疊、拖曳 Esc、標題徽章、討論區、即時同步請求數、矮視窗、依賴圖示

# 設定 REVIEW_SHOTS=<資料夾> 時輸出截圖（人工檢查用）
SHOTS = os.environ.get("REVIEW_SHOTS")


def shot(page: Page, name: str) -> None:
    if not SHOTS:
        return
    Path(SHOTS).mkdir(parents=True, exist_ok=True)
    page.wait_for_timeout(400)
    page.screenshot(path=str(Path(SHOTS) / f"{name}.png"))


def open_as(browser: Browser, base_url: str, user: dict, path: str, width: int = 1280, height: int = 800) -> Page:
    context = browser.new_context(base_url=base_url, viewport={"width": width, "height": height})
    page = context.new_page()
    login_via_ui(page, user, path)
    return page


def post(page: Page, url: str, data: dict):
    res = page.request.post(url, data=data)
    assert res.ok, res.text()
    return res.json()


def create_task(page: Page, data: dict) -> dict:
    return post(page, "/api/tasks", data)


def drawer_of(page: Page):
    return page.locator(".task-drawer:not([data-leaving])")


def toasts(page: Page):
    return page.get_by_role("region", name="通知")


def undo_btn(page: Page):
    return page.locator('[data-undo-button="undo"]')


def checklist_of(page: Page):
    return page.get_by_test_id("checklist")


def cl_row(page: Page, text: str):
    return checklist_of(page).locator("[data-checklist-row]", has_text=text)


def _p(prefix: str) -> str:
    return f"{prefix}-{int(time.time() * 1000) % 1_000_000}"


def test_m1_undo_permanent_failure_removed(browser: Browser, base_url: str):
    """M1 復原遇到永久性失敗（描述已被鎖定）：移除該筆並提示，之後可復原更早的動作"""
    P = _p("RVM1")
    mgr = open_as(browser, base_url, E2E_USERS["manager"], "/tasks/list")
    task = create_task(mgr, {"title": f"{P} 任務", "description": "原本的描述"})
    mem = open_as(browser, base_url, E2E_USERS["member"], f"/tasks/list?q={P}&task={task['id']}")
    drawer = drawer_of(mem)
    expect(drawer.get_by_text("建立於")).to_be_visible()

    # ① 新增待辦項目
    add = checklist_of(mem).get_by_role("textbox", name="新增待辦")
    add.fill("先做的事")
    add.press("Enter")
    expect(cl_row(mem, "先做的事")).to_have_count(1)
    expect(undo_btn(mem)).to_have_attribute("aria-label", "復原：新增待辦項目『先做的事』")
    # ② 改描述（Esc 離開輸入框即儲存）
    desc = drawer.get_by_role("textbox", name="描述")
    desc.fill("成員改過的描述")
    desc.press("Escape")
    expect(drawer.get_by_text("已儲存")).to_be_visible()
    expect(undo_btn(mem)).to_have_attribute("aria-label", f"復原：修改『{P} 任務』的描述")
    # ③ 管理者鎖定描述
    lock = mgr.request.patch(f"/api/tasks/{task['id']}", data={"descriptionLocked": True})
    assert lock.ok
    expect(drawer.get_by_role("note").get_by_text("描述已鎖定")).to_be_visible(timeout=10_000)

    # 復原描述 → 403（永久性）：從復原紀錄移除並提示
    mem.keyboard.press("Control+z")
    expect(toasts(mem).get_by_text(f"無法復原，已從復原紀錄移除：修改『{P} 任務』的描述")).to_be_visible()
    expect(undo_btn(mem)).to_have_attribute("aria-label", "復原：新增待辦項目『先做的事』")
    # 再按一次：復原更早的動作（不會卡在同一個錯誤）
    mem.keyboard.press("Control+z")
    expect(cl_row(mem, "先做的事")).to_have_count(0)
    expect(toasts(mem).get_by_text("已復原：新增待辦項目『先做的事』")).to_be_visible()

    mgr.context.close()
    mem.context.close()


def test_m3_checklist_drag_escape_keeps_drawer(page: Page):
    """M3 待辦清單拖曳中按 Esc 只取消拖曳，抽屜保持開啟（鍵盤與滑鼠）"""
    P = _p("RVM3")
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    task = create_task(page, {"title": f"{P} 任務"})
    post(page, f"/api/tasks/{task['id']}/checklist", {"items": [{"text": "甲"}, {"text": "乙"}, {"text": "丙"}]})
    page.goto(f"/tasks/list?q={P}&task={task['id']}")
    drawer = drawer_of(page)
    expect(cl_row(page, "丙")).to_have_count(1)

    def order():
        return checklist_of(page).locator("[data-checklist-row] .cl-text").all_text_contents()

    before = order()

    # 鍵盤拖曳：Space 拿起 → ↓ → Esc
    handle = cl_row(page, "甲").get_by_role("button", name=re.compile(r"拖曳排序：甲"))
    handle.focus()
    page.keyboard.press("Space")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    expect(drawer).to_be_visible()
    assert order() == before

    # 滑鼠拖曳中按 Esc
    cl_row(page, "乙").hover()
    box = cl_row(page, "乙").get_by_role("button", name=re.compile(r"拖曳排序：乙")).bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2 + 40, steps=6)
    page.keyboard.press("Escape")
    page.mouse.up()
    page.wait_for_timeout(300)
    expect(drawer).to_be_visible()
    assert order() == before

    # 沒在拖曳時 Esc 照常關閉抽屜
    page.locator(".task-drawer-head").click(position={"x": 5, "y": 5})
    page.keyboard.press("Escape")
    expect(drawer).to_have_count(0)


def test_m2_rapid_comments_and_checks_undo(page: Page):
    """m2 快速連送兩則留言都送達；連續勾選兩項都登記復原"""
    P = _p("RVM2")
    login_via_ui(page, E2E_USERS["manager"], "/tasks/list")
    task = create_task(page, {"title": f"{P} 任務"})
    post(page, f"/api/tasks/{task['id']}/checklist", {"items": [{"text": "甲"}, {"text": "乙"}]})
    page.goto(f"/tasks/list?q={P}&task={task['id']}")
    disc = page.locator("section.disc")
    inp = disc.get_by_role("combobox", name="討論區訊息")
    inp.fill("第一則")
    inp.press("Enter")
    inp.fill("第二則")
    inp.press("Enter")
    expect(disc.locator(".disc-body").filter(has_text=re.compile(r"^第一則$"))).to_be_visible()
    expect(disc.locator(".disc-body").filter(has_text=re.compile(r"^第二則$"))).to_be_visible()
    expect(disc.get_by_text("傳送中…")).to_have_count(0, timeout=5_000)

    # 連續勾選：兩筆都在復原堆疊
    lst = checklist_of(page)
    lst.get_by_role("checkbox", name="標為完成：甲").click()
    lst.get_by_role("checkbox", name="標為完成：乙").click()
    expect(lst.get_by_role("checkbox", name="標為未完成：乙")).to_be_visible()
    page.locator(".task-drawer-head").click(position={"x": 5, "y": 5})
    expect(undo_btn(page)).to_have_attribute("aria-label", "復原：勾選待辦項目『乙』")
    page.keyboard.press("Control+z")
    expect(lst.get_by_role("checkbox", name="標為完成：乙")).to_be_visible()
    expect(undo_btn(page)).to_have_attribute("aria-label", "復原：勾選待辦項目『甲』")
    page.keyboard.press("Control+z")
    expect(lst.get_by_role("checkbox", name="標為完成：甲")).to_be_visible()

    # m4：1.5 秒內勾選又取消，不留下空的復原
    lst.get_by_role("checkbox", name="標為完成：甲").click()
    lst.get_by_role("checkbox", name="標為未完成：甲").click()
    page.wait_for_timeout(500)
    expect(undo_btn(page)).to_be_disabled()


def test_m3_toast_undo_not_on_top(page: Page):
    """m3 toast 的「復原」不在堆疊頂端時：執行後從堆疊移除，之後 Ctrl+Z 不重複執行"""
    P = _p("RVM3T")
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    a = create_task(page, {"title": f"{P} 主任務"})
    b = create_task(page, {"title": f"{P} 相關"})
    post(page, f"/api/tasks/{a['id']}/relations", {"type": "related", "targetId": b["id"]})
    post(page, f"/api/tasks/{a['id']}/checklist", {"text": "甲"})
    page.goto(f"/tasks/list?q={P}&task={a['id']}")
    drawer = drawer_of(page)
    drawer.get_by_role("button", name=f"移除相關任務「{b['title']}」").click()
    rel_toast = toasts(page).locator(".ui-toast").filter(has_text="已移除相關任務")
    expect(toasts(page).get_by_text("已移除相關任務")).to_be_visible()
    # 另一個動作蓋在上面
    checklist_of(page).get_by_role("checkbox", name="標為完成：甲").click()
    expect(undo_btn(page)).to_have_attribute("aria-label", "復原：勾選待辦項目『甲』")
    # 按「已移除相關任務」toast 的復原
    rel_toast.first.get_by_role("button", name="復原").click()
    expect(drawer.get_by_role("button", name=f"移除相關任務「{b['title']}」")).to_be_visible()
    # 堆疊只剩勾選；Ctrl+Z 一次後堆疊清空（相關任務那筆不會再執行一次）
    page.locator(".task-drawer-head").click(position={"x": 5, "y": 5})
    expect(undo_btn(page)).to_have_attribute("aria-label", "復原：勾選待辦項目『甲』")
    page.keyboard.press("Control+z")
    expect(checklist_of(page).get_by_role("checkbox", name="標為完成：甲")).to_be_visible()
    expect(undo_btn(page)).to_be_disabled()
    rels = page.request.get(f"/api/tasks/{a['id']}/relations").json()
    assert len(rels) == 1


def test_m7_request_count_for_one_comment(page: Page):
    """m7 送一則留言的請求數（自己的 SSE 回音不再觸發第二輪重抓）"""
    P = _p("RVM7")
    login_via_ui(page, E2E_USERS["manager"], "/tasks/list")
    task = create_task(page, {"title": f"{P} 任務"})
    post(page, f"/api/tasks/{task['id']}/checklist", {"text": "甲"})
    page.goto(f"/tasks/list?q={P}&task={task['id']}")
    expect(checklist_of(page).get_by_text("甲")).to_be_visible()
    page.wait_for_timeout(1500)
    requests: list[str] = []

    def on_request(r):
        u = urlparse(r.url)
        if u.path.startswith("/api/") and not re.search(r"/api/(events|presence)", u.path):
            requests.append(f"{r.method} {u.path}{'?' + u.query if u.query else ''}")

    page.on("request", on_request)
    inp = page.locator("section.disc").get_by_role("combobox", name="討論區訊息")
    inp.fill("計數用的留言")
    inp.press("Enter")
    expect(page.locator("section.disc .disc-body").filter(has_text="計數用的留言")).to_be_visible()
    page.wait_for_timeout(2500)
    print(f"[m7] 送一則留言的請求數：{len(requests)}\n" + "\n".join(requests))
    # 修正前為 13（mutation 失效整個 ['tasks'] ＋ SSE 回音再失效一次）
    assert len(requests) <= 7
    # 不重抓與留言無關的子資源
    assert [r for r in requests if re.search(r"/(checklist|relations|dependencies|history)", r)] == []


def test_m8_short_viewport_discussion_collapsed(browser: Browser, base_url: str):
    """m8 矮視窗：討論區預設收合（內容區至少 200px），收合 / 展開狀態會記住"""
    P = _p("RVM8")
    page = open_as(browser, base_url, E2E_USERS["manager"], "/tasks/list")
    task = create_task(page, {"title": f"{P} 任務", "description": "描述"})
    post(page, f"/api/tasks/{task['id']}/comments", {"body": "一則討論"})
    # 窄視窗的導覽列為收合選單：以一般寬度登入後再縮成 667×375
    page.set_viewport_size({"width": 667, "height": 375})
    page.goto(f"/tasks/list?q={P}&task={task['id']}")
    drawer = drawer_of(page)
    disc = page.locator("section.disc")
    expect(disc).to_have_attribute("data-mode", "collapsed")
    body = drawer.locator(".task-drawer-body")
    assert body.bounding_box()["height"] >= 200
    shot(page, "667x375-drawer-collapsed")

    # 展開 → 重新整理仍展開（記住使用者的選擇）
    disc.get_by_role("button", name=re.compile(r"^討論")).click()
    expect(disc).to_have_attribute("data-mode", "normal")
    shot(page, "667x375-drawer-expanded")
    page.reload()
    expect(page.locator("section.disc")).to_have_attribute("data-mode", "normal")
    # 收合 → 換到高視窗也維持收合
    page.locator("section.disc").get_by_role("button", name=re.compile(r"^討論")).click()
    page.set_viewport_size({"width": 1280, "height": 800})
    page.reload()
    expect(page.locator("section.disc")).to_have_attribute("data-mode", "collapsed")
    page.locator("section.disc").get_by_role("button", name=re.compile(r"^討論")).click()

    # 1280×500：討論區降高，內容區保有空間
    page.set_viewport_size({"width": 1280, "height": 500})
    page.wait_for_timeout(300)
    h500 = drawer.locator(".task-drawer-body").bounding_box()["height"]
    assert h500 >= 150
    shot(page, "1280x500-drawer")
    for width in [1024, 768]:
        page.set_viewport_size({"width": width, "height": 500})
        page.wait_for_timeout(300)
        assert drawer.locator(".task-drawer-body").bounding_box()["height"] >= 150
        shot(page, f"{width}x500-drawer")
    page.context.close()


_MEASURE_TITLE_CELL = """(cell) => {
    const r = cell.getBoundingClientRect();
    const text = cell.querySelector('.tl-title-text') ?? cell.querySelector('.tl-field');
    const tr = text.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(text).fontSize);
    const box = cell.querySelector('.tl-tbadges');
    const top = box.querySelector('.tl-tbadge:not(:empty)')?.offsetTop ?? 0;
    const visible = [...box.querySelectorAll('.tl-tbadge')].filter(
        (k) => k.offsetWidth > 0 && k.offsetTop <= top + 2,
    );
    const more = cell.querySelector('.tl-tbadge-more');
    const rights = [...visible, ...(more ? [more] : [])].map((e) => e.getBoundingClientRect().right);
    return {
        textWidth: tr.width,
        em,
        cellRight: r.right,
        maxRight: Math.max(...rights),
        boxRight: box.getBoundingClientRect().right,
        visible: visible.map((k) => k.dataset.badge),
        more: more?.getAttribute('aria-label') ?? null,
    };
}"""


def test_m4_m11_title_badges_and_hourglass(browser: Browser, base_url: str):
    """M4 / m11 清單標題：五種徽章齊全時標題保底 8 字、徽章不被切；等待中改用沙漏且可聚焦"""
    P = _p("RVM4")
    mgr = open_as(browser, base_url, E2E_USERS["manager"], "/tasks/list")
    title = f"{P} 報表模組整合測試與部署前檢查"
    main = create_task(mgr, {"title": title, "description": "說明", "descriptionLocked": True})
    blocker = create_task(mgr, {"title": f"{P} 前置"})
    related = create_task(mgr, {"title": f"{P} 相關"})
    post(mgr, f"/api/tasks/{main['id']}/dependencies", {"direction": "blocked_by", "targetId": blocker["id"]})
    post(mgr, f"/api/tasks/{main['id']}/relations", {"type": "related", "targetId": related["id"]})
    post(mgr, f"/api/tasks/{main['id']}/checklist", {"items": [{"text": "甲"}, {"text": "乙"}]})
    post(mgr, f"/api/tasks/{main['id']}/comments", {"body": "請看一下 @member"})
    mem = open_as(browser, base_url, E2E_USERS["member"], f"/tasks/list?q={quote(P, safe='')}")
    row = mem.locator(f'.tl-row--task[data-task-id="{main["id"]}"]')
    expect(row.get_by_test_id("dep-lock")).to_be_visible()

    for width in [1280, 1024, 768]:
        mem.set_viewport_size({"width": width, "height": 800})
        mem.wait_for_timeout(400)
        m = row.locator(".tl-cell--title").evaluate(_MEASURE_TITLE_CELL)
        print(f"[M4] {width}: {_json.dumps(m, ensure_ascii=False)}")
        # 1280 / 1024：標題保底 8 字；768（列動作鈕常駐）保底 4 字
        assert m["textWidth"] >= (8 if width >= 1024 else 4) * m["em"] - 1
        assert m["maxRight"] <= m["cellRight"] + 0.5
        assert m["boxRight"] <= m["cellRight"] + 0.5
        if width >= 1024:
            # 優先保留未讀留言與等待中；其餘收成「+N」
            assert m["visible"][:2] == ["unread", "waiting"]
            if len(m["visible"]) < 5:
                assert re.match(r"^另有 \d+ 項：", m["more"] or "")
        else:
            # 窄寬：全部收成一顆「+5」（有未讀時強調）
            assert m["visible"] == []
            assert re.match(r"^另有 5 項：", m["more"] or "")
            expect(row.get_by_test_id("title-badges-more")).to_have_attribute("data-unread", "true")
        shot(mem, f"list-title-badges-{width}")

    # m11：看板卡片的等待中為沙漏（不是鎖頭）、可用 Tab 聚焦並顯示說明
    mem.set_viewport_size({"width": 1280, "height": 800})
    mem.goto(f"/tasks/kanban?q={quote(P, safe='')}")
    card = mem.locator(".kanban-card", has_text=title)
    hourglass = card.get_by_test_id("dep-lock").get_by_role("img")
    expect(hourglass).to_have_attribute("aria-label", re.compile(r"^等待中："))
    expect(card.get_by_test_id("dep-lock").locator("svg path")).to_have_count(1)
    hourglass.focus()
    expect(mem.get_by_role("tooltip")).to_be_visible()
    expect(hourglass.locator("..")).to_have_attribute("aria-describedby", re.compile(r".+"))
    shot(mem, "kanban-hourglass-focus-1280")
    for width in [1024, 768]:
        mem.set_viewport_size({"width": width, "height": 800})
        mem.wait_for_timeout(300)
        shot(mem, f"kanban-hourglass-{width}")

    mgr.context.close()
    mem.context.close()


def test_delete_task_in_drawer_no_404(page: Page):
    """刪除抽屜中的任務後不出現 404（子資源不重抓）"""
    errors = collect_errors(page)
    P = _p("RV404")
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    task = create_task(page, {"title": f"{P} 要刪的"})
    post(page, f"/api/tasks/{task['id']}/checklist", {"text": "甲"})
    page.goto(f"/tasks/list?q={P}&task={task['id']}")
    drawer = drawer_of(page)
    expect(checklist_of(page).get_by_text("甲")).to_be_visible()
    drawer.get_by_role("button", name="更多動作").click()
    page.get_by_role("menuitem", name="刪除任務").click()
    page.get_by_role("alertdialog").get_by_role("button", name="刪除", exact=True).click()
    expect(page.locator(".task-drawer")).to_have_count(0)
    page.wait_for_timeout(800)
    assert [e for e in errors if not re.search(r"status of 401", e)] == []
