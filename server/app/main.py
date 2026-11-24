"""正式進入點：`python -m uvicorn server.app.main:app --port $PORT`（或 `python -m server.app`）。

啟動時：migration → seed → 首次啟動建立預設管理員；正式模式同時提供 dist/web 靜態檔。
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

app = create_app(db, static_dir=config.STATIC_DIR if config.is_production else None)
print(f"[server] FastAPI 已就緒（{config.NODE_ENV}，DB: {config.DATABASE_PATH}）", flush=True)
