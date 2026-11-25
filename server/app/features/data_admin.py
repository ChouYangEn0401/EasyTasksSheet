"""/api/admin/data：資料管理。權限見 server/app/permissions.py（不足時 403）：
backup = data.backup_db（root）；export = data.export_json、import = data.import_merge（manager 以上）；
apply 的 mode=replace 另需 data.import_replace（root）。

- GET  /backup          完整 SQLite 快照（VACUUM INTO；含密碼雜湊與 session，屬敏感檔）
- GET  /export          可攜 JSON（業務資料，不含密碼雜湊 / session / 登入紀錄）
- POST /import/preview  上傳匯出檔（body 即匯出檔 JSON），不改資料；回傳統計、衝突、缺少成員與 token
- POST /import/apply    以 token（或 data 重新上傳）＋策略套用；先自動備份到 BACKUP_DIR，單一 transaction
邏輯在 server/app/data_transfer.py（CLI 共用）。
"""

from __future__ import annotations

import json
import secrets
import shutil
import tempfile
import threading
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, StringConstraints, ValidationError
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from .. import audit_events
from .. import data_transfer as dt
from ..backup import BackupError
from ..config import config
from ..errors import HttpError, bad_request, pydantic_issues, validation_error
from ..context import Ctx
from ..permissions import check, require

router = APIRouter()

PREVIEW_TTL_MS = 30 * 60_000
#: 同時保留的預覽數（每份可能很大，只留最近幾份）
PREVIEW_MAX = 3


@dataclass
class _Preview:
    user_id: int
    expires_at: int
    doc: dict[str, Any]


class PreviewStore:
    def __init__(self) -> None:
        self._items: dict[str, _Preview] = {}
        self._lock = threading.Lock()

    def put(self, user_id: int, doc: dict[str, Any], now: int) -> tuple[str, int]:
        token = secrets.token_urlsafe(24)
        expires = now + PREVIEW_TTL_MS
        with self._lock:
            self._items = {k: v for k, v in self._items.items() if v.expires_at > now}
            while len(self._items) >= PREVIEW_MAX:
                self._items.pop(next(iter(self._items)))
            self._items[token] = _Preview(user_id, expires, doc)
        return token, expires

    def get(self, token: str, user_id: int, now: int) -> dict[str, Any] | None:
        with self._lock:
            p = self._items.get(token)
            if p is None or p.user_id != user_id or p.expires_at <= now:
                return None
            return p.doc

    def drop(self, token: str) -> None:
        with self._lock:
            self._items.pop(token, None)


def _store(request: Request) -> PreviewStore:
    st = request.app.state
    store = getattr(st, "import_previews", None)
    if store is None:
        store = st.import_previews = PreviewStore()
    return store


def _max_bytes(request: Request) -> int:
    v = getattr(request.app.state, "import_max_bytes", None)
    return int(v) if v else int(config.DATA_IMPORT_MAX_MB * 1024 * 1024)


def _backup_dir(request: Request) -> str:
    return getattr(request.app.state, "backup_dir", None) or config.BACKUP_DIR


def _too_large(limit: int) -> HttpError:
    return HttpError(413, "PAYLOAD_TOO_LARGE", f"檔案超過大小上限（{limit / 1024 / 1024:g} MB）")


async def _read_limited(request: Request) -> bytes:
    """讀取 body，超過上限立即中止（不先整份讀進記憶體）"""
    limit = _max_bytes(request)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise _too_large(limit)
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise _too_large(limit)
        chunks.append(chunk)
    return b"".join(chunks)


def _transfer_error(e: dt.TransferError) -> HttpError:
    return HttpError(400, "IMPORT_INVALID", e.message, e.details if e.details is not None else [])


def _attachment(name: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"}


@router.get("/backup")
async def download_backup(ctx: Ctx = Depends(require("data.backup_db"))):
    tmp = tempfile.mkdtemp(prefix="tasks-sheets-download-")
    try:
        file = await run_in_threadpool(dt.snapshot, ctx.db, tmp, "backup")
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    return FileResponse(
        file,
        media_type="application/vnd.sqlite3",
        headers=_attachment(dt.export_filename("tasks-sheets-backup", "db")),
        background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True),
    )


@router.get("/export")
async def download_export(ctx: Ctx = Depends(require("data.export_json"))):
    doc = await run_in_threadpool(dt.export_document, ctx.db, ctx.now())
    body = json.dumps(doc, ensure_ascii=False, indent=1)
    return Response(
        body.encode("utf-8"),
        media_type="application/json; charset=utf-8",
        headers=_attachment(dt.export_filename("tasks-sheets-export", "json")),
    )


def _preview(db: Any, doc: dict[str, Any]) -> dict[str, Any]:
    with db.tx() as conn:
        plan = dt.plan_import(conn, doc)
    return dt.preview_summary(plan, doc)


@router.post("/import/preview")
async def import_preview(request: Request, ctx: Ctx = Depends(require("data.import_merge"))):
    raw = await _read_limited(request)
    try:
        doc = await run_in_threadpool(dt.parse_document, raw)
    except dt.TransferError as e:
        raise _transfer_error(e) from None
    summary = await run_in_threadpool(_preview, ctx.db, doc)
    token, expires = _store(request).put(ctx.user["id"], doc, ctx.now())
    return {**summary, "token": token, "expiresAt": expires}


class ApplyInput(BaseModel):
    model_config = {"extra": "forbid"}
    token: Annotated[str, StringConstraints(min_length=1, max_length=100)] | None = None
    #: 不用 token 時直接重新上傳匯出檔內容
    data: dict[str, Any] | None = None
    mode: Literal["merge", "replace"] = "merge"
    strategy: Literal["keep_newer", "keep_local", "use_import"] = "keep_newer"
    overrides: Annotated[
        dict[Annotated[str, StringConstraints(max_length=200)], Literal["keep_local", "use_import"]],
        Field(max_length=dt.MAX_ITEMS),
    ] = {}
    missingUsers: Literal["skip", "create"] = "skip"
    confirm: Annotated[str, StringConstraints(max_length=100)] | None = None


@router.post("/import/apply")
async def import_apply(request: Request, ctx: Ctx = Depends(require("data.import_merge"))):
    raw = await _read_limited(request)
    try:
        json.loads(raw)
    except (ValueError, RecursionError, UnicodeDecodeError):
        raise bad_request("請求內容須為 JSON") from None
    try:
        data = ApplyInput.model_validate_json(raw, strict=True)
    except ValidationError as e:
        raise validation_error(pydantic_issues(e)) from None
    if data.mode == "replace":
        check(ctx, "data.import_replace")

    store = _store(request)
    if data.data is not None:
        try:
            doc = await run_in_threadpool(dt.parse_document, data.data)
        except dt.TransferError as e:
            raise _transfer_error(e) from None
    elif data.token:
        doc = store.get(data.token, ctx.user["id"], ctx.now())
        if doc is None:
            raise HttpError(400, "PREVIEW_EXPIRED", "預覽已過期或不存在，請重新選擇檔案預覽")
    else:
        raise bad_request("請提供預覽 token 或匯出檔內容")

    opts = dt.ApplyOptions(
        strategy=data.strategy,
        overrides=dict(data.overrides),
        missing_users=data.missingUsers,
        mode=data.mode,
        confirm=data.confirm,
    )
    t = ctx.now()
    try:
        result = await run_in_threadpool(
            lambda: dt.apply_import(
                ctx.db,
                doc,
                opts,
                actor_id=ctx.user["id"],
                now=t,
                backup_dir=_backup_dir(request),
                on_applied=lambda conn, res: audit_events.import_applied(conn, ctx.user, res, t),
            )
        )
    except dt.TransferError as e:
        raise _transfer_error(e) from None
    except (BackupError, OSError) as e:
        raise HttpError(500, "BACKUP_FAILED", f"匯入前自動備份失敗，未進行匯入：{e}") from None
    if data.token:
        store.drop(data.token)
    result.pop("backupPath", None)
    return result
