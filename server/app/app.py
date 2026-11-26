"""建立 FastAPI app。所有 feature router 在此一次掛好；各軌道只需修改自己的 features/<name>.py。"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import time
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

# Windows 的登錄檔常把 .js 對到 text/plain，瀏覽器會拒絕以 ES module 載入；這裡一律釘死
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("font/woff2", ".woff2")

from .config import config
from .db import Database
from .errors import HttpError, error_body, error_response, install_error_handlers
from .permissions import guard_write
from .security import csrf_check, require_session
from .settings import auth_settings_from
from .stub import ALL_METHODS
from .features import admin, auth, data_admin, eng, feedback, overview, personal, profile, projects, properties, sync, tasks, users
from .features import permissions_admin
from .features import eng_attach
from .features import presence
from .features import sync_push
from .features import eng_paste, eng_status
from .features import task_relations
from .features import dependencies
from .features import task_checklist
from .features import audit_log
from .features import task_comments
from .features import site_pack
from .version import APP_NAME, AUTHOR, REPOSITORY, __version__

#: 不需登入的路由。/api/eng/worktrees/report 由端點自行以 WORKTREE_REPORT_TOKEN 驗證（仍受 CSRF 檢查約束）
PUBLIC_PATHS = {
    "/api/health",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/eng/worktrees/report",
    # 多台電腦同步：以同步來源金鑰驗證（server/app/features/sync_push.py）
    "/api/sync/push",
    # 整站搬家包：狀態查詢與「全新 server」的還原（後端自行檢查只在全新時可用）
    "/api/setup/status",
    "/api/setup/restore",
}


def _real_now() -> int:
    return int(time.time() * 1000)


def create_app(
    db: Database,
    now: Callable[[], int] | None = None,
    settings: dict[str, Any] | None = None,
    static_dir: str | None = None,
    base_path: str = "",
) -> FastAPI:
    """建立 app。now：可注入時鐘（unix ms）；settings：AuthSettings 欄位覆寫（測試用）；
    static_dir：前端目錄（含 index.html 與 static/；None = 只提供 API）。index.html 是模板，每次請求代入 BASE_PATH；
    base_path：子路徑前綴（BASE_PATH，例如 /easytasks；空 = 根目錄）。"""
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db = db
    app.state.now = now or _real_now
    app.state.settings = auth_settings_from(config).with_overrides(**(settings or {}))
    install_error_handlers(app)

    @app.middleware("http")
    async def api_guard(request: Request, call_next):  # type: ignore[no-untyped-def]
        # 與路由器比對同一個值（scope["path"]：已解碼、不含 root_path / query）；request.url.path 會重新編碼，
        # 兩者不一致時可能讓授權判斷與實際命中的路由不同
        path = request.scope["path"]
        if path == "/api" or path.startswith("/api/"):
            st = request.app.state
            try:
                csrf_check(request, st.settings)
                if path not in PUBLIC_PATHS:
                    user, session = require_session(st.db, st.settings, request, st.now())
                    request.state.user = user
                    request.state.session = session
                    # 一般協作權限（任務、回饋…）依權限設定的有效矩陣檢查（server/app/permissions.py）
                    denied = guard_write(user, request.method, path, st.db)
                    if denied is not None:
                        raise denied
            except HttpError as err:
                return error_response(err)
        return await call_next(request)

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "time": app.state.now(),
            "app": APP_NAME,
            "version": __version__,
            "author": AUTHOR,
            "repository": REPOSITORY,
        }

    app.include_router(auth.router, prefix="/api/auth")
    app.include_router(users.router, prefix="/api/users")
    app.include_router(profile.router, prefix="/api/profile")
    app.include_router(projects.router, prefix="/api/projects")
    app.include_router(projects.statuses_router, prefix="/api/statuses")
    # 任務依賴 / 延遲鏈：須在 tasks.router 之前（/api/tasks/delay-chains 不可被 /{id} 攔截）
    app.include_router(dependencies.router, prefix="/api/tasks")
    app.include_router(tasks.router, prefix="/api/tasks")
    app.include_router(task_relations.router, prefix="/api/tasks")
    app.include_router(task_checklist.router, prefix="/api/tasks")
    app.include_router(audit_log.task_router, prefix="/api/tasks")
    app.include_router(task_comments.router, prefix="/api/tasks")
    app.include_router(properties.router, prefix="/api/properties")
    app.include_router(overview.router, prefix="/api/overview")
    app.include_router(feedback.router, prefix="/api/feedback")
    app.include_router(personal.router, prefix="/api/personal")
    app.include_router(eng.router, prefix="/api/eng")
    app.include_router(eng_status.router, prefix="/api/eng")
    app.include_router(eng_paste.router, prefix="/api/eng")
    app.include_router(eng_attach.router, prefix="/api/eng")
    app.include_router(eng_attach.files_router, prefix="/api/attachments")
    # 須在 admin.router 之前：admin 有 /api/admin/* 的 fallback
    app.include_router(site_pack.setup_router, prefix="/api/setup")
    app.include_router(site_pack.admin_router, prefix="/api/admin/data/pack")
    app.include_router(data_admin.router, prefix="/api/admin/data")
    app.include_router(permissions_admin.router, prefix="/api/admin/permissions")
    app.include_router(sync_push.admin_router, prefix="/api/admin/sync")
    app.include_router(audit_log.router, prefix="/api/admin/audit")
    app.include_router(sync_push.push_router, prefix="/api/sync")
    app.include_router(admin.router, prefix="/api/admin")
    app.include_router(sync.changes_router, prefix="/api/changes")
    app.include_router(sync.events_router, prefix="/api/events")
    app.include_router(presence.router, prefix="/api/presence")

    # 未知的 /api/* 一律回 JSON 404（放在所有 API 之後、SPA fallback 之前）
    async def api_not_found() -> JSONResponse:
        return JSONResponse(error_body("NOT_FOUND", "找不到 API"), status_code=404)

    app.add_api_route("/api", api_not_found, methods=ALL_METHODS, include_in_schema=False)
    app.add_api_route("/api/{rest:path}", api_not_found, methods=ALL_METHODS, include_in_schema=False)

    if static_dir is not None:
        _mount_spa(app, Path(static_dir), base_path, recompute=not config.is_production)
    if base_path:
        # 最外層：先去掉子路徑前綴，內部所有路由與檢查仍以 /api/... 為準
        app.add_middleware(StripBasePath, base_path=base_path)
    return app


class StripBasePath:
    """子路徑部署（BASE_PATH=/easytasks）：請求路徑若帶前綴就去掉。

    nginx 以 `proxy_pass http://127.0.0.1:PORT/;`（結尾斜線）轉發時前綴已被去掉，這裡不做任何事；
    直接連後端（http://127.0.0.1:PORT/easytasks/）或 proxy_pass 不去前綴時，由這裡去掉。兩種都能用。
    """

    def __init__(self, app: Any, base_path: str) -> None:
        self.app = app
        self.base = base_path

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] in ("http", "websocket"):
            path: str = scope.get("path", "")
            if path == self.base or path.startswith(self.base + "/"):
                scope = dict(scope)
                scope["path"] = path[len(self.base) :] or "/"
                raw = scope.get("raw_path")
                if isinstance(raw, bytes | bytearray) and raw.startswith(self.base.encode()):
                    scope["raw_path"] = bytes(raw[len(self.base) :]) or b"/"
        await self.app(scope, receive, send)


def _static_version(static_root: Path) -> str:
    """static/ 底下所有檔案的（相對路徑、大小、修改時間）雜湊，當作網址裡的版本段。檔案一變網址就變，舊快取自然失效。"""
    h = hashlib.sha1()
    for dirpath, dirnames, filenames in os.walk(static_root):
        dirnames.sort()
        for name in sorted(filenames):
            full = Path(dirpath) / name
            st = full.stat()
            h.update(f"{full.relative_to(static_root).as_posix()}|{st.st_size}|{st.st_mtime_ns}\n".encode())
    return h.hexdigest()[:12]


def _mount_spa(app: FastAPI, root: Path, base_path: str = "", recompute: bool = True) -> None:
    """同一行程提供前端（無建置步驟的 ES modules）。

    - `index.html` 是模板：`{{BASE}}` → BASE_PATH、`{{STATIC}}` → `{BASE}/static/v/<版本>`；每次請求代入，回 no-cache。
    - `/static/v/<版本>/...`：版本化路徑，回一年 immutable 快取。模組之間以相對路徑互相 import，自然都落在同一個版本段底下。
    - `/static/...`（沒有版本段）：回 no-cache，給人直接看或除錯用。
    - `/static/` 底下找不到檔回 404（不能回 index.html，否則瀏覽器只會看到難懂的 MIME 錯誤）。
    - 其他路徑一律回 index.html（SPA 路由）。
    - recompute：每次回 index.html 都重算版本（開發：改了 JS 重新整理就生效）；正式模式啟動時算一次，改檔要重啟。
    """
    root = root.resolve()
    static_root = (root / "static").resolve()
    template = (root / "index.html").read_text(encoding="utf-8")
    cached_version = _static_version(static_root) if static_root.is_dir() else "0"

    def render_index() -> HTMLResponse:
        ver = _static_version(static_root) if (recompute and static_root.is_dir()) else cached_version
        html = template.replace("{{STATIC}}", f"{base_path}/static/v/{ver}").replace("{{BASE}}", base_path)
        return HTMLResponse(html, headers={"Cache-Control": "no-cache"})

    def serve_static(rel: str, immutable: bool) -> Response:
        candidate = (static_root / rel).resolve()
        if not (candidate.is_relative_to(static_root) and candidate.is_file()):
            return JSONResponse({"error": "NOT_FOUND", "message": f"找不到靜態檔：{rel}"}, status_code=404)
        headers = {"Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"}
        return FileResponse(candidate, headers=headers)

    async def spa(rest: str = ""):  # type: ignore[no-untyped-def]
        if rest == "static" or rest.startswith("static/"):
            rel = rest[len("static/") :]
            if rel.startswith("v/"):
                parts = rel.split("/", 2)
                return serve_static(parts[2] if len(parts) == 3 else "", immutable=True)
            return serve_static(rel, immutable=False)
        return render_index()

    app.add_api_route("/", spa, methods=["GET", "HEAD"], include_in_schema=False)
    app.add_api_route("/{rest:path}", spa, methods=["GET", "HEAD"], include_in_schema=False)
