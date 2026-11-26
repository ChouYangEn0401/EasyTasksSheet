"""realtime-feedback.spec.ts 的 Python 版：T9 雙瀏覽器即時同步、斷線重連、toast、他人變更提示、閒置提醒。"""

from __future__ import annotations

import json as _json
import re
import time
from urllib.parse import quote

import pytest
from playwright.sync_api import Browser, Page, expect

from .helpers import E2E_USERS, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# T9 feat/realtime-feedback：雙瀏覽器即時同步、斷線重連、toast、他人變更提示、閒置提醒
# （原檔 serial：pytest 同檔內本來就照順序跑）

# 產品目標：A 的變更在 B 2 秒內出現。E2E 的等待上限放寬為 5 秒，避免計時成為偶發來源；
# 2 秒目標僅在第一次新增處以「單次量測」記錄（annotation），不作為失敗條件。
SYNC = 5_000


def open_as(browser: Browser, base_url: str, user: dict, path: str) -> Page:
    context = browser.new_context(base_url=base_url)
    page = context.new_page()
    login_via_ui(page, user, path)
    return page


def row_of(page: Page, title: str):
    return page.locator(".tl-row--task", has_text=title)


def toasts(page: Page):
    return page.get_by_role("region", name="通知")


def create_task(page: Page, title: str) -> dict:
    res = page.request.post("/api/tasks", data={"title": title})
    assert res.ok
    return res.json()


def wait_live(a: Page, b: Page, P: str) -> None:
    """等 SSE 連上（伺服器 ready 後前端才開始接收）：以一筆暖身變更確認"""
    warm = create_task(a, f"{P} 暖身")
    expect(row_of(b, warm["title"])).to_be_visible(timeout=10_000)
    a.request.delete(f"/api/tasks/{warm['id']}")
    expect(row_of(b, warm["title"])).to_have_count(0, timeout=10_000)


def test_two_browsers_sync_and_sse_does_not_refresh_idle(browser: Browser, base_url: str, record_property):
    """雙瀏覽器：新增 / 修改 / 刪除 2 秒內同步；SSE 不刷新閒置計時"""
    P = f"T9-{int(time.time() * 1000)}"
    a = open_as(browser, base_url, E2E_USERS["admin"], f"/tasks/list?q={P}")
    b = open_as(browser, base_url, E2E_USERS["member"], f"/tasks/list?q={P}")
    wait_live(a, b, P)

    me_before = b.request.get("/api/auth/me").json()

    # A 以快速新增建立 → A 有成功 toast；B 2 秒內出現
    quick_add = a.get_by_role("textbox", name="快速新增任務")
    quick_add.fill(f"{P} 甲")
    t0 = time.time()
    quick_add.press("Enter")
    expect(toasts(a).get_by_text("已建立任務")).to_be_visible()
    expect(row_of(b, f"{P} 甲")).to_be_visible(timeout=SYNC)
    record_property("sync-latency-ms", str(int((time.time() - t0) * 1000)))

    # A 修改標題 → B 2 秒內更新
    created = a.request.get(f"/api/tasks?q={quote(f'{P} 甲', safe='')}").json()[0]
    a.request.patch(f"/api/tasks/{created['id']}", data={"title": f"{P} 甲改"})
    expect(row_of(b, f"{P} 甲改")).to_be_visible(timeout=SYNC)

    # A 刪除 → B 2 秒內移除
    a.request.delete(f"/api/tasks/{created['id']}")
    expect(row_of(b, f"{P} 甲改")).to_have_count(0, timeout=SYNC)

    # 整段期間 B 只有 GET（SSE、重抓）→ 閒置計時未被刷新
    me_after = b.request.get("/api/auth/me").json()
    assert me_after["session"]["lastActiveAt"] == me_before["session"]["lastActiveAt"]

    a.context.close()
    b.context.close()


def test_others_edit_or_delete_task_im_viewing(browser: Browser, base_url: str):
    """他人修改 / 刪除我正在看的任務：提示誰、改了什麼"""
    P = f"T9d-{int(time.time() * 1000)}"
    a = open_as(browser, base_url, E2E_USERS["admin"], f"/tasks/list?q={P}")
    task = create_task(a, f"{P} 抽屜")
    b = open_as(browser, base_url, E2E_USERS["member"], f"/tasks/list?q={P}&task={task['id']}")
    drawer = b.locator(".task-drawer")
    expect(drawer.get_by_text("建立於")).to_be_visible()
    expect(row_of(b, task["title"])).to_be_visible()

    statuses = a.request.get("/api/statuses").json()
    doing = next(s for s in statuses if s["name"] == "進行中")
    # 確認 SSE 已連上後再改（暖身變更）
    warm = create_task(a, f"{P} 暖身")
    expect(row_of(b, warm["title"])).to_be_visible(timeout=10_000)

    a.request.patch(f"/api/tasks/{task['id']}", data={"statusId": doing["id"], "dueDate": "2026-12-31"})
    notice = drawer.get_by_role("status").filter(has_text="管理員 剛更新了此任務")
    expect(notice).to_be_visible(timeout=SYNC)
    expect(notice).to_contain_text("狀態、到期日")

    a.request.delete(f"/api/tasks/{task['id']}")
    expect(drawer.get_by_text("此任務已被 管理員 刪除")).to_be_visible(timeout=SYNC)
    expect(toasts(b).get_by_text(f"管理員 刪除了「{task['title']}」")).to_be_visible()
    expect(row_of(b, task["title"])).to_have_count(0)
    drawer.get_by_role("button", name="關閉", exact=True).click()
    expect(drawer).to_have_count(0)

    a.context.close()
    b.context.close()


def test_sse_reconnect_after_offline(browser: Browser, base_url: str):
    """SSE 斷線自動重連：中斷提示、恢復後補上期間的變更"""
    P = f"T9o-{int(time.time() * 1000)}"
    a = open_as(browser, base_url, E2E_USERS["admin"], f"/tasks/list?q={P}")
    b = open_as(browser, base_url, E2E_USERS["member"], f"/tasks/list?q={P}")
    wait_live(a, b, P)

    b.context.set_offline(True)
    expect(toasts(b).get_by_text("即時更新中斷，正在重新連線…")).to_be_visible(timeout=15_000)
    missed = create_task(a, f"{P} 斷線期間")
    b.wait_for_timeout(500)
    expect(row_of(b, missed["title"])).to_have_count(0)

    b.context.set_offline(False)
    expect(toasts(b).get_by_text("已恢復即時更新")).to_be_visible(timeout=15_000)
    expect(row_of(b, missed["title"])).to_be_visible(timeout=5_000)

    # 恢復後仍即時
    after = create_task(a, f"{P} 恢復後")
    expect(row_of(b, after["title"])).to_be_visible(timeout=SYNC)

    a.context.close()
    b.context.close()


def test_write_failure_toast_and_rollback(page: Page):
    """寫入失敗：toast 並回復樂觀更新"""
    P = f"T9f-{int(time.time() * 1000)}"
    login_via_ui(page, E2E_USERS["admin"], f"/tasks/list?q={P}")
    task = create_task(page, f"{P} 標記")
    page.goto(f"/tasks/list?q={P}&task={task['id']}")
    drawer = page.locator(".task-drawer")
    expect(drawer.get_by_text("建立於")).to_be_visible()

    page.route(
        "**/api/personal/pins/*",
        lambda route: route.fulfill(
            status=500,
            content_type="application/json",
            body=_json.dumps({"error": {"code": "INTERNAL_ERROR", "message": "伺服器錯誤"}}),
        ),
    )
    drawer.get_by_role("button", name="加入我的標記").click()
    alert = toasts(page).get_by_role("alert").filter(has_text="無法儲存變更")
    expect(alert).to_be_visible()
    expect(alert).to_contain_text("已還原為先前的內容。")
    expect(drawer.get_by_role("button", name="加入我的標記")).to_be_visible()

    # 重試成功 → toast 關閉、標記生效
    page.unroute("**/api/personal/pins/*")
    alert.get_by_role("button", name="重試").click()
    expect(alert).to_have_count(0)
    expect(drawer.get_by_role("button", name="移出我的標記")).to_be_visible()


def test_reduced_motion_and_drawer(browser: Browser, base_url: str):
    """動畫尊重 prefers-reduced-motion；抽屜開合"""
    context = browser.new_context(base_url=base_url, reduced_motion="reduce")
    page = context.new_page()
    P = f"T9m-{int(time.time() * 1000)}"
    login_via_ui(page, E2E_USERS["admin"], f"/tasks/list?q={P}")
    task = create_task(page, f"{P} 動畫")
    expect(row_of(page, task["title"])).to_be_visible(timeout=10_000)
    duration = page.evaluate(
        "() => getComputedStyle(document.documentElement).getPropertyValue('--duration-base').trim()"
    )
    assert float(re.match(r"[-\d.]+", duration).group(0)) == 0  # 0ms（建置後可能正規化為 0s）
    page.goto(f"/tasks/list?q={P}&task={task['id']}")
    drawer = page.locator(".task-drawer")
    expect(drawer).to_be_visible()
    assert drawer.evaluate("(el) => getComputedStyle(el).animationName") == "none"
    page.keyboard.press("Escape")
    expect(drawer).to_have_count(0)
    context.close()


def test_idle_warning_five_minutes_before_logout(page: Page):
    """閒置登出前 5 分鐘提醒，可一鍵延續"""
    page.clock.install()
    login_via_ui(page, E2E_USERS["member"], "/")
    # 前端時鐘快轉 55 分鐘（伺服器端 session 仍有效）
    page.clock.fast_forward("55:30")
    dialog = page.get_by_role("alertdialog", name="即將自動登出")
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role("button", name="繼續使用")).to_be_focused()
    expect(dialog).to_contain_text(re.compile(r"4:\d\d"))
    # 提醒期間背景操作不算活動：Esc 不關閉
    page.keyboard.press("Escape")
    expect(dialog).to_be_visible()
    page.keyboard.press("Enter")
    expect(dialog).to_have_count(0)
    expect(page.get_by_role("navigation", name="主要導覽")).to_be_visible()
