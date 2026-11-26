"""perm-config.spec.ts 的 Python 版：權限設定（docs/design/permissions-config.md）——root 調整成員權限、在線成員即時更新。"""

from __future__ import annotations

import os
import re

import pytest
from playwright.sync_api import Browser, Page, expect

from .helpers import E2E_USERS, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 權限設定（docs/design/permissions-config.md）：root 調整成員權限 → 在線成員不需重新整理即更新（SSE）。
# 結束時一律還原為預設，避免影響其他 spec。


def nav(page: Page):
    return page.get_by_role("navigation", name="主要導覽")


def new_logged_in(browser: Browser, base_url: str, user: dict, next_path: str = "/"):
    context = browser.new_context(base_url=base_url)
    page = context.new_page()
    login_via_ui(page, user, next_path)
    return context, page


def reset_defaults(page: Page) -> None:
    res = page.request.post("/api/admin/permissions/reset", data={})
    assert res.status == 200


def test_root_adjusts_member_permissions_live(browser: Browser, base_url: str):
    """root 調整成員權限，在線成員即時看到 / 失去入口；受保護項目不可勾"""
    root_ctx, root_page = new_logged_in(browser, base_url, E2E_USERS["admin"])
    member_ctx, member_page = new_logged_in(browser, base_url, E2E_USERS["member"])
    try:
        reset_defaults(root_page)
        page = root_page
        nav(page).get_by_role("link", name="權限設定").click()
        expect(page).to_have_url(re.compile(r"/admin/permissions"))
        expect(page.get_by_text("權限設定即時生效；超級管理員永遠擁有全部權限。")).to_be_visible()

        # 超級管理員欄固定勾選且停用；受保護項目鎖定
        expect(page.get_by_label("超級管理員：管理狀態（固定擁有）")).to_be_checked()
        expect(page.get_by_label("超級管理員：管理狀態（固定擁有）")).to_be_disabled()
        for label in ["成員：完整備份下載", "管理者：權限設定", "管理者：指派超級管理員"]:
            expect(page.get_by_label(label)).to_be_disabled()
            expect(page.get_by_label(label)).not_to_be_checked()
        expect(page.locator('tr[data-capability="data.backup_db"] .prm-lock')).to_be_visible()

        # 成員原本看不到資料管理
        expect(nav(member_page).get_by_role("link", name="總覽")).to_be_visible()
        expect(nav(member_page).get_by_role("link", name="資料管理")).to_have_count(0)

        # 授予成員「管理狀態」與「JSON 匯出」
        page.get_by_label("成員：管理狀態").check()
        page.get_by_label("成員：JSON 匯出").check()
        bar = page.get_by_role("region", name="未儲存的權限變更")
        expect(bar).to_contain_text("2 項未儲存變更")
        expect(bar).to_contain_text("成員：＋管理狀態、＋JSON 匯出")
        shots = os.environ.get("SHOTS_DIR")
        if shots:
            intro = page.get_by_text("權限設定即時生效；超級管理員永遠擁有全部權限。")
            for width in [1280, 768]:
                page.set_viewport_size({"width": width, "height": 900})
                page.mouse.move(0, 0)
                intro.scroll_into_view_if_needed()
                page.screenshot(path=f"{shots}/perm-top-{width}.png")
                page.get_by_label("成員：JSON 匯出").scroll_into_view_if_needed()
                page.screenshot(path=f"{shots}/perm-{width}.png")
            page.set_viewport_size({"width": 1280, "height": 720})
        # 還原未儲存 → 列消失；再勾一次後儲存
        bar.get_by_role("button", name="還原未儲存").click()
        expect(bar).to_have_count(0)
        expect(page.get_by_label("成員：管理狀態")).not_to_be_checked()
        page.get_by_label("成員：管理狀態").check()
        page.get_by_label("成員：JSON 匯出").check()
        bar.get_by_role("button", name="儲存", exact=True).click()
        expect(page.get_by_text("已儲存權限設定")).to_be_visible()
        expect(bar).to_have_count(0)
        expect(page.locator('tr[data-capability="statuses.manage"]')).to_contain_text("已自訂")

        # 成員：不需重新整理即出現入口，capabilities 含 statuses.manage
        expect(nav(member_page).get_by_role("link", name="資料管理")).to_be_visible(timeout=10_000)
        me = member_page.request.get("/api/auth/me").json()
        assert "statuses.manage" in me["capabilities"]
        assert member_page.request.post("/api/statuses", data={"name": "E2E 權限狀態"}).status == 201

        # 撤回 → 入口消失
        page.get_by_label("成員：管理狀態").uncheck()
        page.get_by_label("成員：JSON 匯出").uncheck()
        page.get_by_role("region", name="未儲存的權限變更").get_by_role("button", name="儲存", exact=True).click()
        expect(nav(member_page).get_by_role("link", name="資料管理")).to_have_count(0, timeout=10_000)

        # 還原為預設（需確認）
        page.get_by_label("成員：JSON 匯出").check()
        page.get_by_role("region", name="未儲存的權限變更").get_by_role("button", name="儲存", exact=True).click()
        expect(nav(member_page).get_by_role("link", name="資料管理")).to_be_visible(timeout=10_000)
        page.get_by_role("button", name="還原為預設").click()
        dialog = page.get_by_role("alertdialog", name="還原為預設權限？")
        dialog.get_by_role("button", name="還原").click()
        expect(page.get_by_text("已還原為預設權限")).to_be_visible()
        expect(page.get_by_role("button", name="還原為預設")).to_be_disabled()
        expect(nav(member_page).get_by_role("link", name="資料管理")).to_have_count(0, timeout=10_000)

        # 後端同樣拒絕授予受保護權限
        res = page.request.put(
            "/api/admin/permissions",
            data={"changes": [{"role": "manager", "capability": "data.backup_db", "allowed": True}]},
        )
        assert res.status == 400

        # 成員看不到權限設定入口、API 403
        expect(nav(member_page).get_by_role("link", name="權限設定")).to_have_count(0)
        assert member_page.request.get("/api/admin/permissions").status == 403
    finally:
        reset_defaults(root_page)
        # 刪除測試建立的狀態（若有）
        statuses = root_page.request.get("/api/statuses").json()
        for s in [x for x in statuses if x["name"] == "E2E 權限狀態"]:
            root_page.request.delete(f"/api/statuses/{s['id']}")
        root_ctx.close()
        member_ctx.close()


def test_manager_cannot_see_permissions(page: Page):
    """manager 看不到權限設定"""
    login_via_ui(page, E2E_USERS["manager"])
    expect(nav(page).get_by_role("link", name="成員管理")).to_be_visible()
    expect(nav(page).get_by_role("link", name="權限設定")).to_have_count(0)
    page.goto("/admin/permissions")
    expect(page.get_by_text("沒有權限")).to_be_visible()
