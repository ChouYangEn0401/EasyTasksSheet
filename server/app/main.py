"""正式進入點：`python -m uvicorn server.app.main:app --port $PORT`（或 `python -m server.app`）。

啟動時：migration → seed → 首次啟動建立預設管理員（admin / password，首次登入強制重設帳號與密碼）；正式模式同時提供 dist/web 靜態檔。
"""

from __future__ import annotations

import os
import time

from .app import create_app
from .config import config
from .db import create_db, run_migrations, run_seed
from .features.users import ensure_admin

os.environ["TZ"] = config.TZ
if hasattr(time, "tzset"):
    time.tzset()

db = create_db(config.DATABASE_PATH)
run_migrations(db)
run_seed(db)
ensure_admin(db, config.ADMIN_USERNAME, config.ADMIN_PASSWORD, log=lambda m: print(m, flush=True))

# 前端已建置（dist/web 存在）就由同一個行程提供，不論是否為正式模式；
# 開發時另用 Vite（npm run dev:web）也不衝突。
serve_frontend = config.is_production or os.path.isdir(config.STATIC_DIR)
app = create_app(db, static_dir=config.STATIC_DIR if serve_frontend else None)
print(f"[server] FastAPI 已就緒（{config.NODE_ENV}，DB: {config.DATABASE_PATH}）", flush=True)
if not serve_frontend:
    print(f"[server] 找不到前端建置檔（{config.STATIC_DIR}），請先執行 npm ci && npm run build", flush=True)
