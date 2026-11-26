"""task-list.spec.ts 的 Python 版：T1 List 檢視（快速新增、就地編輯、狀態、排序、分組、自訂欄位、Drawer）。"""

from __future__ import annotations

import os
import re
import time
from urllib.parse import quote

import pytest
from playwright.sync_api import Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# T1 feat/task-list：快速新增 → 就地編輯 → 一鍵完成 → 排序 / 分組 → 自訂欄位 → Drawer
# （原檔 serial：pytest 同檔內本來就照順序跑）


def fetch_tasks(page: Page, q: str) -> list[dict]:
    res = page.request.get(f"/api/tasks?q={quote(q, safe='')}")
    return res.json()


def test_list_view_full_flow(page: Page):
    """List 檢視：快速新增、就地編輯、狀態、排序、自訂欄位、Drawer"""
    errors = collect_errors(page)
    P = f"T1-{int(time.time() * 1000)}"
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")

    # 空狀態（全新 DB 時）
    expect(page.get_by_text(re.compile(r"共 \d+ 筆"))).to_be_visible()
    if page.get_by_text("共 0 筆").is_visible():
        expect(page.get_by_text("還沒有任務")).to_be_visible()

    # 以關鍵字篩選，只看本測試建立的任務
    page.goto(f"/tasks/list?q={P}")
    expect(page.get_by_text("沒有符合條件的任務")).to_be_visible()

    # ── 快速新增：N 聚焦 → Enter 建立 → 保持 focus 連續新增，不需重整即出現 ──
    page.locator("#main").click(position={"x": 5, "y": 300})
    page.keyboard.press("n")
    quick_add = page.get_by_role("textbox", name="快速新增任務")
    expect(quick_add).to_be_focused()
    quick_add.fill(f"{P} 甲")
    quick_add.press("Enter")
    expect(quick_add).to_have_value("")
    expect(quick_add).to_be_focused()
    quick_add.fill(f"{P} 乙")
    quick_add.press("Enter")
    expect(quick_add).to_have_value("")
    rows = page.locator(".tl-row--task")
    expect(rows).to_have_count(2)
    expect(page.locator("[data-task-id]:not([data-temp])")).to_have_count(2)
    quick_add.press("Escape")

    # 以 id 定位列（編輯中時列文字會變成輸入框）
    def row_of(title: str):
        tid = page.locator(".tl-row--task", has_text=title).get_attribute("data-task-id")
        return page.locator(f'.tl-row--task[data-task-id="{tid}"]')

    row_a = row_of(f"{P} 甲")
    row_b = row_of(f"{P} 乙")
    # 依狀態分組：新任務在「待辦」；每列顯示最後更新
    expect(page.locator(".tl-row--group").first).to_contain_text("待辦")
    expect(row_a.locator("time")).to_have_text("剛剛")

    # ── 就地編輯標題 ──
    row_a.locator(".tl-field--title .tl-title-text").click()
    title_input = row_a.locator(".tl-field--title input")
    expect(title_input).to_be_focused()
    title_input.fill(f"{P} 甲改")
    title_input.press("Enter")
    row_a2 = row_a
    expect(row_a2.locator(".tl-field--title")).to_have_text(f"{P} 甲改")

    # ── 改狀態：點 StatusBadge → 面板選項 ──
    row_b.locator(".tl-field--status").click()
    page.get_by_role("option", name="進行中").click()
    expect(row_b.locator(".tl-field--status")).to_contain_text("進行中")

    # ── 一鍵完成 ──
    done_btn = row_a2.get_by_role("button", name="標記為完成")
    done_btn.click()
    expect(done_btn).to_have_attribute("aria-pressed", "true")
    expect(row_a2.locator(".tl-field--status")).to_contain_text("完成")

    # ── 負責人 ──
    row_b.locator(".tl-field--assignee").click()
    page.get_by_role("option", name=E2E_USERS["admin"]["display_name"]).click()
    expect(row_b.locator(".tl-field--assignee")).to_contain_text(E2E_USERS["admin"]["display_name"])

    # ── 日期：到期日早於開始日 → 錯誤；正常日期 → 寫入 ──
    row_b.locator(".tl-field--startDate").click()
    page.get_by_role("dialog", name="開始日").locator('input[type="date"]').fill("2026-12-05")
    expect(row_b.locator(".tl-field--startDate")).to_contain_text("12/05")
    row_b.locator(".tl-field--dueDate").click()
    page.get_by_role("dialog", name="到期日").locator('input[type="date"]').fill("2026-12-01")
    expect(row_b.get_by_role("alert")).to_have_text("到期日不可早於開始日")
    row_b.locator(".tl-field--dueDate").click()
    page.get_by_role("dialog", name="到期日").locator('input[type="date"]').fill("2026-12-31")
    expect(row_b.locator(".tl-field--dueDate")).to_contain_text("12/31")

    # ── 預估工時：非數字 → 錯誤並回復；2.5 → 寫入 ──
    est = row_b.locator(".tl-field--estimate")
    est.click()
    page.keyboard.type("abc")
    page.keyboard.press("Enter")
    expect(row_b.get_by_role("alert")).to_have_text("請輸入數字")
    est.click()
    page.keyboard.type("2.5")
    page.keyboard.press("Enter")
    expect(est).to_have_text("2.5")

    # ── 鍵盤：方向鍵移動、Enter 進入編輯、Esc 取消 ──
    est.focus()
    page.keyboard.press("ArrowLeft")
    expect(row_b.locator(".tl-field--dueDate")).to_be_focused()
    page.keyboard.press("ArrowRight")
    page.keyboard.press("Enter")
    expect(est.locator("input")).to_be_focused()
    page.keyboard.press("Escape")
    expect(est).to_be_focused()

    # ── 排序：點欄名升冪 → 降冪 → 取消（寫入 URL） ──
    title_header = page.get_by_role("columnheader", name=re.compile(r"^標題"))
    title_header.locator(".tl-hcell-label").click()
    expect(page).to_have_url(re.compile(r"sort=title&dir=asc"))
    expect(title_header).to_have_attribute("aria-sort", "ascending")
    title_header.locator(".tl-hcell-label").click()
    expect(title_header).to_have_attribute("aria-sort", "descending")
    title_header.locator(".tl-hcell-label").click()
    expect(page).not_to_have_url(re.compile(r"sort="))

    # ── 分組：負責人 → 回到狀態 ──
    page.get_by_role("button", name="分組").click()
    page.get_by_role("option", name="負責人").click()
    expect(page).to_have_url(re.compile(r"group=assignee"))
    expect(page.locator(".tl-row--group", has_text="未指派")).to_be_visible()
    page.get_by_role("button", name="分組").click()
    page.get_by_role("option", name="狀態").click()
    expect(page).not_to_have_url(re.compile(r"group="))

    # ── 自訂欄位：新增 → 填值 → 改名 → 隱藏 / 顯示 → 刪除（需確認） ──
    page.locator(".tl-hcell--add").get_by_role("button", name="新增欄位").click()
    panel = page.get_by_role("dialog", name="新增欄位")
    expect(panel.get_by_label("名稱")).to_be_focused()
    panel.get_by_label("名稱").fill("狀態")
    expect(panel.get_by_text("已有同名欄位")).to_be_visible()
    expect(panel.get_by_role("button", name="建立")).to_be_disabled()
    prop_name = f"批次{int(time.time() * 1000) % 10000}"
    panel.get_by_label("名稱").fill(prop_name)
    panel.get_by_role("button", name="建立").click()
    expect(panel).to_have_count(0)
    prop_header = page.get_by_role("columnheader", name=re.compile(f"^{prop_name}"))
    expect(prop_header).to_be_visible()

    text_cell = row_b.locator(".tl-field--text")
    text_cell.click()
    page.keyboard.type("B-12")
    page.keyboard.press("Enter")
    expect(text_cell).to_have_text("B-12")

    prop_header.get_by_role("button", name=f"{prop_name} 欄位選單").click()
    page.get_by_role("menuitem", name="重新命名").click()
    rename_input = page.get_by_role("textbox", name="欄位名稱")
    rename_input.fill(f"{prop_name}改")
    rename_input.press("Enter")
    renamed = page.get_by_role("columnheader", name=re.compile(f"^{prop_name}改"))
    expect(renamed).to_be_visible()

    page.get_by_role("button", name="欄位", exact=True).click()
    columns_panel = page.get_by_role("dialog", name="欄位")
    columns_panel.get_by_label(f"{prop_name}改").uncheck()
    expect(renamed).to_have_count(0)
    columns_panel.get_by_label(f"{prop_name}改").check()
    expect(renamed).to_be_visible()
    page.keyboard.press("Escape")

    renamed.get_by_role("button", name=f"{prop_name}改 欄位選單").click()
    page.get_by_role("menuitem", name="刪除欄位").click()
    confirm = page.get_by_role("alertdialog", name=f"刪除欄位「{prop_name}改」？")
    expect(confirm.get_by_role("button", name="取消")).to_be_focused()
    confirm.get_by_role("button", name="刪除欄位").click()
    expect(renamed).to_have_count(0)

    # ── Drawer：從列開啟、編輯欄位與描述、顯示更新時間 ──
    row_b.hover()
    row_b.get_by_role("button", name="開啟").click()
    drawer = page.get_by_role("dialog", name=f"{P} 乙")
    expect(drawer).to_be_visible()
    expect(row_b).to_have_attribute("data-selected", "true")
    expect(drawer.get_by_text(re.compile(r"更新於"))).to_be_visible()
    expect(drawer.get_by_text(re.compile(r"建立於"))).to_be_visible()
    expect(drawer.get_by_text("尚未建立自訂欄位")).to_be_visible()
    drawer.get_by_label("優先度").click()
    page.get_by_role("option", name="高", exact=True).click()
    expect(drawer.get_by_label("優先度")).to_contain_text("高")
    desc = drawer.get_by_label("描述")
    desc.fill("量測前先校正")
    desc.press("Control+Enter")
    expect(drawer.get_by_text("已儲存")).to_be_visible()
    if os.environ.get("SHOTS_DIR"):
        page.screenshot(path=f"{os.environ['SHOTS_DIR']}/t1-drawer.png")
    drawer.get_by_role("button", name="關閉任務詳情").click()
    expect(drawer).to_have_count(0)

    # 後端資料確認
    tasks = fetch_tasks(page, P)
    b = next(t for t in tasks if t["title"] == f"{P} 乙")
    assert b["dueDate"] == "2026-12-31"
    assert b["estimateHours"] == 2.5
    assert b["priority"] == "high"
    assert b["description"] == "量測前先校正"
    assert b["assigneeId"] is not None
    assert any(t["title"] == f"{P} 甲改" for t in tasks)

    # ── Drawer 刪除任務（需確認） ──
    row_a2.hover()
    row_a2.get_by_role("button", name="開啟").click()
    drawer_a = page.get_by_role("dialog", name=f"{P} 甲改")
    drawer_a.get_by_role("button", name="更多動作").click()
    page.get_by_role("menuitem", name="刪除任務").click()
    page.get_by_role("alertdialog").get_by_role("button", name="刪除", exact=True).click()
    expect(drawer_a).to_have_count(0)
    expect(row_a2).to_have_count(0)
    expect(rows).to_have_count(1)
    # 等 SSE 的刪除事件套用完（抽屜離場中不可重抓已刪除任務的子資源而得到 404）
    page.wait_for_timeout(500)

    # 登入前的 /api/auth/me 探測回 401 屬預期
    assert [e for e in errors if not re.search(r"status of 401", e)] == []


def test_list_no_horizontal_scroll(page: Page):
    """List 1280 / 1024 / 768 寬度不產生頁面水平捲軸"""
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    shots = os.environ.get("SHOTS_DIR")
    for width in [1280, 1024, 768]:
        page.set_viewport_size({"width": width, "height": 800})
        page.goto("/tasks/list")
        expect(page.get_by_role("grid", name="任務清單")).to_be_visible()
        overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        assert overflow <= 0, f"{width}px"
        if shots:
            page.screenshot(path=f"{shots}/t1-list-{width}.png")
