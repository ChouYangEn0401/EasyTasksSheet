"""gantt-schedule-drag.spec.ts 的 Python 版：甘特圖未排程任務拖到時間軸排程（docs/design/gantt-overview.md §A7）。"""

from __future__ import annotations

import datetime as _dt
import os
import re
import time

import pytest
from playwright.sync_api import APIRequestContext, Browser, Locator, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 甘特圖：未排程任務拖到時間軸排程（docs/design/gantt-overview.md §A7）。
# 指標拖曳（預覽長條 + 氣泡）、重整保留、復原 / 重做、依負責人分組改指派、預估工時決定天數、
# 拖回未排程區 / Esc 取消、鍵盤拖曳、沒有 tasks.edit 無把手。截圖於設定 GANTT_DRAG_SHOTS 時輸出。
# （原檔 serial：pytest 同檔內本來就照順序跑；後面的測試依賴第一個測試建立的 ids）


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


stamp = _base36(int(time.time() * 1000))
T = {
    "s1": f"排程拖曳-既有A-{stamp}",
    "s2": f"排程拖曳-既有B-{stamp}",
    "u1": f"排程拖曳-無工時-{stamp}",
    "u2": f"排程拖曳-有工時-{stamp}",
    "u3": f"排程拖曳-改指派-{stamp}",
    "u4": f"排程拖曳-鍵盤-{stamp}",
    "u5": f"排程拖曳-取消-{stamp}",
}
SHOTS = os.environ.get("GANTT_DRAG_SHOTS")
json = {"Content-Type": "application/json"}
DW = 32  # 日刻度每日寬
ids = {k: 0 for k in T}
state = {"manager_id": 0, "member_id": 0}

_UNSET = object()


def _poll(fn, expected=_UNSET, *, pred=None, timeout_ms: int = 5000):
    """對應 expect.poll(fn)：重試直到等於 expected（或 pred 成立）。"""
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        value = fn()
        ok = pred(value) if pred is not None else value == expected
        if ok:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"poll 逾時：期望 {expected!r}，實際 {value!r}")
        time.sleep(0.1)


def _match(obj: dict, sub: dict) -> None:
    """對應 toMatchObject。"""
    for k, v in sub.items():
        assert obj.get(k) == v, f"{k}: 期望 {v!r}，實際 {obj.get(k)!r}"


def day(offset: int) -> str:
    d = _dt.date.today() + _dt.timedelta(days=offset)
    return d.isoformat()


def md(offset: int) -> str:
    d = _dt.date.today() + _dt.timedelta(days=offset)
    return f"{d.month}/{d.day}"


def get_task(req: APIRequestContext, tid: int) -> dict:
    return req.get(f"/api/tasks/{tid}").json()


def GANTT_URL() -> str:
    return f"/tasks/gantt?q={stamp}&scale=day&group=assignee"


def unscheduled_row(page: Page, tid: int) -> Locator:
    return page.get_by_test_id(f"unscheduled-{tid}")


def handle_of(page: Page, tid: int) -> Locator:
    return unscheduled_row(page, tid).locator(".gantt-sched-handle")


def bubble(page: Page) -> Locator:
    return page.get_by_test_id("gantt-sched-bubble")


def live(page: Page) -> Locator:
    return page.get_by_test_id("gantt-sched-live")


def day_x(page: Page, offset: int) -> float:
    """時間軸上「今天 + offset」那一天的中心 x（以既有長條 S1 的起點 = 今天為基準）"""
    box = page.get_by_test_id(f"gantt-bar-{ids['s1']}").bounding_box()
    return box["x"] + offset * DW + DW / 2


def row_y(page: Page, row_key: str) -> float:
    box = page.locator(f'[data-row-key="{row_key}"]').bounding_box()
    return box["y"] + box["height"] / 2


def pointer_drag(page: Page, src: Locator, to: dict, *, shot: str | None = None, before_drop=None) -> None:
    """以 page.mouse 分段移動拖曳（dnd-kit 需要多個 pointermove）；src 為按下的位置"""
    a = src.bounding_box()
    ax = a["x"] + min(a["width"] / 2, 40)
    ay = a["y"] + a["height"] / 2
    page.mouse.move(ax, ay)
    page.mouse.down()
    page.mouse.move(ax + 8, ay - 4, steps=4)
    page.mouse.move(to["x"], to["y"], steps=20)
    page.mouse.move(to["x"] + 2, to["y"], steps=2)
    if shot and SHOTS:
        page.screenshot(path=f"{SHOTS}/{shot}")
    if before_drop:
        before_drop()
    page.mouse.up()
    # dnd-kit 在放下後約 50ms 內會攔下接著的 click
    page.wait_for_timeout(150)


def key(page: Page, k: str) -> None:
    """鍵盤拖曳的按鍵間留一點時間（dnd-kit 鍵盤感應器在拿起後的下一個 tick 才開始監聽）"""
    page.keyboard.press(k)
    page.wait_for_timeout(150)


def new_logged_in(browser: Browser, base_url: str, user: dict, next_path: str):
    context = browser.new_context(base_url=base_url, viewport={"width": 1280, "height": 800})
    page = context.new_page()
    login_via_ui(page, user, next_path)
    return context, page


def test_drag_schedule_preview_drop_reload_undo(page: Page):
    """拖曳排程：預覽與氣泡、放下排程、重整保留、復原 / 重做"""
    page.set_viewport_size({"width": 1280, "height": 800})
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    errors = collect_errors(page)
    req = page.request
    users = req.get("/api/users").json()
    manager_id = next(u for u in users if u["username"] == E2E_USERS["manager"]["username"])["id"]
    member_id = next(u for u in users if u["username"] == E2E_USERS["member"]["username"])["id"]
    state["manager_id"] = manager_id
    state["member_id"] = member_id

    def create(data: dict) -> int:
        return req.post("/api/tasks", headers=json, data=data).json()["id"]

    ids["s1"] = create({"title": T["s1"], "assigneeId": manager_id, "startDate": day(0), "dueDate": day(2)})
    ids["s2"] = create({"title": T["s2"], "assigneeId": member_id, "startDate": day(1), "dueDate": day(3)})
    ids["u1"] = create({"title": T["u1"], "assigneeId": manager_id})
    ids["u2"] = create({"title": T["u2"], "assigneeId": manager_id, "estimateHours": 12})
    ids["u3"] = create({"title": T["u3"], "assigneeId": manager_id})
    ids["u4"] = create({"title": T["u4"], "assigneeId": manager_id})
    ids["u5"] = create({"title": T["u5"], "assigneeId": manager_id})

    page.goto(GANTT_URL())
    expect(page.get_by_test_id(f"gantt-bar-{ids['s1']}")).to_be_visible()
    expect(unscheduled_row(page, ids["u1"])).to_be_visible()

    # 把手：hover 才顯示；有中文標籤；「排入日期」仍在
    unscheduled_row(page, ids["u1"]).hover()
    expect(handle_of(page, ids["u1"])).to_have_attribute("aria-label", f"拖曳「{T['u1']}」到時間軸排程")
    expect(handle_of(page, ids["u1"])).to_have_css("opacity", "1")
    expect(unscheduled_row(page, ids["u1"]).get_by_role("button", name="排入日期")).to_be_visible()

    # 整列按住（從標題處）拖到管理者那一組、今天 + 5 → 預覽 3 天，氣泡顯示日期區間
    x5 = day_x(page, 5)
    y_manager = row_y(page, f"t{ids['s1']}")

    def check_preview():
        expect(bubble(page)).to_contain_text(f"{md(5)} – {md(7)}（3 天）")
        expect(bubble(page)).not_to_contain_text("指派給")
        expect(page.get_by_test_id("gantt-sched-preview")).to_be_visible()
        expect(page.locator(f'[data-row-key="u{manager_id}"]')).to_have_class(re.compile(r"is-drop-target"))
        expect(page.locator(".gantt-sched-col")).to_have_count(1)

    with page.expect_response(
        lambda r: r.url.endswith(f"/api/tasks/{ids['u1']}") and r.request.method == "PATCH"
    ) as patched:
        pointer_drag(
            page,
            unscheduled_row(page, ids["u1"]).locator(".gantt-unscheduled-title"),
            {"x": x5, "y": y_manager},
            shot="dragging-1280.png",
            before_drop=check_preview,
        )
    assert patched.value.status == 200
    # 樂觀更新：立刻離開未排程區、長條出現在該日期且寬 3 天
    expect(unscheduled_row(page, ids["u1"])).to_have_count(0)
    bar = page.get_by_test_id(f"gantt-bar-{ids['u1']}")
    expect(bar).to_be_visible()
    bar_box = bar.bounding_box()
    assert round(bar_box["x"] - (x5 - DW / 2)) == 0
    assert round(bar_box["width"]) == 3 * DW
    expect(page.locator(f'[data-row-key="t{ids["u1"]}"]')).to_have_class(re.compile(r"is-flash"))
    expect(page.get_by_text(f"已排程『{T['u1']}』：{md(5)} – {md(7)}")).to_be_visible()
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/dropped-1280.png")
    _match(get_task(req, ids["u1"]), {"startDate": day(5), "dueDate": day(7), "assigneeId": manager_id})

    # 重整後保留
    page.reload()
    expect(page.get_by_test_id(f"gantt-bar-{ids['u1']}")).to_be_visible()
    expect(unscheduled_row(page, ids["u1"])).to_have_count(0)

    # 重整會清空復原堆疊 → 再排一次以測試復原 / 重做（U2：預估 12 小時 → 2 天）
    x10 = day_x(page, 10)
    unscheduled_row(page, ids["u2"]).hover()
    pointer_drag(
        page,
        handle_of(page, ids["u2"]),
        {"x": x10, "y": row_y(page, f"t{ids['s1']}")},
        before_drop=lambda: expect(bubble(page)).to_contain_text(f"{md(10)} – {md(11)}（2 天）"),
    )
    _poll(lambda: get_task(req, ids["u2"])["dueDate"], day(11))
    assert get_task(req, ids["u2"])["startDate"] == day(10)
    expect(page.get_by_test_id(f"gantt-bar-{ids['u2']}")).to_be_visible()

    # Ctrl+Z → 回到未排程；Ctrl+Shift+Z → 再排程
    page.evaluate("() => document.activeElement?.blur()")
    page.keyboard.press("Control+z")
    expect(page.get_by_text(re.compile(r"已復原：排程『"))).to_be_visible()
    _poll(lambda: get_task(req, ids["u2"])["startDate"], None)
    assert get_task(req, ids["u2"])["dueDate"] is None
    expect(unscheduled_row(page, ids["u2"])).to_be_visible()
    page.keyboard.press("Control+Shift+z")
    _poll(lambda: get_task(req, ids["u2"])["startDate"], day(10))
    expect(page.get_by_test_id(f"gantt-bar-{ids['u2']}")).to_be_visible()
    expect(unscheduled_row(page, ids["u2"])).to_have_count(0)

    assert errors == []


def test_drag_to_other_assignee_row_reassigns(page: Page):
    """拖曳排程：依負責人分組拖到別人的列 → 改指派（氣泡與 toast 寫明）"""
    page.set_viewport_size({"width": 1280, "height": 800})
    login_via_ui(page, E2E_USERS["admin"], GANTT_URL())
    req = page.request
    member_id = state["member_id"]
    member_name = E2E_USERS["member"]["display_name"]
    expect(page.get_by_test_id(f"gantt-bar-{ids['s2']}")).to_be_visible()
    y_member = row_y(page, f"t{ids['s2']}")
    unscheduled_row(page, ids["u3"]).hover()

    def check():
        expect(bubble(page)).to_contain_text(f"{md(3)} – {md(5)}（3 天）")
        expect(bubble(page)).to_contain_text(f"同時指派給 {member_name}")
        expect(page.locator(f'[data-row-key="u{member_id}"]')).to_have_class(re.compile(r"is-drop-target"))

    pointer_drag(page, handle_of(page, ids["u3"]), {"x": day_x(page, 3), "y": y_member}, before_drop=check)
    _poll(lambda: get_task(req, ids["u3"])["assigneeId"], member_id)
    _match(get_task(req, ids["u3"]), {"startDate": day(3), "dueDate": day(5)})
    expect(page.get_by_text(f"同時指派給 {member_name}")).to_be_visible()
    expect(page.get_by_test_id(f"gantt-bar-{ids['u3']}")).to_be_visible()


def test_drag_back_or_escape_cancels(page: Page):
    """拖曳排程：拖回未排程區 = 取消；拖曳中 Esc = 取消"""
    page.set_viewport_size({"width": 1280, "height": 800})
    login_via_ui(page, E2E_USERS["admin"], GANTT_URL())
    req = page.request
    expect(page.get_by_test_id(f"gantt-bar-{ids['s1']}")).to_be_visible()
    patch_count = {"n": 0}

    def on_request(r):
        if r.method == "PATCH" and r.url.endswith(f"/api/tasks/{ids['u5']}"):
            patch_count["n"] += 1

    page.on("request", on_request)

    # 先移到時間軸（出現預覽），再拖回未排程區放開
    y_manager = row_y(page, f"t{ids['s1']}")
    x4 = day_x(page, 4)
    unscheduled_row(page, ids["u5"]).hover()
    h = handle_of(page, ids["u5"]).bounding_box()
    page.mouse.move(h["x"] + h["width"] / 2, h["y"] + h["height"] / 2)
    page.mouse.down()
    page.mouse.move(h["x"] + 10, h["y"], steps=4)
    page.mouse.move(x4, y_manager, steps=16)
    expect(bubble(page)).to_be_visible()
    head = page.locator(".gantt-unscheduled-head").bounding_box()
    page.mouse.move(head["x"] + 400, head["y"] + head["height"] / 2, steps=12)
    expect(bubble(page)).to_have_count(0)
    expect(page.locator(".gantt-sched-overlay")).to_contain_text(T["u5"])
    expect(live(page)).to_have_text("不在時間軸上，放開將取消")
    page.mouse.up()
    page.wait_for_timeout(300)
    expect(live(page)).to_have_text(f"已取消排程『{T['u5']}』")
    expect(unscheduled_row(page, ids["u5"])).to_be_visible()

    # Esc 取消
    unscheduled_row(page, ids["u5"]).hover()
    h2 = handle_of(page, ids["u5"]).bounding_box()
    page.mouse.move(h2["x"] + h2["width"] / 2, h2["y"] + h2["height"] / 2)
    page.mouse.down()
    page.mouse.move(h2["x"] + 10, h2["y"], steps=4)
    page.mouse.move(x4, y_manager, steps=16)
    expect(bubble(page)).to_be_visible()
    page.keyboard.press("Escape")
    expect(bubble(page)).to_have_count(0)
    page.mouse.up()
    page.wait_for_timeout(300)
    assert patch_count["n"] == 0
    _match(get_task(req, ids["u5"]), {"startDate": None, "dueDate": None})
    # 拖曳中按 Esc 不會關掉頁面上的其他東西；未排程列仍在
    expect(unscheduled_row(page, ids["u5"])).to_be_visible()


def test_keyboard_schedule(page: Page):
    """拖曳排程：鍵盤（Space 拿起、←→ 日期、↑↓ 分組列、Space 放下、Esc 取消）"""
    page.set_viewport_size({"width": 1280, "height": 800})
    login_via_ui(page, E2E_USERS["admin"], GANTT_URL())
    req = page.request
    member_name = E2E_USERS["member"]["display_name"]
    expect(page.get_by_test_id(f"gantt-bar-{ids['s1']}")).to_be_visible()

    # Esc 取消
    handle_of(page, ids["u5"]).focus()
    key(page, "Space")
    expect(live(page)).to_contain_text(f"已拿起『{T['u5']}』")
    expect(live(page)).to_contain_text(f"預計排程 {md(0)} 到 {md(2)}")
    key(page, "ArrowRight")
    expect(live(page)).to_have_text(f"預計排程 {md(1)} 到 {md(3)}")
    key(page, "Escape")
    expect(live(page)).to_have_text(f"已取消排程『{T['u5']}』")
    _match(get_task(req, ids["u5"]), {"startDate": None, "dueDate": None})

    # 拿起 → 右移兩天 → ↑ 到「一般成員」列（改指派）→ ↓ 回自己的列 → Space 放下
    handle_of(page, ids["u4"]).focus()
    key(page, "Space")
    key(page, "ArrowRight")
    key(page, "ArrowRight")
    expect(live(page)).to_have_text(f"預計排程 {md(2)} 到 {md(4)}")
    key(page, "ArrowUp")
    expect(live(page)).to_have_text(f"預計排程 {md(2)} 到 {md(4)}，指派給 {member_name}")
    expect(bubble(page)).to_contain_text(f"同時指派給 {member_name}")
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/keyboard-1280.png")
    key(page, "ArrowDown")
    expect(live(page)).to_have_text(f"預計排程 {md(2)} 到 {md(4)}")
    key(page, "Space")
    expect(live(page)).to_have_text(f"已排程『{T['u4']}』：{md(2)} 到 {md(4)}")
    _poll(lambda: get_task(req, ids["u4"])["startDate"], day(2))
    _match(get_task(req, ids["u4"]), {"dueDate": day(4), "assigneeId": state["manager_id"]})
    # 焦點移到新長條所在列
    expect(page.locator(f'[data-row-key="t{ids["u4"]}"]')).to_be_focused()


def test_768_handle_always_visible(page: Page):
    """拖曳排程：768 寬把手常駐、拖曳中截圖"""
    page.set_viewport_size({"width": 768, "height": 900})
    login_via_ui(page, E2E_USERS["admin"], GANTT_URL())
    expect(page.get_by_test_id(f"gantt-bar-{ids['s1']}")).to_be_visible()
    expect(handle_of(page, ids["u5"])).to_have_css("opacity", "1")
    x = day_x(page, 3)
    y = row_y(page, f"t{ids['s1']}")

    def check_and_cancel():
        expect(bubble(page)).to_contain_text(f"{md(3)} – {md(5)}（3 天）")
        # 不實際排程：Esc 取消
        page.keyboard.press("Escape")

    pointer_drag(page, handle_of(page, ids["u5"]), {"x": x, "y": y}, shot="dragging-768.png", before_drop=check_and_cancel)
    _match(get_task(page.request, ids["u5"]), {"startDate": None, "dueDate": None})
    if SHOTS:
        handle_of(page, ids["u5"]).focus()
        key(page, "Space")
        key(page, "ArrowRight")
        page.screenshot(path=f"{SHOTS}/keyboard-768.png")
        key(page, "Escape")


def test_no_handle_without_tasks_edit(browser: Browser, base_url: str):
    """拖曳排程：沒有 tasks.edit 看不到把手"""
    root_ctx, root_page = new_logged_in(browser, base_url, E2E_USERS["admin"], "/tasks/list")
    try:
        res = root_page.request.put(
            "/api/admin/permissions",
            headers=json,
            data={"changes": [{"role": "user", "capability": "tasks.edit", "allowed": False}]},
        )
        assert res.status == 200
        member_ctx, member_page = new_logged_in(browser, base_url, E2E_USERS["member"], GANTT_URL())
        expect(unscheduled_row(member_page, ids["u5"])).to_be_visible()
        unscheduled_row(member_page, ids["u5"]).hover()
        expect(member_page.locator(".gantt-sched-handle")).to_have_count(0)
        member_ctx.close()
        # admin（root）仍有把手
        root_page.goto(GANTT_URL())
        expect(handle_of(root_page, ids["u5"])).to_have_count(1)
    finally:
        root_page.request.put(
            "/api/admin/permissions",
            headers=json,
            data={"changes": [{"role": "user", "capability": "tasks.edit", "allowed": True}]},
        )
        root_ctx.close()
