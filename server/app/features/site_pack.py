"""整站搬家包 API（設計見 server/app/sitepack.py 與 docs/design/site-pack.md）。

公開（不需登入）：
- GET  /api/setup/status    {pristine, restoreUnlocked, unlockExpiresAt, maxUploadMb}
- POST /api/setup/restore   multipart：file、passphrase。只在全新 server（is_pristine）時可用。

需登入（root 專屬權限，無法下放）：
- POST /api/admin/data/pack            {password} → 建立搬家包，回傳 {id, filename, size, passphrase, manifest}
- GET  /api/admin/data/pack/{id}       下載剛建立的搬家包（同一人、30 分鐘內、下載後刪除）
- POST /api/admin/data/pack/restore    multipart：file、passphrase、password、confirm；
                                        還需 server 本機開啟的「還原解鎖」（python -m server.cli allow-restore）

所有判斷都在後端執行，前端只負責顯示。
"""

from __future__ import annotations

import secrets
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, StringConstraints, ValidationError
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from .. import sitepack as sp
from ..audit import record_audit
from ..config import config
from ..context import Ctx
from ..errors import HttpError, bad_request, forbidden, pydantic_issues, validation_error
from ..permissions import require
from ..security import verify_password
from .eng_attach import attachments_dir

setup_router = APIRouter()
admin_router = APIRouter()

PACK_TTL_SECONDS = 30 * 60


# ── app.state 覆寫（測試用）────────────────────────────────


def _backup_dir(request: Request) -> Path:
    return Path(getattr(request.app.state, "backup_dir", None) or config.BACKUP_DIR)


def _unlock_dir(request: Request) -> Path:
    v = getattr(request.app.state, "restore_unlock_dir", None)
    if v:
        return Path(v)
    db_path = request.app.state.db.path
    return Path(db_path).resolve().parent if db_path != ":memory:" else Path(config.DATABASE_PATH).resolve().parent


def _max_bytes(request: Request) -> int:
    v = getattr(request.app.state, "pack_max_bytes", None)
    return int(v) if v else int(config.PACK_MAX_MB * 1024 * 1024)


def _pack_error(e: sp.PackError) -> HttpError:
    return HttpError(e.status, e.code, e.message)


# ── 狀態 ─────────────────────────────────────────────────


@setup_router.get("/status")
async def setup_status(request: Request) -> dict[str, Any]:
    db = request.app.state.db
    expires = sp.unlock_expires_at(_unlock_dir(request))
    return {
        "pristine": await run_in_threadpool(sp.is_pristine, db),
        "restoreUnlocked": expires is not None,
        "unlockExpiresAt": int(expires * 1000) if expires else None,
        "maxUploadMb": round(_max_bytes(request) / 1024 / 1024),
        "confirmText": sp.CONFIRM_TEXT,
    }


# ── 上傳 ─────────────────────────────────────────────────


async def _receive(request: Request, fields: tuple[str, ...]) -> tuple[Path, dict[str, str]]:
    """讀取 multipart：檔案存到暫存資料夾（回傳路徑，呼叫端負責刪除 parent），其餘為文字欄位"""
    limit = _max_bytes(request)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit + 64 * 1024:
        raise HttpError(413, "PAYLOAD_TOO_LARGE", f"檔案超過大小上限（{limit / 1024 / 1024:g} MB）；大檔請在 server 上用指令匯入")
    form = await request.form(max_files=1, max_fields=len(fields) + 1, max_part_size=64 * 1024)
    try:
        upload = form.get("file")
        if upload is None or isinstance(upload, str) or not hasattr(upload, "read"):
            raise bad_request("請選擇搬家包檔案（.etpack）")
        work = Path(tempfile.mkdtemp(prefix="etpack-upload-", dir=_backup_dir(request) if _backup_dir(request).exists() else None))
        dest = work / "upload.etpack"
        size = 0
        try:
            with dest.open("wb") as out:
                while chunk := await upload.read(1 << 20):
                    size += len(chunk)
                    if size > limit:
                        raise HttpError(413, "PAYLOAD_TOO_LARGE", f"檔案超過大小上限（{limit / 1024 / 1024:g} MB）")
                    out.write(chunk)
        except BaseException:
            shutil.rmtree(work, ignore_errors=True)
            raise
        values = {}
        for f in fields:
            v = form.get(f)
            values[f] = v if isinstance(v, str) else ""
        return dest, values
    finally:
        await form.close()


def _audit_restore(actor_label: str, manifest: dict[str, Any], pre: Path | None):
    def write(conn) -> None:  # type: ignore[no-untyped-def]
        counts = manifest.get("counts") or {}
        record_audit(
            conn,
            actor=None,
            actor_name=actor_label,
            entity_type="import",
            entity_id=None,
            action="pack_restore",
            summary=(
                f"以整站搬家包取代全部資料（帳號 {counts.get('users', 0)}、任務 {counts.get('tasks', 0)}、"
                f"附件 {counts.get('attachments', 0)}）"
            ),
            after={"createdAt": manifest.get("createdAt"), "createdBy": manifest.get("createdBy"), "counts": counts},
            source="system",
            revertable=False,
            note=f"還原前的資料已備份為 {pre.name}" if pre else None,
            entity_label="整站還原",
        )

    return write


def _restore_sync(request: Request, pack: Path, passphrase: str, actor_label: str, require_pristine: bool) -> dict[str, Any]:
    st = request.app.state
    opened = sp.open_pack(pack, passphrase, work_parent=pack.parent)
    try:
        sp.check_compatible(opened.manifest)
        # 解密完成後、動資料前再檢查一次（避免檢查與套用之間狀態改變）
        if require_pristine and not sp.is_pristine(st.db):
            raise sp.PackError("這台 server 已經有資料，不能從登入頁還原", "NOT_PRISTINE", 403)
        manifest = opened.manifest
        result = sp.apply_restore(
            st.db,
            opened,
            attachments_dir=attachments_dir(st),
            backup_dir=_backup_dir(request),
            after_restore=None,
        )
        # 稽核紀錄寫進「還原後」的資料庫
        with st.db.tx() as conn:
            _audit_restore(actor_label, manifest, result.pre_restore_backup)(conn)
        sp.revoke_unlock(_unlock_dir(request))
        return {
            "ok": True,
            "counts": manifest.get("counts"),
            "createdAt": manifest.get("createdAt"),
            "createdBy": manifest.get("createdBy"),
            "preRestoreBackup": result.pre_restore_backup.name if result.pre_restore_backup else None,
            "appliedMigrations": result.applied_migrations,
        }
    finally:
        opened.cleanup()


async def _guarded_restore(request: Request, fields: tuple[str, ...], check, *, require_pristine: bool) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    if not sp.RESTORE_LOCK.acquire(blocking=False):
        raise HttpError(409, "RESTORE_BUSY", "另一個還原正在進行中，請稍後再試")
    try:
        pack, values = await _receive(request, fields)
        try:
            actor_label = check(values)
            return await run_in_threadpool(
                _restore_sync, request, pack, values.get("passphrase", ""), actor_label, require_pristine
            )
        except sp.PackError as e:
            raise _pack_error(e) from None
        finally:
            shutil.rmtree(pack.parent, ignore_errors=True)
    finally:
        sp.RESTORE_LOCK.release()


@setup_router.post("/restore")
async def setup_restore(request: Request) -> dict[str, Any]:
    db = request.app.state.db
    if not await run_in_threadpool(sp.is_pristine, db):
        raise HttpError(403, "NOT_PRISTINE", "這台 server 已經有資料，不能從登入頁還原。請由 root 登入後在「資料管理」操作")
    return await _guarded_restore(request, ("passphrase",), lambda values: "全新安裝還原", require_pristine=True)


@admin_router.post("/restore")
async def admin_restore(request: Request, ctx: Ctx = Depends(require("data.import_replace"))) -> dict[str, Any]:
    if sp.unlock_expires_at(_unlock_dir(request)) is None:
        raise HttpError(
            403,
            "RESTORE_LOCKED",
            "尚未開啟還原解鎖。請用遠端桌面登入 server，在專案資料夾執行 "
            "deploy\\windows\\allow_restore.bat（或 python -m server.cli allow-restore），30 分鐘內有效",
        )

    def check(values: dict[str, str]) -> str:
        if not verify_password(ctx.user["password_hash"], values.get("password", "")):
            raise forbidden("密碼不正確")
        if values.get("confirm", "").strip() != sp.CONFIRM_TEXT:
            raise bad_request(f"請輸入「{sp.CONFIRM_TEXT}」確認")
        return f"{ctx.user['display_name']}（{ctx.user['username']}）"

    return await _guarded_restore(request, ("passphrase", "password", "confirm"), check, require_pristine=False)


# ── 建立與下載 ───────────────────────────────────────────


class CreateInput(BaseModel):
    password: Annotated[str, StringConstraints(min_length=1, max_length=256)]


@dataclass
class _Built:
    path: Path
    owner: int
    expires: float


class _BuiltStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: dict[str, _Built] = {}

    def put(self, item: _Built) -> str:
        key = secrets.token_urlsafe(18)
        with self._lock:
            self._purge()
            self._items[key] = item
        return key

    def take(self, key: str, owner: int) -> _Built | None:
        with self._lock:
            self._purge()
            item = self._items.get(key)
            if item is None or item.owner != owner:
                return None
            return self._items.pop(key)

    def _purge(self) -> None:
        now = time.time()
        for k in [k for k, v in self._items.items() if v.expires < now]:
            shutil.rmtree(self._items.pop(k).path.parent, ignore_errors=True)


def _built(request: Request) -> _BuiltStore:
    st = request.app.state
    store = getattr(st, "site_packs", None)
    if store is None:
        store = st.site_packs = _BuiltStore()
    return store


@admin_router.post("")
async def create_pack(request: Request, ctx: Ctx = Depends(require("data.backup_db"))) -> dict[str, Any]:
    raw = await request.body()
    try:
        data = CreateInput.model_validate_json(raw or b"{}", strict=True)
    except ValidationError as e:
        raise validation_error(pydantic_issues(e)) from None
    if not verify_password(ctx.user["password_hash"], data.password):
        raise forbidden("密碼不正確")
    st = request.app.state
    base = _backup_dir(request)
    base.mkdir(parents=True, exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix="etpack-out-", dir=base))
    try:
        result = await run_in_threadpool(
            sp.build_pack, st.db, attachments_dir(st), out, created_by=ctx.user["username"]
        )
    except BaseException:
        shutil.rmtree(out, ignore_errors=True)
        raise
    key = _built(request).put(_Built(path=result.file, owner=ctx.user["id"], expires=time.time() + PACK_TTL_SECONDS))
    return {
        "id": key,
        "filename": result.file.name,
        "size": result.file.stat().st_size,
        "passphrase": result.passphrase,
        "manifest": {k: result.manifest[k] for k in ("createdAt", "createdBy", "counts", "missingAttachments")},
    }


@admin_router.get("/{key}")
async def download_pack(key: str, request: Request, ctx: Ctx = Depends(require("data.backup_db"))):
    item = _built(request).take(key, ctx.user["id"])
    if item is None or not item.path.is_file():
        raise HttpError(404, "PACK_EXPIRED", "搬家包已下載過或已過期，請重新建立")
    return FileResponse(
        item.path,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{item.path.name}"', "Cache-Control": "no-store"},
        background=BackgroundTask(shutil.rmtree, item.path.parent, ignore_errors=True),
    )
