"""eng-tracking.spec.ts 的 Python 版：工程追蹤簡化版（問題的新增／改狀態／結案；worktree 紀錄；回報快照與提示）。"""

from __future__ import annotations

import os
import re
import sqlite3
import time
from pathlib import Path

import pytest
from playwright.sync_api import Locator, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 工程追蹤簡化版（手動輸入優先）：問題的新增 / 改狀態 / 結案；worktree 紀錄的新增 / 登記 / 刪除；
# 各電腦回報快照的顯示與「未登記」「可能遺失」提示。
# （原檔 serial：pytest 同檔內本來就照順序跑）

ROOT = Path(__file__).resolve().parents[2]


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


stamp = _base36(int(time.time() * 1000))
ISSUE = f"E2E 問題 {stamp}"
ISSUE_RENAMED = f"E2E 問題改名 {stamp}"
PROJECT = f"e2e-proj-{stamp}"
MACHINE = f"E2E-PC-{stamp}"
WT = {
    "kept": {"path": f"C:/e2e/{stamp}/wt-kept", "branch": f"feat/kept-{stamp}"},
    "gone": {"path": f"C:/e2e/{stamp}/wt-gone", "branch": f"feat/gone-{stamp}"},
    "spike": {"path": f"C:/e2e/{stamp}/wt-spike", "branch": f"tmp/spike-{stamp}"},
}


def seed_report() -> None:
    """模擬某台電腦已回報（直接寫入 E2E 專用 DB）"""
    db = sqlite3.connect(str(ROOT / "data" / "e2e.db"))
    try:
        db.execute("PRAGMA busy_timeout = 5000")
        sql = (
            "INSERT INTO worktree_reports (machine, repo, path, branch, head_sha, is_dirty, ahead, behind, is_merged, reported_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        t = int(time.time() * 1000)
        db.execute(sql, (MACHINE, "e2e-repo", WT["kept"]["path"], WT["kept"]["branch"], "abcdef1", 1, 2, 0, 0, t))
        db.execute(sql, (MACHINE, "e2e-repo", WT["spike"]["path"], WT["spike"]["branch"], "abcdef2", 0, 0, 3, 0, t))
        db.commit()
    finally:
        db.close()


def tab(page: Page, name: re.Pattern):
    return page.get_by_role("navigation", name="工程追蹤").get_by_role("link", name=name)


def issue_row(page: Page, title: str) -> Locator:
    return page.locator("tr.eng-issue-row").filter(has_text=title)


def wt_row(scope, branch: str) -> Locator:
    return scope.locator("tr.eng-wt-row").filter(has_text=branch)


def pick_option(page: Page, trigger: Locator, option: str) -> None:
    trigger.click()
    page.get_by_role("option", name=option).click()


def test_issue_add_status_edit_close(page: Page):
    """問題：手動新增 → 改狀態 → 編輯 → 結案 → 顯示已結案"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["member"], "/eng")
    expect(tab(page, re.compile(r"問題"))).to_have_attribute("aria-current", "page")

    # 新增表單在最上面：填標題與專案，Enter 送出
    form = page.get_by_role("form", name="新增問題")
    form.get_by_label("專案 / Repo").fill(PROJECT)
    form.get_by_label("標題").fill(ISSUE)
    form.get_by_label("標題").press("Enter")
    row = issue_row(page, ISSUE)
    expect(row).to_be_visible()
    expect(row.get_by_text(PROJECT)).to_be_visible()
    expect(row.get_by_text("未處理")).to_be_visible()
    expect(row.locator("time")).to_have_count(1)
    # 送出後標題清空、專案保留，方便連續登錄
    expect(form.get_by_label("標題")).to_have_value("")
    expect(form.get_by_label("專案 / Repo")).to_have_value(PROJECT)

    # 列上直接改狀態
    pick_option(page, row.get_by_role("button", name=f"「{ISSUE}」的狀態"), "處理中")
    expect(row.get_by_text("處理中")).to_be_visible()

    # 編輯（對話框）
    row.get_by_role("button", name=f"「{ISSUE}」的操作").click()
    page.get_by_role("menuitem", name="編輯").click()
    dialog = page.get_by_role("dialog", name="編輯問題")
    dialog.get_by_label("標題").fill(ISSUE_RENAMED)
    dialog.get_by_label("連結").fill("https://example.com/issue/1")
    dialog.get_by_role("button", name="儲存").click()
    expect(dialog).to_have_count(0)
    renamed = issue_row(page, ISSUE_RENAMED)
    expect(renamed.get_by_role("link", name=f"開啟「{ISSUE_RENAMED}」的連結")).to_have_attribute(
        "href", "https://example.com/issue/1"
    )

    # 結案：預設清單隱藏，勾選「顯示已結案」後出現
    renamed.get_by_role("button", name=f"「{ISSUE_RENAMED}」的操作").click()
    page.get_by_role("menuitem", name="結案").click()
    expect(renamed).to_have_count(0)
    page.get_by_label(re.compile(r"顯示已結案")).check()
    expect(renamed.get_by_text("已結案")).to_be_visible()

    assert [e for e in errors if "Failed to load resource" not in e] == []


def test_github_link_without_token(page: Page):
    """GitHub 連動（未設定 token）：不顯示 GitHub 按鈕；貼 GitHub issue 網址會解析出編號"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["member"], "/eng")
    enabled = page.request.get("/api/eng/issues").json()["githubEnabled"]
    if enabled:
        pytest.skip("E2E 伺服器設定了 GITHUB_TOKEN")

    expect(page.get_by_role("button", name=re.compile(r"GitHub"))).to_have_count(0)

    title = f"E2E GitHub {stamp}"
    form = page.get_by_role("form", name="新增問題")
    form.get_by_label("標題").fill(title)
    form.get_by_label("連結").fill("https://github.com/Acme/Widgets/issues/42")
    form.get_by_role("button", name="新增問題").click()
    row = issue_row(page, title)
    expect(row.get_by_text("#42")).to_be_visible()
    # 一般網址不顯示編號
    row.get_by_role("button", name=f"「{title}」的操作").click()
    expect(page.get_by_role("menuitem", name="編輯")).to_be_visible()
    expect(page.get_by_role("menuitem", name=re.compile(r"GitHub"))).to_have_count(0)
    page.get_by_role("menuitem", name="編輯").click()
    dialog = page.get_by_role("dialog", name="編輯問題")
    dialog.get_by_label("連結").fill("https://example.com/issue/42")
    dialog.get_by_role("button", name="儲存").click()
    expect(dialog).to_have_count(0)
    expect(row.get_by_text("#42")).to_have_count(0)

    assert [e for e in errors if "Failed to load resource" not in e] == []


def test_worktree_manual_records_and_report_hints(page: Page):
    """Worktree：手動新增紀錄、回報快照依電腦分組、未登記與可能遺失提示"""
    errors = collect_errors(page)
    # 未設定回報 token：回報端點一律 403（不需登入）
    if not os.environ.get("WORKTREE_REPORT_TOKEN"):
        res = page.request.post(
            "/api/eng/worktrees/report",
            headers={"x-report-token": "whatever"},
            data={"machine": MACHINE, "worktrees": []},
        )
        assert res.status == 403

    login_via_ui(page, E2E_USERS["member"], "/eng?tab=worktrees")
    expect(tab(page, re.compile(r"工作樹"))).to_have_attribute("aria-current", "page")

    # 手動新增兩筆紀錄（電腦名稱會記住，第二筆不用再填）
    form = page.get_by_role("form", name="新增 worktree 紀錄")
    form.get_by_label("電腦").fill(MACHINE)
    for wt in [WT["kept"], WT["gone"]]:
        form.get_by_label("路徑").fill(wt["path"])
        form.get_by_label("分支").fill(wt["branch"])
        form.get_by_role("button", name="新增紀錄").click()
        expect(form.get_by_label("路徑")).to_have_value("")
    expect(form.get_by_label("電腦")).to_have_value(MACHINE)

    section = page.get_by_role("region", name=f"電腦 {MACHINE}")
    expect(section.get_by_text("尚未回報（僅手動紀錄）")).to_be_visible()
    expect(wt_row(section, WT["kept"]["branch"]).get_by_text("使用中")).to_be_visible()
    # 同電腦同路徑不可重複
    form.get_by_label("路徑").fill(WT["kept"]["path"].upper())
    form.get_by_role("button", name="新增紀錄").click()
    expect(form.get_by_text("此電腦的這個路徑已有紀錄")).to_be_visible()
    form.get_by_label("路徑").fill("")

    # 該電腦回報：kept（有紀錄）與 spike（未登記）；gone 不在回報中 → 可能遺失
    seed_report()
    page.reload()
    expect(section.get_by_text(re.compile(r"回報於")).first).to_be_visible()
    expect(wt_row(section, WT["kept"]["branch"]).get_by_text("未提交變更 · ↑2 ↓0")).to_be_visible()
    expect(wt_row(section, WT["gone"]["branch"]).get_by_text("可能遺失")).to_be_visible()
    spike = wt_row(section, WT["spike"]["branch"])
    expect(spike.get_by_text("未登記")).to_be_visible()
    expect(tab(page, re.compile(r"工作樹")).get_by_label("2 個提示")).to_be_visible()
    # 每列都有更新時間
    rows = section.locator("tr.eng-wt-row").count()
    assert rows == 3
    expect(section.locator("tr.eng-wt-row time")).to_have_count(rows)

    # 一鍵登記 → 不再是未登記
    spike.get_by_role("button", name="登記").click()
    expect(spike.get_by_text("未登記")).to_have_count(0)
    expect(spike.get_by_text("使用中")).to_be_visible()

    # 手動狀態改為「已遺失」→ 不再提示可能遺失；已遺失屬於「已結束」類，預設隱藏（勾選「顯示已清理」才出現）
    gone = wt_row(section, WT["gone"]["branch"])
    pick_option(page, gone.get_by_role("button", name=f"「{WT['gone']['branch']}」的狀態"), "已遺失")
    expect(gone).to_have_count(0)
    page.get_by_label(re.compile(r"顯示已清理")).check()
    expect(gone.get_by_text("已遺失")).to_be_visible()
    expect(gone.get_by_text("可能遺失")).to_have_count(0)

    # 編輯備註、刪除紀錄
    gone.get_by_role("button", name=f"「{WT['gone']['branch']}」的操作").click()
    page.get_by_role("menuitem", name="編輯").click()
    dialog = page.get_by_role("dialog", name="編輯 worktree 紀錄")
    dialog.get_by_label("備註").fill("硬碟重灌後消失")
    dialog.get_by_role("button", name="儲存").click()
    expect(gone.get_by_text("硬碟重灌後消失")).to_be_visible()

    # 刪除改為移到回收區（可還原）
    gone.get_by_role("button", name=f"「{WT['gone']['branch']}」的操作").click()
    page.get_by_role("menuitem", name="移到回收區").click()
    confirm = page.get_by_role("alertdialog", name="移到回收區？")
    confirm.get_by_role("button", name="移到回收區").click()
    expect(gone).to_have_count(0)

    # 預期中的 409（路徑重複）會在 console 留下資源載入失敗訊息，不算錯誤
    assert [e for e in errors if "Failed to load resource" not in e] == []
