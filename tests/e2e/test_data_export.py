"""data-export.spec.ts 的 Python 版：資料管理（權限、完整備份、JSON 匯出 → 匯入衝突 → keep_local + 逐筆 use_import）。"""

from __future__ import annotations

import re
import time

import pytest
from playwright.sync_api import APIRequestContext, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 資料管理：權限、完整備份下載（含敏感確認）、JSON 匯出 → 改動資料 → 匯入預覽出現衝突 →
# 全域 keep_local + 逐筆 use_import → 結果正確。只改動本 spec 自建的任務。
# （原檔 serial：pytest 同檔內本來就照順序跑）


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


stamp = _base36(int(time.time() * 1000))
TITLE_A = f"E2E 匯入 A {stamp}"
TITLE_B = f"E2E 匯入 B {stamp}"


def create_task(request: APIRequestContext, title: str) -> dict:
    res = request.post("/api/tasks", data={"title": title})
    assert res.status == 201
    return res.json()


def get_task(request: APIRequestContext, tid: int) -> dict:
    return request.get(f"/api/tasks/{tid}").json()


def test_member_has_no_access(page: Page):
    """一般成員：導覽無入口、頁面沒有權限、API 403"""
    login_via_ui(page, E2E_USERS["member"])
    expect(page.get_by_role("navigation", name="主要導覽").get_by_text("資料管理")).to_have_count(0)
    page.goto("/admin/data")
    expect(page.get_by_text("沒有權限")).to_be_visible()
    assert page.request.get("/api/admin/data/export").status == 403
    assert page.request.get("/api/admin/data/backup").status == 403


def test_admin_backup_export_import_conflicts(page: Page):
    """管理員：備份下載、匯出 → 改動 → 匯入衝突 → keep_local + 逐筆 use_import"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["admin"])
    page.get_by_role("navigation", name="主要導覽").get_by_role("link", name="資料管理").click()
    expect(page).to_have_url(re.compile(r"/admin/data$"))

    a = create_task(page.request, TITLE_A)
    b = create_task(page.request, TITLE_B)

    # 完整備份：先經過敏感性確認
    page.get_by_role("button", name="下載完整備份").click()
    dialog = page.get_by_role("alertdialog", name="下載完整備份？")
    expect(dialog.get_by_text("密碼雜湊")).to_be_visible()
    with page.expect_download() as backup_download:
        dialog.get_by_role("button", name="我了解，下載").click()
    assert re.match(r"^tasks-sheets-backup-\d{8}-\d{6}\.db$", backup_download.value.suggested_filename)

    # 匯出 JSON
    with page.expect_download() as export_download:
        page.get_by_role("button", name="下載 JSON 匯出檔").click()
    download = export_download.value
    assert re.match(r"^tasks-sheets-export-\d{8}-\d{6}\.json$", download.suggested_filename)
    file = download.path()

    # 匯出後在本機改動兩筆（本機較新）
    for t, title in [(a, f"{TITLE_A} 本機改"), (b, f"{TITLE_B} 本機改")]:
        res = page.request.patch(f"/api/tasks/{t['id']}", data={"title": title})
        assert res.status == 200

    # 匯入預覽：兩筆衝突
    page.get_by_label("選擇匯出檔").set_input_files(file)
    preview = page.get_by_label("匯入預覽")
    expect(preview).to_be_visible()
    expect(preview.locator('tr[data-category="tasks"] td').nth(4)).to_have_text("2")
    conflict_a = preview.locator(".dat-conflict", has_text=TITLE_A)
    conflict_b = preview.locator(".dat-conflict", has_text=TITLE_B)
    expect(conflict_a).to_be_visible()
    expect(conflict_a.get_by_text("本機較新")).to_be_visible()
    expect(conflict_a.get_by_role("cell", name=f"{TITLE_A} 本機改")).to_be_visible()

    # 全域 keep_local，A 逐筆改為 use_import
    preview.get_by_role("button", name="全域策略").click()
    page.get_by_role("option", name="保留本機").click()
    conflict_a.get_by_role("button", name=f"「{TITLE_A}」的處理方式").click()
    page.get_by_role("option", name="使用匯入檔").click()
    expect(conflict_b.get_by_role("button", name=f"「{TITLE_B}」的處理方式")).to_contain_text("依全域策略（保留本機）")

    preview.get_by_role("button", name="套用匯入").click()
    confirm = page.get_by_role("alertdialog", name="確定套用匯入？")
    expect(confirm).to_contain_text("有 1 筆採用匯入檔")
    confirm.get_by_role("button", name="套用").click()

    result = page.get_by_label("匯入結果")
    expect(result.get_by_text(re.compile(r"匯入完成：新增 0、更新 1"))).to_be_visible()
    expect(result.get_by_text(re.compile(r"pre-import-\d{8}-\d{6}\.db"))).to_be_visible()
    expect(result.locator('tr[data-category="tasks"] td').nth(2)).to_have_text("1")

    assert get_task(page.request, a["id"])["title"] == TITLE_A
    assert get_task(page.request, b["id"])["title"] == f"{TITLE_B} 本機改"

    result.get_by_role("button", name="完成").click()
    expect(page.get_by_text("尚未選擇檔案")).to_be_visible()

    # 清理本 spec 的任務
    page.request.delete(f"/api/tasks/{a['id']}")
    page.request.delete(f"/api/tasks/{b['id']}")
    # 登入前的 /api/auth/me 401 屬正常
    assert [e for e in errors if not re.search(r"status of 401", e)] == []
