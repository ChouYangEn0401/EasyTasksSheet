"""task-relations.spec.ts 的 Python 版：相關任務（新增 → 清單連結數 → 跳轉 → 移除）與複製任務。"""

from __future__ import annotations

import os
import re
import time
from urllib.parse import quote

import pytest
from playwright.sync_api import Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# feat/task-relations：相關任務（新增 → 清單連結數 → 跳轉 → 移除）與複製任務
# （原檔 serial：pytest 同檔內本來就照順序跑）

shots = os.environ.get("SHOTS_DIR")


def shot(page: Page, name: str) -> None:
    if not shots:
        return
    page.wait_for_timeout(400)  # 等進場動畫結束
    page.screenshot(path=f"{shots}/{name}.png")


def create_task(page: Page, title: str, extra: dict | None = None) -> dict:
    res = page.request.post("/api/tasks", data={"title": title, **(extra or {})})
    assert res.status == 201
    return res.json()


def fetch_tasks(page: Page, q: str) -> list[dict]:
    return page.request.get(f"/api/tasks?q={quote(q, safe='')}").json()


def test_related_tasks(page: Page):
    """相關任務：新增、清單連結數、跳轉、移除"""
    errors = collect_errors(page)
    P = f"REL-{int(time.time() * 1000)}"
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    a = create_task(page, f"{P} ntu ranking new workflow")
    b = create_task(page, f"{P} pyDMS related repo integration mechanism")

    for width in [1280, 768]:
        page.set_viewport_size({"width": width, "height": 860})
        page.goto(f"/tasks/list?q={P}&task={a['id']}")
        drawer = page.locator(".task-drawer")
        section = drawer.get_by_test_id("related-tasks")
        expect(section.get_by_text("還沒有相關任務")).to_be_visible()

        # 開啟搜尋選單 → 輸入關鍵字 → 鍵盤選取 Enter 加入
        section.get_by_role("button", name="新增關聯").click()
        search = page.get_by_role("combobox", name="搜尋要關聯的任務")
        expect(search).to_be_focused()
        search.fill(f"{P} pyDMS")
        option = page.get_by_role("option", name=re.compile(r"pyDMS related repo"))
        expect(option).to_be_visible()
        # 自己不會出現在結果中
        search.fill(P)
        expect(page.get_by_role("option")).to_have_count(1)
        shot(page, f"{width}-relation-search")
        search.press("ArrowDown")
        search.press("Enter")
        expect(search).to_be_hidden()
        row = section.get_by_role("button", name=re.compile(r"開啟相關任務「.*pyDMS"))
        expect(row).to_be_visible()
        shot(page, f"{width}-related-section")

        # 清單出現連結數（兩端都有）
        badge_a = page.locator(f'.tl-row--task[data-task-id="{a["id"]}"]').get_by_test_id("relation-badge")
        badge_b = page.locator(f'.tl-row--task[data-task-id="{b["id"]}"]').get_by_test_id("relation-badge")
        expect(badge_a).to_have_accessible_name("1 個相關任務")
        expect(badge_b).to_have_text("1")
        assert [t.get("relationCount") for t in fetch_tasks(page, P)] == [1, 1]

        # 點擊跳轉 → 抽屜切換到 B，B 也看得到 A；返回鍵回到 A
        row.click()
        expect(page).to_have_url(re.compile(f"task={b['id']}"))
        expect(drawer.get_by_test_id("related-tasks").get_by_text(re.compile(r"ntu ranking new workflow"))).to_be_visible()
        shot(page, f"{width}-jumped")
        drawer.get_by_role("button", name=re.compile(r"^返回")).click()
        expect(page).to_have_url(re.compile(f"task={a['id']}"))

        # 移除（可復原）
        section_a = page.locator(".task-drawer").get_by_test_id("related-tasks")
        section_a.get_by_role("button", name=re.compile(r"移除相關任務")).click()
        expect(section_a.get_by_text("還沒有相關任務")).to_be_visible()
        expect(page.get_by_text("已移除相關任務")).to_be_visible()
        expect(badge_a).to_have_count(0)
        expect(badge_b).to_have_count(0)

    # 看板卡片也顯示連結數
    rel = page.request.post(f"/api/tasks/{a['id']}/relations", data={"targetId": b["id"]})
    assert rel.status == 201
    page.set_viewport_size({"width": 1280, "height": 860})
    page.goto(f"/tasks/kanban?q={P}")
    expect(page.locator(f'.kanban-card[data-task-id="{a["id"]}"]').get_by_test_id("relation-badge")).to_have_text("1")
    shot(page, "1280-kanban-badge")
    for width in [1280, 768]:
        page.set_viewport_size({"width": width, "height": 860})
        page.goto(f"/tasks/list?q={P}")
        expect(page.locator(f'.tl-row--task[data-task-id="{b["id"]}"]').get_by_test_id("relation-badge")).to_be_visible()
        page.mouse.move(0, 0)
        shot(page, f"{width}-list-badge")

    assert [e for e in errors if not re.search(r"Failed to load resource", e)] == []


def test_duplicate_task(page: Page):
    """複製任務：預設選項 → 新任務在待辦並與原任務相關"""
    errors = collect_errors(page)
    P = f"DUP-{int(time.time() * 1000)}"
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    statuses = page.request.get("/api/statuses").json()
    doing = next(s for s in statuses if s["category"] == "doing")
    todo = next(s for s in statuses if s["category"] == "todo")
    src = create_task(
        page,
        f"{P} 原任務",
        {"statusId": doing["id"], "description": "要帶過去的描述", "priority": "high"},
    )

    for width in [1280, 768]:
        page.set_viewport_size({"width": width, "height": 860})
        page.goto(f"/tasks/list?q={P}&task={src['id']}")
        drawer = page.locator(".task-drawer")
        expect(drawer.get_by_test_id("related-tasks")).to_be_visible()
        if width == 1280:
            # 選單開啟
            drawer.get_by_role("button", name="更多動作").click()
            page.get_by_role("menuitem", name=re.compile(r"複製任務")).click()
        else:
            # 快速鍵 D（focus 在抽屜內）
            drawer.get_by_role("button", name="關閉任務詳情").focus()
            page.keyboard.press("d")
        dialog = page.get_by_role("dialog", name="複製任務")
        expect(dialog).to_be_visible()
        title = dialog.get_by_label("標題")
        expect(title).to_have_value(f"{P} 原任務（複製）")
        for label in ["描述", "自訂欄位", "開始日與到期日", "負責人", "預估工時", "優先度"]:
            expect(dialog.get_by_label(label, exact=True)).to_be_checked()
        expect(dialog.get_by_label("並與原任務建立相關連結")).to_be_checked()
        shot(page, f"{width}-duplicate-dialog")
        if width == 768:
            # Esc 取消
            page.keyboard.press("Escape")
            expect(dialog).to_be_hidden()
            continue
        # Ctrl+Enter 送出
        title.press("Control+Enter")
        expect(dialog).to_be_hidden()
        # toast 標題（名稱截斷為 20 字）
        expect(page.get_by_text(re.compile(f"已建立「{P}"))).to_be_visible()
        # 抽屜切換到新任務並聚焦標題
        expect(page).not_to_have_url(re.compile(f"task={src['id']}(&|$)"))
        expect(drawer.locator(".tl-drawer-title-field")).to_be_focused()
        expect(drawer.get_by_test_id("related-tasks").get_by_text(f"{P} 原任務", exact=True)).to_be_visible()

    all_tasks = fetch_tasks(page, P)
    copy = next((t for t in all_tasks if t["title"] == f"{P} 原任務（複製）"), None)
    assert copy
    assert copy["statusId"] == todo["id"]
    assert copy["relationCount"] == 1
    detail = page.request.get(f"/api/tasks/{copy['id']}").json()
    assert detail["description"] == "要帶過去的描述"
    assert detail["priority"] == "high"
    assert detail["progress"] == 0
    # 清單：新任務在待辦群組，原任務顯示連結數
    page.goto(f"/tasks/list?q={P}")
    expect(page.locator(f'.tl-row--task[data-task-id="{src["id"]}"]').get_by_test_id("relation-badge")).to_have_text("1")

    assert [e for e in errors if not re.search(r"Failed to load resource", e)] == []
