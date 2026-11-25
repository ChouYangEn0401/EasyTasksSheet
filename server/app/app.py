"""建立 FastAPI app。所有 feature router 在此一次掛好；各軌道只需修改自己的 features/<name>.py。"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

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

#: 不需登入的路由。/api/eng/worktrees/report 由端點自行以 WORKTREE_REPORT_TOKEN 驗證（仍受 CSRF 檢查約束）
PUBLIC_PATHS = {
    "/api/health",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/eng/worktrees/report",
    # 多台電腦同步：以同步來源金鑰驗證（server/app/features/sync_push.py）
    "/api/sync/push",
}


def _real_now() -> int:
    return int(time.time() * 1000)


def create_app(
    db: Database,
    now: Callable[[], int] | None = None,
    settings: dict[str, Any] | None = None,
    static_dir: str | None = None,
) -> FastAPI:
    """建立 app。now：可注入時鐘（unix ms）；settings：AuthSettings 欄位覆寫（測試用）；
    static_dir：正式模式提供前端靜態檔與 SPA fallback 的目錄（None = 不提供）。"""
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db = db
    app.state.now = now or _real_now
    app.state.settings = auth_settings_from(config).with_overrides(**(settings or {}))
    install_error_handlers(app)

    @app.middleware("http")
    async def api_guard(request: Request, call_next):  # type: ignore[no-untyped-def]
        path = request.url.path
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
        return {"ok": True, "time": app.state.now()}

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
    app.include_router(data_admin.router, prefix="/api/admin/data")
    app.include_router(permissions_admin.router, prefix="/api/admin/permissions")
    app.include_router(sync_push.admin_router, prefix="/api/admin/sync")
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
        _mount_spa(app, Path(static_dir))
    return app


def _mount_spa(app: FastAPI, root: Path) -> None:
    """正式模式：同一行程提供前端靜態檔，非 /api 路徑回退到 index.html（SPA）"""
    root = root.resolve()
    index_html = (root / "index.html").read_text(encoding="utf-8")

    async def spa(rest: str = ""):  # type: ignore[no-untyped-def]
        if rest:
            candidate = (root / rest).resolve()
            if candidate.is_relative_to(root) and candidate.is_file():
                return FileResponse(candidate)
        return HTMLResponse(index_html)

    app.add_api_route("/", spa, methods=["GET", "HEAD"], include_in_schema=False)
    app.add_api_route("/{rest:path}", spa, methods=["GET", "HEAD"], include_in_schema=False)
