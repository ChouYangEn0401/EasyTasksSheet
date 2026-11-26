"""audit-log.spec.ts 的 Python 版：稽核紀錄與還原（docs/design/audit-log.md）。"""

from __future__ import annotations

import os
import re
import time

import pytest
from playwright.sync_api import Browser, Page, expect

from .helpers import E2E_USERS, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 稽核紀錄與還原（docs/design/audit-log.md）：成員修改描述 → 管理者在稽核頁看到前後差異並還原；
# 衝突時可「仍要還原（覆蓋）」；成員可在任務詳情看到活動歷史但沒有還原鈕。
# SHOTS_DIR 有設定時另存截圖（1280 / 768）。


def nav(page: Page):
    return page.get_by_role("navigation", name="主要導覽")


shots = os.environ.get("SHOTS_DIR")


def new_logged_in(browser: Browser, base_url: str, user: dict, next_path: str = "/"):
    context = browser.new_context(base_url=base_url)
    page = context.new_page()
    login_via_ui(page, user, next_path)
    return context, page


# 本 spec 建立的任務：結束時刪除（core-shell spec 假設任務清單一開始是空的）
created: list[tuple[Page, int]] = []


def create_task(page: Page, title: str, description: str) -> dict:
    res = page.request.post("/api/tasks", data={"title": title, "description": description})
    assert res.status == 201
    task = res.json()
    created.append((page, task["id"]))
    return task


def cleanup() -> None:
    items = created[:]
    created.clear()
    for page, tid in items:
        try:
            page.request.delete(f"/api/tasks/{tid}")
        except Exception:
            pass


def audit_of(page: Page, task_id: int) -> list[dict]:
    res = page.request.get(f"/api/admin/audit?taskId={task_id}")
    assert res.status == 200
    return res.json()["items"]


def shoot(page: Page, name: str, widths=(1280, 768)) -> None:
    if not shots:
        return
    for width in widths:
        page.set_viewport_size({"width": width, "height": 900})
        page.mouse.move(0, 0)
        # 等對話框 / 展開動畫結束
        page.wait_for_timeout(400)
        page.screenshot(path=f"{shots}/{name}-{width}.png")
    page.set_viewport_size({"width": 1280, "height": 720})


def test_member_breaks_description_manager_reverts(browser: Browser, base_url: str):
    """成員改壞描述 → 管理者在稽核頁看到差異並還原；成員的活動歷史沒有還原鈕"""
    member_ctx, member_page = new_logged_in(browser, base_url, E2E_USERS["member"])
    manager_ctx, manager_page = new_logged_in(browser, base_url, E2E_USERS["manager"])
    try:
        title = f"E2E 稽核 {int(time.time() * 1000)}"
        task = create_task(member_page, title, "請在週五前完成首頁設計稿")

        # 成員在任務詳情修改描述
        member_page.goto(f"/tasks/list?task={task['id']}")
        desc = member_page.get_by_role("textbox", name="描述")
        expect(desc).to_have_value("請在週五前完成首頁設計稿")
        desc.fill("改成下週再說")
        desc.blur()
        expect(member_page.get_by_text("已儲存")).to_be_visible()

        # 管理者：導覽有「稽核紀錄」，頁首說明語氣中性
        page = manager_page
        nav(page).get_by_role("link", name="稽核紀錄").click()
        expect(page).to_have_url(re.compile(r"/admin/audit"))
        expect(page.get_by_text("用來回溯與還原，而非評比")).to_be_visible()
        page.get_by_role("textbox", name="搜尋摘要或名稱").fill(title)
        updated = next(e for e in audit_of(page, task["id"]) if "描述" in e["summary"])
        row = page.locator(f'li[data-entry-id="{updated["id"]}"]')
        expect(row).to_contain_text(f"修改了『{title[:39]}")
        expect(row).to_contain_text("一般成員")
        expect(row).to_contain_text("可還原")
        shoot(page, "audit-list")

        # 展開：修改前 / 修改後（行內差異）
        row.get_by_role("button", name=re.compile(r"修改了")).click()
        diff = row.locator(".aud-diff")
        expect(diff.locator('td[data-side="before"]')).to_contain_text("請在週五前完成首頁設計稿")
        expect(diff.locator('td[data-side="after"]')).to_contain_text("改成下週再說")
        expect(diff.locator("del.aud-del").first).to_be_visible()
        expect(diff.locator("ins.aud-ins").first).to_be_visible()
        shoot(page, "audit-diff")

        # 還原
        row.get_by_role("button", name="還原", exact=True).click()
        dialog = page.get_by_role("dialog", name="還原這次改動？")
        expect(dialog).to_contain_text("以下欄位會改回這次修改之前的內容")
        expect(dialog.get_by_role("button", name="還原", exact=True)).to_be_visible()
        dialog.get_by_role("button", name="還原", exact=True).click()
        expect(page.get_by_text(re.compile(r"^已還原："))).to_be_visible()
        expect(row).to_contain_text("已還原")
        expect(row).to_contain_text("由 管理者")
        after = member_page.request.get(f"/api/tasks/{task['id']}").json()
        assert after["description"] == "請在週五前完成首頁設計稿"

        # 成員：任務詳情的活動歷史可見（含還原紀錄），但沒有還原鈕；也看不到稽核頁入口
        member_page.goto(f"/tasks/list?task={task['id']}")
        expect(member_page.get_by_role("textbox", name="描述")).to_have_value("請在週五前完成首頁設計稿")
        member_page.get_by_role("button", name="活動歷史").click()
        history = member_page.get_by_role("list", name="活動歷史")
        expect(history).to_contain_text("還原：修改了")
        expect(history).to_contain_text(f"建立任務『{title[:39]}")
        expect(history.get_by_role("button", name="還原", exact=True)).to_have_count(0)
        history.get_by_role("button", name="查看差異").first.click()
        expect(history).to_contain_text("修改前")
        if shots:
            for width in [1280, 768]:
                member_page.set_viewport_size({"width": width, "height": 900})
                member_page.mouse.move(0, 0)
                history.scroll_into_view_if_needed()
                member_page.screenshot(path=f"{shots}/task-history-{width}.png")
        expect(nav(member_page).get_by_role("link", name="稽核紀錄")).to_have_count(0)
    finally:
        cleanup()
        member_ctx.close()
        manager_ctx.close()


def test_revert_first_of_two_edits_conflict(browser: Browser, base_url: str):
    """連續修改兩次後還原第一次：提示衝突並可仍要還原（覆蓋）"""
    manager_ctx, page = new_logged_in(browser, base_url, E2E_USERS["manager"])
    try:
        title = f"E2E 衝突 {int(time.time() * 1000)}"
        task = create_task(page, title, "第一版")
        for description in ["第二版", "第三版"]:
            res = page.request.patch(f"/api/tasks/{task['id']}", data={"description": description})
            assert res.status == 200
        updates = [e for e in audit_of(page, task["id"]) if "描述" in e["summary"]]
        first = updates[-1]  # 由新到舊，最後一筆是第一次修改

        page.goto(f"/admin/audit?taskId={task['id']}")
        row = page.locator(f'li[data-entry-id="{first["id"]}"]')
        row.get_by_role("button", name="還原", exact=True).click()
        dialog = page.get_by_role("dialog", name="還原這次改動？")
        expect(dialog).to_contain_text("在此之後又被修改過")
        expect(dialog).to_contain_text("現在是「第三版」")
        shoot(page, "audit-conflict")
        dialog.get_by_role("button", name="仍要還原（覆蓋）").click()
        expect(page.get_by_text(re.compile(r"^已還原："))).to_be_visible()
        after = page.request.get(f"/api/tasks/{task['id']}").json()
        assert after["description"] == "第一版"
        # 同一筆不可再還原
        assert page.request.post(f"/api/admin/audit/{first['id']}/revert", data={}).status == 409
    finally:
        cleanup()
        manager_ctx.close()


def test_member_has_no_audit_access(page: Page):
    """權限不足：成員看不到稽核紀錄入口，直接進入顯示沒有權限"""
    login_via_ui(page, E2E_USERS["member"])
    expect(nav(page).get_by_role("link", name="總覽")).to_be_visible()
    expect(nav(page).get_by_role("link", name="稽核紀錄")).to_have_count(0)
    page.goto("/admin/audit")
    expect(page.get_by_text("沒有權限")).to_be_visible()
    assert page.request.get("/api/admin/audit").status == 403
