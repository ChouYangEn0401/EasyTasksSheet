"""personal.spec.ts 的 Python 版：T5 個人清單（三區、PinButton、自由待辦、唯讀檢視他人、403）。"""

from __future__ import annotations

import re
import time
from urllib.parse import parse_qs, urlparse

import pytest
from playwright.sync_api import APIRequestContext, Browser, Locator, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# T5 個人清單：三區、PinButton（個人頁 / Kanban / List）、自由待辦（新增 / 勾選 / 排序 / 刪除 / 重整保留）、唯讀檢視他人、403
# （原檔 serial：pytest 同檔內本來就照順序跑）

stamp = int(time.time() * 1000)
TASK = f"個人A-{stamp}"
TODO = {"a": f"待辦甲-{stamp}", "b": f"待辦乙-{stamp}", "c": f"待辦丙-{stamp}", "d": f"待辦丁-{stamp}"}
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


def _qp(page: Page, name: str):
    return parse_qs(urlparse(page.url).query).get(name, [None])[0]


def me_id(req: APIRequestContext) -> int:
    return req.get("/api/auth/me").json()["user"]["id"]


def section(page: Page, name: str) -> Locator:
    return page.get_by_role("region", name=name, exact=True)


def pin_of(scope: Locator) -> Locator:
    return scope.get_by_role("button", name=re.compile(r"我的標記$"))


def mine(titles: list[str]) -> list[str]:
    """只看本 spec 自己建立的待辦（標題帶 stamp），不假設 member 原本沒有任何待辦"""
    return [t for t in titles if f"-{stamp}" in t]


def todo_titles(page: Page) -> list[str]:
    return mine(
        section(page, "自由待辦").get_by_role("list", name="自由待辦").locator(".pl-todo-title").all_text_contents()
    )


def key(page: Page, k: str) -> None:
    page.keyboard.press(k)
    page.wait_for_timeout(150)


def test_personal_assigned_pinned_todos_and_pins(page: Page):
    """個人清單：指派 / 標記 / 自由待辦，PinButton 於 Kanban 與 List 生效"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["member"], "/me")
    req = page.request
    me = me_id(req)
    task = req.post("/api/tasks", headers=json, data={"title": TASK, "assigneeId": me, "dueDate": "2020-01-02"}).json()

    page.goto("/me")
    assigned = section(page, "指派給我的任務")
    pinned = section(page, "我標記的任務")
    todos = section(page, "自由待辦")

    # 指派給我：列含狀態、逾期到期日、最後更新
    row = assigned.locator(f'.pl-task-row[data-task-id="{task["id"]}"]')
    expect(row).to_be_visible()
    expect(row.locator(".pl-task-due")).to_have_class(re.compile(r"is-overdue"))
    expect(row.locator("time")).to_have_text("剛剛")

    # 我標記的：本 spec 的任務尚未標記 → 點書籤 → 不需重整即出現，且不開啟詳情
    expect(pinned.locator(f'.pl-task-row[data-task-id="{task["id"]}"]')).to_have_count(0)
    pin = pin_of(row)
    expect(pin).to_have_attribute("aria-pressed", "false")
    pin.click()
    expect(pin).to_have_attribute("aria-pressed", "true")
    expect(pinned.locator(f'.pl-task-row[data-task-id="{task["id"]}"]')).to_be_visible()
    assert _qp(page, "task") is None

    # 點列本體開啟任務詳情
    row.get_by_role("button", name=f"開啟任務：{TASK}").click()
    expect(page).to_have_url(re.compile(f"task={task['id']}"))
    page.goto("/me")

    # 自由待辦：空狀態 → Enter 連續新增（新項目在最上方、輸入框保持 focus）
    add = todos.get_by_role("textbox", name="新增待辦")
    add.fill(TODO["a"])
    add.press("Enter")
    expect(add).to_have_value("")
    expect(add).to_be_focused()
    add.fill(TODO["b"])
    add.press("Enter")
    expect(add).to_have_value("")
    add.fill(TODO["c"])
    add.press("Enter")
    _poll(lambda: todo_titles(page), [TODO["c"], TODO["b"], TODO["a"]])
    expect(todos.locator(".pl-todo-row time").first).to_be_visible()

    # 鍵盤排序：把手 Space 拿起 → ↓ → Space 放下
    todos.get_by_role("button", name=f"拖曳排序：{TODO['c']}").focus()
    key(page, "Space")
    key(page, "ArrowDown")
    key(page, "Space")
    _poll(lambda: todo_titles(page), [TODO["b"], TODO["c"], TODO["a"]])
    # Alt+↑：直接上移一格
    todos.get_by_role("button", name=f"開啟待辦詳情：{TODO['a']}").focus()
    key(page, "Alt+ArrowUp")
    _poll(lambda: todo_titles(page), [TODO["b"], TODO["a"], TODO["c"]])

    # 點標題開啟詳情 inspector（?todo=<id>）改標題；Esc 關閉
    todos.get_by_role("button", name=f"開啟待辦詳情：{TODO['c']}").click()
    expect(page).to_have_url(re.compile(r"todo=\d+"))
    edit = page.locator(".pl-inspector").get_by_role("textbox", name="標題")
    edit.fill(f"{TODO['c']}改")
    edit.press("Enter")
    _poll(lambda: todo_titles(page), [TODO["b"], TODO["a"], f"{TODO['c']}改"])
    edit.press("Escape")  # 先結束編輯
    page.keyboard.press("Escape")  # 再關閉 inspector
    expect(page.locator(".pl-inspector")).to_have_count(0)
    assert _qp(page, "todo") is None

    # 勾選 → 移入「已完成」群組（預設收合）
    todos.get_by_role("checkbox", name=f"標為完成：{TODO['b']}").click()
    _poll(lambda: todo_titles(page), [TODO["a"], f"{TODO['c']}改"])
    expect(todos.get_by_role("button", name=re.compile(r"^已完成 \d+"))).to_have_attribute("aria-expanded", "false")

    # 刪除
    todos.get_by_role("button", name=f"刪除待辦：{TODO['a']}").click()
    _poll(lambda: todo_titles(page), [f"{TODO['c']}改"])

    # 重整後順序與完成狀態保留
    page.reload()
    _poll(lambda: todo_titles(page), [f"{TODO['c']}改"])
    todos.get_by_role("button", name=re.compile(r"^已完成 \d+")).click()
    expect(todos.get_by_role("checkbox", name=f"標為未完成：{TODO['b']}")).to_be_checked()
    expect(pinned.locator(f'.pl-task-row[data-task-id="{task["id"]}"]')).to_be_visible()

    # Kanban：卡片上的 PinButton 反映同一份標記；點擊取消且不開詳情
    page.goto(f"/tasks/kanban?q={stamp}")
    card = page.locator(f'.kanban-card[data-task-id="{task["id"]}"]')
    expect(card).to_be_visible()
    card_pin = pin_of(card)
    expect(card_pin).to_have_attribute("aria-pressed", "true")
    card_pin.click()
    expect(card_pin).to_have_attribute("aria-pressed", "false")
    assert _qp(page, "task") is None

    # List：列上的 PinButton 再標記一次，不開詳情
    page.goto(f"/tasks/list?q={stamp}")
    list_row = page.locator(f'.tl-row--task[data-task-id="{task["id"]}"]')
    list_row.hover()
    list_pin = pin_of(list_row)
    expect(list_pin).to_have_attribute("aria-pressed", "false")
    list_pin.click()
    expect(list_pin).to_have_attribute("aria-pressed", "true")
    assert _qp(page, "task") is None

    # 回到個人頁：標記清單已更新
    page.goto("/me")
    expect(pinned.locator(f'.pl-task-row[data-task-id="{task["id"]}"]')).to_be_visible()

    # API：不能改他人的清單（403）
    admin = req.get("/api/users").json()
    admin_id = next(u for u in admin if u["username"] == E2E_USERS["admin"]["username"])["id"]
    forbidden = req.post(f"/api/personal?user={admin_id}", headers=json, data={"title": "x"})
    assert forbidden.status == 403

    # 登入前查詢 /auth/me 的 401 屬預期
    assert [e for e in errors if not re.search(r"status of 401", e)] == []


def test_todo_status_and_inspector(page: Page):
    """自由待辦小狀態與詳情 inspector：切換狀態、篩選、編輯細節，重整後仍在"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["member"], "/me")
    todos = section(page, "自由待辦")
    add = todos.get_by_role("textbox", name="新增待辦")
    add.fill(TODO["d"])
    add.press("Enter")

    def row():
        return todos.locator(".pl-todo-row").filter(has_text=TODO["d"])

    def chip(label: str):
        return row().get_by_role("button", name=f"狀態：{label}，點擊變更：{TODO['d']}")

    def pick(frm: str, to: str):
        chip(frm).click()
        page.get_by_role("menuitem", name=to).click()

    expect(chip("待處理")).to_be_visible()

    # 狀態 chip：進行中 → 延後（沉到「延後與取消」）→ 取消（標題刪除線）
    pick("待處理", "進行中")
    expect(chip("進行中")).to_be_visible()
    _poll(lambda: todo_titles(page), pred=lambda v: TODO["d"] in v)
    pick("進行中", "延後")
    _poll(lambda: todo_titles(page), pred=lambda v: TODO["d"] not in v)
    parked = todos.get_by_role("list", name="延後與取消")
    expect(parked.get_by_text(TODO["d"])).to_be_visible()
    pick("延後", "取消")
    expect(row().locator(".pl-todo-title")).to_have_css("text-decoration-line", "line-through")

    # 篩選：取消 → 只剩取消的；已完成 → 看到 b；全部
    todos.get_by_role("button", name=re.compile(r"^篩選取消")).click()
    expect(todos.locator(".pl-todo-row").filter(has_text=f"-{stamp}")).to_have_count(1)
    todos.get_by_role("button", name=re.compile(r"^篩選已完成")).click()
    expect(todos.get_by_text(f"{TODO['b']}")).to_be_visible()
    todos.get_by_role("button", name=re.compile(r"^篩選全部")).click()

    # 清除已完成只清 done：取消的項目仍在
    # （此處不實際清除，避免影響後續測試；由後端 pytest 驗證）

    # inspector：標題旁開啟 → 狀態、到期日、細節
    row().get_by_role("button", name=f"開啟待辦詳情：{TODO['d']}").click()
    insp = page.locator(".pl-inspector")
    expect(insp).to_be_visible()
    todo_id = _qp(page, "todo")
    assert todo_id and re.match(r"^\d+$", todo_id)
    insp.get_by_role("button", name="狀態", exact=True).click()
    page.get_by_role("option", name="延後").click()
    insp.get_by_role("textbox", name="到期日", exact=True).fill("2030-01-02")
    detail = insp.get_by_role("textbox", name="細節")
    detail.fill("第一行\n第二行：細節內容")
    detail.press("Control+Enter")
    expect(insp.get_by_text("已儲存")).to_be_visible()
    expect(insp.get_by_text(re.compile(r"建立於"))).to_be_visible()
    expect(insp.get_by_text(re.compile(r"更新於"))).to_be_visible()

    # 重整後 inspector 與內容仍在
    page.reload()
    insp2 = page.locator(".pl-inspector")
    expect(insp2.get_by_role("textbox", name="細節")).to_have_value("第一行\n第二行：細節內容")
    expect(insp2.get_by_role("textbox", name="到期日", exact=True)).to_have_value("2030-01-02")
    expect(insp2.get_by_role("button", name="狀態", exact=True)).to_contain_text("延後")
    expect(row().get_by_role("button", name=f"狀態：延後，點擊變更：{TODO['d']}")).to_be_visible()

    # 刪除需確認
    insp2.get_by_role("button", name="刪除待辦").click()
    dialog = page.get_by_role("alertdialog")
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="取消").click()
    expect(insp2).to_be_visible()
    insp2.get_by_role("button", name="刪除待辦").click()
    page.get_by_role("alertdialog").get_by_role("button", name="刪除", exact=True).click()
    expect(page.locator(".pl-inspector")).to_have_count(0)
    expect(row()).to_have_count(0)
    assert _qp(page, "todo") is None

    assert [e for e in errors if not re.search(r"status of 401", e)] == []


def test_view_others_list_read_only(browser: Browser, base_url: str):
    """唯讀檢視他人清單：看得到內容，沒有任何可修改的控制項"""
    ctx = browser.new_context(base_url=base_url)
    page = ctx.new_page()
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["admin"], "/me")
    users = page.request.get("/api/users").json()
    member_id = next(u for u in users if u["username"] == E2E_USERS["member"]["username"])["id"]

    # 用成員切換選單前往
    page.get_by_role("button", name="檢視成員的清單").click()
    page.get_by_role("option", name=E2E_USERS["member"]["display_name"]).click()
    expect(page).to_have_url(re.compile(f"/me\\?user={member_id}"))

    name = E2E_USERS["member"]["display_name"]
    expect(page.get_by_text(f"正在檢視 {name} 的清單（唯讀）")).to_be_visible()
    todos = section(page, f"{name} 的自由待辦")
    expect(todos.get_by_text(f"{TODO['c']}改")).to_be_visible()
    expect(todos.get_by_role("textbox")).to_have_count(0)
    expect(todos.get_by_role("button", name=re.compile(r"^(刪除待辦|拖曳排序|編輯待辦|備註|狀態：)"))).to_have_count(0)
    expect(todos.get_by_role("button", name="清除已完成")).to_have_count(0)
    expect(todos.get_by_role("checkbox").first).to_be_disabled()
    expect(section(page, f"{name} 標記的任務").get_by_text(TASK)).to_be_visible()
    expect(section(page, f"指派給 {name} 的任務").get_by_text(TASK)).to_be_visible()

    # 唯讀 inspector：看得到內容，沒有任何可編輯的欄位或刪除
    todos.get_by_role("button", name=f"開啟待辦詳情：{TODO['c']}改").click()
    insp = page.locator(".pl-inspector")
    expect(insp.get_by_text("待辦詳情（唯讀）")).to_be_visible()
    expect(insp.locator(".pl-insp-readonly").first).to_have_text(f"{TODO['c']}改")
    expect(insp.get_by_role("textbox")).to_have_count(0)
    expect(insp.get_by_role("button", name=re.compile(r"刪除"))).to_have_count(0)
    page.keyboard.press("Escape")
    expect(insp).to_have_count(0)

    # PinButton 在他人清單上反映的是自己的標記（admin 沒標記）
    row = section(page, f"{name} 標記的任務").locator(".pl-task-row").filter(has_text=TASK)
    expect(pin_of(row)).to_have_attribute("aria-pressed", "false")

    # 回到我的清單；不存在的成員顯示找不到
    page.get_by_role("link", name="回到我的清單").click()
    expect(page).to_have_url(re.compile(r"/me$"))
    expect(section(page, "自由待辦")).to_be_visible()

    # 1280px 與 768px 無水平捲軸（以成員清單有資料的畫面檢查）
    page.goto(f"/me?user={member_id}")
    for width in [1280, 768]:
        page.set_viewport_size({"width": width, "height": 900})
        expect(todos.get_by_text(f"{TODO['c']}改")).to_be_visible()
        overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        assert overflow <= 0, f"{width}px"

    page.goto("/me?user=99999")
    expect(page.get_by_text("找不到這位成員")).to_be_visible()

    # 登入前查詢 /auth/me 的 401 屬預期
    assert [e for e in errors if not re.search(r"status of 401", e)] == []
    ctx.close()
