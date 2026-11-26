"""personal-report.spec.ts 的 Python 版：個人頁「匯報報告」（預覽、取消勾選、複製、下載 .md / .csv、上週空狀態、768、他人）。"""

from __future__ import annotations

import re
import time
from pathlib import Path

import pytest
from playwright.sync_api import Browser, BrowserContext, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 個人頁「匯報報告」：完成任務 / 待辦 → 選本週 → 預覽 → 取消勾選 → 複製 → 下載 .md；上週無資料 → 空狀態
# （原檔 serial：pytest 同檔內本來就照順序跑）

# 原檔即寫死此 Windows 路徑（逐字照搬）
SHOTS = (
    "C:\\Users\\629\\AppData\\Local\\Temp\\claude\\e7fe0c0dcc39054e\\13d96097-8b6c-4c25-a5d3-fc64b31cc29f\\scratchpad\\report"
)
stamp = int(time.time() * 1000)
T1 = f"報告任務甲-{stamp}"
T2 = f"報告任務乙-{stamp}"
D1 = f"報告待辦甲-{stamp}"
D2 = f"報告待辦乙-{stamp}"
json = {"Content-Type": "application/json"}
task_ids: list[int] = []
todo_ids: list[int] = []


def seed(page: Page) -> None:
    me = page.request.get("/api/auth/me").json()
    for title in [T1, T2]:
        res = page.request.post(
            "/api/tasks",
            headers=json,
            data={"title": title, "statusId": 4, "assigneeId": me["user"]["id"], "estimateHours": 2},
        )
        assert res.status == 201
        task_ids.append(res.json()["id"])
    for title in [D1, D2]:
        todo = page.request.post("/api/personal", headers=json, data={"title": title}).json()
        todo_ids.append(todo["id"])
        res = page.request.patch(f"/api/personal/{todo['id']}", headers=json, data={"isDone": True})
        assert res.ok is True


@pytest.fixture(scope="module", autouse=True)
def _cleanup_after_all(browser: Browser, base_url: str):
    """清除自己建立的資料：其他 spec（personal.spec）假設成員的自由待辦清單原本是空的（對應 test.afterAll）"""
    yield
    ctx = browser.new_context(base_url=base_url)
    page = ctx.new_page()
    try:
        login_via_ui(page, E2E_USERS["member"], "/me")
        for i in todo_ids:
            page.request.delete(f"/api/personal/{i}")
        for i in task_ids:
            page.request.delete(f"/api/tasks/{i}")
    finally:
        ctx.close()


def _width(page: Page) -> int:
    vs = page.viewport_size
    return vs["width"] if vs else 0


def test_report_preview_copy_download_empty(page: Page, context: BrowserContext):
    """匯報報告：預覽、取消勾選、複製、下載 .md、上週空狀態"""
    Path(SHOTS).mkdir(parents=True, exist_ok=True)
    context.grant_permissions(["clipboard-read", "clipboard-write"])
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["member"], "/me")
    seed(page)
    page.goto("/me")

    page.get_by_role("button", name="產生匯報報告").click()
    dialog = page.get_by_role("dialog", name="匯報報告")
    expect(dialog).to_be_visible()
    expect(dialog.get_by_label("快速區間")).to_have_value("week")
    for t in [T1, T2, D1, D2]:
        expect(dialog.get_by_text(t, exact=True)).to_be_visible()
    expect(dialog.get_by_test_id("report-summary")).to_contain_text("完成任務")
    page.wait_for_timeout(400)  # 等對話框淡入完成
    page.screenshot(path=f"{SHOTS}\\preview-{_width(page)}.png")

    # 取消勾選任務乙：彙總與輸出同步更新
    dialog.get_by_role("checkbox", name=f"納入：{T2}").uncheck()
    dialog.get_by_role("tab", name="可編輯文字").click()
    area = dialog.get_by_role("textbox", name="可編輯文字")
    expect(area).to_have_value(re.compile(re.escape(T1)))
    expect(area).not_to_have_value(re.compile(re.escape(T2)))
    expect(area).to_have_value(re.compile(r"匯報報告"))
    dialog.get_by_role("tab", name="預覽").click()

    # 複製（剪貼簿）
    dialog.get_by_role("button", name="複製", exact=True).click()
    expect(page.get_by_text("已複製到剪貼簿")).to_be_visible()
    clip = page.evaluate("() => navigator.clipboard.readText()")
    assert T1 in clip
    assert D1 in clip
    assert T2 not in clip

    # Markdown 格式 + 下載 .md
    dialog.get_by_label("輸出格式").select_option("markdown")
    dialog.get_by_role("tab", name="可編輯文字").click()
    expect(area).to_have_value(re.compile(r"^# 匯報報告"))
    page.wait_for_timeout(400)  # 等對話框淡入完成
    page.screenshot(path=f"{SHOTS}\\format-{_width(page)}.png")
    with page.expect_download() as dl:
        dialog.get_by_role("button", name="下載 .md").click()
    file = dl.value
    assert re.match(r"^匯報報告_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.md$", file.suggested_filename)
    text = Path(file.path()).read_text(encoding="utf-8")
    assert "# 匯報報告" in text
    assert T1 in text
    assert D2 in text
    assert T2 not in text

    # CSV 下載：UTF-8 BOM
    with page.expect_download() as csv_dl:
        dialog.get_by_role("button", name="下載 .csv").click()
    csv = Path(csv_dl.value.path()).read_bytes()
    assert csv[:3] == bytes([0xEF, 0xBB, 0xBF])
    assert T1 in csv.decode("utf-8")

    # 上週：沒有紀錄
    dialog.get_by_label("快速區間").select_option("lastWeek")
    dialog.get_by_role("tab", name="預覽").click()
    expect(dialog.get_by_text("這段期間沒有紀錄").first).to_be_visible()
    page.wait_for_timeout(400)  # 等對話框淡入完成
    page.screenshot(path=f"{SHOTS}\\empty-{_width(page)}.png")

    # 選項記憶：重新整理後仍為上週
    page.keyboard.press("Escape")
    expect(dialog).to_be_hidden()
    page.reload()
    page.get_by_role("button", name="產生匯報報告").click()
    expect(page.get_by_role("dialog", name="匯報報告").get_by_label("快速區間")).to_have_value("lastWeek")
    assert [e for e in errors if not re.search(r"401", e)] == []


def test_report_768_and_other_member(page: Page):
    """匯報報告：768px 版面與檢視他人成員"""
    page.set_viewport_size({"width": 768, "height": 900})
    login_via_ui(page, E2E_USERS["member"], "/me")
    page.get_by_role("button", name="產生匯報報告").click()
    dialog = page.get_by_role("dialog", name="匯報報告")
    expect(dialog.get_by_test_id("report-summary")).to_be_visible()
    expect(dialog.get_by_text(T1, exact=True)).to_be_visible()
    page.wait_for_timeout(400)  # 等對話框淡入完成
    page.screenshot(path=f"{SHOTS}\\preview-768.png")
    dialog.get_by_role("tab", name="可編輯文字").click()
    page.wait_for_timeout(400)  # 等對話框淡入完成
    page.screenshot(path=f"{SHOTS}\\format-768.png")
    page.keyboard.press("Escape")

    # 他人：標題標示成員名稱（唯讀資料）
    users = page.request.get("/api/users").json()
    peer = next(u for u in users if u["username"] == E2E_USERS["peer"]["username"])
    page.goto(f"/me?user={peer['id']}")
    page.get_by_role("button", name="產生匯報報告").click()
    expect(page.get_by_role("dialog", name=f"匯報報告：{E2E_USERS['peer']['display_name']}")).to_be_visible()
    expect(page.get_by_role("dialog").get_by_text(T1, exact=True)).to_have_count(0)
