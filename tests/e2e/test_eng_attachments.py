"""eng-attachments.spec.ts 的 Python 版：問題的附件（上傳、燈箱、刪除、失敗卡片）與連結預覽（本機測試頁）。"""

from __future__ import annotations

import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import Page, expect

from .helpers import E2E_USERS, collect_errors, login_via_ui

pytestmark = pytest.mark.usefixtures("data_hygiene")

# 問題的附件（圖片 / 影片上傳、燈箱、刪除、失敗卡片）與連結預覽（本機測試頁）。
# E2E 伺服器以 LINK_PREVIEW_ALLOW_PRIVATE=true 啟動（僅限 E2E），才能抓 127.0.0.1 的測試頁。
# （原檔 serial：pytest 同檔內本來就照順序跑）

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"


def _base36(n: int) -> str:
    chars = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = chars[r] + out
    return out or "0"


stamp = _base36(int(time.time() * 1000))


def _poll(fn, *, pred, timeout_ms: int = 5000):
    """對應 expect.poll(fn)：重試直到 pred 成立。"""
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        value = fn()
        if pred(value):
            return value
        if time.monotonic() > deadline:
            raise AssertionError(f"poll 逾時：實際 {value!r}")
        time.sleep(0.1)


def _to_pass(fn, timeout_ms: int = 5000) -> None:
    """對應 expect(async () => {...}).toPass()：重試到不再丟 AssertionError。"""
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        try:
            fn()
            return
        except AssertionError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.1)


def issue_row(page: Page, title: str):
    return page.locator("tr.eng-issue-row").filter(has_text=title)


def create_issue(page: Page, title: str, url: str | None = None) -> None:
    form = page.get_by_role("form", name="新增問題")
    form.get_by_label("標題").fill(title)
    if url:
        form.get_by_label("連結").fill(url)
    form.get_by_role("button", name="新增問題").click()
    expect(issue_row(page, title)).to_be_visible()


def expand(page: Page, title: str) -> None:
    page.get_by_role("button", name=f"展開「{title}」的附件與詳細").click()
    expect(page.get_by_role("button", name=f"收合「{title}」的附件與詳細")).to_be_visible()


def test_attachments_upload_lightbox_delete(page: Page):
    """附件：上傳圖片與影片 → 縮圖格 → 燈箱預覽（影片可載入）→ 刪除"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["member"], "/eng")
    title = f"E2E 附件 {stamp}"
    create_issue(page, title)
    expand(page, title)

    detail = page.locator("tr.eng-detail-row")
    drop = detail.get_by_role("button", name=re.compile(r"新增附件"))
    expect(drop).to_contain_text("拖放檔案到這裡")
    expect(drop).to_contain_text("25 MB")

    # 鍵盤：拖放區可聚焦，Enter 開啟檔案選擇器
    # （列表在背景重新整理時列可能被重新排列而失去焦點，失敗就重新聚焦再按一次）
    chooser = None
    for _ in range(3):
        if chooser:
            break
        drop.focus()
        try:
            with page.expect_file_chooser(timeout=3_000) as fc:
                page.keyboard.press("Enter")
            chooser = fc.value
        except PlaywrightError:
            chooser = None
    if not chooser:
        raise AssertionError("按 Enter 沒有開啟檔案選擇器")
    chooser.set_files([str(FIXTURES / "screenshot.png"), str(FIXTURES / "sample.webm")])

    grid = detail.locator(".eng-att-grid")
    expect(grid.locator(".eng-tile:not(.eng-tile--upload)")).to_have_count(2, timeout=15_000)
    expect(grid.get_by_text("screenshot.png")).to_be_visible()
    expect(grid.get_by_text("sample.webm")).to_be_visible()
    # 收合時的小標記
    expect(issue_row(page, title).get_by_label("2 個附件")).to_be_visible()

    # 圖片縮圖可載入
    thumb = grid.locator('.eng-tile[data-kind="image"] img')
    expect(thumb).to_be_visible()
    assert thumb.evaluate("(img) => img.naturalWidth") > 0

    # 燈箱：圖片 → → 切到影片，video 可載入 metadata（Range 支援）→ Esc 關閉
    grid.get_by_role("button", name="預覽「screenshot.png」").click()
    box = page.get_by_role("dialog", name=re.compile(r"附件預覽"))
    expect(box.locator("img")).to_be_visible()
    page.keyboard.press("ArrowRight")
    video = box.locator("video")
    expect(video).to_be_visible()
    _poll(lambda: video.evaluate("(v) => v.readyState"), pred=lambda v: v >= 1, timeout_ms=15_000)
    page.keyboard.press("Escape")
    expect(box).to_have_count(0)

    # 下載標頭：影片支援 Range
    href = grid.locator('.eng-tile[data-kind="video"] a[download]').get_attribute("href")
    ranged = page.request.get(href.replace("?download=1", ""), headers={"Range": "bytes=0-15"})
    assert ranged.status == 206
    assert re.match(r"^bytes 0-15/", ranged.headers["content-range"])

    # 不支援的類型：顯示失敗卡片與原因，可移除
    detail.locator("input[type=file]").set_input_files(
        {"name": "virus.exe", "mimeType": "application/octet-stream", "buffer": b"MZ"}
    )
    failed = grid.locator('.eng-tile--upload[data-status="error"]')
    expect(failed).to_contain_text("不支援的檔案類型")
    failed.get_by_role("button", name="移除").click()
    expect(failed).to_have_count(0)

    # 偽造內容（副檔名 png、內容不是圖片）：伺服器拒絕，卡片顯示伺服器訊息
    detail.locator("input[type=file]").set_input_files(
        {"name": "fake.png", "mimeType": "image/png", "buffer": b"<html>not a png</html>"}
    )
    expect(grid.locator('.eng-tile--upload[data-status="error"]')).to_contain_text("內容與副檔名不符")
    grid.locator(".eng-tile--upload").get_by_role("button", name="移除").click()

    # 刪除（需確認）
    grid.get_by_role("button", name="刪除「screenshot.png」").click()
    confirm = page.get_by_role("alertdialog", name="刪除附件？")
    confirm.get_by_role("button", name="刪除").click()
    expect(grid.get_by_text("screenshot.png")).to_have_count(0)
    expect(issue_row(page, title).get_by_label("1 個附件")).to_be_visible()

    assert [e for e in errors if "Failed to load resource" not in e] == []


def test_attachments_before_create_auto_upload(page: Page):
    """附件：新增問題時先貼上 / 選擇檔案，建立後自動上傳"""
    login_via_ui(page, E2E_USERS["member"], "/eng")
    title = f"E2E 先附檔 {stamp}"
    form = page.get_by_role("form", name="新增問題")
    form.get_by_label("選擇附件").set_input_files(str(FIXTURES / "screenshot.png"))
    expect(form.get_by_text("screenshot.png")).to_be_visible()
    form.get_by_label("標題").fill(title)
    form.get_by_role("button", name="新增問題").click()
    # 建立後自動展開並上傳
    detail = page.locator("tr.eng-detail-row")
    expect(detail.locator(".eng-tile:not(.eng-tile--upload)")).to_have_count(1, timeout=15_000)
    expect(issue_row(page, title).get_by_label("1 個附件")).to_be_visible()


# ── 連結預覽 ──

_PREVIEW_HTML = f"""<!doctype html><html><head><title>備用標題</title>
<meta property="og:title" content="E2E 測試頁 {stamp}">
<meta property="og:description" content="這是給連結預覽的說明 &lt;script&gt;">
<meta property="og:site_name" content="E2E Site">
</head><body><p>內文第一段</p><script>document.title='x'</script></body></html>"""


class _PreviewHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path == "/page":
            body = _PREVIEW_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def preview_base():
    """對應 test.describe('連結預覽') 的 beforeAll / afterAll：起一個本機測試頁。"""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _PreviewHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def test_link_preview_card(page: Page, preview_base: str):
    """連結預覽：貼連結後顯示網頁預覽卡片（標題、說明、網站），開新分頁連結"""
    errors = collect_errors(page)
    login_via_ui(page, E2E_USERS["member"], "/eng")
    title = f"E2E 連結 {stamp}"
    create_issue(page, title, f"{preview_base}/page")
    expand(page, title)
    card = page.locator("tr.eng-detail-row .eng-preview-card")

    def check():
        if card.count() == 0:
            btn = page.get_by_role("button", name="重新取得預覽")
            if btn.is_visible():
                btn.click()
        expect(card).to_be_visible(timeout=2_000)

    _to_pass(check, timeout_ms=20_000)
    expect(card).to_contain_text(f"E2E 測試頁 {stamp}")
    expect(card).to_contain_text("這是給連結預覽的說明 <script>")
    expect(card).to_contain_text("E2E Site")
    expect(card).to_have_attribute("target", "_blank")
    expect(card).to_have_attribute("rel", "noopener noreferrer")
    assert [e for e in errors if "Failed to load resource" not in e] == []
