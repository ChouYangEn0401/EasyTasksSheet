"""list-dnd.spec.ts 的 Python 版：清單拖曳（改狀態／負責人、空群組、收合群組、鍵盤拖曳、排序中限制、權限）與表格撐滿寬度。"""

from __future__ import annotations

import json as _json
import os
import re
import time

import pytest
from playwright.sync_api import APIRequestContext, Browser, Locator, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 清單拖曳（docs/design/task-list.md §13）：拖到別的群組改狀態 / 負責人、空群組、收合群組、鍵盤拖曳、
# 排序中限制、權限；以及表格撐滿寬度（§10）。截圖於設定 LIST_DND_SHOTS 時輸出。
# （原檔 serial：pytest 同檔內本來就照順序跑）

stamp = int(time.time() * 1000)
T = {"a": f"拖曳A-{stamp}", "b": f"拖曳B-{stamp}", "c": f"拖曳C-{stamp}", "d": f"拖曳D-{stamp}"}
SHOTS = os.environ.get("LIST_DND_SHOTS")
json = {"Content-Type": "application/json"}

_UNSET = object()


def _poll(fn, expected=_UNSET, *, pred=None, timeout_ms: int = 5000, message: str = ""):
    """對應 expect.poll(fn)：重試直到等於 expected（或 pred 成立）。"""
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        value = fn()
        ok = pred(value) if pred is not None else value == expected
        if ok:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"{message} poll 逾時：期望 {expected!r}，實際 {value!r}")
        time.sleep(0.1)


def list_tasks(req: APIRequestContext) -> list[dict]:
    return req.get(f"/api/tasks?q={stamp}").json()


def task_by_title(req: APIRequestContext, title: str):
    return next((t for t in list_tasks(req) if t["title"] == title), None)


def status_id_of(req: APIRequestContext, name: str) -> int:
    return next(s for s in req.get("/api/statuses").json() if s["name"] == name)["id"]


def user_id_of(req: APIRequestContext, username: str) -> int:
    return next(u for u in req.get("/api/users").json() if u["username"] == username)["id"]


def row(page: Page, title: str) -> Locator:
    return page.locator(".tl-row--task", has_text=title)


def handle(page: Page, title: str) -> Locator:
    return row(page, title).locator(".tl-drag-handle")


def group_row(page: Page, name: str) -> Locator:
    return page.locator(".tl-row--group", has_text=name)


def insert_row_of(page: Page, name: str) -> Locator:
    return group_row(page, name).locator('xpath=following-sibling::div[contains(@class,"tl-row--insert")][1]')


def group_of(page: Page, title: str) -> str:
    """列所在群組（往上找最近的群組列）的文字"""
    return row(page, title).evaluate(
        """(el) => {
            let n = el.previousElementSibling;
            while (n && !n.classList.contains('tl-row--group')) n = n.previousElementSibling;
            return n?.textContent ?? '';
        }"""
    )


def key(page: Page, k: str) -> None:
    """鍵盤拖曳的按鍵間留一點時間（dnd-kit 鍵盤感應器在拿起後的下一個 tick 才開始監聽）"""
    page.keyboard.press(k)
    page.wait_for_timeout(150)


def pointer_drag(page: Page, src: Locator, dst: Locator, *, y: float = 0.5, shot: str | None = None, before_drop=None):
    """以 page.mouse 分段移動拖曳（dnd-kit 需要多個 pointermove）；y 為目標內的相對位置 0–1"""
    src.locator('xpath=ancestor::div[@role="row"][1]').hover()
    a = src.bounding_box()
    ax = a["x"] + a["width"] / 2
    ay = a["y"] + a["height"] / 2
    page.mouse.move(ax, ay)
    page.mouse.down()
    page.mouse.move(ax + 4, ay + 8, steps=4)
    b = dst.bounding_box()
    bx = b["x"] + min(240, b["width"] / 2)
    by = b["y"] + b["height"] * y
    page.mouse.move(bx, by, steps=16)
    page.mouse.move(bx + 3, by, steps=3)
    if shot and SHOTS:
        page.screenshot(path=f"{SHOTS}/{shot}")
    if before_drop:
        before_drop()
    page.mouse.up()
    # dnd-kit 在放下後約 50ms 內會攔下接著的 click（避免拖曳觸發點擊），稍等再進行下一步
    page.wait_for_timeout(150)


def new_logged_in(browser: Browser, base_url: str, user: dict, next_path: str):
    context = browser.new_context(base_url=base_url, viewport={"width": 1280, "height": 800})
    page = context.new_page()
    login_via_ui(page, user, next_path)
    return context, page


def test_mouse_drag_to_groups_and_reorder(page: Page):
    """清單拖曳：滑鼠拖到空群組 / 完成 / 收合群組，重整後保留；組內調整順序"""
    errors = collect_errors(page)
    page.set_viewport_size({"width": 1280, "height": 800})
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    req = page.request
    doing = status_id_of(req, "進行中")
    todo = status_id_of(req, "待辦")
    done = status_id_of(req, "完成")
    review = status_id_of(req, "審查中")
    for i, title in enumerate([T["a"], T["b"], T["c"], T["d"]]):
        req.post("/api/tasks", headers=json, data={"title": title, "statusId": doing, "sortOrder": 1000 + i})
    page.goto(f"/tasks/list?q={stamp}")
    expect(row(page, T["a"])).to_be_visible()
    expect(group_row(page, "待辦")).to_contain_text("0")

    # 把手：hover 才顯示，有中文標籤
    row(page, T["a"]).hover()
    expect(handle(page, T["a"])).to_have_attribute("aria-label", f"拖曳「{T['a']}」")
    expect(handle(page, T["a"])).to_have_css("opacity", "1")

    # 進行中 → 空的「待辦」群組（放在「新增任務」列上）
    def check_drop_target():
        expect(page.locator(".tl-drag-overlay")).to_contain_text(T["a"])
        expect(group_row(page, "待辦")).to_have_attribute("data-drop-target", "true")
        expect(insert_row_of(page, "待辦")).to_have_attribute("data-drop", "before")

    pointer_drag(page, handle(page, T["a"]), insert_row_of(page, "待辦"), shot="dragging-1280.png", before_drop=check_drop_target)
    _poll(lambda: task_by_title(req, T["a"])["statusId"], todo)
    _poll(lambda: group_of(page, T["a"]), pred=lambda v: "待辦" in v)
    expect(page.get_by_text("已移到「待辦」")).to_be_visible()
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/dropped-1280.png")
    page.reload()
    expect(row(page, T["a"])).to_be_visible()
    assert "待辦" in group_of(page, T["a"])

    # 進行中 → 「完成」群組標頭 → 狀態 done
    pointer_drag(page, handle(page, T["b"]), group_row(page, "完成"))
    _poll(lambda: task_by_title(req, T["b"])["statusId"], done)
    expect(row(page, T["b"])).to_have_attribute("data-done", "true")

    # 組內調整順序：D 拖到 C 之前（C 列上半部）
    pointer_drag(page, handle(page, T["d"]), row(page, T["c"]), y=0.2)

    def d_before_c():
        c = task_by_title(req, T["c"])
        d = task_by_title(req, T["d"])
        return d["sortOrder"] < c["sortOrder"] and d["statusId"] == doing

    _poll(d_before_c, True)

    # 收合群組標頭也可放：放下後保持收合並提示
    group_row(page, "審查中").locator(".tl-group-cell").click()
    expect(group_row(page, "審查中")).to_have_attribute("aria-expanded", "false")
    pointer_drag(page, handle(page, T["c"]), group_row(page, "審查中"))
    _poll(lambda: task_by_title(req, T["c"])["statusId"], review)
    expect(page.get_by_text("已移到「審查中」")).to_be_visible()
    expect(group_row(page, "審查中")).to_have_attribute("aria-expanded", "false")
    expect(row(page, T["c"])).to_have_count(0)
    group_row(page, "審查中").locator(".tl-group-cell").click()
    expect(row(page, T["c"])).to_be_visible()

    # 拖到清單外放開 = 取消
    before = task_by_title(req, T["d"])
    pointer_drag(page, handle(page, T["d"]), page.get_by_role("navigation", name="主要導覽"))
    page.wait_for_timeout(300)
    after = task_by_title(req, T["d"])
    assert after["statusId"] == before["statusId"]
    assert after["sortOrder"] == before["sortOrder"]

    # 儲存失敗：還原 + 提示列
    def fail_patch(route):
        if route.request.method == "PATCH":
            route.fulfill(
                status=500,
                content_type="application/json",
                body=_json.dumps({"error": {"code": "internal", "message": "伺服器錯誤"}}),
            )
        else:
            route.continue_()

    page.route("**/api/tasks/*", fail_patch)
    pointer_drag(page, handle(page, T["d"]), insert_row_of(page, "完成"))
    expect(page.get_by_role("alert").filter(has_text=f"無法移動『{T['d']}』，已還原。")).to_be_visible()
    _poll(lambda: group_of(page, T["d"]), pred=lambda v: "進行中" in v)
    page.unroute("**/api/tasks/*")

    assert [e for e in errors if not re.search(r"status of (401|500)", e)] == []


def test_keyboard_drag(page: Page):
    """清單拖曳：鍵盤（Space 拿起、↑↓ 移動、Space 放下、Esc 取消）"""
    page.set_viewport_size({"width": 1280, "height": 800})
    login_via_ui(page, E2E_USERS["admin"], f"/tasks/list?q={stamp}")
    req = page.request
    todo = status_id_of(req, "待辦")
    # 目前：待辦 [A]、進行中 [D]、審查中 [C]、完成 [B]
    expect(row(page, T["d"])).to_be_visible()
    live = page.locator('.tl-sr-only[aria-live="assertive"]')

    # Esc 取消：不送請求
    before = task_by_title(req, T["d"])
    handle(page, T["d"]).focus()
    key(page, "Space")
    expect(live).to_have_text(re.compile(f"已拿起『{re.escape(T['d'])}』，目前在 進行中 第 1 筆"))
    key(page, "ArrowUp")
    expect(live).to_have_text("移到 待辦 第 2 筆")
    key(page, "Escape")
    expect(live).to_have_text("已取消，回到 進行中 第 1 筆")
    after = task_by_title(req, T["d"])
    assert after["statusId"] == before["statusId"]
    assert after["sortOrder"] == before["sortOrder"]

    # ↑ 兩次 → 待辦第 1 筆（A 之前）→ Space 放下
    handle(page, T["d"]).focus()
    key(page, "Space")
    key(page, "ArrowUp")
    key(page, "ArrowUp")
    expect(live).to_have_text("移到 待辦 第 1 筆")
    key(page, "Space")
    expect(live).to_have_text("已放到 待辦 第 1 筆")
    _poll(lambda: task_by_title(req, T["d"])["statusId"], todo)
    _poll(lambda: task_by_title(req, T["d"])["sortOrder"] < task_by_title(req, T["a"])["sortOrder"], True)
    expect(handle(page, T["d"])).to_be_focused()
    # 方向鍵仍可在表格內移動（把手為任務列第一格）
    page.keyboard.press("ArrowRight")
    expect(row(page, T["d"]).locator(".tl-done")).to_be_focused()


def test_sorted_allows_cross_group_only(page: Page):
    """清單拖曳：排序中可跨群組、群組內順序停用"""
    page.set_viewport_size({"width": 1280, "height": 800})
    login_via_ui(page, E2E_USERS["admin"], f"/tasks/list?q={stamp}&sort=title&dir=asc")
    req = page.request
    review = status_id_of(req, "審查中")
    expect(row(page, T["a"])).to_be_visible()
    # 待辦 [A, D]（依標題排序）
    a0 = task_by_title(req, T["a"])
    d0 = task_by_title(req, T["d"])

    # 群組內：D 拖到 A 之前 → 不變（浮層提示排序中）
    def check_sorted_hint():
        expect(page.locator(".tl-drag-overlay")).to_contain_text("排序中，無法手動調整順序")
        expect(row(page, T["a"])).not_to_have_attribute("data-drop", "before")

    pointer_drag(page, handle(page, T["d"]), row(page, T["a"]), y=0.2, before_drop=check_sorted_hint)
    page.wait_for_timeout(300)
    assert task_by_title(req, T["a"])["sortOrder"] == a0["sortOrder"]
    d1 = task_by_title(req, T["d"])
    assert d1["statusId"] == d0["statusId"]
    assert d1["sortOrder"] == d0["sortOrder"]

    # 跨群組：D → 審查中（只改狀態，不改 sort_order）
    pointer_drag(page, handle(page, T["d"]), group_row(page, "審查中"))
    _poll(lambda: task_by_title(req, T["d"])["statusId"], review)
    assert task_by_title(req, T["d"])["sortOrder"] == d0["sortOrder"]

    # 把手的 Tooltip 說明
    row(page, T["a"]).hover()
    handle(page, T["a"]).hover()
    expect(page.get_by_role("tooltip")).to_have_text("排序中，無法手動調整順序；仍可拖到其他群組")


def test_group_by_assignee_drag(page: Page):
    """清單拖曳：依負責人分組拖到另一人 / 未指派"""
    page.set_viewport_size({"width": 1280, "height": 800})
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    req = page.request
    member = user_id_of(req, E2E_USERS["member"]["username"])
    a = task_by_title(req, T["a"])
    req.patch(f"/api/tasks/{a['id']}", headers=json, data={"assigneeId": member})
    page.goto(f"/tasks/list?q={stamp}&group=assignee")
    member_name = E2E_USERS["member"]["display_name"]
    expect(group_row(page, member_name)).to_be_visible()
    expect(group_row(page, "未指派")).to_be_visible()

    # 未指派的 B → 一般成員
    pointer_drag(page, handle(page, T["b"]), insert_row_of(page, member_name))
    _poll(lambda: task_by_title(req, T["b"])["assigneeId"], member)
    _poll(lambda: group_of(page, T["b"]), pred=lambda v: member_name in v)

    # A → 未指派（null）
    pointer_drag(page, handle(page, T["a"]), group_row(page, "未指派"))
    _poll(lambda: task_by_title(req, T["a"])["assigneeId"], None)


def test_no_handle_without_tasks_edit(browser: Browser, base_url: str):
    """清單拖曳：沒有 tasks.edit 看不到把手"""
    root_ctx, root_page = new_logged_in(browser, base_url, E2E_USERS["admin"], "/tasks/list")
    try:
        res = root_page.request.put(
            "/api/admin/permissions",
            headers=json,
            data={"changes": [{"role": "user", "capability": "tasks.edit", "allowed": False}]},
        )
        assert res.status == 200
        member_ctx, member_page = new_logged_in(browser, base_url, E2E_USERS["member"], f"/tasks/list?q={stamp}")
        expect(row(member_page, T["a"])).to_be_visible()
        row(member_page, T["a"]).hover()
        expect(member_page.locator(".tl-drag-handle")).to_have_count(0)
        member_ctx.close()
        # admin（root）仍有把手
        root_page.goto(f"/tasks/list?q={stamp}")
        expect(handle(root_page, T["a"])).to_have_count(1)
    finally:
        root_page.request.put(
            "/api/admin/permissions",
            headers=json,
            data={"changes": [{"role": "user", "capability": "tasks.edit", "allowed": True}]},
        )
        root_ctx.close()


def test_table_fills_width(page: Page):
    """清單表格撐滿寬度：1280 / 1440 / 1920 無水平捲軸；抽屜開啟時只讓出被蓋住的寬度"""
    page.set_viewport_size({"width": 1280, "height": 800})
    login_via_ui(page, E2E_USERS["admin"], f"/tasks/list?q={stamp}")
    scroll = page.locator(".tl-scroll")

    def measure():
        return scroll.evaluate(
            """(el) => {
                const head = el.querySelector('.tl-row--header').getBoundingClientRect();
                const r = el.getBoundingClientRect();
                return {
                    overflow: el.scrollWidth - el.clientWidth,
                    gap: r.left + el.clientLeft + el.clientWidth - head.right,
                };
            }"""
        )

    for width in [1280, 1440, 1920]:
        page.set_viewport_size({"width": width, "height": 800})
        expect(row(page, T["a"])).to_be_visible()
        _poll(lambda: measure()["overflow"], pred=lambda v: v <= 0, message=f"{width}px 水平捲軸")
        # 表頭撐滿捲動區（右側沒有空白）
        assert measure()["gap"] <= 1, f"{width}px 右側空白"
        # 「+」新增欄位按鈕在最右
        add = page.locator(".tl-hcell--add button").bounding_box()
        box = scroll.bounding_box()
        assert box["x"] + box["width"] - (add["x"] + add["width"]) < 40, f"{width}px ＋ 位置"
        if SHOTS:
            page.screenshot(path=f"{SHOTS}/table-{width}.png")

    # 1920 開抽屜：表格右緣貼齊抽屜左緣，不出現水平捲軸
    row(page, T["a"]).hover()
    row(page, T["a"]).get_by_role("button", name="開啟").click()
    expect(page.get_by_role("dialog", name=T["a"])).to_be_visible()
    page.wait_for_timeout(400)
    _poll(lambda: measure()["overflow"], pred=lambda v: v <= 0)
    drawer = page.locator(".task-drawer").bounding_box()
    head = page.locator(".tl-row--header").bounding_box()
    assert abs(head["x"] + head["width"] - drawer["x"]) <= 2
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/table-drawer-1920.png")
    page.keyboard.press("Escape")

    # 768：既有排版（區塊內捲動），頁面本身不產生水平捲軸
    page.set_viewport_size({"width": 768, "height": 900})
    expect(row(page, T["a"])).to_be_visible()
    page_overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert page_overflow <= 0
    expect(handle(page, T["a"])).to_have_css("opacity", "1")
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/table-768.png")
    if SHOTS:
        # 768 拖曳中截圖（放到清單外取消，不改資料）
        pointer_drag(
            page,
            handle(page, T["a"]),
            group_row(page, "進行中"),
            shot="dragging-768.png",
            before_drop=lambda: page.keyboard.press("Escape"),
        )
