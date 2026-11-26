"""delay-link.spec.ts 的 Python 版：延遲鏈（docs/design/delay-link.md）——依賴、看板標示、延遲鏈分頁、循環被拒、權限、大鏈。"""

from __future__ import annotations

import datetime as _dt
import os
import re
import time
from urllib.parse import quote

import pytest
from playwright.sync_api import APIRequestContext, Browser, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 延遲鏈（docs/design/delay-link.md）：在詳情建立 A→B→C 依賴 → 看板變色並顯示延後 → 延遲鏈分頁顯示整條鏈與最長路徑
# → 嘗試建立循環被拒 → A 完成後 B 不再被擋；成員沒有 tasks.edit 時不可新增（結尾還原權限）。
# 截圖：設定 SHOTS_DIR 時輸出 1280 / 768 兩種寬度。
# （原檔 serial：pytest 同檔內本來就照順序跑）

stamp = int(time.time() * 1000)
T = {"a": f"延遲A-{stamp}", "b": f"延遲B-{stamp}", "c": f"延遲C-{stamp}"}
json = {"Content-Type": "application/json"}
shots = os.environ.get("SHOTS_DIR")


def day_str(offset: int) -> str:
    return (_dt.date.today() + _dt.timedelta(days=offset)).isoformat()


def md(offset: int) -> str:
    return day_str(offset)[5:].replace("-", "/", 1)


def create_task(req: APIRequestContext, data: dict) -> dict:
    res = req.post("/api/tasks", headers=json, data=data)
    assert res.status == 201
    return res.json()


def done_status_id(req: APIRequestContext) -> int:
    return next(s for s in req.get("/api/statuses").json() if s["category"] == "done")["id"]


def drawer(page: Page):
    return page.locator("aside.task-drawer")


def dep_section(page: Page):
    return drawer(page).get_by_test_id("dep-section")


def card(page: Page, title: str):
    return page.get_by_role("listitem", name=re.compile(f"^{re.escape(title)}，"))


def add_blocker(page: Page, task_id: int, blocker_title: str) -> None:
    page.goto(f"/tasks/kanban?q={stamp}&task={task_id}")
    expect(dep_section(page)).to_be_visible()
    dep_section(page).get_by_role("button", name="新增前置任務").click()
    search = page.get_by_role("combobox", name="搜尋要連結的任務")
    search.fill(blocker_title)
    expect(page.get_by_role("option", name=blocker_title)).to_be_visible()
    search.press("Enter")


def shoot(page: Page, name: str, fn=None) -> None:
    if not shots:
        return
    for width in [1280, 768]:
        page.set_viewport_size({"width": width, "height": 900})
        page.mouse.move(0, 0)
        if fn:
            fn()
        page.wait_for_timeout(150)
        page.screenshot(path=f"{shots}/{name}-{width}.png")
    page.set_viewport_size({"width": 1280, "height": 720})


def test_dependencies_full_flow(page: Page):
    """依賴：建立 A→B→C、看板標示、延遲鏈、循環被拒、完成後解除"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["admin"], "/tasks/delay-link")
    req = page.request

    # 分頁在甘特圖後面；空狀態（此 spec 之前沒有任何依賴時）
    tabs = page.get_by_role("navigation", name="任務檢視").get_by_role("link")
    expect(tabs).to_have_text(["清單", "看板", "甘特圖", "延遲鏈"])
    empty = page.get_by_text("目前沒有依賴關係")
    try:
        empty_visible = empty.is_visible()
    except Exception:
        empty_visible = False
    if empty_visible:
        expect(page.get_by_text("在任務詳情的「依賴」加入前置任務，就能在這裡看到整條鏈")).to_be_visible()
        shoot(page, "delay-link-empty")

    A = create_task(req, {"title": T["a"], "dueDate": day_str(5)})
    B = create_task(req, {"title": T["b"], "startDate": day_str(2), "dueDate": day_str(4)})
    C = create_task(req, {"title": T["c"], "dueDate": day_str(6)})

    # 在詳情建立依賴：B 等 A、C 等 B
    add_blocker(page, B["id"], T["a"])
    expect(page.get_by_text("已加入前置任務").first).to_be_visible()
    expect(dep_section(page).get_by_test_id("dep-row").filter(has_text=T["a"])).to_be_visible()
    expect(dep_section(page).get_by_test_id("dep-self")).to_contain_text(f"預計延後 4 天（到 {md(8)}）")
    add_blocker(page, C["id"], T["b"])
    expect(dep_section(page).get_by_test_id("dep-row").filter(has_text=T["b"])).to_contain_text(
        f"預計延後 4 天（到 {md(8)}）"
    )
    shoot(page, "drawer-deps")

    # 看板：B / C 為「等待中」並顯示延後；A 顯示「擋住 1」
    page.goto(f"/tasks/kanban?q={stamp}")
    expect(card(page, T["b"])).to_have_class(re.compile(r"dep-card--blocked"))
    expect(card(page, T["b"]).get_by_test_id("dep-waiting")).to_have_text(f"等待中 · 預計延後 4 天 → {md(8)}")
    expect(card(page, T["c"]).get_by_test_id("dep-waiting")).to_have_text(f"等待中 · 預計延後 3 天 → {md(9)}")
    expect(card(page, T["a"])).not_to_have_class(re.compile(r"dep-card--blocked"))
    expect(card(page, T["a"]).get_by_test_id("dep-blocks")).to_have_text("擋住 1")
    expect(card(page, T["b"]).get_by_test_id("dep-lock")).to_be_visible()
    shoot(page, "kanban-blocked")
    # 顯示開關：關閉後不顯示，重新整理後仍記得；再打開
    toggle = page.get_by_label("顯示依賴標示")
    toggle.uncheck()
    expect(card(page, T["b"])).not_to_have_class(re.compile(r"dep-card--blocked"))
    page.reload()
    expect(page.get_by_label("顯示依賴標示")).not_to_be_checked()
    page.get_by_label("顯示依賴標示").check()
    expect(card(page, T["b"])).to_have_class(re.compile(r"dep-card--blocked"))

    # 清單：標題旁鎖頭
    page.goto(f"/tasks/list?q={stamp}")
    expect(page.get_by_test_id("dep-lock")).to_have_count(2)

    # 延遲鏈分頁
    page.goto(f"/tasks/delay-link?q={stamp}")
    expect(page.get_by_test_id("dl-summary")).to_have_text("共 1 條依賴鏈・最長預計延後 4 天")
    chain = page.get_by_test_id("dl-chain")
    expect(chain).to_have_count(1)
    expect(chain.locator(".dl-node")).to_have_count(3)
    expect(chain.locator(".dl-node.is-critical")).to_have_count(3)
    expect(chain.get_by_text("強調的路徑決定了最終完成日")).to_be_visible()
    expect(chain.locator(f'[data-node-id="{A["id"]}"]')).to_contain_text("可立即開始")
    expect(chain.locator(f'[data-node-id="{B["id"]}"]')).to_contain_text("+4 天")
    expect(chain.locator(".dl-edge")).to_have_count(2)
    # 鍵盤：→ 沿箭頭移動，Enter 開啟詳情
    chain.locator(f'[data-node-id="{A["id"]}"]').focus()
    page.keyboard.press("ArrowRight")
    expect(chain.locator(f'[data-node-id="{B["id"]}"]')).to_be_focused()
    page.keyboard.press("Enter")
    expect(page).to_have_url(re.compile(f"task={B['id']}"))
    page.keyboard.press("Escape")
    page.goto(f"/tasks/delay-link?q={stamp}")
    expect(page.get_by_test_id("dl-chain")).to_be_visible()
    shoot(page, "delay-link-chain")

    # 循環：A 等 C → 拒絕並顯示中文訊息
    add_blocker(page, A["id"], T["c"])
    expect(page.get_by_role("alert").filter(has_text="會形成循環")).to_contain_text(
        f"無法建立：「{T['c']}」 → 「{T['a']}」 → 「{T['b']}」 → 「{T['c']}」 會形成循環"
    )
    page.keyboard.press("Escape")

    # A 完成 → B 不再被擋（紀錄保留，可在延遲鏈顯示已完成的前置任務）
    req.patch(f"/api/tasks/{A['id']}", headers=json, data={"statusId": done_status_id(req)})
    page.goto(f"/tasks/kanban?q={stamp}")
    expect(card(page, T["b"])).not_to_have_class(re.compile(r"dep-card--blocked"))
    expect(card(page, T["c"])).to_have_class(re.compile(r"dep-card--blocked"))
    page.goto(f"/tasks/delay-link?q={stamp}")
    expect(page.get_by_test_id("dl-chain").locator(".dl-node")).to_have_count(2)
    page.get_by_label("顯示已完成的前置任務").check()
    expect(page.get_by_test_id("dl-chain").locator(".dl-node")).to_have_count(3)
    expect(page.get_by_test_id("dl-chain").locator(".dl-node.is-done")).to_have_count(1)
    page.get_by_label("顯示已完成的前置任務").uncheck()

    # 移除依賴（附復原）
    page.goto(f"/tasks/list?q={stamp}&task={C['id']}")
    row = dep_section(page).get_by_test_id("dep-row").filter(has_text=T["b"])
    row.hover()
    row.get_by_role("button", name=f"移除依賴「{T['b']}」").click()
    expect(row).to_have_count(0)
    page.get_by_role("button", name="復原", exact=True).click()
    expect(dep_section(page).get_by_test_id("dep-row").filter(has_text=T["b"])).to_be_visible()

    # 409（循環被拒）與登入前的 401 為預期內的請求失敗
    assert [e for e in errors if not re.search(r"\b(401|409)\b", e)] == []


def test_member_without_tasks_edit_cannot_add_dependency(browser: Browser, base_url: str):
    """成員沒有 tasks.edit 時不能新增依賴（結尾還原）"""
    root_ctx = browser.new_context(base_url=base_url)
    root = root_ctx.new_page()
    login_via_ui(root, E2E_USERS["admin"], "/")
    member_ctx = browser.new_context(base_url=base_url)
    member = member_ctx.new_page()
    try:
        tasks = root.request.get(f"/api/tasks?q={stamp}").json()
        B = next(t for t in tasks if t["title"] == T["b"])
        C = next(t for t in tasks if t["title"] == T["c"])
        res = root.request.put(
            "/api/admin/permissions",
            headers=json,
            data={"changes": [{"role": "user", "capability": "tasks.edit", "allowed": False}]},
        )
        assert res.status == 200
        login_via_ui(member, E2E_USERS["member"], f"/tasks/list?q={stamp}&task={C['id']}")
        expect(dep_section(member)).to_be_visible()
        expect(dep_section(member).get_by_test_id("dep-row").first).to_be_visible()
        expect(dep_section(member).get_by_role("button", name="新增前置任務")).to_have_count(0)
        expect(dep_section(member).get_by_role("button", name=re.compile(r"移除依賴"))).to_have_count(0)
        post = member.request.post(
            f"/api/tasks/{B['id']}/dependencies",
            headers=json,
            data={"direction": "blocks", "targetId": C["id"]},
        )
        assert post.status == 403
        assert member.request.get("/api/tasks/delay-chains").status == 200
    finally:
        root.request.post("/api/admin/permissions/reset", headers=json, data={})
        root_ctx.close()
        member_ctx.close()


def test_big_chain_55_tasks(page: Page):
    """大鏈（55 個任務）可正常顯示"""
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    req = page.request
    tag = f"大鏈-{stamp}"
    ids: list[int] = []
    for i in range(55):
        data = {"title": f"{tag}-{str(i + 1).zfill(2)}"}
        if i % 4 != 3:
            data["dueDate"] = day_str(2 + i // 5)
        ids.append(create_task(req, data)["id"])
    # 每層 5 個，往下一層各連 1～2 條；偶爾跨層
    for i in range(5, 55):
        blockers = {ids[i - 5], ids[max(0, i - 5 - (i % 2))]}
        if i % 7 == 0 and i >= 10:
            blockers.add(ids[i - 10])
        for b in blockers:
            data = {"direction": "blocked_by", "targetId": b}
            if i % 9 == 0:
                data["lagDays"] = 1
            r = req.post(f"/api/tasks/{ids[i]}/dependencies", headers=json, data=data)
            assert r.status in [200, 201]
    t0 = time.time()
    page.goto(f"/tasks/delay-link?q={quote(tag, safe='')}")
    chain = page.get_by_test_id("dl-chain")
    expect(chain.locator(".dl-node")).to_have_count(55)
    assert (time.time() - t0) * 1000 < 10_000
    expect(chain.locator(".dl-lag").first).to_be_visible()
    shoot(page, "delay-link-big")
    # 窄螢幕：由上而下堆疊
    page.set_viewport_size({"width": 700, "height": 900})
    expect(chain.locator(".dl-stack .dl-node")).to_have_count(55)
    page.set_viewport_size({"width": 1280, "height": 720})
    # 清除：大量有日期的任務會影響之後的甘特圖 spec
    for tid in ids:
        req.delete(f"/api/tasks/{tid}", headers=json)
