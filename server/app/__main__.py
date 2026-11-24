"""`python -m server.app [--reload]`：以 .env / 環境變數的 HOST、PORT 啟動 uvicorn。"""

import sys

import uvicorn

from .config import config

if __name__ == "__main__":
    reload = "--reload" in sys.argv[1:]
    uvicorn.run(
        "server.app.main:app",
        host=config.HOST,
        port=config.PORT,
        reload=reload,
        reload_dirs=["server"] if reload else None,
        proxy_headers=False,
    )
