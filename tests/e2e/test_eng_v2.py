"""eng-v2.spec.ts 的 Python 版：工程追蹤 v2（自訂狀態、掃描本機專案、多台電腦回報的安全機制與回收區）。"""

from __future__ import annotations

import os
import re
import shutil
import sqlite3
import subprocess
import time
from pathlib import Path

import pytest
from playwright.sync_api import Locator, Page, expect

from .conftest import E2E_DB, E2E_ENV
from .helpers import E2E_USERS, collect_errors, login_via_ui

# 工程追蹤 v2：(A) 自訂狀態、(B) 掃描本機專案、(C) 多台電腦回報的安全機制（空回報攔截、回收區）。
# 截圖：設定 ENG_SHOT_DIR（與 ENG_SHOT_WIDTH）時，把關鍵畫面存到該資料夾。
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
TOKEN = "e2e-report-token"
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
    page.wait_for_timeout(350)  # 等對話框淡入完成
    page.screenshot(path=str(Path(SHOT_DIR).resolve() / f"{name}-{WIDTH}.png"), animations="disabled")


def wt_row(scope, text: str) -> Locator:
    return scope.locator("tr.eng-wt-row").filter(has_text=text)


def issue_row(page: Page, title: str) -> Locator:
    return page.locator("tr.eng-issue-row").filter(has_text=title)


def ok_errors(errors: list[str]) -> list[str]:
    return [e for e in errors if "Failed to load resource" not in e]


def test_a_custom_statuses(page: Page):
    """(A) 成員新增自訂工作樹狀態並套用；新增問題狀態；管理狀態對話框"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["member"], "/eng?tab=worktrees")
    branch = f"feat/status-{stamp}"
    form = page.get_by_role("form", name="新增 worktree 紀錄")
    form.get_by_label("電腦").fill(f"E2E-ST-{stamp}")
    form.get_by_label("路徑").fill(f"C:/e2e/{stamp}/status")
    form.get_by_label("分支").fill(branch)
    form.get_by_role("button", name="新增紀錄").click()
    row = wt_row(page, branch)
    expect(row.get_by_text("使用中")).to_be_visible()

    # 選單有新的內建狀態；底部可新增 / 管理
    row.get_by_role("button", name=f"「{branch}」的狀態").click()
    for label in ["損毀", "技術債", "舊版保留", "未知"]:
        expect(page.get_by_role("option", name=label)).to_be_visible()
    expect(page.get_by_role("button", name="管理狀態…")).to_be_visible()
    shot(page, "a1-status-menu")
    page.get_by_role("button", name="新增狀態…").click()
    add = page.get_by_role("dialog", name="新增工作樹狀態")
    custom = f"待驗證{stamp}"
    add.get_by_label("狀態名稱").fill(custom)
    add.get_by_role("button", name="新增", exact=True).click()
    expect(add).to_have_count(0)
    # 新增後直接套用到這一列
    expect(row.get_by_text(custom)).to_be_visible()

    # 管理狀態對話框：內建不可刪除，有使用的自訂狀態只能封存
    page.get_by_role("button", name="管理狀態", exact=True).click()
    manage = page.get_by_role("dialog", name="管理工作樹狀態")
    expect(manage.get_by_test_id("eng-status-row")).to_have_count(10)
    expect(manage.get_by_role("button", name="刪除狀態：使用中")).to_have_count(0)
    expect(manage.get_by_role("button", name=f"刪除狀態：{custom}")).to_be_disabled()
    shot(page, "a2-status-manage")
    manage.get_by_role("button", name="完成").click()

    # 問題：成員新增問題狀態並套用
    page.goto("/eng")
    title = f"E2E 狀態問題 {stamp}"
    issue_form = page.get_by_role("form", name="新增問題")
    issue_form.get_by_label("標題").fill(title)
    issue_form.get_by_label("標題").press("Enter")
    irow = issue_row(page, title)
    expect(irow.get_by_text("未處理")).to_be_visible()
    irow.get_by_role("button", name=f"「{title}」的狀態").click()
    expect(page.get_by_role("option", name="卡住")).to_be_visible()
    page.get_by_role("button", name="新增狀態…").click()
    add_issue = page.get_by_role("dialog", name="新增問題狀態")
    issue_status = f"待回覆{stamp}"
    add_issue.get_by_label("狀態名稱").fill(issue_status)
    add_issue.get_by_role("button", name="新增", exact=True).click()
    expect(irow.get_by_text(issue_status)).to_be_visible()

    assert ok_errors(errors) == []


def test_b_scan_local_projects(page: Page):
    """(B) 掃描本機專案：預覽 → 勾選 → 登記"""
    errors = collect_errors(page)
    # 在允許掃描的資料夾（伺服器的 WORKTREE_SCAN_ROOTS，見 conftest 的 E2E_ENV）建立暫存 git repo 與兩個 worktree
    root = ROOT / E2E_ENV["WORKTREE_SCAN_ROOTS"] / stamp
    shutil.rmtree(root, ignore_errors=True)
    proj = root / "proj"
    proj.mkdir(parents=True, exist_ok=True)

    def git(cwd: Path, *args: str) -> None:
        subprocess.run(
            ["git", "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "commit.gpgsign=false", *args],
            cwd=cwd,
            check=True,
            capture_output=True,
        )

    git(proj, "init", "-q", "-b", "main")
    git(proj, "commit", "-q", "--allow-empty", "-m", "init")
    git(proj, "worktree", "add", "-q", "-b", f"feat/scan-a-{stamp}", str(root / "wt-a"))
    git(proj, "worktree", "add", "-q", "-b", f"feat/scan-b-{stamp}", str(root / "wt-b"))

    login_via_ui(page, E2E_USERS["admin"], "/eng?tab=worktrees")
    page.get_by_role("button", name="掃描本機專案").click()
    dialog = page.get_by_role("dialog", name="掃描本機專案")
    dialog.get_by_label("專案資料夾").fill(str(proj))
    dialog.get_by_role("button", name="預覽").click()
    preview = dialog.get_by_test_id("scan-preview")
    expect(preview).to_contain_text("新增 2、已存在 0、可能搬動 0")
    expect(preview.get_by_text(f"feat/scan-a-{stamp}")).to_be_visible()
    shot(page, "b1-scan-preview")
    # 只登記一個：取消勾選 b
    dialog.get_by_label(f"登記 feat/scan-b-{stamp}").uncheck()
    dialog.get_by_role("button", name="登記（1）").click()
    expect(dialog).to_have_count(0)
    expect(wt_row(page, f"feat/scan-a-{stamp}").get_by_text("掃描登記")).to_be_visible()
    expect(wt_row(page, f"feat/scan-b-{stamp}")).to_have_count(0)

    # 再掃一次：a 為已登記（不可勾選）
    page.get_by_role("button", name="掃描本機專案").click()
    dialog.get_by_role("button", name="預覽").click()
    expect(dialog.get_by_test_id("scan-preview")).to_contain_text("新增 1、已存在 1")
    expect(dialog.get_by_label(f"登記 feat/scan-a-{stamp}")).to_be_disabled()
    # 範圍外的資料夾被拒
    dialog.get_by_label("專案資料夾").fill(str(ROOT))
    dialog.get_by_role("button", name="預覽").click()
    expect(dialog.get_by_text(re.compile(r"不在允許掃描的範圍內"))).to_be_visible()
    dialog.get_by_role("button", name="取消").click()

    # 一般成員看不到掃描按鈕
    page.context.clear_cookies()
    login_via_ui(page, E2E_USERS["member"], "/eng?tab=worktrees")
    expect(page.get_by_role("button", name="回收區", exact=False)).to_be_visible()
    expect(page.get_by_role("button", name="掃描本機專案")).to_have_count(0)

    assert ok_errors(errors) == []


def test_c_empty_report_held_and_grouped_by_machine_id(page: Page):
    """(C) 回報空清單被攔住、舊資料仍在；不同電腦依識別碼分組"""
    errors = collect_errors(page)
    machine = f"E2E-RPT-{stamp}"
    machine_id = f"e2e-{stamp}-aaaa"

    def post(worktrees: list):
        return page.request.post(
            "/api/eng/worktrees/report",
            headers={"x-report-token": TOKEN},
            data={"machine": machine, "machineId": machine_id, "repo": "e2e-repo", "worktrees": worktrees},
        )

    wts = [
        {"path": f"D:/e2e/{stamp}/wt-{i}", "branch": f"feat/rpt-{i}-{stamp}", "headSha": "abcdef1"} for i in [1, 2, 3]
    ]
    assert post(wts).status == 200
    held = post([]).json()
    assert held["held"] is True
    assert held["reason"] == "empty"
    assert held["previous"] == 3

    # 另一台很久沒回報的電腦（模擬 3 天前）
    db = sqlite3.connect(str(ROOT / E2E_DB))  # 伺服器用的那一份（conftest 的 E2E_DB）
    try:
        db.execute("PRAGMA busy_timeout = 5000")
        old = int(time.time() * 1000) - 3 * 86_400_000
        db.execute(
            "INSERT INTO worktree_report_sources (machine_key, machine_id, machine, repo, last_report_at, last_applied_at) VALUES (?, ?, ?, ?, ?, ?)",
            (f"id:e2e-old-{stamp}", f"e2e-old-{stamp}", f"E2E-OLD-{stamp}", "e2e-repo", old, old),
        )
        db.execute(
            "INSERT INTO worktree_reports (machine, machine_id, repo, path, branch, head_sha, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"E2E-OLD-{stamp}", f"e2e-old-{stamp}", "e2e-repo", f"E:/old/{stamp}", f"feat/old-{stamp}", "abcdef2", old),
        )
        db.commit()
    finally:
        db.close()

    # 回報來的電腦與未登記項目沒有負責人，集中在「全部成員」的「未指派」卡片
    login_via_ui(page, E2E_USERS["member"], "/eng?tab=worktrees&user=all")
    section = page.get_by_role("region", name=f"電腦 {machine}")
    expect(section.get_by_text("可疑回報待確認")).to_be_visible()
    expect(section.get_by_test_id("pending-report")).to_contain_text("最新回報為空清單（先前 3 筆），已保留舊資料")
    # 舊資料仍在（3 筆未登記）
    expect(section.locator("tr.eng-wt-row")).to_have_count(3)
    old_section = page.get_by_role("region", name=f"電腦 E2E-OLD-{stamp}")
    expect(old_section.get_by_text(re.compile(r"未回報（最後看到 3 天前）"))).to_be_visible()
    section.scroll_into_view_if_needed()
    shot(page, "c1-machines-suspicious")

    # 保留舊資料（忽略這次回報）
    section.get_by_role("button", name="保留舊資料").click()
    expect(section.get_by_test_id("pending-report")).to_have_count(0)
    expect(section.locator("tr.eng-wt-row")).to_have_count(3)

    assert ok_errors(errors) == []


def test_c_trash_and_restore(page: Page):
    """(C) 刪除 → 回收區 → 還原"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["member"], "/eng?tab=worktrees")
    branch = f"feat/trash-{stamp}"
    form = page.get_by_role("form", name="新增 worktree 紀錄")
    form.get_by_label("電腦").fill(f"E2E-TR-{stamp}")
    form.get_by_label("路徑").fill(f"C:/e2e/{stamp}/trash")
    form.get_by_label("分支").fill(branch)
    form.get_by_role("button", name="新增紀錄").click()
    row = wt_row(page, branch)
    expect(row).to_be_visible()

    row.get_by_role("button", name=f"「{branch}」的操作").click()
    page.get_by_role("menuitem", name="移到回收區").click()
    page.get_by_role("alertdialog", name="移到回收區？").get_by_role("button", name="移到回收區").click()
    expect(row).to_have_count(0)

    page.get_by_role("button", name=re.compile(r"回收區（\d+）")).click()
    trash = page.get_by_role("dialog", name="回收區")
    item = trash.locator(".eng-trash-item").filter(has_text=branch)
    expect(item).to_be_visible()
    # 成員看不到「清空回收區」（需管理者）
    expect(trash.get_by_role("button", name="清空回收區")).to_have_count(0)
    shot(page, "c2-trash")
    item.get_by_role("button", name="還原").click()
    expect(item).to_have_count(0)
    trash.get_by_role("button", name="完成").click()
    expect(wt_row(page, branch)).to_be_visible()

    assert ok_errors(errors) == []
