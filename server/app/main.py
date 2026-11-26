"""ASGI 進入點：`python main.py`（建議）或 `python -m uvicorn server.app.main:app --port $PORT`。

啟動時：migration → seed → 首次啟動建立預設管理員（admin / password，首次登入強制重設帳號與密碼）；
同一個行程提供前端（`web/`：原生 ES modules，沒有建置步驟）。
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from .app import create_app
from .audit import prune_on_startup
from .changes import prune_on_startup as prune_changes_on_startup
from .config import config
from .db import create_db, run_migrations, run_seed
from .features.users import ensure_admin

os.environ["TZ"] = config.TZ
if hasattr(time, "tzset"):
    time.tzset()

#: 前端目錄：固定在專案的 web/（不再由環境變數指定，免得舊 .env 殘留的 STATIC_DIR 默默提供舊版前端）
WEB_DIR = Path(__file__).resolve().parents[2] / "web"

if not (WEB_DIR / "index.html").is_file():
    print(f"[server] 錯誤：找不到前端 {WEB_DIR / 'index.html'}；專案不完整，請重新取得完整的專案資料夾。", flush=True)
    raise SystemExit(1)
if os.environ.get("STATIC_DIR"):
    print("[server] 提示：環境變數 STATIC_DIR 已不再使用（前端固定在 web/），可從 .env 移除。", flush=True)

db = create_db(config.DATABASE_PATH)
run_migrations(db)
run_seed(db)
prune_on_startup(db)  # 稽核紀錄保留期限（AUDIT_RETENTION_DAYS）；之後寫入時每日檢查一次
prune_changes_on_startup(db)  # 變更流水保留期限（CHANGES_RETENTION_DAYS）；之後寫入時每日檢查一次
ensure_admin(db, config.ADMIN_USERNAME, config.ADMIN_PASSWORD, log=lambda m: print(m, flush=True))

app = create_app(db, static_dir=str(WEB_DIR), base_path=config.BASE_PATH)
print(
    f"[server] FastAPI 已就緒（{config.APP_ENV}，DB: {config.DATABASE_PATH}，BASE_PATH: {config.BASE_PATH or '/'}）",
    flush=True,
)
