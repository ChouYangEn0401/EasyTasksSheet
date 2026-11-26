"""Python 版 Playwright E2E 的共用設定（取代以前的 playwright.config.ts）。

跑法：`.venv/bin/python -m pytest tests/e2e -q`（Windows：`.venv\\Scripts\\python -m pytest tests\\e2e -q`）。
第一次要先 `python scripts/install.py --dev` 與 `python -m playwright install chromium`
（容器已預裝瀏覽器時可用環境變數 E2E_CHROMIUM_PATH 指定執行檔）。

- 整個 session 起一個正式模式的伺服器（單一行程同時提供 API 與前端），用獨立的 E2E 資料庫（`data/e2e.db`）。
- 帳號由 `server/e2e_setup.py` 建立（E2E_USERS 是單一來源）。
- 環境變數與以前的 playwright.config.ts 相同，只是 NODE_ENV 改 APP_ENV。
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from server.e2e_setup import E2E_USERS  # noqa: E402

PORT = int(os.environ.get("E2E_PORT", "3999"))
BASE_URL = f"http://localhost:{PORT}"
#: 幾個人同時跑 E2E 時各用自己的資料庫與資料夾（名稱一定要含 e2e，e2e_setup 才肯清）
E2E_DB = os.environ.get("E2E_DB", "data/e2e.db")
E2E_DIR = E2E_DB.rsplit(".", 1)[0]  # data/e2e → data/e2e-attachments 等

E2E_ENV = {
    "APP_ENV": "production",
    "PORT": str(PORT),
    "DATABASE_PATH": E2E_DB,
    "ATTACHMENTS_DIR": f"{E2E_DIR}-attachments",
    # 僅限 E2E：連結預覽測試要抓本機的測試頁（127.0.0.1）。正式環境預設為 false，請勿開啟
    "LINK_PREVIEW_ALLOW_PRIVATE": "true",
    "COOKIE_SECURE": "false",
    "APP_ORIGIN": BASE_URL,
    "PYTHONUTF8": "1",
    # 預設管理員帳號改用 E2E 專用的 bootstrap，不影響固定的 admin 帳號
    "ADMIN_USERNAME": "bootstrap",
    # 在線感知：縮短在線 / 閒置門檻
    "PRESENCE_ONLINE_SECONDS": "10",
    "PRESENCE_IDLE_SECONDS": "25",
    # 工程追蹤 v2：回報 token、允許掃描的資料夾、本機電腦識別設定的位置（不讀寫使用者家目錄）
    "WORKTREE_REPORT_TOKEN": "e2e-report-token",
    "WORKTREE_SCAN_ROOTS": f"{E2E_DIR}-scan",
    "TASKS_SHEETS_HOME": f"{E2E_DIR}-home",
}


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _wait_health(timeout: float = 60) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{BASE_URL}/api/health", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("E2E 伺服器沒有在時限內就緒")


@pytest.fixture(scope="session")
def server():
    """啟動 E2E 伺服器（整個 session 一次）。"""
    if not _port_free(PORT):
        raise RuntimeError(f"埠 {PORT} 已被佔用；設 E2E_PORT 換一個")
    env = {**os.environ, **E2E_ENV}
    # 不要讓外面的 .env 蓋掉 E2E 設定：config 的優先序是「真實環境變數 > .env」，所以這裡設的就是最終值
    subprocess.run([sys.executable, "-m", "server.e2e_setup"], check=True, cwd=ROOT, env=env)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server.app.main:app", "--port", str(PORT)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )
    try:
        _wait_health()
        yield BASE_URL
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture(scope="session")
def base_url(server):
    return server


@pytest.fixture(scope="session")
def browser_type_launch_args(browser_type_launch_args):
    """容器或無法 `playwright install` 的機器：用 E2E_CHROMIUM_PATH 指定既有的 Chromium。"""
    path = os.environ.get("E2E_CHROMIUM_PATH")
    if path:
        return {**browser_type_launch_args, "executable_path": path}
    return browser_type_launch_args


@pytest.fixture
def users():
    return E2E_USERS
