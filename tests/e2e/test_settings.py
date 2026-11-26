"""settings.spec.ts 的 Python 版：個人設定（顯示名稱、密碼、帳號；768 寬與 role 不可經 API 改）。"""

from __future__ import annotations

import re
import time

import pytest
from playwright.sync_api import Browser, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 個人設定：自建專用成員（由 admin 建立 → 首次登入改密碼），不動 admin / member / newbie 的狀態；
# 測完以 admin 停用該測試帳號。
# （原檔 serial：pytest 同檔內本來就照順序跑）


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


stamp = _base36(int(time.time() * 1000))
USERNAME = f"set-{stamp}"
RENAMED = f"set2-{stamp}"
NAME = f"設定測試 {stamp}"
NEW_NAME = f"改名後 {stamp}"
PW1 = "settings-pass-1"
PW2 = "settings-pass-2"


def create_user(browser: Browser, base_url: str) -> str:
    ctx = browser.new_context(base_url=base_url)
    page = ctx.new_page()
    login_via_ui(page, E2E_USERS["admin"], "/admin/users")
    res = page.request.post("/api/admin/users", data={"username": USERNAME, "displayName": NAME})
    assert res.status == 201
    temp = res.json()["tempPassword"]
    ctx.close()
    return temp


def first_login(page: Page, temp: str) -> None:
    page.goto("/login")
    page.get_by_label("帳號").fill(USERNAME)
    page.get_by_label("密碼", exact=True).fill(temp)
    page.get_by_role("button", name="登入").click()
    page.get_by_label("目前密碼").fill(temp)
    page.get_by_label("新密碼", exact=True).fill(PW1)
    page.get_by_label("確認新密碼").fill(PW1)
    page.get_by_role("button", name="更新密碼").click()
    expect(page.get_by_role("navigation", name="主要導覽")).to_be_visible()


def test_settings_name_password_username(page: Page, browser: Browser, base_url: str):
    """個人設定：改顯示名稱、改密碼（其他裝置登出）、改帳號，最後停用測試帳號"""
    errors = collect_errors(page)
    temp = create_user(browser, base_url)
    first_login(page, temp)

    # 另一個裝置的 session，改密碼後應被登出
    other_ctx = browser.new_context(base_url=base_url)
    other = other_ctx.new_page()
    login_via_ui(other, {"username": USERNAME, "password": PW1})

    # 從使用者選單進入
    page.get_by_role("button", name=re.compile(r"使用者選單")).click()
    page.get_by_role("menuitem", name="個人設定").click()
    expect(page).to_have_url(re.compile(r"/settings$"))
    expect(page.get_by_role("heading", name="個人資料")).to_be_visible()
    expect(page.get_by_role("heading", name="帳號資訊")).to_be_visible()

    # 顯示名稱：未變更不可儲存、空白報錯、儲存成功後頂欄更新
    profile_form = page.get_by_role("form", name="個人資料")
    save = profile_form.get_by_role("button", name="儲存變更")
    expect(save).to_be_disabled()
    profile_form.get_by_label("顯示名稱").fill("")
    expect(profile_form.get_by_text("請輸入顯示名稱")).to_be_visible()
    profile_form.get_by_label("顯示名稱").fill(NEW_NAME)
    save.click()
    expect(page.get_by_role("button", name=f"使用者選單：{NEW_NAME}")).to_be_visible()
    expect(page.get_by_text("個人資料已更新")).to_be_visible()

    # 密碼：規則提示、不一致報錯、目前密碼錯誤、成功
    pw_form = page.get_by_role("form", name="變更密碼")
    update = pw_form.get_by_role("button", name="更新密碼")
    pw_form.get_by_label("目前密碼").fill(PW1)
    pw_form.get_by_label("新密碼", exact=True).fill("short")
    expect(pw_form.get_by_text("至少需要 8 個字元")).to_be_visible()
    pw_form.get_by_label("新密碼", exact=True).fill(PW2)
    pw_form.get_by_label("確認新密碼").fill("different-pass")
    expect(pw_form.get_by_text("兩次輸入的新密碼不一致")).to_be_visible()
    expect(update).to_be_disabled()
    pw_form.get_by_label("確認新密碼").fill(PW2)
    pw_form.get_by_label("目前密碼").fill("wrong-current-pass")
    update.click()
    expect(pw_form.get_by_text("目前密碼不正確")).to_be_visible()
    pw_form.get_by_label("目前密碼").fill(PW1)
    update.click()
    expect(pw_form.get_by_text("密碼已更新，其他裝置已登出。")).to_be_visible()

    # 其他裝置已登出；新密碼可登入
    assert other.request.get("/api/auth/me").status == 401
    other_ctx.close()
    fresh = browser.new_context(base_url=base_url)
    login_via_ui(fresh.new_page(), {"username": USERNAME, "password": PW2})
    fresh.close()

    # 改帳號：需目前密碼；密碼錯、重複、格式錯誤標在欄位
    page.reload()
    form = page.get_by_role("form", name="個人資料")
    username = form.get_by_label("帳號", exact=True)
    username.fill(RENAMED)
    expect(form.get_by_label("目前密碼")).to_be_visible()
    expect(form.get_by_role("button", name="儲存變更")).to_be_disabled()
    form.get_by_label("目前密碼").fill("wrong-current-pass")
    form.get_by_role("button", name="儲存變更").click()
    expect(form.get_by_text("目前密碼不正確")).to_be_visible()
    username.fill(E2E_USERS["member"]["username"])
    form.get_by_label("目前密碼").fill(PW2)
    form.get_by_role("button", name="儲存變更").click()
    expect(form.get_by_text("此帳號已被使用")).to_be_visible()
    username.fill("Bad Name!")
    expect(form.get_by_text(re.compile(r"3–32")).last).to_be_visible()
    username.fill(RENAMED.upper())
    form.get_by_label("目前密碼").fill(PW2)
    form.get_by_role("button", name="儲存變更").click()
    expect(username).to_have_value(RENAMED)
    expect(form.get_by_label("目前密碼")).to_have_count(0)

    # 目前 session 仍有效；新帳號可登入
    assert page.request.get("/api/auth/me").status == 200
    ctx3 = browser.new_context(base_url=base_url)
    login_via_ui(ctx3.new_page(), {"username": RENAMED, "password": PW2})
    ctx3.close()

    # 還原：admin 停用測試帳號
    admin_ctx = browser.new_context(base_url=base_url)
    admin_page = admin_ctx.new_page()
    login_via_ui(admin_page, E2E_USERS["admin"])
    lst = admin_page.request.get("/api/admin/users").json()
    created = next((u for u in lst if u["username"] == RENAMED), None)
    assert created
    off = admin_page.request.patch(f"/api/admin/users/{created['id']}", data={"isActive": False})
    assert off.status == 200
    admin_ctx.close()

    assert [e for e in errors if not re.search(r"401|Failed to load resource", e)] == []


def test_member_768_and_role_immutable(page: Page):
    """一般成員：768 寬度可用，且 role 無法經 API 更動"""
    page.set_viewport_size({"width": 768, "height": 900})
    login_via_ui(page, E2E_USERS["member"], "/settings")
    expect(page.get_by_role("heading", name="個人資料")).to_be_visible()
    expect(page.get_by_role("form", name="個人資料").get_by_label("帳號", exact=True)).to_have_value(
        E2E_USERS["member"]["username"]
    )
    before = page.request.get("/api/profile").json()
    res = page.request.patch("/api/profile", data={"role": "admin"})
    assert res.status == 400
    after = page.request.get("/api/profile").json()
    assert after["role"] == before["role"]
    overflow = page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth")
    assert overflow is False
