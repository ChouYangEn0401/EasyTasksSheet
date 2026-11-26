"""sync-push.spec.ts 的 Python 版：多台電腦同步（docs/sync.md、docs/design/sync.md）——來源、金鑰、推送衝突、逐欄位決定。"""

from __future__ import annotations

import os
import random
import re
import time
from urllib.parse import quote

import pytest
from playwright.sync_api import APIRequestContext, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 多台電腦同步（docs/sync.md、docs/design/sync.md）：manager 建立來源 → 取得一次性金鑰 →
# 以該金鑰推送兩次製造一筆衝突 → 在「待確認衝突」並排比較、逐欄位選擇 → 套用後任務資料正確。
# SYNC_SHOT_DIR 有設定時另存截圖（1280 / 768）。
# （原檔 serial：pytest 同檔內本來就照順序跑）

_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def _base36(n: int) -> str:
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = _B36[r] + out
    return out or "0"


stamp = _base36(int(time.time() * 1000))
SOURCE_NAME = f"E2E 筆電 {stamp}"
TITLE = f"E2E 同步任務 {stamp}"


def uid(p: str) -> str:
    return f"{p}{stamp}{''.join(random.choice(_B36) for _ in range(8))}"[:40]


TASK_UID = uid("t")
STATUS_UID = uid("s")
PROJECT_UID = uid("p")
SHOT_DIR = os.environ.get("SYNC_SHOT_DIR")


def now_ms() -> int:
    return int(time.time() * 1000)


def shot(page: Page, name: str) -> None:
    if not SHOT_DIR:
        return
    for width in [1280, 768]:
        page.set_viewport_size({"width": width, "height": 900})
        page.wait_for_timeout(150)
        page.screenshot(path=f"{SHOT_DIR}/{name}-{width}.png", full_page=True)
    page.set_viewport_size({"width": 1280, "height": 720})


def push_doc(task: dict) -> dict:
    now = now_ms()
    return {
        "format": "tasks-sheets-export",
        "schemaVersion": 1,
        "exportedAt": now,
        "source": {"machineName": "e2e-laptop", "exportedAt": now, "since": None, "pushId": uid("push")},
        "incremental": False,
        "batch": {"index": 0, "total": 1},
        "users": [],
        # 狀態 / 專案以名稱對應中央預設資料；updatedAt 極舊 → 中央較新，不會改到中央
        "statuses": [
            {
                "uid": STATUS_UID,
                "name": "待辦",
                "color": "gray",
                "category": "todo",
                "sortOrder": 1,
                "createdAt": 0,
                "updatedAt": 0,
            }
        ],
        "projects": [
            {
                "uid": PROJECT_UID,
                "name": "預設專案",
                "color": "blue",
                "isArchived": False,
                "sortOrder": 1,
                "createdAt": 0,
                "updatedAt": 0,
            }
        ],
        "tasks": [
            {
                "uid": TASK_UID,
                "projectUid": PROJECT_UID,
                "statusUid": STATUS_UID,
                "title": task["title"],
                "description": task["description"],
                "assigneeUsername": None,
                "priority": task["priority"],
                "startDate": None,
                "dueDate": None,
                "estimateHours": None,
                "progress": 0,
                "sortOrder": 1,
                "custom": {},
                "createdByUsername": None,
                "updatedByUsername": None,
                "createdAt": now,
                "updatedAt": task["updatedAt"],
                "completedAt": None,
                "deletedAt": None,
            }
        ],
    }


def push(request: APIRequestContext, token: str, doc: dict) -> dict:
    res = request.post("/api/sync/push", data=doc, headers={"Authorization": f"Bearer {token}"})
    assert res.status == 200, res.text()
    return res.json()


def find_task(request: APIRequestContext) -> dict:
    res = request.get(f"/api/tasks?q={quote(stamp, safe='')}")
    lst = res.json()
    t = next(
        (x for x in lst if stamp in x["title"] or "中央標題" in x["title"] or "上傳標題" in x["title"]),
        None,
    )
    assert t
    return t


def test_member_has_no_sync(page: Page):
    """一般成員：導覽沒有「資料同步」，頁面與 API 一律拒絕"""
    login_via_ui(page, E2E_USERS["member"])
    expect(page.get_by_role("navigation", name="主要導覽").get_by_text("資料同步")).to_have_count(0)
    page.goto("/admin/data/sync")
    expect(page.get_by_text("沒有權限")).to_be_visible()
    assert page.request.get("/api/admin/sync/sources").status == 403
    assert page.request.get("/api/admin/sync/conflicts").status == 403


def test_manager_sync_conflict_field_merge(page: Page):
    """管理者：建立來源 → 一次性金鑰 → 推送製造衝突 → 逐欄位決定 → 任務資料正確"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["manager"])
    page.get_by_role("navigation", name="主要導覽").get_by_role("link", name="資料同步").click()
    expect(page).to_have_url(re.compile(r"/admin/data/sync$"))
    expect(page.get_by_role("tab", name="同步來源")).to_have_attribute("aria-selected", "true")

    # 建立來源
    page.get_by_role("button", name="新增同步來源").click()
    create = page.get_by_role("dialog", name="新增同步來源")
    create.get_by_label("名稱").fill(SOURCE_NAME)
    create.get_by_role("button", name="建立並產生金鑰").click()
    token_dialog = page.get_by_role("alertdialog", name=f"已建立「{SOURCE_NAME}」")
    expect(token_dialog.get_by_text("金鑰只會顯示這一次")).to_be_visible()
    token = (token_dialog.get_by_label("同步金鑰").text_content() or "").strip()
    assert re.match(r"^tss_", token)
    expect(token_dialog.get_by_label("上傳命令")).to_contain_text("sync-push --server")
    expect(token_dialog.get_by_label("上傳命令")).to_contain_text(token)
    shot(page, "token-dialog")
    token_dialog.get_by_role("button", name="我已妥善保存").click()
    row = page.locator("tr", has_text=SOURCE_NAME)
    expect(row).to_contain_text("尚未同步")
    expect(row).to_contain_text("啟用中")

    # 第一次推送：新增任務
    first = push(
        page.request,
        token,
        push_doc({"title": TITLE, "description": "原說明", "priority": "none", "updatedAt": now_ms() - 60 * 60_000}),
    )
    assert first["totals"]["created"] == 1
    task = find_task(page.request)

    # 中央修改，接著本機也修改（幾乎同時）→ 衝突
    patched = page.request.patch(
        f"/api/tasks/{task['id']}", data={"title": f"中央標題 {stamp}", "description": "中央說明"}
    )
    assert patched.status == 200
    second = push(
        page.request,
        token,
        push_doc({"title": f"上傳標題 {stamp}", "description": "上傳說明", "priority": "high", "updatedAt": now_ms()}),
    )
    assert second["totals"]["conflict"] == 1

    page.reload()
    expect(row).to_contain_text("衝突 1")
    shot(page, "sources")

    # 待確認衝突
    conflicts_tab = page.get_by_role("tab", name=re.compile(r"待確認衝突"))
    expect(conflicts_tab).to_contain_text(re.compile(r"\d+"))
    conflicts_tab.click()
    item = page.locator("tr", has_text=f"中央標題 {stamp}").or_(page.locator("tr", has_text=f"上傳標題 {stamp}"))
    expect(item.first).to_be_visible()
    expect(item.first).to_contain_text(SOURCE_NAME)
    expect(item.first).to_contain_text(re.compile(r"差"))
    shot(page, "conflicts")
    item.first.get_by_role("button", name=re.compile(r"比較")).click()

    # 並排比較：只列出不同的欄位，逐欄位選擇
    compare = page.get_by_role("region", name="並排比較")
    expect(compare.get_by_text("這筆資料兩邊幾乎同時被修改")).to_be_visible()
    expect(compare.locator("tr[data-field]")).to_have_count(3)
    expect(compare.locator('tr[data-field="title"]')).to_contain_text(f"中央標題 {stamp}")
    expect(compare.locator('tr[data-field="title"]')).to_contain_text(f"上傳標題 {stamp}")
    compare.get_by_label("標題：採用上傳").check()
    compare.get_by_label("優先度：採用上傳").check()
    expect(compare.get_by_label("描述：保留中央")).to_be_checked()
    expect(compare.get_by_text("將採用上傳的 2 個欄位，其餘保留中央")).to_be_visible()
    shot(page, "compare")
    compare.get_by_role("button", name="套用決定").click()
    expect(page.get_by_text(re.compile(r"已處理（逐欄位合併）"))).to_be_visible()

    after = page.request.get(f"/api/tasks/{task['id']}").json()
    assert after["title"] == f"上傳標題 {stamp}"
    assert after["description"] == "中央說明"
    assert after["priority"] == "high"

    # 已處理紀錄
    page.get_by_role("button", name="已處理紀錄").click()
    done = page.locator("tr", has_text=f"上傳標題 {stamp}")
    expect(done).to_contain_text("逐欄位合併")
    expect(done).to_contain_text(E2E_USERS["manager"]["display_name"])

    # 重送同一份不再產生衝突
    again = push(
        page.request,
        token,
        push_doc({"title": f"上傳標題 {stamp}", "description": "上傳說明", "priority": "high", "updatedAt": now_ms()}),
    )
    assert again["totals"]["conflict"] == 0
    assert [e for e in errors if not re.search(r"status of 401", e)] == []
