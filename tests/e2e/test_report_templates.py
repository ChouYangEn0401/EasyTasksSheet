"""匯報模版（docs/design/ui-refresh-2026-11-26.md §6、requirements R1～R4）。

1. 純函式：在瀏覽器裡動態 import `features/personal/reportTemplates.js`、餵固定資料，驗四個模版的輸出
   （工作日誌的 `[專案] - 人名`、`_完成`、`: 進行中...(90%)`、`: 暫停...(10%)`、HTML 的橘／紅色）。
2. 畫面：個人頁「本週」卡三個數字＝清單筆數；「今日」直接開工作日誌、「匯報」預選個人週報；
   一鍵複製同時寫 text/plain 與 text/html；下載 .md／.html 檔名帶模版名。
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

SHOTS = os.environ.get("REPORT_SHOTS")  # 設了才截圖（例：scratchpad/ui-rep）

FIXTURE_JS = """async (prefix) => {
  const m = await import(`${prefix}/js/features/personal/reportTemplates.js`);
  const statuses = new Map([
    [1, { name: '待辦', category: 'todo' }],
    [2, { name: '進行中', category: 'doing' }],
    [3, { name: '暫停', category: 'doing', color: 'gray' }],
    [4, { name: '完成', category: 'done' }],
    [5, { name: 'On hold', category: 'todo' }],
  ]);
  const projects = new Map([[10, { name: 'pyDMS' }], [11, { name: '產學' }], [12, { name: '系統設計' }]]);
  const at = (d) => new Date(`${d}T10:00:00`).getTime();
  const tasks = [
    { id: 1, title: 'SQL架構設計', projectId: 10, statusId: 3, assigneeId: 7, progress: 10, updatedAt: at('2026-11-20') },
    { id: 2, title: 'ACA 搬動到 pyDMS 上面', projectId: 10, statusId: 2, assigneeId: 7, progress: 90,
      description: '遇到一些舊的技術債要多修\\n第二行', updatedAt: at('2026-11-26') },
    { id: 3, title: '11603期校庫異動申請表與說明文件撰寫', projectId: 11, statusId: 4, assigneeId: 7,
      completedAt: at('2026-11-25'), updatedAt: at('2026-11-25'), description: '王老師過目中' },
    { id: 4, title: '上個月做完的', projectId: 11, statusId: 4, assigneeId: 7,
      completedAt: at('2026-10-01'), updatedAt: at('2026-10-01') },
    { id: 5, title: 'API 介面決議', projectId: 12, statusId: 2, assigneeId: 7, dueDate: '2026-11-27',
      description: '決議：採用 REST\\n## 理由\\n- 團隊熟\\n## 影響\\n前端要改', updatedAt: at('2026-11-26'),
      isBlocked: true, blockedByCount: 2 },
    { id: 6, title: '可計算指標說明', projectId: 11, statusId: 2, assigneeId: 8, progress: 75, updatedAt: at('2026-11-26') },
    { id: 7, title: '還沒開始', projectId: 10, statusId: 1, assigneeId: 7, updatedAt: at('2026-11-26') },
    { id: 8, title: '擱著的', projectId: 10, statusId: 5, assigneeId: 7, updatedAt: at('2026-11-26') },
  ];
  const base = { tasks, statuses, projects, from: '2026-11-23', to: '2026-11-29', today: '2026-11-26' };
  const one = m.buildTemplateModel({ ...base, members: [{ id: 7, name: '周暘恩' }],
    comments: { 5: ['替代方案：GraphQL'] } });
  const two = m.buildTemplateModel({ ...base, members: [{ id: 8, name: '予澤' }, { id: 7, name: '周暘恩' }] });
  const out = {};
  for (const t of ['worklog', 'weekly', 'decision']) out[t] = m.renderTemplate(t, one, {});
  out.worklogNote = m.renderTemplate('worklog', one, { showNote: true });
  out.worklogNum = m.renderTemplate('worklog', one, { bullet: 'number', showProgress: false });
  out.pl = m.renderTemplate('pl', two, {});
  const emptyModel = m.buildTemplateModel({ ...base, tasks: [], members: [{ id: 7, name: '周暘恩' }] });
  out.decisionEmpty = m.renderTemplate('decision', emptyModel, {});
  out.week = (() => {
    const b = m.weekBuckets(tasks.filter((t) => t.assigneeId === 7), statuses, '2026-11-26');
    return { doing: b.doing.map((t) => t.id), due: b.due.map((t) => t.id), done: b.done.map((t) => t.id), from: b.from, to: b.to };
  })();
  out.file = m.templateFileName('worklog', '2026-11-24', '2026-11-30', 'md', '王 小明');
  out.state = [m.worklogState({ category: 'done' }), m.worklogState({ category: 'doing', paused: true }),
               m.worklogState({ category: 'todo' })];
  out.paused = [m.isPausedStatus({ name: '暫停中' }), m.isPausedStatus({ name: 'ON HOLD' }),
                m.isPausedStatus({ name: 'x', color: 'orange' }), m.isPausedStatus({ name: '進行中' })];
  out.summary = m.templateSummary(one);
  out.week48 = m.isoWeek('2026-11-26');
  return out;
}"""


def _prefix(page: Page, base_url: str) -> str:
    page.goto(f"{base_url}/login")
    prefix = page.get_attribute('meta[name="ts-static"]', "content")
    assert prefix
    return prefix


def test_templates_pure_functions(page: Page, base_url: str):
    out = page.evaluate(FIXTURE_JS, _prefix(page, base_url))

    wl = out["worklog"]["text"]
    assert "[pyDMS] - 周暘恩" in wl
    assert "[產學] - 周暘恩" in wl
    assert "➢ ACA 搬動到 pyDMS 上面: 進行中...(90%)" in wl
    assert "➢ SQL架構設計: 暫停...(10%)" in wl
    assert "➢ 11603期校庫異動申請表與說明文件撰寫_完成" in wl
    assert "擱著的: 暫停..." in wl  # 狀態名含 hold → 暫停；沒有進度不寫 (0%)
    assert "(0%)" not in wl
    assert "上個月做完的" not in wl  # 範圍外完成的不收
    assert "還沒開始" not in wl  # 待辦、沒進度的不收
    # 純文字不帶顏色；HTML 版進行中橘、暫停紅、完成一般色
    assert "#8f5a06" not in wl
    html = out["worklog"]["html"]
    assert '<span class="rp-doing" style="color:#8f5a06">: 進行中...(90%)</span>' in html
    assert '<span class="rp-paused" style="color:#a82c26">: 暫停...(10%)</span>' in html
    assert '<span class="rp-done">_完成</span>' in html
    assert "[pyDMS] - 周暘恩" in out["worklog"]["md"]
    assert "_完成" in out["worklog"]["md"]

    # 備註：進行中接「 – 備註」、完成接括號
    note = out["worklogNote"]["text"]
    assert ": 進行中...(90%) – 遇到一些舊的技術債要多修" in note
    assert "_完成(王老師過目中)" in note
    # 編號條列、不顯示進度
    num = out["worklogNum"]["text"]
    assert "  1. " in num and "(90%)" not in num
    assert "<ol" in out["worklogNum"]["html"]

    weekly = out["weekly"]["text"]
    for h in ("【本週完成】", "【進行中】", "【下週預計】", "【卡住的事】"):
        assert h in weekly
    assert weekly.startswith("週報 11/23–11/29 · 周暘恩")
    assert "等待 2 項前置任務" in weekly
    assert "## 下週預計" in out["weekly"]["md"]

    pl = out["pl"]["text"]
    assert pl.startswith("進度匯報 11/23–11/29")
    assert "・予澤：完成 0／進行中 1／逾期 0" in pl
    assert pl.index("【予澤】") < pl.index("【周暘恩】")  # 照名字排，不排名
    assert "[產學] - 予澤" in pl and ": 進行中...(75%)" in pl
    assert "| 成員 | 完成 | 進行中 | 逾期 |" in out["pl"]["md"]

    dec = out["decision"]["text"]
    assert "■ 議題：API 介面決議" in dec
    assert "【決議】\n採用 REST" in dec
    assert "【替代方案】\nGraphQL" in dec  # 從討論抓
    assert "【影響】\n前端要改" in dec
    assert "### 理由" in out["decision"]["md"]
    empty = out["decisionEmpty"]
    assert empty["empty"] is True
    assert "【決議】（待填）" in empty["text"]
    assert "加上「決議」" in empty["text"]

    assert out["week"] == {"doing": [5, 1, 2], "due": [5], "done": [3], "from": "2026-11-23", "to": "2026-11-29"}
    assert out["file"] == "工作日誌_2026-11-24_2026-11-30_王小明.md"
    assert out["state"] == ["done", "paused", "doing"]
    assert out["paused"] == [True, True, True, False]
    assert out["summary"] == "共 5 項 · 1 完成 · 2 進行中 · 2 暫停"
    assert out["week48"] == 48


# ── 畫面 ─────────────────────────────


@pytest.fixture
def seeded(page: Page, base_url: str, data_hygiene):
    """以 member 登入，建一個進行中 90%、一個暫停、一個今天完成的任務（都指派給自己）。"""
    login_via_ui(page, E2E_USERS["member"], "/me")
    req = page.request
    me = req.get("/api/auth/me").json()["user"]
    statuses = req.get("/api/statuses").json()
    doing = next(s for s in statuses if s["category"] == "doing")
    done = next(s for s in statuses if s["category"] == "done")
    paused = next((s for s in statuses if "暫停" in s["name"] or "擱置" in s["name"]), None)
    stamp = int(time.time() * 1000)
    titles = {"doing": f"模版進行中-{stamp}", "paused": f"模版暫停-{stamp}", "done": f"模版完成-{stamp}"}
    today = time.strftime("%Y-%m-%d")

    def make(title, status_id, **extra):
        res = req.post("/api/tasks", data={"title": title, "statusId": status_id, "assigneeId": me["id"], **extra})
        assert res.status == 201, res.text()
        return res.json()

    t_doing = make(titles["doing"], doing["id"], progress=90, dueDate=today)
    make(titles["done"], done["id"])
    # 沒有「暫停」狀態就先當進行中（只驗工作日誌格式時用不到）
    make(titles["paused"], (paused or doing)["id"], progress=10)
    make(
        f"模版設計決議-{stamp}",
        doing["id"],
        dueDate=today,
        description="決議：週報改用模版產生\n## 理由\n- 每週少花半小時排版\n## 影響\n個人頁多一張本週卡",
    )
    return {"me": me, "titles": titles, "paused": paused is not None, "project_id": t_doing["projectId"]}


def _shot(page: Page, name: str):
    if SHOTS:
        Path(SHOTS).mkdir(parents=True, exist_ok=True)
        page.wait_for_timeout(350)
        page.screenshot(path=str(Path(SHOTS) / name), full_page=False)


def test_week_card_and_template_dialog(page: Page, base_url: str, seeded, tmp_path):
    errors = collect_errors(page)
    page.context.grant_permissions(["clipboard-read", "clipboard-write"])
    page.set_viewport_size({"width": 1366, "height": 900})
    page.goto(f"{base_url}/me")
    t = seeded["titles"]
    name = seeded["me"]["displayName"]

    week = page.get_by_role("region", name="本週", exact=True)
    expect(week).to_be_visible()
    expect(week.locator('[data-kind="doing"]').get_by_text(t["doing"])).to_be_visible()
    expect(week.locator('[data-kind="due"]').get_by_text(t["doing"])).to_be_visible()
    expect(week.locator('[data-kind="done"]').get_by_text(t["done"])).to_be_visible()
    # 數字＝底下清單筆數（最多列 5 筆，超過的寫在「還有 N 項」）
    for kind in ("doing", "due", "done"):
        col = week.locator(f'[data-kind="{kind}"]')
        n = int(col.get_by_test_id(f"week-count-{kind}").inner_text())
        rows = col.locator(".pl-week-item").count()
        more = col.locator(".pl-week-more")
        extra = int(more.inner_text().split()[1]) if more.count() else 0
        assert n == rows + extra
    expect(week.locator('[data-kind="due"] .pl-week-item[data-due="today"]').first).to_be_visible()
    _shot(page, "personal-week.png")

    # 「今日」：不動任何設定就是工作日誌＋今日
    week.get_by_role("button", name="今日", exact=True).click()
    dialog = page.get_by_role("dialog", name="匯報報告")
    expect(dialog).to_be_visible()
    expect(dialog.locator('.rp-templates .rp-template[aria-pressed="true"]')).to_have_text("工作日誌")
    expect(dialog.get_by_label("模版區間")).to_have_value("today")
    preview = dialog.get_by_test_id("template-preview")
    expect(preview).to_contain_text(f"] - {name}")
    expect(preview).to_contain_text(f"{t['doing']}: 進行中...(90%)")
    expect(preview).to_contain_text(f"{t['done']}_完成")
    color = preview.locator(".rp-doing").first.evaluate("el => getComputedStyle(el).color")
    assert color != preview.evaluate("el => getComputedStyle(el).color")  # 進行中是橘字
    if seeded["paused"]:
        expect(preview).to_contain_text(f"{t['paused']}: 暫停...(10%)")
    _shot(page, "template-worklog.png")

    # 一鍵複製：純文字 + HTML
    dialog.get_by_role("button", name="一鍵複製").click()
    expect(dialog.get_by_text("已複製 ✓")).to_be_visible()
    clip = page.evaluate(
        """async () => {
            const items = await navigator.clipboard.read();
            const out = {};
            for (const it of items) for (const type of it.types) out[type] = await (await it.getType(type)).text();
            return out;
        }"""
    )
    assert f"{t['doing']}: 進行中...(90%)" in clip["text/plain"]
    assert "<span" not in clip["text/plain"]
    assert "color:#8f5a06" in clip["text/html"]

    # 下載 .md／.html：檔名帶模版名
    with page.expect_download() as dl:
        dialog.get_by_role("button", name="下載 .md").click()
    md = dl.value
    assert md.suggested_filename.startswith("工作日誌_") and md.suggested_filename.endswith(".md")
    md_text = Path(md.path()).read_text(encoding="utf-8")
    assert f"] - {name}**" in md_text and "_完成" in md_text
    with page.expect_download() as dl:
        dialog.get_by_role("button", name="下載 .html").click()
    html_text = Path(dl.value.path()).read_text(encoding="utf-8")
    assert html_text.startswith("<!doctype html>") and "color:#8f5a06" in html_text

    # 純文字分頁
    dialog.get_by_role("tab", name="純文字").click()
    expect(dialog.get_by_role("textbox", name="純文字")).to_have_value(
        re.compile(rf"\] - {re.escape(name)}")
    )
    dialog.get_by_role("tab", name="預覽").click()

    # 個人週報、PL 匯報、設計決議
    for label, shot, needle in (
        ("個人週報", "template-weekly.png", "本週完成"),
        ("PL 匯報", "template-pl.png", "總覽"),
        ("設計決議", "template-decision.png", "決議"),
    ):
        dialog.locator(".rp-templates .rp-template", has_text=label).click()
        expect(dialog.locator('.rp-templates .rp-template[aria-pressed="true"]')).to_have_text(label)
        expect(preview).to_contain_text(needle)
        if label == "個人週報":
            dialog.get_by_label("模版區間").select_option("week")
            expect(preview).to_contain_text(t["done"])
        _shot(page, shot)

    # 一般格式仍是原本的畫面
    dialog.locator(".rp-templates .rp-template", has_text="一般格式").click()
    expect(dialog.get_by_label("輸出格式")).to_be_visible()
    expect(dialog.get_by_role("button", name="複製", exact=True)).to_be_visible()
    page.keyboard.press("Escape")

    # 「匯報」：預選個人週報＋本週
    week.get_by_role("button", name="匯報", exact=True).click()
    expect(dialog.locator('.rp-templates .rp-template[aria-pressed="true"]')).to_have_text("個人週報")
    expect(dialog.get_by_label("模版區間")).to_have_value("week")
    page.keyboard.press("Escape")

    # 原本的「產生匯報報告」：一般格式
    page.get_by_role("button", name="產生匯報報告").click()
    expect(dialog.locator('.rp-templates .rp-template[aria-pressed="true"]')).to_have_text("一般格式")
    expect(dialog.get_by_label("快速區間")).to_be_visible()

    real = [e for e in errors if "status of 401" not in e and "favicon" not in e]
    assert real == [], "\n".join(real)
