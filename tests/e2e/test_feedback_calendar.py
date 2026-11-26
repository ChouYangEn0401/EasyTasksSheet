"""feedback-calendar.spec.ts 的 Python 版：T4 問題 / 回饋 + 月曆（新增、篩選、拖曳排程、改期、換月、編輯、解決、刪除）。"""

from __future__ import annotations

import os
import re
import time

import pytest
from playwright.sync_api import Locator, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# T4 問題 / 回饋 + 月曆：新增、篩選、拖到某天排程、改期、拖回清單、月份切換、重整保留、編輯、解決、刪除
# （原檔 serial：pytest 同檔內本來就照順序跑）

_UNSET = object()


def _poll(fn, expected=_UNSET, *, pred=None, timeout_ms: int = 5000):
    """對應 expect.poll(fn)：重試直到等於 expected（或 pred 成立）。"""
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        value = fn()
        ok = pred(value) if pred is not None else value == expected
        if ok:
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"poll 逾時：期望 {expected!r}，實際 {value!r}")
        time.sleep(0.1)


def pad(n: int) -> str:
    return str(n).zfill(2)


def page_today(page: Page) -> str:
    """頁面（瀏覽器）實際的「今天」YYYY-MM-DD；月曆以瀏覽器本地日期決定本月"""
    return page.evaluate(
        """() => {
            const d = new Date();
            const p = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        }"""
    )


def months_of(today_key: str) -> dict:
    """由「今天」推出本月 / 下月與測試用日期（固定取 10、20 日，與今天是月初或月底無關）"""
    y, m = (int(x) for x in today_key.split("-")[:2])
    month_key = f"{y}-{pad(m)}"
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)  # 下個月 1 日
    next_month_key = f"{ny}-{pad(nm)}"
    return {
        "month_key": month_key,
        "heading": f"{y} 年 {m} 月",
        "next_month_key": next_month_key,
        "next_heading": f"{ny} 年 {nm} 月",
        "DAY_A": f"{month_key}-10",
        "DAY_B": f"{month_key}-20",
    }


def find_item(page: Page, title: str) -> dict:
    res = page.request.get("/api/feedback")
    item = next((i for i in res.json() if i["title"] == title), None)
    assert item, title
    return item


def drag(page: Page, source: Locator, target: Locator) -> None:
    """以滑鼠拖曳（dnd-kit PointerSensor 需移動超過 6px 才啟動）"""
    s = source.bounding_box()
    t = target.bounding_box()
    page.mouse.move(s["x"] + s["width"] / 2, s["y"] + s["height"] / 2)
    page.mouse.down()
    page.mouse.move(s["x"] + s["width"] / 2 + 12, s["y"] + s["height"] / 2 + 12, steps=4)
    page.mouse.move(t["x"] + t["width"] / 2, t["y"] + t["height"] / 2, steps=15)
    page.mouse.up()
    # 等放下動畫結束（動畫期間不會啟動下一次拖曳）
    expect(page.locator(".fb-card--overlay, .cal-chip--overlay")).to_have_count(0)


def cell(page: Page, date: str) -> Locator:
    return page.locator(f'[role="gridcell"][data-date="{date}"]')


def test_feedback_full_flow(page: Page):
    """問題回饋：新增 → 篩選 → 拖曳排程 / 改期 / 取消 → 換月 → 重整保留 → 編輯 → 解決 → 刪除"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["member"], "/feedback")
    expect(page).to_have_url(re.compile(r"/feedback$"))

    lst = page.get_by_role("region", name="問題與回饋清單")
    calendar = page.get_by_role("region", name="月曆")
    expect(calendar.get_by_role("grid")).to_be_visible()
    mo = months_of(page_today(page))
    month_key, heading = mo["month_key"], mo["heading"]
    next_month_key, next_heading = mo["next_month_key"], mo["next_heading"]
    DAY_A, DAY_B = mo["DAY_A"], mo["DAY_B"]
    expect(calendar.get_by_role("heading")).to_have_text(heading)

    # 新增：Enter 建立後清空並保持 focus，可連續新增
    stamp = int(time.time() * 1000)
    problem = f"E2E 離心機溫度異常 {stamp}"
    feedback = f"E2E 週報格式建議 {stamp}"
    page.locator("#main").click(position={"x": 5, "y": 5})
    page.keyboard.press("c")
    inp = page.get_by_role("textbox", name="新增問題或回饋")
    expect(inp).to_be_focused()
    inp.fill(problem)
    inp.press("Enter")
    expect(lst.get_by_text("已建立")).to_be_visible()
    expect(inp).to_have_value("")
    expect(inp).to_be_focused()
    page.get_by_role("button", name="類型").click()
    page.get_by_role("option", name="回饋").click()
    inp.fill(feedback)
    inp.press("Enter")
    expect(inp).to_have_value("")

    p = find_item(page, problem)
    f = find_item(page, feedback)
    assert p["status"] == "open" and p["scheduledDate"] is None
    p_card = page.get_by_test_id(f"fb-card-{p['id']}")
    f_card = page.get_by_test_id(f"fb-card-{f['id']}")
    expect(p_card).to_be_visible()
    expect(f_card).to_be_visible()
    expect(p_card.get_by_text("問題", exact=True)).to_be_visible()
    expect(f_card.get_by_text("回饋", exact=True)).to_be_visible()
    expect(p_card.locator("time")).to_have_text("剛剛")

    # 篩選：類型（URL 驅動）
    lst.get_by_role("radio", name="問題").click()
    expect(page).to_have_url(re.compile(r"kind=problem"))
    expect(f_card).to_have_count(0)
    expect(p_card).to_be_visible()
    lst.get_by_role("button", name="清除", exact=True).click()
    expect(page).not_to_have_url(re.compile(r"kind="))
    expect(f_card).to_be_visible()

    # 拖到某天 → 已排程
    drag(page, p_card, cell(page, DAY_A))
    chip = page.get_by_test_id(f"cal-chip-{p['id']}")
    expect(cell(page, DAY_A).get_by_test_id(f"cal-chip-{p['id']}")).to_be_visible()
    _poll(lambda: find_item(page, problem)["scheduledDate"], DAY_A)
    assert find_item(page, problem)["status"] == "scheduled"
    expect(lst.get_by_role("region", name="已排程").get_by_test_id(f"fb-card-{p['id']}")).to_be_visible()

    # 日期間拖曳改期
    drag(page, cell(page, DAY_A).get_by_test_id(f"cal-chip-{p['id']}"), cell(page, DAY_B))
    expect(cell(page, DAY_B).get_by_test_id(f"cal-chip-{p['id']}")).to_be_visible()
    _poll(lambda: find_item(page, problem)["scheduledDate"], DAY_B)

    # 狀態篩選同時作用於月曆
    lst.get_by_role("button", name="狀態篩選").click()
    page.get_by_role("option", name="未排程").click()
    page.keyboard.press("Escape")
    expect(page).to_have_url(re.compile(r"status=open"))
    expect(chip).to_have_count(0)
    lst.get_by_role("button", name="清除", exact=True).click()
    expect(chip).to_be_visible()

    # 月份切換、回今天（month 存 URL）
    today = calendar.get_by_role("button", name="今天")
    expect(today).to_be_disabled()
    calendar.get_by_role("button", name="下個月").click()
    expect(page).to_have_url(re.compile(f"month={next_month_key}"))
    expect(calendar.get_by_role("heading")).to_have_text(next_heading)
    expect(today).to_be_enabled()
    # 重整後保留月份
    page.reload()
    expect(calendar.get_by_role("heading")).to_have_text(next_heading)
    today.click()
    expect(page).to_have_url(re.compile(f"month={month_key}"))
    expect(calendar.get_by_role("heading")).to_have_text(heading)

    # 重整後排程保留
    page.reload()
    expect(cell(page, DAY_B).get_by_test_id(f"cal-chip-{p['id']}")).to_be_visible()

    # 拖回清單 → 取消排程
    drag(page, chip, lst)
    expect(chip).to_have_count(0)
    _poll(lambda: find_item(page, problem)["status"], "open")
    assert find_item(page, problem)["scheduledDate"] is None

    # 非拖曳路徑：S 開啟「排入日期」
    f_card.focus()
    page.keyboard.press("s")
    schedule_dialog = page.get_by_role("dialog", name="排入日期")
    expect(schedule_dialog).to_be_visible()
    schedule_dialog.get_by_label(re.compile(r"排程日")).fill(DAY_A)
    schedule_dialog.get_by_role("button", name="排入").click()
    expect(cell(page, DAY_A).get_by_test_id(f"cal-chip-{f['id']}")).to_be_visible()
    _poll(lambda: find_item(page, feedback)["status"], "scheduled")

    # 編輯：點卡片開啟 Dialog，改標題與負責人
    p_card.click()
    edit = page.get_by_role("dialog", name="編輯問題")
    expect(edit).to_be_visible()
    expect(edit.get_by_text(re.compile(r"更新於"))).to_be_visible()
    save = edit.get_by_role("button", name="儲存")
    expect(save).to_be_disabled()
    renamed = f"{problem}（已更名）"
    edit.get_by_label("標題").fill(renamed)
    edit.get_by_label("內容").fill("讀數高於設定 3 度")
    edit.get_by_label("負責人").click()
    page.get_by_role("option", name=E2E_USERS["admin"]["display_name"]).click()
    save.click()
    expect(edit).to_have_count(0)
    expect(p_card.get_by_text(renamed)).to_be_visible()
    expect(p_card.get_by_text(E2E_USERS["admin"]["display_name"])).to_be_visible()

    # 標記已解決（保留排程日）→ 移到已解決群組（預設收合）
    f_card.get_by_role("button", name=re.compile(r"標記「.*」為已解決")).click()
    _poll(lambda: find_item(page, feedback)["status"], "resolved")
    assert find_item(page, feedback)["scheduledDate"] == DAY_A
    expect(f_card).to_have_count(0)
    lst.get_by_role("region", name="已解決").get_by_role("button", expanded=False).click()
    expect(f_card).to_be_visible()
    # 已解決 chip 仍顯示在月曆上
    expect(cell(page, DAY_A).get_by_test_id(f"cal-chip-{f['id']}")).to_be_visible()
    # 重新開啟 → 回到已排程
    f_card.get_by_role("button", name=re.compile(r"重新開啟")).click()
    _poll(lambda: find_item(page, feedback)["status"], "scheduled")

    # 刪除（⋯ 選單 → 確認）
    p_card.hover()
    p_card.get_by_role("button", name=re.compile(r"更多動作")).click()
    page.get_by_role("menuitem", name="刪除").click()
    confirm = page.get_by_role("alertdialog", name=re.compile(r"刪除這筆問題"))
    expect(confirm).to_be_visible()
    confirm.get_by_role("button", name="刪除").click()
    expect(p_card).to_have_count(0)
    after = page.request.get("/api/feedback").json()
    assert next((i for i in after if i["id"] == p["id"]), None) is None

    # 鍵盤導覽月曆：PageDown 換月、T 回今天。
    # 換月後原本 focus 的格子會被移除，新月份格子的 focus 在下一次 render 後才設定；
    # 須等焦點落到新格子再按 T，否則按鍵會送到 body 而被忽略（先前偶發失敗的原因）。
    cell(page, DAY_A).focus()
    expect(cell(page, DAY_A)).to_be_focused()
    page.keyboard.press("PageDown")
    expect(page).to_have_url(re.compile(f"month={next_month_key}"))
    expect(cell(page, f"{next_month_key}-01")).to_be_focused()
    page.keyboard.press("t")
    # 以按鍵當下頁面的「今天」為準（跨午夜 / 跨月執行時仍正確）
    today_key = page_today(page)
    expect(page).to_have_url(re.compile(f"month={today_key[:7]}(&|$)"))
    expect(cell(page, today_key)).to_be_focused()

    # 清掉本測試留下的項目，重複執行時 DAY_A 不會累積超過格內可顯示的 chip 數
    assert page.request.delete(f"/api/feedback/{f['id']}").ok is True

    # 登入前的 /api/auth/me 探測回 401 屬預期
    assert [e for e in errors if not re.search(r"status of 401", e)] == []


def test_feedback_no_horizontal_scroll(page: Page):
    """1280 / 1024 / 768 寬度不產生水平捲軸"""
    login_via_ui(page, E2E_USERS["member"], "/feedback")
    for width in [1280, 1024, 768]:
        page.set_viewport_size({"width": width, "height": 800})
        page.goto("/feedback")
        expect(page.get_by_role("region", name="月曆").get_by_role("grid")).to_be_visible()
        overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        assert overflow <= 0, f"{width}px"
        if os.environ.get("SHOTS_DIR"):
            page.screenshot(path=f"{os.environ['SHOTS_DIR']}/feedback-{width}.png")
