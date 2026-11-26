"""gantt-overview.spec.ts 的 Python 版：總覽（無任務成員排前並標示、近三週）與 Gantt（刻度、今日線、未排程、拖曳改日期）。"""

from __future__ import annotations

import datetime as _dt
import json as _json
import re
import time
from urllib.parse import urlparse

import pytest
from playwright.sync_api import Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# feat/gantt-overview：總覽（目前無任務者排前且明顯標示）→ Gantt（刻度切換、今日線、未排程、排入日期、拖曳改日期、開啟詳情）
# （原檔 serial：pytest 同檔內本來就照順序跑）


def day(offset: int) -> str:
    return (_dt.date.today() + _dt.timedelta(days=offset)).isoformat()


def api(page: Page, method: str, path: str, body=None):
    u = urlparse(page.url)
    origin = f"{u.scheme}://{u.netloc}"
    res = page.request.fetch(
        f"{origin}{path}",
        method=method,
        headers={"content-type": "application/json", "origin": origin},
        data=None if body is None else _json.dumps(body),
    )
    assert res.ok, f"{method} {path} → {res.status}"
    return res.json()


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


suffix = _base36(int(time.time() * 1000))
SCHEDULED = f"甘特排程 {suffix}"
UNSCHEDULED = f"未排程 {suffix}"


def test_overview_idle_first_and_gantt(page: Page):
    """總覽：目前無任務的成員排前並標示；Gantt：刻度、今日線、未排程、拖曳改日期"""
    login_via_ui(page, E2E_USERS["admin"], "/")
    # 登入前的 401（/api/auth/me 探測）屬預期，之後不得再有 console error
    errors = collect_errors(page)

    users = api(page, "GET", "/api/users")
    # 總覽預設不列入 root（admin），改以列入統計的 manager 帳號當負責人
    admin = next(u for u in users if u["username"] == E2E_USERS["manager"]["username"])
    member = next(u for u in users if u["username"] == E2E_USERS["member"]["username"])

    scheduled = api(
        page,
        "POST",
        "/api/tasks",
        {
            "title": SCHEDULED,
            "statusId": 2,  # 進行中
            "assigneeId": admin["id"],
            "startDate": day(-2),
            "dueDate": day(5),
            "progress": 40,
            "estimateHours": 6,
        },
    )
    unscheduled = api(page, "POST", "/api/tasks", {"title": UNSCHEDULED})

    # ── 總覽 ──
    page.goto("/")
    member_card = page.get_by_test_id(f"member-card-{member['id']}")
    admin_card = page.get_by_test_id(f"member-card-{admin['id']}")
    expect(member_card).to_be_visible()
    expect(member_card.get_by_text("目前無任務", exact=True)).to_be_visible()
    expect(member_card.get_by_text("沒有進行中的任務")).to_be_visible()
    expect(admin_card.get_by_role("button", name=SCHEDULED)).to_be_visible()
    expect(admin_card.get_by_text("目前無任務", exact=True)).to_have_count(0)
    # 「目前無任務」區段在「進行中」區段之前，且成員卡在前者內
    idle_section = page.locator("#overview-idle")
    expect(idle_section.get_by_test_id(f"member-card-{member['id']}")).to_be_visible()
    cards = page.locator('[data-testid^="member-card-"]')
    order = cards.evaluate_all("(els) => els.map((e) => e.getAttribute('data-testid'))")
    assert order.index(f"member-card-{member['id']}") < order.index(f"member-card-{admin['id']}")
    expect(page.get_by_test_id("stat-idle")).to_contain_text("目前無任務")
    # 精簡 Gantt 顯示進行中任務的長條（唯讀，無把手）
    expect(page.get_by_test_id(f"gantt-bar-{scheduled['id']}")).to_be_visible()
    expect(page.get_by_test_id(f"gantt-handle-end-{scheduled['id']}")).to_have_count(0)
    # 卡片上的任務可開啟詳情
    admin_card.get_by_role("button", name=SCHEDULED).click()
    expect(page).to_have_url(re.compile(f"[?&]task={scheduled['id']}"))

    # ── Gantt ──
    page.goto("/tasks/gantt?scale=week")
    bar = page.get_by_test_id(f"gantt-bar-{scheduled['id']}")
    expect(bar).to_be_visible()
    # 週刻度 8 天 = 128px：標題在條內
    expect(bar.locator(".gantt-bar-label--in")).to_contain_text(SCHEDULED)
    # 今天膠囊與刻度文字並排（不蓋住刻度）、今日線一條
    expect(page.locator(".gantt-head-cell.is-today .gantt-today-chip")).to_have_text("今天")
    expect(page.locator(".gantt-head-cell.is-today .gantt-head-label")).to_be_visible()
    expect(page.locator(".gantt-today-line")).to_have_count(1)
    # 左欄：無「更新」欄，改為起訖日期區間
    expect(page.locator(".gantt-head-corner")).to_have_text(re.compile(r"任務\s*起訖"))
    row = page.locator(f'[data-row-key="t{scheduled["id"]}"]')
    expect(row.locator(".gantt-task-dates")).to_be_visible()
    expect(row.locator(".ui-updated-at")).to_have_count(0)
    # 時間軸填滿容器寬
    fill = page.locator(".gantt-scroll").evaluate("(el) => el.scrollWidth >= el.clientWidth")
    assert fill

    # 刻度切換
    scale_group = page.get_by_role("group", name="時間刻度")
    for label, scale in [("月", "month"), ("週", "week"), ("日", "day")]:
        scale_group.get_by_role("button", name=label).click()
        expect(page).to_have_url(re.compile(f"scale={scale}"))
        expect(scale_group.get_by_role("button", name=label)).to_have_attribute("aria-pressed", "true")
        expect(bar).to_be_visible()
    # 手動切換的刻度記在 localStorage：不帶 scale 參數重新進頁仍為日刻度
    page.goto("/tasks/gantt")
    expect(scale_group.get_by_role("button", name="日")).to_have_attribute("aria-pressed", "true")
    expect(bar).to_be_visible()

    # 未排程區：沒有日期的任務不會消失，可排入日期（開始日與到期日預填今天）
    unscheduled_row = page.get_by_test_id(f"unscheduled-{unscheduled['id']}")
    expect(page.get_by_role("button", name=re.compile(r"^未排程\s*\d+$"))).to_be_visible()
    expect(unscheduled_row).to_contain_text(UNSCHEDULED)
    unscheduled_row.get_by_role("button", name="排入日期").click()
    dialog = page.get_by_role("dialog", name=f"設定「{UNSCHEDULED}」的日期")
    expect(dialog.get_by_label("開始日")).to_have_value(day(0))
    expect(dialog.get_by_label("到期日")).to_have_value(day(0))
    dialog.get_by_label("開始日").fill(day(3))
    dialog.get_by_label("到期日").fill(day(1))
    expect(dialog.get_by_text("到期日不可早於開始日")).to_be_visible()
    expect(dialog.get_by_role("button", name="儲存")).to_be_disabled()
    dialog.get_by_label("到期日").fill(day(4))
    dialog.get_by_role("button", name="儲存").click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_test_id(f"gantt-bar-{unscheduled['id']}")).to_be_visible()
    expect(unscheduled_row).to_have_count(0)

    # 日刻度下拖曳長條本體 +2 天（每日 32px）
    bar.scroll_into_view_if_needed()
    box = bar.bounding_box()
    x = box["x"] + box["width"] / 2
    y = box["y"] + box["height"] / 2

    def is_patch(r):
        return r.url.endswith(f"/api/tasks/{scheduled['id']}") and r.request.method == "PATCH"

    with page.expect_response(is_patch) as patched:
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + 20, y, steps=4)
        page.mouse.move(x + 64, y, steps=6)
        expect(page.get_by_role("status").filter(has_text="→")).to_contain_text("（8 天）")
        page.mouse.up()
    assert patched.value.status == 200
    after = api(page, "GET", f"/api/tasks/{scheduled['id']}")
    assert after["startDate"] == day(0)
    assert after["dueDate"] == day(7)

    # 拖右把手：只改到期日
    box2 = page.get_by_test_id(f"gantt-handle-end-{scheduled['id']}").bounding_box()
    with page.expect_response(is_patch):
        page.mouse.move(box2["x"] + box2["width"] / 2, box2["y"] + box2["height"] / 2)
        page.mouse.down()
        page.mouse.move(box2["x"] + 3 + 32, box2["y"] + box2["height"] / 2, steps=6)
        page.mouse.up()
    after2 = api(page, "GET", f"/api/tasks/{scheduled['id']}")
    assert after2["startDate"] == day(0)
    assert after2["dueDate"] == day(8)

    # 分組切換
    page.get_by_role("button", name="分組").click()
    page.get_by_role("option", name="分組：專案").click()
    expect(page).to_have_url(re.compile(r"group=project"))
    expect(page.get_by_role("treeitem", name=re.compile(r"預設專案"))).to_be_visible()

    # 點擊長條開啟任務詳情
    page.get_by_test_id(f"gantt-bar-{unscheduled['id']}").click()
    expect(page).to_have_url(re.compile(f"[?&]task={unscheduled['id']}"))

    assert errors == []


def test_overview_three_weeks(page: Page):
    """總覽：近三週（迷你直條、Tooltip、展開詳情、有估時才顯示工時）"""
    login_via_ui(page, E2E_USERS["admin"], "/")
    errors = collect_errors(page)

    users = api(page, "GET", "/api/users")
    # 總覽預設不列入 root（admin），改以列入統計的 manager 帳號當負責人
    admin = next(u for u in users if u["username"] == E2E_USERS["manager"]["username"])
    DONE_EST = f"近三週有估時 {suffix}"
    DONE_NO_EST = f"近三週沒估時 {suffix}"
    done1 = api(
        page,
        "POST",
        "/api/tasks",
        {"title": DONE_EST, "statusId": 4, "assigneeId": admin["id"], "estimateHours": 3},  # 完成
    )
    api(page, "POST", "/api/tasks", {"title": DONE_NO_EST, "statusId": 4, "assigneeId": admin["id"]})

    activity = api(page, "GET", "/api/overview/activity")
    assert [w["current"] for w in activity["weeks"]] == [False, False, True]
    mine = next(m for m in activity["members"] if m["userId"] == admin["id"])["weeks"][2]
    assert mine["completed"] >= 2
    assert mine["hoursKnown"] >= 1

    page.goto("/")
    # 全隊合計：中性呈現
    team = page.get_by_test_id("team-weeks")
    expect(team).to_contain_text("近三週團隊進展")
    expect(team).to_contain_text("本週")

    admin_card = page.get_by_test_id(f"member-card-{admin['id']}")
    toggle = admin_card.get_by_role("button", name=re.compile(r"^近三週："))
    expect(toggle).to_be_visible()
    expect(admin_card.locator(".ov-bar")).to_have_count(3)
    expect(toggle).to_contain_text(re.compile(r"完成 \d+・處理 \d+"))
    # 鍵盤 focus 顯示 Tooltip（緩和語氣）
    toggle.focus()
    page.keyboard.press("Shift+Tab")
    page.keyboard.press("Tab")
    expect(page.get_by_role("tooltip")).to_contain_text(re.compile(r"本週：完成 \d+ 件、處理 \d+ 件"))

    # 展開詳情（鍵盤可操作）：預設本週
    page.keyboard.press("Enter")
    expect(toggle).to_have_attribute("aria-expanded", "true")
    panel = admin_card.get_by_role("region", name=re.compile(r"近三週的任務"))
    expect(panel.get_by_role("button", name="本週")).to_have_attribute("aria-pressed", "true")
    expect(panel.get_by_role("button", name=DONE_EST)).to_be_visible()
    expect(panel.get_by_role("button", name=DONE_NO_EST)).to_be_visible()
    expect(panel).to_contain_text(re.compile(r"預估工時約 [\d.]+ 小時（\d+ 件有填估時）"))
    # 前週沒有紀錄：說「這週沒有紀錄」，且不顯示工時
    panel.get_by_role("button", name="前週").click()
    expect(panel).to_contain_text("這週沒有紀錄")
    expect(panel).not_to_contain_text("預估工時")
    # 不出現排名 / 落後字眼
    expect(page.locator(".ov-page")).not_to_contain_text(re.compile(r"排名|落後|最少|沒做事"))
    # 任務可開啟詳情
    panel.get_by_role("button", name="本週").click()
    panel.get_by_role("button", name=DONE_EST).click()
    expect(page).to_have_url(re.compile(f"[?&]task={done1['id']}"))

    assert errors == []
