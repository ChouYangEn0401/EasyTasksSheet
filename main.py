"""專案唯一的啟動入口：`python main.py`

整個系統只有 Python：後端（FastAPI + uvicorn + SQLite）與前端（web/ 底下的原生 ES modules，
沒有建置步驟、不需要 Node.js）由同一個行程提供。

用法：
    python main.py              開發模式（HOST / PORT 讀 .env，預設 http://127.0.0.1:3000）
    python main.py --reload     程式修改後自動重載（只看 server/）
    python main.py --prod       正式模式（cookie 要求 HTTPS，請搭配反向代理）
    python main.py --port 3001  這一次改用別的埠（不改 .env）
    python main.py --help       只印用法，什麼都不啟動

第一次使用：`python scripts/install.py`（建 .venv、裝套件、建資料夾、複製 .env 範本）。
其他管理指令：`python -m server.cli --help`（新增帳號、備份、還原、搬家包）。

啟動時自動建立資料庫、套用 migration、寫入預設資料；沒有任何帳號時建立預設管理員
admin / password（可由 .env 的 ADMIN_USERNAME / ADMIN_PASSWORD 覆寫），首次登入須重設帳號與密碼。
"""

from __future__ import annotations

import argparse
import os
import socket
import sys

#: 埠被佔、服務沒起來（與 uvicorn 綁不到埠時的結束代碼相同）
EXIT_PORT_IN_USE = 3


def port_problem(host: str, port: int) -> str | None:
    """啟動前先問一次「這個埠綁得到嗎」。

    uvicorn 是先載入應用程式（這裡會跑 migration、動到資料庫）再綁埠；第二個實例對著同一份資料庫起來、
    最後卻因為埠被佔而退出，等於白白動了一次資料。所以先試連、再試綁，不行就什麼都不碰直接結束。
    """
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "") else host
    try:
        with socket.create_connection((probe_host, port), timeout=0.3):
            return f"埠 {port} 已有服務在聽（可能是另一個 EasyTasksSheet 已在跑）。"
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
    except OSError as e:
        return f"埠 {port} 綁不起來：{e}"
    return None


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python main.py", description="啟動 EasyTasksSheet（後端與前端同一個行程）")
    p.add_argument("--prod", action="store_true", help="正式模式（等同 APP_ENV=production）")
    p.add_argument("--reload", action="store_true", help="程式修改後自動重載（開發用）")
    p.add_argument("--host", help="監聽位址（預設讀 .env 的 HOST，再預設 127.0.0.1）")
    p.add_argument("--port", type=int, help="監聽埠（預設讀 .env 的 PORT，再預設 3000）")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.prod:
        os.environ["APP_ENV"] = "production"

    try:
        import uvicorn
    except ImportError:
        print(
            "找不到套件 uvicorn：請先執行  python scripts/install.py\n"
            "（或自行  pip install -r requirements.txt）",
            file=sys.stderr,
            flush=True,
        )
        return 1

    # 必須在設定 APP_ENV 之後才載入設定（它會讀 .env）
    from server.app.config import config

    host = args.host or config.HOST
    port = args.port or config.PORT

    problem = port_problem(host, port)
    if problem:
        print(f"[main] {problem}\n       換一個埠：python main.py --port {port + 1}", file=sys.stderr, flush=True)
        return EXIT_PORT_IN_USE

    # 0.0.0.0 只是「監聽所有網卡」，瀏覽器不能開；印出可直接點的網址
    shown_host = "localhost" if host in ("0.0.0.0", "127.0.0.1", "") else host
    print(f"\n>>> 請用瀏覽器開啟： http://{shown_host}:{port}{config.BASE_PATH}/\n", flush=True)
    uvicorn.run(
        "server.app.main:app",
        host=host,
        port=port,
        reload=args.reload,
        reload_dirs=["server"] if args.reload else None,
        proxy_headers=False,
        timeout_graceful_shutdown=3,  # SSE 長連線不應讓關機卡住
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
