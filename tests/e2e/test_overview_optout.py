"""overview-optout.spec.ts 的 Python 版：帳號可「不列入總覽統計」；root（admin）預設不列入。"""

from __future__ import annotations

import json as _json
import os
import time
from urllib.parse import urlparse

import pytest
from playwright.sync_api import Page, expect

from .helpers import E2E_USERS, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# feat/overview-optout：帳號可「不列入總覽統計」。root（admin）預設不列入；
# 只操作本 spec 自建的帳號，不改動 admin / member / manager / peer 的狀態。
# （原檔 serial：pytest 同檔內本來就照順序跑）


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


stamp = _base36(int(time.time() * 1000))
USERNAME = f"oo-{stamp}"
NAME = f"總覽測試 {stamp}"
shots = os.environ.get("SHOTS_DIR")


def users(page: Page) -> list[dict]:
    res = page.request.get("/api/users")
    assert res.ok
    return res.json()


def shoot(page: Page, name: str) -> None:
    """設了 SHOTS_DIR 時，以 1280 / 768 各截一張（驗收用）"""
    if not shots:
        return
    orig = page.viewport_size or {"width": 1280, "height": 720}
    for width in [1280, 768]:
        page.set_viewport_size({"width": width, "height": 900})
        page.screenshot(path=f"{shots}/{name}-{width}.png")
    page.set_viewport_size(orig)


def test_root_not_in_overview_and_toggle(page: Page):
    """root 不出現在總覽；成員管理可關閉 / 開啟「列入總覽統計」"""
    login_via_ui(page, E2E_USERS["admin"], "/admin/users")

    # 新增成員（預設列入）：對話框內開關預設勾選；切到 root 角色預設取消
    page.get_by_role("button", name="新增成員").click()
    create = page.get_by_role("dialog", name="新增成員")
    toggle = create.get_by_label("列入總覽統計")
    expect(toggle).to_be_checked()
    expect(create.get_by_text("任務仍可指派給他。")).to_be_visible()
    create.get_by_label("帳號").fill(USERNAME)
    create.get_by_label("顯示名稱").fill(NAME)
    create.get_by_role("button", name="建立").click()
    created = page.get_by_role("dialog", name=f"已建立成員「{NAME}」")
    expect(created).to_be_visible()
    created.get_by_role("button", name="完成").click()

    lst = users(page)
    admin = next(u for u in lst if u["username"] == E2E_USERS["admin"]["username"])
    mine = next(u for u in lst if u["username"] == USERNAME)
    assert admin["inOverview"] is False
    assert mine["inOverview"] is True

    # 全站完全沒有任務時，總覽會把「目前無任務」的成員收合成一組（不顯示個別卡片）；
    # 先指派一筆任務給新成員，讓卡片版面不依賴其他 spec 殘留的資料
    seed = page.request.post("/api/tasks", data={"title": f"指派給新成員 {stamp}", "assigneeId": mine["id"]})
    assert seed.ok

    # 總覽：root 無卡片、新成員有卡片
    page.goto("/")
    expect(page.get_by_test_id(f"member-card-{mine['id']}")).to_be_visible()
    expect(page.get_by_test_id(f"member-card-{admin['id']}")).to_have_count(0)

    # 成員管理：關閉該成員
    page.goto("/admin/users")
    row = page.locator(f'tbody tr[data-username="{USERNAME}"]')
    expect(row.get_by_text("不列入總覽")).to_have_count(0)

    def open_edit():
        page.get_by_role("button", name=f"{NAME} 的操作").click()
        page.get_by_role("menuitem", name="編輯").click()
        return page.get_by_role("dialog", name="編輯成員")

    edit = open_edit()
    edit.get_by_label("列入總覽統計").uncheck()
    shoot(page, "admin-users-dialog")
    edit.get_by_role("button", name="儲存").click()
    expect(edit).to_be_hidden()
    expect(row.get_by_text("不列入總覽")).to_be_visible()
    shoot(page, "admin-users")

    page.goto("/")
    expect(page.get_by_test_id("stat-idle")).to_be_visible()
    expect(page.get_by_test_id(f"member-card-{mine['id']}")).to_have_count(0)
    shoot(page, "overview")
    # 任務仍可指派給他：任務 API 不受影響
    u = urlparse(page.url)
    res = page.request.post(
        "/api/tasks",
        headers={"content-type": "application/json", "origin": f"{u.scheme}://{u.netloc}"},
        data=_json.dumps({"title": f"指派給不列入者 {stamp}", "assigneeId": mine["id"]}),
    )
    assert res.ok

    # 再開啟 → 卡片回來
    page.goto("/admin/users")
    edit = open_edit()
    edit.get_by_label("列入總覽統計").check()
    edit.get_by_role("button", name="儲存").click()
    expect(edit).to_be_hidden()
    expect(row.get_by_text("不列入總覽")).to_have_count(0)
    page.goto("/")
    expect(page.get_by_test_id(f"member-card-{mine['id']}")).to_be_visible()

    # 還原：停用測試帳號，避免影響他處
    page.goto("/admin/users")
    page.get_by_role("button", name=f"{NAME} 的操作").click()
    page.get_by_role("menuitem", name="停用").click()
    page.get_by_role("alertdialog").get_by_role("button", name="停用").click()
    expect(row.get_by_text("已停用")).to_be_visible()
