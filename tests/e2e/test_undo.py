"""undo.spec.ts 的 Python 版：全站復原 / 重做（docs/design/undo.md）。"""

from __future__ import annotations

import os
import re
import time

import pytest
from playwright.sync_api import Browser, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# feat/undo：全站復原 / 重做（docs/design/undo.md）
# （原檔 serial：pytest 同檔內本來就照順序跑）

# 設定 UNDO_SHOTS_DIR 時輸出截圖（1280 寬）
SHOTS = os.environ.get("UNDO_SHOTS_DIR")

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


def shot(page: Page, name: str, clip: dict | None = None) -> None:
    if not SHOTS:
        return
    page.wait_for_timeout(500)  # 等進場動畫結束
    page.screenshot(path=f"{SHOTS}/{name}.png", clip=clip)


def open_as(browser: Browser, base_url: str, user: dict, path: str) -> Page:
    context = browser.new_context(base_url=base_url, viewport={"width": 1280, "height": 800})
    page = context.new_page()
    login_via_ui(page, user, path)
    return page


def create_task(page: Page, data: dict) -> dict:
    res = page.request.post("/api/tasks", data=data)
    assert res.ok
    return res.json()


def get_task(page: Page, tid: int):
    return page.request.get(f"/api/tasks/{tid}")


def status_id_of(page: Page, name: str) -> int:
    return next(s for s in page.request.get("/api/statuses").json() if s["name"] == name)["id"]


def row_by_id(page: Page, tid: int):
    return page.locator(f'.tl-row--task[data-task-id="{tid}"]')


def undo_btn(page: Page):
    return page.locator('[data-undo-button="undo"]')


def redo_btn(page: Page):
    return page.locator('[data-undo-button="redo"]')


def toasts(page: Page):
    return page.get_by_role("region", name="通知")


def blur(page: Page) -> None:
    """讓焦點離開輸入框（點主要區域的空白處）"""
    page.locator("#main").click(position={"x": 5, "y": 300})


def test_inline_title_undo_redo_native_in_input_buttons_tooltip(page: Page):
    """清單就地改標題：Ctrl+Z 復原、Ctrl+Shift+Z 重做；輸入框內 Ctrl+Z 為原生行為；按鈕與 Tooltip"""
    errors = collect_errors(page)
    page.set_viewport_size({"width": 1280, "height": 800})
    P = f"UN{int(time.time() * 1000)}"
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    task = create_task(page, {"title": f"{P} 原"})
    page.goto(f"/tasks/list?q={P}")
    row = row_by_id(page, task["id"])
    expect(row).to_be_visible()

    # 沒有可復原項目：按鈕停用；Ctrl+Z 什麼都不做
    expect(undo_btn(page)).to_be_disabled()
    expect(redo_btn(page)).to_be_disabled()

    # 就地改標題
    row.locator(".tl-field--title .tl-title-text").click()
    inp = row.locator(".tl-field--title input")
    inp.fill(f"{P} 新")
    inp.press("Enter")
    expect(row.locator(".tl-field--title")).to_have_text(f"{P} 新")
    expect(undo_btn(page)).to_be_enabled()
    expect(undo_btn(page)).to_have_attribute("aria-label", f"復原：修改『{P} 新』的標題")

    # 焦點在輸入框內：Ctrl+Z 交給瀏覽器（不觸發全域復原）
    quick_add = page.get_by_role("textbox", name="快速新增任務")
    quick_add.click()
    quick_add.press_sequentially("abc")
    page.keyboard.press("Control+z")
    page.wait_for_timeout(500)
    expect(row.locator(".tl-field--title")).to_have_text(f"{P} 新")
    expect(undo_btn(page)).to_have_attribute("aria-label", f"復原：修改『{P} 新』的標題")
    assert get_task(page, task["id"]).json()["title"] == f"{P} 新"
    quick_add.fill("")
    quick_add.press("Escape")
    blur(page)

    # Tooltip：下一步內容 + 快捷鍵
    undo_btn(page).hover()
    expect(page.get_by_role("tooltip")).to_have_text(f"復原：修改『{P} 新』的標題（Ctrl+Z）")
    shot(page, "header-buttons", {"x": 232, "y": 0, "width": 1048, "height": 110})
    page.mouse.move(600, 500)

    # Ctrl+Z 復原
    page.keyboard.press("Control+z")
    expect(row.locator(".tl-field--title")).to_have_text(f"{P} 原")
    expect(toasts(page).get_by_text(f"已復原：修改『{P} 新』的標題")).to_be_visible()
    expect(toasts(page).get_by_role("button", name="重做")).to_be_visible()
    _poll(lambda: get_task(page, task["id"]).json()["title"], f"{P} 原")
    shot(page, "toast-undone")
    expect(undo_btn(page)).to_be_disabled()
    expect(redo_btn(page)).to_be_enabled()

    # Ctrl+Shift+Z 重做
    page.keyboard.press("Control+Shift+z")
    expect(row.locator(".tl-field--title")).to_have_text(f"{P} 新")
    expect(toasts(page).get_by_text(f"已重做：修改『{P} 新』的標題")).to_be_visible()
    _poll(lambda: get_task(page, task["id"]).json()["title"], f"{P} 新")

    # 頂欄按鈕：復原 → toast 的「重做」鈕
    undo_btn(page).click()
    expect(row.locator(".tl-field--title")).to_have_text(f"{P} 原")
    toasts(page).get_by_role("button", name="重做").click()
    expect(row.locator(".tl-field--title")).to_have_text(f"{P} 新")
    _poll(lambda: get_task(page, task["id"]).json()["title"], f"{P} 新")

    assert [e for e in errors if not re.search(r"status of 401", e)] == []


def test_create_undo_redo_delete_undo(page: Page):
    """建立任務 → 復原（消失）→ 重做（回來）；刪除 → 復原（回來）"""
    # 頁面 console 不可出現 404（抽屜離場中重抓已刪除任務的子資源）；poll 用 page.request，不經過頁面 console
    errors = collect_errors(page)
    P = f"UC{int(time.time() * 1000)}"
    login_via_ui(page, E2E_USERS["admin"], f"/tasks/list?q={P}")
    expect(page.get_by_text("沒有符合條件的任務")).to_be_visible()

    # 快速新增
    quick_add = page.get_by_role("textbox", name="快速新增任務")
    quick_add.fill(f"{P} 新建")
    quick_add.press("Enter")
    rows = page.locator(".tl-row--task:not([data-temp])")
    expect(rows).to_have_count(1)
    tid = int(rows.first.get_attribute("data-task-id"))
    quick_add.press("Escape")
    blur(page)
    expect(undo_btn(page)).to_have_attribute("aria-label", f"復原：建立任務『{P} 新建』")

    page.keyboard.press("Control+z")
    expect(rows).to_have_count(0)
    _poll(lambda: get_task(page, tid).status, 404)

    page.keyboard.press("Control+Shift+z")
    expect(rows).to_have_count(1)
    _poll(lambda: get_task(page, tid).status, 200)

    # 刪除（Drawer → 確認）→ 復原
    row = row_by_id(page, tid)
    row.hover()
    row.get_by_role("button", name="開啟").click()
    drawer = page.get_by_role("dialog", name=f"{P} 新建")
    drawer.get_by_role("button", name="更多動作").click()
    page.get_by_role("menuitem", name="刪除任務").click()
    page.get_by_role("alertdialog").get_by_role("button", name="刪除", exact=True).click()
    expect(drawer).to_have_count(0)
    expect(rows).to_have_count(0)
    blur(page)
    expect(undo_btn(page)).to_have_attribute("aria-label", f"復原：刪除任務『{P} 新建』")

    page.keyboard.press("Control+z")
    expect(rows).to_have_count(1)
    _poll(lambda: get_task(page, tid).status, 200)
    # Ctrl+Y 也可重做（再次刪除）
    page.keyboard.press("Control+y")
    expect(rows).to_have_count(0)
    _poll(lambda: get_task(page, tid).status, 404)
    page.wait_for_timeout(500)
    assert [e for e in errors if not re.search(r"status of 401", e)] == []


def test_kanban_drag_then_undo(page: Page):
    """看板拖曳改狀態 → 復原 → 回到原欄"""
    page.set_viewport_size({"width": 1280, "height": 800})
    P = f"UK{int(time.time() * 1000)}"
    login_via_ui(page, E2E_USERS["admin"], "/tasks/kanban")
    todo = status_id_of(page, "待辦")
    doing = status_id_of(page, "進行中")
    task = create_task(page, {"title": f"{P} 卡", "statusId": todo})
    page.goto(f"/tasks/kanban?q={P}")

    def column(name: str):
        return page.get_by_role("group", name=name, exact=True)

    card_name = re.compile(f"^{P} 卡，")
    card = column("待辦").get_by_role("listitem", name=card_name)
    expect(card).to_be_visible()
    a = card.bounding_box()
    b = column("進行中").bounding_box()
    page.mouse.move(a["x"] + a["width"] / 2, a["y"] + a["height"] / 2)
    page.mouse.down()
    page.mouse.move(a["x"] + a["width"] / 2 + 12, a["y"] + a["height"] / 2, steps=4)
    page.mouse.move(b["x"] + b["width"] / 2, b["y"] + 90, steps=15)
    page.mouse.up()

    expect(column("進行中").get_by_role("listitem", name=card_name)).to_be_visible()
    _poll(lambda: get_task(page, task["id"]).json()["statusId"], doing)
    expect(undo_btn(page)).to_have_attribute("aria-label", f"復原：把『{P} 卡』移到『進行中』")

    page.keyboard.press("Control+z")
    expect(column("待辦").get_by_role("listitem", name=card_name)).to_be_visible()
    _poll(lambda: get_task(page, task["id"]).json()["statusId"], todo)
    expect(toasts(page).get_by_text(f"已復原：把『{P} 卡』移到『進行中』")).to_be_visible()


def test_undo_conflict_dialog(browser: Browser, base_url: str):
    """A 修改後 B 又改同欄位：A 復原時出現衝突對話框（略過 / 仍要復原）"""
    P = f"UX{int(time.time() * 1000)}"
    a = open_as(browser, base_url, E2E_USERS["admin"], "/tasks/list")
    task = create_task(a, {"title": f"{P} 原"})
    a.goto(f"/tasks/list?q={P}")
    b = open_as(browser, base_url, E2E_USERS["member"], f"/tasks/list?q={P}")
    row_a = row_by_id(a, task["id"])

    def edit_title(value: str) -> None:
        row_a.locator(".tl-field--title .tl-title-text").click()
        inp = row_a.locator(".tl-field--title input")
        inp.fill(value)
        inp.press("Enter")
        expect(row_a.locator(".tl-field--title")).to_have_text(value)
        blur(a)

    def patch_as_b(title: str) -> None:
        res = b.request.patch(f"/api/tasks/{task['id']}", data={"title": title})
        assert res.ok
        expect(row_a.locator(".tl-field--title")).to_have_text(title, timeout=10_000)

    # ① 略過這項：不覆蓋，該筆從堆疊移除
    edit_title(f"{P} A改")
    patch_as_b(f"{P} B改")
    a.keyboard.press("Control+z")
    dialog = a.get_by_role("alertdialog")
    expect(dialog).to_be_visible()
    expect(dialog).to_contain_text("「標題」已被別人修改")
    expect(dialog).to_contain_text(f"這個欄位在你修改之後被別人改過（現在是『{P} B改』）。仍要復原並覆蓋嗎？")
    shot(a, "conflict-dialog")
    dialog.get_by_role("button", name="略過這項").click()
    expect(dialog).to_have_count(0)
    expect(row_a.locator(".tl-field--title")).to_have_text(f"{P} B改")
    expect(undo_btn(a)).to_be_disabled()
    assert get_task(a, task["id"]).json()["title"] == f"{P} B改"

    # ② 仍要復原：覆蓋回 A 修改前的值
    edit_title(f"{P} A再改")
    patch_as_b(f"{P} B再改")
    a.keyboard.press("Control+z")
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="仍要復原").click()
    expect(row_a.locator(".tl-field--title")).to_have_text(f"{P} B改")
    _poll(lambda: get_task(a, task["id"]).json()["title"], f"{P} B改")

    # 他人的變更不入 A 的堆疊；B 自己沒有可復原項目
    expect(undo_btn(b)).to_be_disabled()

    # 任務被別人刪除後復原：提示「此任務已不存在」並移除該筆
    edit_title(f"{P} 最後")
    b.request.delete(f"/api/tasks/{task['id']}")
    expect(row_a).to_have_count(0, timeout=10_000)
    a.keyboard.press("Control+z")
    expect(toasts(a).get_by_text("此任務已不存在")).to_be_visible()
    expect(undo_btn(a)).to_be_disabled()

    a.context.close()
    b.context.close()
