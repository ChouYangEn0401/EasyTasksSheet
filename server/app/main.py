"""正式進入點：`python -m uvicorn server.app.main:app --port $PORT`（或 `python -m server.app`）。

啟動時：migration → seed → 首次啟動建立預設管理員（admin / password，首次登入強制重設帳號與密碼）；正式模式同時提供 dist/web 靜態檔。
"""

from __future__ import annotations

import os
import time

from .app import create_app
from .audit import prune_on_startup
from .changes import prune_on_startup as prune_changes_on_startup
from .config import config
from .db import create_db, run_migrations, run_seed
from .features.users import ensure_admin

os.environ["TZ"] = config.TZ
if hasattr(time, "tzset"):
    time.tzset()

# 前端建置檔（dist/web/index.html）存在就由同一個行程提供，不論是否為正式模式；開發時另用 Vite 也不衝突。
# 正式模式一定要有：沒有就在動到資料庫之前，用一行說明結束，而不是噴出 FileNotFoundError。
_index_html = os.path.join(config.STATIC_DIR, "index.html")
serve_frontend = os.path.isfile(_index_html)
if config.is_production and not serve_frontend:
    print(
        f"[server] 錯誤：找不到前端建置檔 {os.path.abspath(_index_html)}，無法以正式模式啟動。\n"
        "         請先建置前端：Windows 跑 deploy\\windows\\setup_easytasks.bat；"
        "或在專案資料夾執行 npm ci 與 npm run build（會讀 .env 的 BASE_PATH）。",
        flush=True,
    )
    raise SystemExit(1)

db = create_db(config.DATABASE_PATH)
run_migrations(db)
run_seed(db)
prune_on_startup(db)  # 稽核紀錄保留期限（AUDIT_RETENTION_DAYS）；之後寫入時每日檢查一次
prune_changes_on_startup(db)  # 變更流水保留期限（CHANGES_RETENTION_DAYS）；之後寫入時每日檢查一次
ensure_admin(db, config.ADMIN_USERNAME, config.ADMIN_PASSWORD, log=lambda m: print(m, flush=True))

app = create_app(db, static_dir=config.STATIC_DIR if serve_frontend else None, base_path=config.BASE_PATH)
print(f"[server] FastAPI 已就緒（{config.NODE_ENV}，DB: {config.DATABASE_PATH}，BASE_PATH: {config.BASE_PATH or '/'}）", flush=True)


def _check_built_base() -> None:
    """前端的網址前綴是建置時寫死的；與目前 BASE_PATH 不同時頁面會空白，啟動時先提醒。"""
    index = _index_html
    with open(index, encoding="utf-8") as f:
        html = f.read()
    expected = f'"{config.BASE_PATH}/assets/'
    if "/assets/" in html and expected not in html:
        print(
            f"[server] 警告：{index} 不是用 BASE_PATH={config.BASE_PATH or '（空）'} 建置的，頁面會載不到資源。"
            "請在 .env 設好 BASE_PATH 後重新執行 npm run build。",
            flush=True,
        )


if serve_frontend:
    _check_built_base()
else:
    print(f"[server] 找不到前端建置檔（{_index_html}），只提供 API；請先執行 npm ci && npm run build", flush=True)
