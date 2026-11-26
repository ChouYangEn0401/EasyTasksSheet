"""eng-person-view.spec.ts 的 Python 版：工程追蹤「工作樹」每人一份（檢視切換、唯讀、全部成員分組、重整保留）。"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

# 工程追蹤「工作樹」每人一份：檢視切換（?user=<id|all>）、我自己只看自己的紀錄、
# 新增預設負責人為自己、檢視他人為唯讀、全部成員依成員分組（含未指派）、重整保留。
# 截圖：設定 ENG_SHOT_DIR（與 ENG_SHOT_WIDTH）時存檔。
# （原檔 serial：pytest 同檔內本來就照順序跑）


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


stamp = _base36(int(time.time() * 1000))
SHOT_DIR = os.environ.get("ENG_SHOT_DIR")
WIDTH = int(os.environ.get("ENG_SHOT_WIDTH") or 1280)

# 對應 test.use({ viewport: { width: WIDTH, height: 900 } })
pytestmark = [
    pytest.mark.usefixtures("data_hygiene"),
    pytest.mark.browser_context_args(viewport={"width": WIDTH, "height": 900}),
]


def shot(page: Page, name: str) -> None:
    if not SHOT_DIR:
        return
    Path(SHOT_DIR).mkdir(parents=True, exist_ok=True)
    page.wait_for_timeout(350)
    page.screenshot(path=str(Path(SHOT_DIR).resolve() / f"{name}-{WIDTH}.png"), animations="disabled")


MACHINE = f"E2E-PV-{stamp}"
BR = {
    "mine": f"feat/pv-mine-{stamp}",
    "admin": f"feat/pv-admin-{stamp}",
    "none": f"feat/pv-none-{stamp}",
}
json = {"Content-Type": "application/json"}


def wt_row(page: Page, branch: str):
    return page.locator("tr.eng-wt-row").filter(has_text=branch)


def card(page: Page, name: str):
    return page.get_by_role("region", name=f"成員 {name}", exact=True)


def test_worktrees_per_person(page: Page):
    """工作樹每人一份：我自己 → 新增預設自己 → 他人唯讀 → 全部成員含未指派 → 重整保留"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["member"], "/eng?tab=worktrees")
    admin_name = E2E_USERS["admin"]["display_name"]
    member_name = E2E_USERS["member"]["display_name"]

    # 準備資料：一筆負責人是管理員、一筆未指派（API 不帶 ownerId）
    users = page.request.get("/api/users").json()
    admin_id = next(u for u in users if u["displayName"] == admin_name)["id"]

    def post(data: dict):
        return page.request.post("/api/eng/worktree-records", headers=json, data=data)

    assert (
        post({"machine": MACHINE, "path": f"C:/e2e/{stamp}/pv-admin", "branch": BR["admin"], "ownerId": admin_id}).status
        == 201
    )
    assert post({"machine": MACHINE, "path": f"C:/e2e/{stamp}/pv-none", "branch": BR["none"]}).status == 201
    page.reload()

    # 我自己：沒有我的紀錄時不會看到別人的；頂部提示未指派筆數並連到「全部成員」
    expect(page.get_by_role("button", name="檢視成員的工作樹")).to_contain_text("我自己")
    expect(wt_row(page, BR["admin"])).to_have_count(0)
    expect(wt_row(page, BR["none"])).to_have_count(0)
    expect(page.get_by_test_id("unassigned-note")).to_contain_text(re.compile(r"有 \d+ 筆未指派的工作樹"))

    # 新增表單的負責人預設為目前登入者
    form = page.get_by_role("form", name="新增 worktree 紀錄")
    expect(form.get_by_role("button", name="負責人")).to_contain_text(member_name)
    form.get_by_label("電腦").fill(MACHINE)
    form.get_by_label("路徑").fill(f"C:/e2e/{stamp}/pv-mine")
    form.get_by_label("分支").fill(BR["mine"])
    form.get_by_role("button", name="新增紀錄").click()
    mine = card(page, "我自己")
    expect(mine.locator("tr.eng-wt-row").filter(has_text=BR["mine"])).to_be_visible()
    # 電腦是第二層小標題
    expect(mine.get_by_role("region", name=f"電腦 {MACHINE}")).to_be_visible()
    expect(mine.get_by_test_id("owner-count")).to_contain_text("筆")
    expect(page.get_by_test_id("scope-total")).to_contain_text("共")
    shot(page, "pv1-self")

    # 貼上 / 掃描對話框的負責人也預設為自己
    page.get_by_role("button", name="貼上 git worktree list").click()
    paste = page.get_by_role("dialog", name="貼上 git worktree list")
    expect(paste.get_by_role("button", name="登記的負責人")).to_contain_text(member_name)
    paste.get_by_role("button", name="取消").click()

    # 切換到管理員：唯讀（沒有新增表單、狀態下拉、操作選單、貼上 / 掃描按鈕）
    page.get_by_role("button", name="檢視成員的工作樹").click()
    page.get_by_role("option", name=admin_name).click()
    expect(page).to_have_url(re.compile(f"user={admin_id}"))
    expect(page.get_by_test_id("readonly-note")).to_have_text(f"正在檢視 {admin_name} 的工作樹（唯讀）")
    expect(page.get_by_role("form", name="新增 worktree 紀錄")).to_have_count(0)
    admin_row = wt_row(page, BR["admin"])
    expect(admin_row).to_be_visible()
    expect(admin_row.get_by_role("button")).to_have_count(0)
    expect(page.get_by_role("button", name="貼上 git worktree list")).to_have_count(0)
    expect(page.get_by_role("button", name="掃描本機專案")).to_have_count(0)
    expect(wt_row(page, BR["mine"])).to_have_count(0)
    shot(page, "pv2-readonly")

    # 全部成員：依成員分組；我自己在前、未指派在最後；可摺疊
    page.get_by_role("button", name="檢視成員的工作樹").click()
    page.get_by_role("option", name="全部成員").click()
    expect(page).to_have_url(re.compile(r"user=all"))
    cards = page.locator("section.eng-owner-card")
    expect(card(page, "我自己")).to_be_visible()
    expect(card(page, admin_name)).to_be_visible()
    expect(card(page, "未指派")).to_be_visible()
    expect(cards.first).to_have_attribute("aria-label", "成員 我自己")
    expect(cards.last).to_have_attribute("aria-label", "成員 未指派")
    expect(card(page, "未指派").locator("tr.eng-wt-row").filter(has_text=BR["none"])).to_be_visible()
    expect(card(page, admin_name).locator("tr.eng-wt-row").filter(has_text=BR["admin"])).to_be_visible()
    shot(page, "pv3-all")
    toggle = card(page, admin_name).locator("button.eng-owner-toggle")
    toggle.click()
    expect(wt_row(page, BR["admin"])).to_have_count(0)
    expect(toggle).to_have_attribute("aria-expanded", "false")
    toggle.click()
    expect(wt_row(page, BR["admin"])).to_be_visible()

    # 重整後 ?user= 保留；回到我自己時參數消失
    page.reload()
    expect(page).to_have_url(re.compile(r"user=all"))
    expect(page.get_by_role("button", name="檢視成員的工作樹")).to_contain_text("全部成員")
    expect(card(page, "未指派")).to_be_visible()
    page.get_by_role("button", name="檢視成員的工作樹").click()
    page.get_by_role("option", name="我自己").click()
    expect(page).not_to_have_url(re.compile(r"user="))

    # 無效的成員參數
    page.goto("/eng?tab=worktrees&user=abc")
    expect(page.get_by_text("找不到此成員")).to_be_visible()

    assert [e for e in errors if "Failed to load resource" not in e] == []
