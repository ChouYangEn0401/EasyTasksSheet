"""專案進入點：`python main.py`

啟動 Python 後端（FastAPI + uvicorn）。啟動時自動建立資料庫、套用 migration、寫入預設資料，
並在沒有任何帳號時建立預設管理員 admin / password（可由 .env 的 ADMIN_USERNAME / ADMIN_PASSWORD
覆寫），首次登入須重設帳號與密碼。

用法：
    python main.py              開發模式（HOST / PORT 讀 .env，預設 http://127.0.0.1:3000）
    python main.py --reload     程式修改後自動重載
    python main.py --prod       正式模式（cookie 要求 HTTPS，請搭配反向代理）

其他管理指令：`python -m server.cli --help`（新增帳號、備份、還原）。
"""

import os
import sys

import uvicorn

if __name__ == "__main__":
    args = sys.argv[1:]
    if "--prod" in args:
        os.environ["NODE_ENV"] = "production"

    # 必須在設定 NODE_ENV 之後才載入設定
    from server.app.config import config

    reload = "--reload" in args

    # 0.0.0.0 只是「監聽所有網卡」，瀏覽器不能開；印出可直接點的網址
    print(f"\n>>> 請用瀏覽器開啟： http://localhost:{config.PORT}\n", flush=True)
    uvicorn.run(
        "server.app.main:app",
        host=config.HOST,
        port=config.PORT,
        reload=reload,
        reload_dirs=["server"] if reload else None,
        proxy_headers=False,
        timeout_graceful_shutdown=3,  # SSE 長連線不應讓關機卡住
    )
