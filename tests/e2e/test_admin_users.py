"""admin-users.spec.ts 的 Python 版：T7 成員管理（權限、搜尋、新增、停用、啟用、重設密碼、編輯、解鎖、最後 root 保護）。"""

from __future__ import annotations

import re
import time

import pytest
from playwright.sync_api import Browser, Page, Playwright, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# T7 成員管理：權限、列出 / 搜尋、新增（臨時密碼 → 強制改密碼）、停用使 session 失效、啟用、
# 重設密碼、編輯、解除登入鎖定、最後一位 root 保護。只操作本 spec 自建的帳號，不影響其他 spec。
# （原檔 serial：pytest 同檔內本來就照順序跑）


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


stamp = _base36(int(time.time() * 1000))
USERNAME = f"e2e-{stamp}"
NAME = f"E2E 新成員 {stamp}"
RENAMED = f"E2E 改名 {stamp}"


def row(page: Page, username: str):
    return page.locator(f'tbody tr[data-username="{username}"]')


def open_menu(page: Page, name: str):
    page.get_by_role("button", name=f"{name} 的操作").click()
    return page.get_by_role("menu", name=f"{name} 的操作")


def test_member_has_no_access(page: Page):
    """一般成員：側邊導覽無入口、頁面顯示沒有權限、API 回 403"""
    login_via_ui(page, E2E_USERS["member"])
    expect(page.get_by_role("navigation", name="主要導覽").get_by_text("成員管理")).to_have_count(0)
    page.goto("/admin/users")
    expect(page.get_by_text("沒有權限")).to_be_visible()
    expect(page.get_by_text("此頁面僅限管理者以上使用")).to_be_visible()
    assert page.request.get("/api/admin/users").status == 403
    page.get_by_role("button", name="回到總覽").click()
    expect(page).to_have_url(re.compile(r"/$"))


def test_admin_full_member_lifecycle(page: Page, browser: Browser, playwright: Playwright, base_url: str):
    """管理員：新增 → 首次登入改密碼 → 停用即登出 → 啟用 → 重設密碼 → 編輯 → 解鎖 → 最後管理員保護"""
    request = playwright.request.new_context(base_url=base_url)
    try:
        errors = collect_errors(page)
        login_via_ui(page, E2E_USERS["admin"], "/admin/users")

        # 列表：自己那列有「你」，每列都有更新時間
        me = row(page, E2E_USERS["admin"]["username"])
        expect(me).to_be_visible()
        expect(me.get_by_text("你", exact=True)).to_be_visible()
        expect(me.locator("td").nth(1)).to_have_text("超級管理員")
        row_count = page.locator("tbody tr").count()
        expect(page.locator("tbody tr td.adm-col-updated time")).to_have_count(row_count)

        # 搜尋（/ 聚焦）與無結果 → 清除篩選
        page.locator("body").click()
        page.keyboard.press("/")
        search = page.get_by_role("searchbox", name="搜尋姓名或帳號")
        expect(search).to_be_focused()
        search.fill("zzz-no-such-user")
        expect(page).to_have_url(re.compile(r"q=zzz-no-such-user"))
        expect(page.get_by_text("沒有符合條件的成員")).to_be_visible()
        page.get_by_role("button", name="清除篩選").click()
        expect(me).to_be_visible()
        expect(page).not_to_have_url(re.compile(r"q="))

        # 新增成員：Enter 送出 → 結果面板顯示一次臨時密碼；Esc 不關閉
        page.get_by_role("button", name="新增成員").click()
        create = page.get_by_role("dialog", name="新增成員")
        expect(create.get_by_label("帳號")).to_be_focused()
        create.get_by_label("帳號").fill("x")
        create.get_by_label("顯示名稱").fill(NAME)
        create.get_by_label("顯示名稱").press("Enter")
        expect(create.get_by_text("帳號須為 3–32 個英文字母")).to_be_visible()
        create.get_by_label("帳號").fill(E2E_USERS["member"]["username"])
        create.get_by_role("button", name="建立").click()
        expect(create.get_by_text("此帳號已被使用")).to_be_visible()
        create.get_by_label("帳號").fill(USERNAME)
        create.get_by_label("顯示名稱").press("Enter")

        created = page.get_by_role("dialog", name=f"已建立成員「{NAME}」")
        expect(created).to_be_visible()
        expect(created.get_by_role("button", name="複製")).to_be_focused()
        temp_password = (created.get_by_label("臨時密碼").text_content() or "").strip()
        assert re.match(r"^\S{4}-\S{4}-\S{4}$", temp_password)
        page.keyboard.press("Escape")
        expect(created).to_be_visible()
        created.get_by_role("button", name="完成").click()
        expect(created).to_be_hidden()
        assert temp_password not in page.url

        new_row = row(page, USERNAME)
        expect(new_row.get_by_text("待改密碼")).to_be_visible()
        expect(new_row.get_by_text("啟用", exact=True)).to_be_visible()

        # 新成員以臨時密碼登入 → 強制改密碼
        ctx = browser.new_context(base_url=base_url)
        other = ctx.new_page()
        other.goto("/login")
        other.get_by_label("帳號").fill(USERNAME)
        other.get_by_label("密碼", exact=True).fill(temp_password)
        other.get_by_role("button", name="登入").click()
        expect(other.get_by_text("請先設定新密碼")).to_be_visible()
        new_password = f"e2e-new-pass-{stamp}"
        other.get_by_label("目前密碼", exact=True).fill(temp_password)
        other.get_by_label("新密碼", exact=True).fill(new_password)
        other.get_by_label("確認新密碼", exact=True).fill(new_password)
        other.get_by_role("button", name="更新密碼").click()
        expect(other.get_by_role("navigation", name="主要導覽")).to_be_visible()

        # 停用 → 該成員的 session 立即失效
        page.reload()
        expect(new_row.get_by_text("待改密碼")).to_have_count(0)
        open_menu(page, NAME).get_by_role("menuitem", name="停用").click()
        disable = page.get_by_role("alertdialog", name=f"停用「{NAME}」？")
        expect(disable.get_by_text("目前的登入狀態會立即失效")).to_be_visible()
        disable.get_by_role("button", name="停用").click()
        expect(page.get_by_role("status").filter(has_text=f"已停用「{NAME}」")).to_be_visible()
        expect(new_row.get_by_text("已停用")).to_be_visible()
        assert other.request.get("/api/auth/me").status == 401
        other.reload()
        expect(other).to_have_url(re.compile(r"/login"))
        ctx.close()

        # 狀態篩選：已停用
        page.get_by_role("button", name="狀態篩選").click()
        page.get_by_role("option", name="已停用").click()
        expect(page).to_have_url(re.compile(r"state=disabled"))
        expect(new_row).to_be_visible()
        expect(me).to_have_count(0)
        page.get_by_role("button", name="狀態篩選").click()
        page.get_by_role("option", name="全部").click()

        # 啟用（立即執行）
        open_menu(page, NAME).get_by_role("menuitem", name="啟用").click()
        expect(page.get_by_role("status").filter(has_text=f"已啟用「{NAME}」")).to_be_visible()
        expect(new_row.get_by_text("啟用", exact=True)).to_be_visible()

        # 重設密碼：確認 → 結果面板（複製 → 已複製）
        open_menu(page, NAME).get_by_role("menuitem", name="重設密碼").click()
        confirm_reset = page.get_by_role("dialog", name=f"重設「{NAME}」的密碼？")
        confirm_reset.get_by_role("button", name="重設密碼").click()
        reset_done = page.get_by_role("dialog", name=f"已重設「{NAME}」的密碼")
        expect(reset_done.get_by_text("該成員下次登入時須設定新密碼。")).to_be_visible()
        reset_password = (reset_done.get_by_label("臨時密碼").text_content() or "").strip()
        assert reset_password != temp_password
        reset_done.get_by_role("button", name="複製").click()
        expect(reset_done.get_by_role("button", name="已複製")).to_be_visible()
        reset_done.get_by_role("button", name="關閉").click()
        expect(reset_done).to_be_hidden()
        expect(new_row.get_by_text("待改密碼")).to_be_visible()

        # 編輯顯示名稱與角色
        open_menu(page, NAME).get_by_role("menuitem", name="編輯").click()
        edit = page.get_by_role("dialog", name="編輯成員")
        save = edit.get_by_role("button", name="儲存")
        expect(save).to_be_disabled()
        edit.get_by_label("顯示名稱").fill(RENAMED)
        edit.get_by_label("顯示名稱").press("Enter")
        expect(page.get_by_role("status").filter(has_text=f"已更新「{RENAMED}」")).to_be_visible()
        expect(new_row.get_by_text(RENAMED)).to_be_visible()

        # 連續登入失敗 → 已鎖定 → 解除鎖定
        for _ in range(5):
            res = request.post("/api/auth/login", data={"username": USERNAME, "password": "wrong-password"})
            assert res.status == 401
        page.reload()
        expect(new_row.get_by_text("已鎖定")).to_be_visible()
        open_menu(page, RENAMED).get_by_role("menuitem", name="解除鎖定").click()
        expect(page.get_by_role("status").filter(has_text=f"已解除「{RENAMED}」的登入鎖定")).to_be_visible()
        expect(new_row.get_by_text("已鎖定")).to_have_count(0)
        relogin = request.post("/api/auth/login", data={"username": USERNAME, "password": reset_password})
        assert relogin.status == 200

        # 最後一位 root：停用選項停用並說明原因；編輯時「成員」「管理者」選項停用
        menu = open_menu(page, E2E_USERS["admin"]["display_name"])
        expect(menu.get_by_role("menuitem", name="停用")).to_have_attribute("aria-disabled", "true")
        expect(menu.get_by_text("至少需保留一位超級管理員")).to_be_visible()
        menu.get_by_role("menuitem", name="編輯").click()
        edit_me = page.get_by_role("dialog", name="編輯成員")
        expect(edit_me.get_by_text("至少需保留一位超級管理員")).to_be_visible()
        edit_me.get_by_role("button", name="角色").click()
        expect(page.get_by_role("option", name="成員", exact=True)).to_have_attribute("aria-disabled", "true")
        expect(page.get_by_role("option", name="管理者", exact=True)).to_have_attribute("aria-disabled", "true")
        page.keyboard.press("Escape")
        edit_me.get_by_role("button", name="取消").click()
        # 後端同樣拒絕
        me_id = page.request.get("/api/auth/me").json()["user"]["id"]
        denied = page.request.patch(f"/api/admin/users/{me_id}", data={"isActive": False})
        assert denied.status == 409

        assert [e for e in errors if not re.search(r"401|409|Failed to load resource", e)] == []
    finally:
        request.dispose()
