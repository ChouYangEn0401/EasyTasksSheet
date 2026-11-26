"""全站搜尋 Ctrl+K（docs/design/ui-refresh-2026-11-26.md §7；需求 U3、M1）。

Ctrl+K 開浮層 → 打字出現任務 → Enter 開任務抽屜；Esc 關閉、焦點回到原處；
在輸入框裡按 Ctrl+K 也要能開；空輸入顯示「最近開啟」與「快速前往」；專案／成員／頁面可直接前往。
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 設定 SEARCH_SHOTS=<資料夾> 時輸出浮層截圖（人工檢查用）
SHOTS = os.environ.get("SEARCH_SHOTS")
P = f"搜尋E2E{int(time.time()) % 100000}"


def shot(page: Page, name: str) -> None:
    if not SHOTS:
        return
    Path(SHOTS).mkdir(parents=True, exist_ok=True)
    page.wait_for_timeout(250)
    page.screenshot(path=str(Path(SHOTS) / f"{name}.png"))


def palette(page: Page):
    return page.locator("dialog.cmdk")


def search_input(page: Page):
    return palette(page).get_by_role("combobox", name="全站搜尋")


def create_task(page: Page, data: dict) -> dict:
    res = page.request.post("/api/tasks", data=data)
    assert res.ok, res.text()
    return res.json()


def test_ctrl_k_type_enter_opens_task_and_remembers_recent(page: Page, base_url: str):
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["admin"], "/")
    target = create_task(page, {"title": f"{P} 撰寫週報"})
    create_task(page, {"title": f"{P} 週報模版整理"})

    expect(palette(page)).to_be_hidden()
    page.keyboard.press("Control+k")
    expect(palette(page)).to_be_visible()
    expect(search_input(page)).to_be_focused()
    # 空輸入：快速前往
    expect(palette(page).get_by_text("快速前往")).to_be_visible()
    shot(page, "cmdk-empty")

    search_input(page).fill(f"{P} 撰寫")
    option = palette(page).get_by_role("option", name=re.compile(f"{P} 撰寫週報"))
    expect(option).to_be_visible()
    expect(option).to_have_attribute("aria-selected", "true")
    # 高亮用 <mark>
    expect(option.locator("mark").first).to_have_text(f"{P} 撰寫")
    # combobox 指著選中的那一筆
    active = search_input(page).get_attribute("aria-activedescendant")
    assert active and active == option.get_attribute("id")

    page.keyboard.press("Enter")
    expect(palette(page)).to_be_hidden()
    expect(page).to_have_url(re.compile(rf"[?&]task={target['id']}(&|$)"))
    expect(page.locator(".task-drawer")).to_be_visible()

    # 再開一次：空輸入列出「最近開啟」，剛剛那筆在最前面
    page.keyboard.press("Control+k")
    expect(palette(page)).to_be_visible()
    recent = palette(page).get_by_role("group", name="最近開啟")
    expect(recent.get_by_role("option").first).to_contain_text(f"{P} 撰寫週報")
    page.keyboard.press("Escape")
    expect(palette(page)).to_be_hidden()
    # Esc 只關浮層，任務抽屜還在
    expect(page.locator(".task-drawer")).to_be_visible()
    assert [e for e in errors if "favicon" not in e and "status of 401" not in e] == []


def test_escape_restores_focus_and_ctrl_k_works_inside_inputs(page: Page, base_url: str):
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    box = page.get_by_role("textbox", name="搜尋任務")
    box.click()
    expect(box).to_be_focused()
    # 在輸入框裡按 Ctrl+K 也要開
    page.keyboard.press("Control+k")
    expect(palette(page)).to_be_visible()
    expect(search_input(page)).to_be_focused()
    page.keyboard.press("Escape")
    expect(palette(page)).to_be_hidden()
    expect(box).to_be_focused()

    # 頂欄按鈕：點了開，Esc 後焦點回到按鈕
    btn = page.get_by_role("button", name="全站搜尋")
    btn.click()
    expect(palette(page)).to_be_visible()
    page.keyboard.press("Escape")
    expect(palette(page)).to_be_hidden()
    expect(btn).to_be_focused()

    # 既有的「/」照舊聚焦篩選列
    page.locator("body").click(position={"x": 5, "y": 300})
    page.keyboard.press("/")
    expect(box).to_be_focused()


def test_member_page_and_id_results_navigate(page: Page, base_url: str):
    login_via_ui(page, E2E_USERS["admin"], "/")
    task = create_task(page, {"title": f"{P} 用編號找"})
    member_id = next(u["id"] for u in page.request.get("/api/users").json() if u["username"] == "member")

    # 成員 → 清單頁篩他負責的任務
    page.keyboard.press("Control+k")
    search_input(page).fill("一般成員")
    member = palette(page).get_by_role("group", name="成員").get_by_role("option", name=re.compile("一般成員"))
    expect(member).to_be_visible()
    shot(page, "cmdk-results")
    member.click()
    expect(palette(page)).to_be_hidden()
    expect(page).to_have_url(re.compile(rf"/tasks/list\?assignee={member_id}$"))

    # 頁面：打「看板」→ 鍵盤選到就開
    page.keyboard.press("Control+k")
    search_input(page).fill("看板")
    pages = palette(page).get_by_role("group", name="頁面")
    expect(pages.get_by_role("option", name=re.compile("看板"))).to_be_visible()
    for _ in range(20):
        if pages.get_by_role("option", name=re.compile("看板")).get_attribute("aria-selected") == "true":
            break
        page.keyboard.press("ArrowDown")
    page.keyboard.press("Enter")
    expect(page).to_have_url(re.compile(r"/tasks/kanban"))

    # #編號直接命中任務
    page.keyboard.press("Control+k")
    search_input(page).fill(f"#{task['id']}")
    hit = palette(page).get_by_role("option", name=re.compile(f"{P} 用編號找"))
    expect(hit).to_be_visible()
    expect(hit).to_have_attribute("aria-selected", "true")
    page.keyboard.press("Escape")


def test_ctrl_k_does_not_open_over_other_dialogs(page: Page, base_url: str):
    """別的對話框開著時不搶（既有規則：對話框開啟時快捷鍵不觸發）"""
    login_via_ui(page, E2E_USERS["admin"], "/")
    page.get_by_role("button", name=re.compile("使用者選單")).click()
    page.get_by_role("menuitem", name="變更密碼").click()
    expect(page.locator("dialog.ui-dialog[open]")).to_be_visible()
    page.keyboard.press("Control+k")
    page.wait_for_timeout(200)
    expect(palette(page)).to_be_hidden()
    page.keyboard.press("Escape")
