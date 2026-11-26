"""eng-paste.spec.ts 的 Python 版：貼上 git worktree list 輸出 → 預覽 → 勾選 → 登記。"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

# 貼上 git worktree list 輸出 → 預覽 → 勾選 → 登記。截圖：設定 ENG_SHOT_DIR（與 ENG_SHOT_WIDTH）時存檔。
# （原檔 serial：pytest 同檔內本來就照順序跑）


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


stamp = _base36(int(time.time() * 1000))
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
    page.wait_for_timeout(350)
    page.screenshot(path=str(Path(SHOT_DIR).resolve() / f"{name}-{WIDTH}.png"), animations="disabled")


SAMPLE = """C:/Users/someone/Desktop/local專案/Main-Repo                                      80a0d97a [feat/extrepo-phase2]
C:/Users/someone/AppData/Local/Temp/claude/abc123/scratchpad/master_base          2e213717 (detached HEAD)
C:/Users/someone/Desktop/local專案/Main-Repo/.claude/worktrees/agent-a238ac466903f90b4  33b6a929 [worktree-agent-a238ac466903f90b4] locked
C:/Users/someone/Desktop/local專案/Main-Repo/.claude/worktrees/agent-a458f9f92f1744e0c  ff16b462 [worktree-agent-a458f9f92f1744e0c]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneA                           16687b8d [hotfix/gitea-ssl-fallback]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneB                           241e5bc4 [feat/db_redesign]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneC1                          30145fda [feat/aca-rebuild-r7-fix-c1]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneC2                          30145fda [feat/aca-rebuild-ac-redo-support]
"""


def test_paste_preview_register_filter_idempotent(page: Page):
    """貼上 git worktree list：預覽 → 預設勾選 → 登記 → 電腦篩選 → 再貼全為已存在"""
    errors = collect_errors(page)
    machine = f"E2E-PASTE-{stamp}"
    login_via_ui(page, E2E_USERS["member"], "/eng?tab=worktrees")
    shot(page, "p1-before")

    page.get_by_role("button", name="貼上 git worktree list").click()
    dialog = page.get_by_role("dialog", name="貼上 git worktree list")
    expect(dialog.get_by_text("這裡只解析文字")).to_be_visible()
    dialog.get_by_label("電腦名稱").fill(machine)
    dialog.get_by_test_id("paste-text").fill(SAMPLE)

    preview = dialog.get_by_test_id("paste-preview")
    expect(preview.get_by_test_id("paste-summary")).to_contain_text("新增 8、已存在 0、可能搬動 0")
    expect(dialog.get_by_label("專案 / Repo 名稱")).to_have_value("Main-Repo")
    # 暫時性 3 筆（scratchpad、兩個 .claude/worktrees）預設不勾；其餘 5 筆勾選
    expect(preview.get_by_text("暫時性", exact=True)).to_have_count(3)
    expect(preview.get_by_text("鎖定", exact=True)).to_have_count(1)
    expect(preview.get_by_text("分離 HEAD", exact=True)).to_have_count(1)
    expect(preview.get_by_test_id("paste-count")).to_have_text("已選 5 / 8")
    expect(dialog.get_by_label("登記 worktree-agent-a238ac466903f90b4")).not_to_be_checked()
    expect(dialog.get_by_label("登記 feat/db_redesign")).to_be_checked()
    # 批次操作
    dialog.get_by_role("button", name="全選").click()
    expect(preview.get_by_test_id("paste-count")).to_have_text("已選 8 / 8")
    dialog.get_by_role("button", name="全不選").click()
    expect(preview.get_by_test_id("paste-count")).to_have_text("已選 0 / 8")
    expect(dialog.get_by_role("button", name="登記 0 筆")).to_be_disabled()
    dialog.get_by_role("button", name="只選非暫時性").click()
    expect(preview.get_by_test_id("paste-count")).to_have_text("已選 5 / 8")
    shot(page, "p2-preview")

    dialog.get_by_role("button", name="登記 5 筆").click()
    expect(dialog).to_have_count(0)
    expect(page.get_by_text("已登記 5 筆、略過 0 筆")).to_be_visible()

    # 清單出現，且自動套用電腦篩選（只剩這台電腦）
    section = page.get_by_role("region", name=f"電腦 {machine}")
    expect(section.locator("tr.eng-wt-row").filter(has_text="feat/db_redesign")).to_be_visible()
    expect(section.locator("tr.eng-wt-row").filter(has_text="貼上登記")).to_have_count(5)
    expect(page.get_by_role("region", name=re.compile(r"^電腦 "), exact=False)).to_have_count(1)
    shot(page, "p3-after")
    # 篩選可切回全部
    page.get_by_role("button", name="依電腦篩選").click()
    page.get_by_role("option", name="全部電腦").click()
    expect(section).to_be_visible()

    # 再貼一次：全部已存在（冪等）；暫時性的 3 筆仍是新增
    page.get_by_role("button", name="貼上 git worktree list").click()
    dialog.get_by_test_id("paste-text").fill(SAMPLE)
    expect(dialog.get_by_label("電腦名稱")).to_have_value(machine)  # 記住上次輸入
    expect(preview.get_by_test_id("paste-summary")).to_contain_text("新增 3、已存在 5")
    expect(dialog.get_by_role("button", name="登記 0 筆")).to_be_disabled()
    expect(dialog.get_by_label("登記 feat/db_redesign")).to_be_disabled()
    # 手動勾選暫時性 → 登記 → Ctrl+Enter
    dialog.get_by_label("登記 worktree-agent-a238ac466903f90b4").check()
    dialog.get_by_test_id("paste-text").press("Control+Enter")
    expect(page.get_by_text("已登記 1 筆、略過 0 筆")).to_be_visible()
    expect(dialog).to_have_count(0)

    # 第三次：全部「已存在」，Esc 關閉
    page.get_by_role("button", name="貼上 git worktree list").click()
    dialog.get_by_test_id("paste-text").fill(SAMPLE)
    expect(preview.get_by_test_id("paste-summary")).to_contain_text("新增 2、已存在 6")
    dialog.get_by_label("登記 worktree-agent-a458f9f92f1744e0c").check()
    dialog.get_by_role("button", name="全選").click()
    dialog.get_by_role("button", name="登記 2 筆").click()
    expect(page.get_by_text("已登記 2 筆、略過 0 筆")).to_be_visible()
    page.get_by_role("button", name="貼上 git worktree list").click()
    dialog.get_by_test_id("paste-text").fill(SAMPLE)
    expect(preview.get_by_test_id("paste-summary")).to_contain_text("新增 0、已存在 8")
    page.keyboard.press("Escape")
    expect(dialog).to_have_count(0)

    assert [e for e in errors if "Failed to load resource" not in e] == []


def test_paste_unparsed_porcelain_and_prompt_lines(page: Page):
    """貼上：無法辨識的行折疊顯示；porcelain 與提示字元行"""
    login_via_ui(page, E2E_USERS["member"], "/eng?tab=worktrees")
    page.get_by_role("button", name="貼上 git worktree list").click()
    dialog = page.get_by_role("dialog", name="貼上 git worktree list")
    dialog.get_by_label("電腦名稱").fill(f"E2E-PASTE2-{stamp}")
    dialog.get_by_test_id("paste-text").fill(
        "\n".join(
            [
                "C:\\Users\\x>git worktree list",
                "worktree C:/Users/王小明/My Projects/Repo A",
                "HEAD 80a0d97a1111111111111111111111111111aaaa",
                "branch refs/heads/main",
                "",
                "worktree C:/tmp/wt",
                "HEAD 2e213717aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "detached",
                "prunable gitdir file points to non-existent location",
                "",
                "this is not a worktree line",
            ]
        )
    )
    preview = dialog.get_by_test_id("paste-preview")
    expect(preview.get_by_test_id("paste-summary")).to_contain_text("新增 2")
    expect(dialog.get_by_label("專案 / Repo 名稱")).to_have_value("Repo A")
    expect(preview.get_by_text("可清理", exact=True)).to_be_visible()
    unparsed = dialog.get_by_test_id("paste-unparsed")
    expect(unparsed).to_have_text("有 1 行無法辨識")
    unparsed.click()
    expect(preview.get_by_text("this is not a worktree line")).to_be_visible()
    # 輸入不是 worktree 輸出 → 空清單提示
    dialog.get_by_test_id("paste-text").fill("hello world")
    expect(dialog.get_by_text("沒有辨識到任何 worktree。")).to_be_visible()
    expect(dialog.get_by_role("button", name="登記 0 筆")).to_be_disabled()
