"""task-checklist.spec.ts 的 Python 版：任務待辦清單（新增、勾選、進度、徽章、排序、貼上、清除、重整、即時同步）。"""

from __future__ import annotations

import os
import re
import time

import pytest
from playwright.sync_api import Browser, Locator, Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# feat/task-checklist：新增 → 勾選 → 進度 → 列表徽章 → 拖曳排序 → 貼上多行 → 清除已完成 → 重整後仍在
# （原檔 serial：pytest 同檔內本來就照順序跑）

SHOTS = os.environ.get("CHECKLIST_SHOTS")

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


def shot(page: Page, name: str) -> None:
    if not SHOTS:
        return
    cl = page.get_by_test_id("checklist")
    if cl.count():
        cl.evaluate("(el) => el.scrollIntoView({ block: 'end' })")
    page.screenshot(path=f"{SHOTS}/{name}.png")


def paste_into(inp: Locator, text: str) -> None:
    inp.evaluate(
        """(el, t) => {
            const dt = new DataTransfer();
            dt.setData('text/plain', t);
            el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }""",
        text,
    )


def texts(page: Page, lst: str = "open") -> list[str]:
    return (
        page.get_by_role("list", name="待辦項目" if lst == "open" else "已完成的待辦")
        .locator("[data-checklist-row] .cl-text")
        .all_text_contents()
    )


def test_checklist_full_flow(page: Page):
    """待辦清單：新增、勾選、進度、徽章、排序、貼上、清除、重整"""
    P = f"CL-{int(time.time() * 1000)}"
    page.set_viewport_size({"width": 1280, "height": 800})
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    errors = collect_errors(page)
    created = page.request.post("/api/tasks", data={"title": f"{P} 任務"})
    assert created.ok
    task = created.json()
    page.request.post("/api/tasks", data={"title": f"{P} 沒有清單"})

    page.goto(f"/tasks/list?q={P}&task={task['id']}")
    lst = page.get_by_test_id("checklist")
    expect(lst.get_by_text("待辦清單", exact=True)).to_be_visible()
    # 空狀態：沒有進度，只有說明與新增列
    expect(lst.get_by_text("把工作拆成小步驟")).to_be_visible()
    expect(page.get_by_test_id("checklist-progress")).to_have_count(0)
    expect(page.get_by_test_id("checklist-badge")).to_have_count(0)
    page.wait_for_timeout(500)
    shot(page, "1280-empty")

    # ── 連續新增 ──
    add = lst.get_by_role("textbox", name="新增待辦")
    for t in ["甲", "乙", "丙", "丁", "戊"]:
        add.fill(t)
        add.press("Enter")
        expect(add).to_have_value("")
    expect(lst.locator("[data-checklist-row]")).to_have_count(5)
    expect(page.get_by_test_id("checklist-progress")).to_have_text("0 / 5")

    # ── 勾選 → 進度 3 / 5 與列表徽章 ──
    for t in ["甲", "乙", "丙"]:
        lst.get_by_role("checkbox", name=f"標為完成：{t}").click()
    expect(page.get_by_test_id("checklist-progress")).to_have_text("3 / 5")
    expect(lst.get_by_role("progressbar", name="待辦清單進度")).to_have_attribute("aria-valuenow", "3")
    badge = page.locator(".tl-row--task", has_text=f"{P} 任務").get_by_test_id("checklist-badge")
    expect(badge).to_have_text("3/5")
    expect(badge).to_have_attribute("aria-label", "待辦清單 3/5 完成")
    expect(page.locator(".tl-row--task", has_text=f"{P} 沒有清單").get_by_test_id("checklist-badge")).to_have_count(0)
    expect(lst.get_by_text("已完成 3 項")).to_be_visible()
    assert texts(page, "done") == ["甲", "乙", "丙"]
    shot(page, "1280-progress")

    # ── 拖曳排序（把手）：戊移到丁之前 ──
    assert texts(page) == ["丁", "戊"]
    row_wu = lst.locator("[data-checklist-row]", has_text="戊")
    row_wu.hover()
    handle = row_wu.get_by_role("button", name=re.compile(r"拖曳排序：戊"))
    hb = handle.bounding_box()
    row_ding = lst.locator("[data-checklist-row]", has_text="丁").bounding_box()
    page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
    page.mouse.down()
    page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2 - 10, steps=4)
    page.mouse.move(hb["x"] + hb["width"] / 2, row_ding["y"] + 2, steps=8)
    page.mouse.up()
    _poll(lambda: texts(page), ["戊", "丁"])
    # 鍵盤 Alt+↓ 移回
    lst.locator("[data-checklist-row]", has_text="戊").locator(".cl-text").focus()
    page.keyboard.press("Alt+ArrowDown")
    _poll(lambda: texts(page), ["丁", "戊"])

    # ── 就地編輯：Enter 儲存並在下方新增下一項；Esc 結束；空項 Backspace 刪除 ──
    lst.locator("[data-checklist-row]", has_text="丁").locator(".cl-text").click()
    editor = lst.get_by_role("textbox", name=re.compile(r"編輯待辦：丁"))
    editor.fill("丁（改）")
    editor.press("Enter")
    nxt = lst.get_by_role("textbox", name="新增下一項待辦")
    expect(nxt).to_be_focused()
    nxt.fill("丁之二")
    nxt.press("Enter")
    nxt.fill("丁之三")
    nxt.press("Enter")
    nxt.fill("不會建立")
    nxt.press("Escape")  # Esc 取消目前輸入並結束連續新增
    _poll(lambda: texts(page), ["丁（改）", "丁之二", "丁之三", "戊"])
    # 等新項目寫入完成（暫時列換成正式列後才有刪除鈕），避免 F2 打開的編輯框在換列時被重新掛載而關閉
    row3 = lst.locator("[data-checklist-row]", has_text="丁之三")
    expect(row3.get_by_role("button", name=re.compile(r"刪除待辦"))).to_be_visible()
    row3.locator(".cl-text").press("F2")
    e2 = lst.get_by_role("textbox", name=re.compile(r"編輯待辦：丁之三"))
    e2.fill("")
    e2.press("Backspace")
    _poll(lambda: texts(page), ["丁（改）", "丁之二", "戊"])
    lst.locator("[data-checklist-row]", has_text="丁之二").get_by_role("button", name=re.compile(r"刪除待辦")).click()
    _poll(lambda: texts(page), ["丁（改）", "戊"])

    # ── 貼上多行：確認後拆成多項（保留勾選）──
    paste_into(add, "- [ ] 買牛奶\n- [x] 寄信\n\n  * 開會\n1. 打掃")
    expect(lst.get_by_text("將建立 4 項，其中 1 項已勾選")).to_be_visible()
    shot(page, "1280-paste")
    lst.get_by_role("button", name="建立 4 項").click()
    expect(page.get_by_text("已建立 4 項待辦")).to_be_visible()
    _poll(lambda: texts(page), ["丁（改）", "戊", "買牛奶", "開會", "打掃"])
    assert texts(page, "done") == ["甲", "乙", "丙", "寄信"]
    expect(page.get_by_test_id("checklist-progress")).to_have_text("4 / 9")
    # 復原
    page.get_by_role("button", name="復原", exact=True).click()
    _poll(lambda: texts(page), ["丁（改）", "戊"])
    expect(page.get_by_test_id("checklist-progress")).to_have_text("3 / 5")
    # 取消貼上不建立
    paste_into(add, "a\nb")
    lst.get_by_role("button", name="取消").click()
    expect(lst.locator("[data-checklist-row]")).to_have_count(5)

    # ── 清除已完成 ──
    lst.get_by_role("button", name="清除已完成").click()
    page.get_by_role("alertdialog").get_by_role("button", name="清除").click()
    expect(lst.get_by_text(re.compile(r"已完成 \d+ 項"))).to_have_count(0)
    expect(page.get_by_test_id("checklist-progress")).to_have_text("0 / 2")
    expect(badge).to_have_text("0/2")

    # ── 重整後仍在 ──
    page.reload()
    expect(page.get_by_test_id("checklist-progress")).to_have_text("0 / 2")
    assert texts(page) == ["丁（改）", "戊"]

    # ── 全部完成：徽章變綠色勾、提示低調出現、任務狀態不變 ──
    for t in ["丁（改）", "戊"]:
        lst.get_by_role("checkbox", name=f"標為完成：{t}").click()
    expect(lst.get_by_text("全部完成")).to_be_visible()
    expect(badge).to_have_attribute("aria-label", "待辦清單 2/2 完成")
    expect(badge).to_have_class(re.compile(r"is-complete"))
    after = page.request.get(f"/api/tasks/{task['id']}").json()
    assert [after["checklistTotal"], after["checklistDone"]] == [2, 2]
    assert after["statusId"] == 1
    for t in ["丁（改）", "戊"]:
        lst.get_by_role("checkbox", name=f"標為未完成：{t}").click()
    lst.locator("[data-checklist-row]", has_text="戊").get_by_role("checkbox").click()

    # ── 看板卡片徽章 ──
    page.goto(f"/tasks/kanban?q={P}")
    card = page.locator(".kanban-card", has_text=f"{P} 任務")
    expect(card.get_by_test_id("checklist-badge")).to_have_text("1/2")
    shot(page, "1280-kanban")

    # ── 768px ──
    page.set_viewport_size({"width": 768, "height": 900})
    page.goto(f"/tasks/list?q={P}&task={task['id']}")
    expect(page.get_by_test_id("checklist-progress")).to_have_text("1 / 2")
    shot(page, "768-progress")
    paste_into(page.get_by_test_id("checklist").get_by_role("textbox", name="新增待辦"), "- [x] 一\n- [ ] 二\n- [ ] 三")
    expect(page.get_by_text("將建立 3 項，其中 1 項已勾選")).to_be_visible()
    shot(page, "768-paste")
    page.get_by_role("button", name="取消").click()
    page.goto(f"/tasks/list?q={P}")
    expect(page.locator(".tl-row--task", has_text=f"{P} 任務").get_by_test_id("checklist-badge")).to_have_text("1/2")
    page.mouse.move(700, 800)
    shot(page, "768-list")

    assert errors == []


def test_checklist_realtime_does_not_clobber_editing(browser: Browser, page: Page, base_url: str):
    """待辦清單：另一個分頁的變更即時出現，且不覆蓋正在編輯的文字"""
    P = f"CLR-{int(time.time() * 1000)}"
    login_via_ui(page, E2E_USERS["admin"], "/tasks/list")
    task = page.request.post("/api/tasks", data={"title": f"{P} 任務"}).json()
    page.request.post(f"/api/tasks/{task['id']}/checklist", data={"items": [{"text": "甲"}, {"text": "乙"}]})
    page.goto(f"/tasks/list?q={P}&task={task['id']}")
    lst = page.get_by_test_id("checklist")
    expect(page.get_by_test_id("checklist-progress")).to_have_text("0 / 2")

    # 開始編輯「甲」，另一位成員同時改動
    lst.locator("[data-checklist-row]", has_text="甲").locator(".cl-text").click()
    editor = lst.get_by_role("textbox", name=re.compile(r"編輯待辦：甲"))
    editor.fill("甲（我正在打字）")

    ctx2 = browser.new_context(base_url=base_url)
    page2 = ctx2.new_page()
    login_via_ui(page2, E2E_USERS["admin"], "/tasks/list")
    items = page2.request.get(f"/api/tasks/{task['id']}/checklist").json()
    page2.request.patch(f"/api/tasks/{task['id']}/checklist/{items[1]['id']}", data={"isDone": True})
    page2.request.patch(f"/api/tasks/{task['id']}/checklist/{items[0]['id']}", data={"text": "甲（別人改的）"})
    page2.request.post(f"/api/tasks/{task['id']}/checklist", data={"text": "丙（別人加的）"})

    expect(page.get_by_test_id("checklist-progress")).to_have_text("1 / 3")
    expect(editor).to_have_value("甲（我正在打字）")
    editor.press("Escape")
    expect(lst.get_by_text("丙（別人加的）")).to_be_visible()
    ctx2.close()
