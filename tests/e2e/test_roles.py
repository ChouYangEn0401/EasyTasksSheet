"""roles.spec.ts 的 Python 版：三層角色（user／manager／root）看得到與做得到的事。"""

from __future__ import annotations

import re

import pytest
from playwright.sync_api import Page, expect

from .helpers import E2E_USERS, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 三層角色（docs/permissions.md）：user 看不到管理入口；manager 可管理成員與資料但不能設 root、
# 看不到完整備份與取代全部；root 皆可。只讀取畫面與 API，不改動任何共用帳號的角色。


def nav(page: Page):
    return page.get_by_role("navigation", name="主要導覽")


def open_create_role_options(page: Page):
    page.get_by_role("button", name="新增成員").click()
    dialog = page.get_by_role("dialog", name="新增成員")
    dialog.get_by_role("button", name="角色").click()
    return dialog


def test_user_cannot_see_admin_pages(page: Page):
    """user：看不到成員管理與資料管理"""
    login_via_ui(page, E2E_USERS["member"])
    expect(nav(page).get_by_role("link", name="總覽")).to_be_visible()
    expect(nav(page).get_by_role("link", name="成員管理")).to_have_count(0)
    expect(nav(page).get_by_role("link", name="資料管理")).to_have_count(0)
    me = page.request.get("/api/auth/me").json()
    assert me["user"]["role"] == "user"
    assert "members.manage" not in me["capabilities"]


def test_manager_limits(page: Page):
    """manager：可進成員管理但不能設 root、不能動 root 帳號；資料管理無完整備份與取代"""
    login_via_ui(page, E2E_USERS["manager"])
    nav(page).get_by_role("link", name="成員管理").click()
    expect(page).to_have_url(re.compile(r"/admin/users"))

    # root 帳號：看得到，但操作停用並說明
    admin = E2E_USERS["admin"]
    root_row = page.locator(f'tbody tr[data-username="{admin["username"]}"]')
    expect(root_row.locator("td").nth(1)).to_have_text("超級管理員")
    page.get_by_role("button", name=f"{admin['display_name']} 的操作").click()
    menu = page.get_by_role("menu", name=f"{admin['display_name']} 的操作")
    expect(menu.get_by_role("menuitem", name="編輯")).to_have_attribute("aria-disabled", "true")
    expect(menu.get_by_text("只有超級管理員可以管理此帳號")).to_be_visible()
    page.keyboard.press("Escape")

    # 新增成員：角色三層，超級管理員不可選
    dialog = open_create_role_options(page)
    expect(page.get_by_role("option", name="超級管理員")).to_have_attribute("aria-disabled", "true")
    expect(page.get_by_role("option", name="管理者", exact=True)).not_to_have_attribute("aria-disabled", "true")
    page.keyboard.press("Escape")
    expect(dialog.get_by_text("只有超級管理員可以指派超級管理員")).to_be_visible()
    dialog.get_by_role("button", name="取消").click()

    # 後端同樣拒絕：設 root、操作 root 帳號
    users = page.request.get("/api/admin/users").json()

    def uid(name: str) -> int:
        return next(u for u in users if u["username"] == name)["id"]

    to_root = page.request.patch(f"/api/admin/users/{uid(E2E_USERS['member']['username'])}", data={"role": "root"})
    assert to_root.status == 403
    touch_root = page.request.post(f"/api/admin/users/{uid(admin['username'])}/unlock")
    assert touch_root.status == 403

    # 資料管理：JSON 匯出與匯入可用；完整備份與取代全部不顯示、API 403
    nav(page).get_by_role("link", name="資料管理").click()
    expect(page.get_by_role("button", name="下載 JSON 匯出檔")).to_be_visible()
    expect(page.get_by_role("heading", name="匯入")).to_be_visible()
    expect(page.get_by_role("button", name="下載完整備份")).to_have_count(0)
    expect(page.get_by_role("heading", name="取代全部資料")).to_have_count(0)
    assert page.request.get("/api/admin/data/backup").status == 403


def test_root_has_everything(page: Page):
    """root：成員管理可選超級管理員；資料管理有完整備份與取代全部"""
    login_via_ui(page, E2E_USERS["admin"], "/admin/users")
    open_create_role_options(page)
    expect(page.get_by_role("option", name="超級管理員")).not_to_have_attribute("aria-disabled", "true")
    page.keyboard.press("Escape")
    page.get_by_role("dialog", name="新增成員").get_by_role("button", name="取消").click()

    nav(page).get_by_role("link", name="資料管理").click()
    expect(page.get_by_role("button", name="下載 JSON 匯出檔")).to_be_visible()
    expect(page.get_by_role("button", name="下載完整備份")).to_be_visible()
    expect(page.get_by_role("heading", name="取代全部資料")).to_be_visible()
