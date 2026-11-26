"""task-kanban.spec.ts 的 Python 版：T2 看板（拖曳改狀態／順序、點擊開詳情、欄尾新增、鍵盤拖曳、錯誤與空狀態）。"""

from __future__ import annotations

import json as _json
import re
import time

import pytest
from playwright.sync_api import APIRequestContext, Locator, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# T2 Kanban：欄 = 狀態、拖曳改狀態 / 順序（重整後保留）、點擊開詳情、欄尾快速新增、鍵盤拖曳、錯誤與空狀態
# （原檔 serial：pytest 同檔內本來就照順序跑）

stamp = int(time.time() * 1000)
T = {"a": f"看板A-{stamp}", "b": f"看板B-{stamp}", "c": f"看板C-{stamp}"}

json = {"Content-Type": "application/json"}

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


def list_tasks(req: APIRequestContext) -> list[dict]:
    return req.get("/api/tasks").json()


def status_id_of(req: APIRequestContext, name: str) -> int:
    return next(s for s in req.get("/api/statuses").json() if s["name"] == name)["id"]


def task_by_title(req: APIRequestContext, title: str):
    return next((t for t in list_tasks(req) if t["title"] == title), None)


def column(page: Page, name: str) -> Locator:
    return page.get_by_role("group", name=name, exact=True)


def card(scope, title: str) -> Locator:
    return scope.get_by_role("listitem", name=re.compile(f"^{re.escape(title)}，"))


def card_titles(page: Page, name: str) -> list[str]:
    return column(page, name).locator(".kanban-card .kanban-card-title").all_text_contents()


def _mine(page: Page, name: str) -> list[str]:
    return [t for t in card_titles(page, name) if str(stamp) in t]


def key(page: Page, k: str) -> None:
    """鍵盤拖曳的按鍵間留一點時間（dnd-kit 鍵盤感應器在拿起後的下一個 tick 才開始監聽）"""
    page.keyboard.press(k)
    page.wait_for_timeout(150)


def pointer_drag(page: Page, src: Locator, dst: Locator) -> None:
    a = src.bounding_box()
    b = dst.bounding_box()
    page.mouse.move(a["x"] + a["width"] / 2, a["y"] + a["height"] / 2)
    page.mouse.down()
    page.mouse.move(a["x"] + a["width"] / 2 + 12, a["y"] + a["height"] / 2, steps=4)
    page.mouse.move(b["x"] + b["width"] / 2, b["y"] + 90, steps=15)
    page.mouse.up()


def _fail_500(method: str):
    def handler(route):
        if route.request.method == method:
            route.fulfill(
                status=500,
                content_type="application/json",
                body=_json.dumps({"error": {"code": "internal", "message": "伺服器錯誤"}}),
            )
        else:
            route.continue_()

    return handler


def test_kanban_drag_open_add_keyboard(page: Page):
    """看板：拖曳改狀態與順序、點擊開詳情、欄尾新增、鍵盤拖曳"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["admin"], "/tasks/kanban")
    req = page.request
    todo = status_id_of(req, "待辦")
    for i, title in enumerate([T["a"], T["b"], T["c"]]):
        req.post(
            "/api/tasks",
            headers=json,
            data={"title": title, "statusId": todo, "sortOrder": 1000 + i, "estimateHours": 2, "dueDate": "2020-01-01"},
        )
    # 以搜尋限定本測試建立的任務（DB 可能有其他 spec 留下的資料）；篩選於重整後保留
    page.goto(f"/tasks/kanban?q={stamp}")

    # 欄 = 狀態（依 sort_order）
    board = page.get_by_role("region", name="任務看板")
    expect(board).to_be_visible()
    for name in ["待辦", "進行中", "審查中", "完成"]:
        expect(column(page, name)).to_be_visible()
    todo_col = column(page, "待辦")
    expect(card(todo_col, T["a"])).to_be_visible()
    _poll(lambda: _mine(page, "待辦"), [T["a"], T["b"], T["c"]])

    # 卡片內容：標題、負責人（未指派）、到期日（逾期）、預估工時、最後更新
    card_a = card(todo_col, T["a"])
    expect(card_a.get_by_role("img", name="未指派")).to_be_visible()
    expect(card_a.get_by_text("2020/01/01")).to_be_visible()
    expect(card_a.get_by_text("2h", exact=True)).to_be_visible()
    expect(card_a.locator("time")).to_have_text("剛剛")
    expect(column(page, "待辦").get_by_text(re.compile(r"Σ \d+h"))).to_be_visible()
    # 空欄提示
    expect(column(page, "進行中").get_by_text("拖曳卡片到這裡")).to_be_visible()

    # 點擊開啟任務詳情，Esc 關閉
    a = task_by_title(req, T["a"])
    card_a.click()
    expect(page).to_have_url(re.compile(f"task={a['id']}"))
    expect(page.get_by_role("dialog", name=T["a"])).to_be_visible()
    expect(card_a).to_have_attribute("aria-current", "true")
    page.keyboard.press("Escape")
    expect(page.get_by_role("dialog")).to_have_count(0)

    # 指標拖曳：A 跨欄到「進行中」→ 改狀態，重整後保留
    doing = status_id_of(req, "進行中")
    pointer_drag(page, card_a, column(page, "進行中"))
    expect(card(column(page, "進行中"), T["a"])).to_be_visible()
    _poll(lambda: task_by_title(req, T["a"])["statusId"], doing)
    page.reload()
    expect(card(column(page, "進行中"), T["a"])).to_be_visible()
    expect(card(column(page, "待辦"), T["a"])).to_have_count(0)

    # 鍵盤拖曳：C 在欄內上移一格（Space 拿起 → ↑ → Space 放下），重整後順序保留
    card_c = card(column(page, "待辦"), T["c"])
    card_c.focus()
    key(page, "Space")
    expect(page.locator('[aria-live="assertive"]').filter(has_text="已拿起")).to_have_text(
        re.compile(f"已拿起『{re.escape(T['c'])}』，目前在 待辦 第 \\d+ 張")
    )
    key(page, "ArrowUp")
    key(page, "Space")
    _poll(lambda: _mine(page, "待辦"), [T["c"], T["b"]])
    _poll(lambda: task_by_title(req, T["c"])["sortOrder"] < task_by_title(req, T["b"])["sortOrder"], True)
    page.reload()
    # 重整後資料非同步載入：以自動重試斷言等待欄內順序穩定
    _poll(lambda: _mine(page, "待辦"), [T["c"], T["b"]])

    # 鍵盤拖曳跨欄：B → 右移一欄（進行中）
    card_b = card(column(page, "待辦"), T["b"])
    card_b.focus()
    key(page, "Space")
    key(page, "ArrowRight")
    key(page, "Space")
    expect(card(column(page, "進行中"), T["b"])).to_be_visible()
    _poll(lambda: task_by_title(req, T["b"])["statusId"], doing)
    expect(card(column(page, "進行中"), T["b"])).to_be_focused()

    # Esc 取消：回原位、不送請求；優先於關閉抽屜
    before = task_by_title(req, T["c"])
    card_c2 = card(column(page, "待辦"), T["c"])
    card_c2.click()
    expect(page.get_by_role("dialog", name=T["c"])).to_be_visible()
    card_c2.focus()
    key(page, "Space")
    key(page, "ArrowRight")
    expect(page.locator('[aria-live="assertive"]').filter(has_text="移到 進行中")).to_be_visible()
    key(page, "Escape")
    expect(card(column(page, "待辦"), T["c"])).to_be_visible()
    expect(page.locator('[aria-live="assertive"]').filter(has_text="已取消")).to_be_visible()
    expect(page.get_by_role("dialog", name=T["c"])).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.get_by_role("dialog")).to_have_count(0)
    after = task_by_title(req, T["c"])
    assert after["statusId"] == before["statusId"]
    assert after["sortOrder"] == before["sortOrder"]

    # 鍵盤瀏覽：↑↓←→ 移動焦點、Enter 開啟詳情
    card(column(page, "進行中"), T["a"]).focus()
    page.keyboard.press("ArrowLeft")
    expect(card(column(page, "待辦"), T["c"])).to_be_focused()
    page.keyboard.press("Enter")
    expect(page.get_by_role("dialog", name=T["c"])).to_be_visible()
    page.keyboard.press("Escape")
    # 等抽屜完全關閉（closeTask 會把 focus 拉回卡片），再操作 QuickAdd，避免 focus 被搶走
    expect(page.get_by_role("dialog")).to_have_count(0)
    expect(page).not_to_have_url(re.compile(r"[?&]task="))
    expect(card(column(page, "待辦"), T["c"])).to_be_focused()

    # 欄尾快速新增：帶入該欄狀態，出現在欄底
    review = status_id_of(req, "審查中")
    review_add = page.get_by_role("group", name="新增任務到「審查中」").get_by_role("textbox")
    new_title = f"看板新增-{stamp}"
    review_add.fill(new_title)
    review_add.press("Enter")
    expect(card(column(page, "審查中"), new_title)).to_be_visible()
    expect(review_add).to_be_focused()
    # 卡片先以樂觀更新出現（暫時 id），POST 完成前 API 還查不到：等伺服器端資料
    _poll(lambda: (task_by_title(req, new_title) or {}).get("statusId"), review)
    # 後續拖曳需等卡片換成伺服器 id（拖曳中途暫時卡片被替換會落空）
    created = task_by_title(req, new_title)
    expect(card(column(page, "審查中"), new_title)).to_have_attribute("data-task-id", str(created["id"]))

    # 儲存失敗：卡片回原欄 + 錯誤提示列
    page.route("**/api/tasks/*", _fail_500("PATCH"))
    pointer_drag(page, card(column(page, "審查中"), new_title), column(page, "待辦"))
    expect(page.get_by_role("alert").filter(has_text=f"無法更新『{new_title}』，已還原。")).to_be_visible()
    expect(card(column(page, "審查中"), new_title)).to_be_visible()
    page.unroute("**/api/tasks/*")

    # 登入前的 /api/auth/me 401 與刻意注入的 500 屬預期
    assert [e for e in errors if not re.search(r"status of (401|500)", e)] == []


def test_kanban_empty_filter_and_load_failure(page: Page):
    """看板：篩選無結果、載入失敗"""
    login_via_ui(page, E2E_USERS["admin"], "/tasks/kanban?q=no-such-task-zzz")
    expect(page.get_by_text("沒有符合條件的任務")).to_be_visible()
    page.get_by_role("button", name="清除篩選").first.click()
    expect(column(page, "待辦")).to_be_visible()

    # 狀態篩選：只渲染被選取的欄
    todo = status_id_of(page.request, "待辦")
    page.goto(f"/tasks/kanban?status={todo}")
    expect(column(page, "待辦")).to_be_visible()
    expect(column(page, "進行中")).to_have_count(0)

    page.route("**/api/tasks", _fail_500("GET"))
    page.goto("/tasks/kanban")
    expect(page.get_by_text("載入失敗")).to_be_visible(timeout=15_000)
    page.unroute("**/api/tasks")
    page.get_by_role("button", name="重試").click()
    expect(column(page, "待辦")).to_be_visible()


def test_kanban_no_page_horizontal_scroll(page: Page):
    """看板：1280 / 768 寬度不產生頁面層級水平捲軸"""
    login_via_ui(page, E2E_USERS["admin"], "/tasks/kanban")
    for width in [1280, 1024, 768]:
        page.set_viewport_size({"width": width, "height": 800})
        expect(column(page, "待辦")).to_be_visible()
        overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        assert overflow <= 0, f"{width}px"
