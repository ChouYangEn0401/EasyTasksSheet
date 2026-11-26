"""status-project.spec.ts 的 Python 版：狀態管理（清單／看板）與 FilterBar 直接新增專案、權限。"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from urllib.parse import quote

import pytest
from playwright.sync_api import Browser, Page, expect

from .helpers import E2E_USERS, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# feat/status-project：statuses.manage 者可在清單 / 看板管理狀態；projects.create 者可在 FilterBar 直接新增專案。
# 截圖：設 E2E_SHOTS=<目錄> 時輸出（驗收用）。
# （原檔 serial：pytest 同檔內本來就照順序跑）

SHOTS = os.environ.get("E2E_SHOTS")


def shot(page: Page, name: str) -> None:
    if not SHOTS:
        return
    page.wait_for_timeout(400)  # 等對話框淡入
    Path(SHOTS).mkdir(parents=True, exist_ok=True)
    page.screenshot(path=f"{SHOTS}/{name}.png")


def test_manager_status_management(page: Page):
    """manager：新增狀態出現在清單 / 看板 / 篩選；刪除使用中的狀態走改移流程"""
    page.set_viewport_size({"width": 1280, "height": 800})
    name = f"驗收{int(time.time() * 1000) % 100000}"
    login_via_ui(page, E2E_USERS["manager"])
    # 清單要有任務才會出現群組標頭列
    seed = page.request.post("/api/tasks", data={"title": f"E2E-seed-{name}"}).json()
    page.goto("/tasks/list")
    expect(page.locator(".tl-row--group").first).to_be_visible()

    # 群組標頭列末端的「＋ 新增狀態」
    page.get_by_role("button", name="新增狀態").first.click()
    add = page.get_by_role("dialog", name="新增狀態")
    add.get_by_label("狀態名稱").fill(name)
    shot(page, "01-add-status-dialog")
    page.keyboard.press("Enter")
    expect(add).to_be_hidden()
    expect(page.get_by_text(f"已新增狀態「{name}」")).to_be_visible()

    statuses = page.request.get("/api/statuses").json()
    created = next((s for s in statuses if s["name"] == name), None)
    assert created

    # 篩選的狀態選項、看板欄位立即出現
    page.get_by_role("button", name="狀態", exact=True).click()
    expect(page.get_by_role("option", name=name)).to_be_visible()
    page.keyboard.press("Escape")
    page.goto("/tasks/kanban")
    expect(page.get_by_role("button", name="新增欄位")).to_be_visible()
    expect(page.get_by_text(name).first).to_be_visible()
    page.get_by_role("button", name="新增欄位").scroll_into_view_if_needed()
    shot(page, "02-kanban-add-column")

    # 建一筆任務放在新狀態，再由清單的狀態下拉「管理狀態…」開對話框
    title = f"E2E-{name}"
    t = page.request.post("/api/tasks", data={"title": title, "statusId": created["id"]}).json()
    page.goto(f"/tasks/list?q={quote(title, safe='')}")
    page.get_by_role("button", name=f"狀態：{name}").click()
    page.get_by_role("button", name="管理狀態…").click()
    manage = page.get_by_role("dialog", name="管理狀態")
    expect(manage.get_by_text("類別決定統計與看板歸類")).to_be_visible()
    row = manage.get_by_test_id("status-row").filter(has=page.get_by_label(f"狀態名稱：{name}"))
    expect(row.get_by_text("1 筆任務")).to_be_visible()

    # 改名、改色
    row.get_by_label(f"狀態名稱：{name}").fill(f"{name}改")
    row.get_by_label(f"狀態名稱：{name}").press("Enter")
    expect(manage.get_by_label(f"狀態名稱：{name}改")).to_be_visible()
    manage.get_by_label(f"顏色：{name}改").get_by_role("radio", name="orange").click()
    shot(page, "03-manage-statuses")

    # 刪除使用中的狀態：改移到「待辦」
    manage.get_by_role("button", name=f"刪除狀態：{name}改").click()
    panel = manage.get_by_test_id("delete-status-panel")
    expect(panel).to_contain_text("有 1 筆任務")
    shot(page, "04-migrate-and-delete")
    panel.get_by_role("button", name="改移任務並刪除").click()
    expect(manage.get_by_label(f"狀態名稱：{name}改")).to_have_count(0)

    after = page.request.get("/api/statuses").json()
    assert not any(s["id"] == created["id"] for s in after)
    moved = page.request.get(f"/api/tasks/{t['id']}").json()
    assert moved["statusId"] != created["id"]
    manage.get_by_role("button", name="完成", exact=True).click()
    page.request.delete(f"/api/tasks/{t['id']}")
    page.request.delete(f"/api/tasks/{seed['id']}")


def test_user_no_status_management_but_can_add_project(page: Page, browser: Browser, base_url: str):
    """user：看不到狀態管理入口，但能新增專案並自動套用篩選"""
    page.set_viewport_size({"width": 1280, "height": 800})
    login_via_ui(page, E2E_USERS["member"])
    seed = page.request.post("/api/tasks", data={"title": f"E2E-seed-{int(time.time() * 1000)}"}).json()
    page.goto("/tasks/list")
    expect(page.locator(".tl-row--group").first).to_be_visible()
    expect(page.get_by_role("button", name="新增狀態")).to_have_count(0)
    page.goto("/tasks/kanban")
    expect(page.get_by_role("button", name="新增欄位")).to_have_count(0)

    # 狀態欄位下拉沒有「管理狀態…」
    title = f"E2E-user-{int(time.time() * 1000) % 100000}"
    t = page.request.post("/api/tasks", data={"title": title}).json()
    page.goto(f"/tasks/list?q={quote(title, safe='')}")
    page.get_by_role("button", name=re.compile(r"^狀態：")).first.click()
    expect(page.get_by_role("option").first).to_be_visible()
    expect(page.get_by_role("button", name="管理狀態…")).to_have_count(0)
    page.keyboard.press("Escape")
    page.request.delete(f"/api/tasks/{t['id']}")
    page.request.delete(f"/api/tasks/{seed['id']}")

    # FilterBar 專案下拉底部「新增專案」；無 projects.manage 看不到「管理專案…」
    page.goto("/tasks/list")
    pname = f"專案{int(time.time() * 1000) % 100000}"
    page.get_by_role("button", name="專案", exact=True).click()
    expect(page.get_by_role("button", name="管理專案…")).to_have_count(0)
    shot(page, "05-project-dropdown")
    page.get_by_role("button", name="新增專案").click()
    dlg = page.get_by_role("dialog", name="新增專案")
    dlg.get_by_label("專案顏色").get_by_role("radio", name="teal").click()
    dlg.get_by_label("專案名稱").fill(pname)
    shot(page, "06-add-project-dialog")
    page.keyboard.press("Enter")
    expect(dlg).to_be_hidden()
    expect(page.get_by_text(f"已新增專案「{pname}」")).to_be_visible()
    # 建立後自動成為目前的專案篩選
    expect(page).to_have_url(re.compile(r"project=\d+"))
    expect(page.get_by_role("button", name=f"專案：{pname}")).to_be_visible()

    # 收尾：由 manager 封存測試專案（預設專案不可刪除，其他專案也只封存）
    projects = page.request.get("/api/projects").json()
    mine = next(p for p in projects if p["name"] == pname)
    ctx = browser.new_context(base_url=base_url)
    mgr = ctx.new_page()
    login_via_ui(mgr, E2E_USERS["manager"])
    # manager 在管理專案對話框中封存
    mgr.goto("/tasks/list")
    mgr.get_by_role("button", name="專案", exact=True).click()
    mgr.get_by_role("button", name="管理專案…").click()
    pm = mgr.get_by_role("dialog", name="管理專案")
    shot(mgr, "07-manage-projects")
    pm.get_by_role("button", name=f"封存：{pname}").click()
    expect(pm.get_by_test_id("project-row").filter(has_text=pname)).to_have_count(0)
    check = mgr.request.get("/api/projects").json()
    assert next(p for p in check if p["id"] == mine["id"])["isArchived"] is True
    ctx.close()


def test_backend_403_message(page: Page):
    """後端 403：沒有權限的人呼叫管理 API 顯示中文錯誤"""
    login_via_ui(page, E2E_USERS["member"])
    res = page.request.post("/api/statuses", data={"name": "x"})
    assert res.status == 403
    assert res.json()["error"]["message"] == "沒有權限執行此操作"
