"""多台電腦同步（docs/sync.md、docs/design/sync.md）。邏輯在 server/app/sync_push.py。

push_router（掛在 /api/sync，屬 PUBLIC_PATHS，以同步金鑰驗證，不需 session）：
- POST /push            上傳一批增量資料（Authorization: Bearer <金鑰> 或 X-Sync-Token）

admin_router（掛在 /api/admin/sync，需 session）：
- GET/POST /sources、PATCH/DELETE /sources/:id、POST /sources/:id/token   → sync.manage
- GET /conflicts?status=、GET /conflicts/:id、POST /conflicts/:id/resolve、POST /conflicts/resolve-bulk → sync.resolve
"""

from __future__ import annotations

import json
import secrets
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

from .. import sync_push as sp
from ..backup import BackupError
from ..config import config
from ..context import Ctx
from ..errors import HttpError, bad_request, forbidden, not_found, pydantic_issues, too_many_requests, validation_error
from ..permissions import require
from ..schemas import DbId
from .auth import client_ip
from .data_admin import _read_limited

push_router = APIRouter()
admin_router = APIRouter()

#: 驗證失敗次數上限（同一 IP、15 分鐘內）；超過後一律 429
AUTH_FAIL_LIMIT = 20
AUTH_FAIL_WINDOW_MS = 15 * 60_000
#: 同一來源每分鐘最多請求數
PUSH_RATE_LIMIT = 120
PUSH_RATE_WINDOW_MS = 60_000
INVALID_TOKEN = "同步金鑰無效或來源已停用"


def _limiter(request: Request) -> sp.RateLimiter:
    st = request.app.state
    lim = getattr(st, "sync_rate", None)
    if lim is None:
        lim = st.sync_rate = sp.RateLimiter()
    return lim


def _threshold_ms(request: Request) -> int:
    minutes = getattr(request.app.state, "sync_auto_resolve_minutes", None)
    return round(float(minutes if minutes is not None else config.SYNC_AUTO_RESOLVE_MINUTES) * 60_000)


def _backup_dir(request: Request) -> str:
    return getattr(request.app.state, "backup_dir", None) or config.BACKUP_DIR


def _sync_error(e: sp.SyncError) -> HttpError:
    return HttpError(e.status, e.code, e.message, e.details if e.details is not None else [])


@push_router.post("/push")
async def push(request: Request):
    st = request.app.state
    now = st.now()
    lim = _limiter(request)
    ip = client_ip(request, st.settings.trusted_proxy)
    fail_key = f"fail:{ip}"
    if lim.count(fail_key, now, AUTH_FAIL_WINDOW_MS) >= AUTH_FAIL_LIMIT:
        raise too_many_requests("驗證失敗次數過多，請稍後再試")
    source = await run_in_threadpool(sp.authenticate, st.db, sp.token_from_headers(request.headers))
    if source is None:
        lim.hit(fail_key, now, AUTH_FAIL_LIMIT, AUTH_FAIL_WINDOW_MS)
        raise forbidden(INVALID_TOKEN)
    if not lim.hit(f"src:{source['id']}", now, PUSH_RATE_LIMIT, PUSH_RATE_WINDOW_MS):
        raise too_many_requests("上傳太頻繁，請稍後再試")
    raw = await _read_limited(request)
    try:
        doc = await run_in_threadpool(sp.parse_push, raw)
    except sp.SyncError as e:
        raise _sync_error(e) from None
    try:
        return await run_in_threadpool(
            lambda: sp.apply_push(
                st.db,
                source["id"],
                doc,
                now=now,
                threshold_ms=_threshold_ms(request),
                backup_dir=_backup_dir(request),
            )
        )
    except sp.SyncError as e:
        raise _sync_error(e) from None
    except (BackupError, OSError) as e:
        raise HttpError(500, "BACKUP_FAILED", f"同步前自動備份失敗，未寫入任何資料：{e}") from None


# ── 管理：同步來源 ──────────────────────────────────────────


def _source_out(r: Any) -> dict[str, Any]:
    summary = None
    if r["last_push_summary"]:
        try:
            summary = json.loads(r["last_push_summary"])
        except ValueError:
            summary = None
    return {
        "id": r["id"],
        "name": r["name"],
        "tokenHint": r["token_hint"],
        "autoCreateUsers": bool(r["auto_create_users"]),
        "isActive": bool(r["is_active"]),
        "createdBy": r["created_by"],
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
        "lastPushAt": r["last_push_at"],
        "lastPushSummary": summary,
        "pendingConflicts": r["pending"] if "pending" in r.keys() else 0,
    }


_SOURCE_SELECT = (
    "SELECT s.*, (SELECT count(*) FROM sync_conflicts c WHERE c.source_id = s.id AND c.status = 'pending') AS pending "
    "FROM sync_sources s"
)


def _get_source(ctx: Ctx, sid: int) -> Any:
    r = ctx.db.one(f"{_SOURCE_SELECT} WHERE s.id = ?", (sid,))
    if r is None:
        raise not_found("找不到這個同步來源")
    return r


def _parse(model: type[BaseModel], raw: bytes) -> Any:
    try:
        return model.model_validate_json(raw or b"{}", strict=True)
    except ValidationError as e:
        raise validation_error(pydantic_issues(e)) from None


Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class SourceCreate(BaseModel):
    model_config = {"extra": "forbid"}
    name: Name
    autoCreateUsers: bool = False


class SourcePatch(BaseModel):
    model_config = {"extra": "forbid"}
    name: Name | None = None
    isActive: bool | None = None
    autoCreateUsers: bool | None = None


@admin_router.get("/sources")
def list_sources(ctx: Ctx = Depends(require("sync.manage"))):
    rows = ctx.db.all(f"{_SOURCE_SELECT} ORDER BY s.created_at, s.id")
    return {"sources": [_source_out(r) for r in rows]}


@admin_router.post("/sources", status_code=201)
async def create_source(request: Request, ctx: Ctx = Depends(require("sync.manage"))):
    data = _parse(SourceCreate, await request.body())
    token = sp.generate_token()
    t = ctx.now()
    with ctx.db.tx() as conn:
        cur = conn.execute(
            "INSERT INTO sync_sources (uid, name, token_hash, token_hint, auto_create_users, is_active, created_by, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
            (secrets.token_hex(16), data.name, sp.hash_token(token), token[-4:], int(data.autoCreateUsers), ctx.user["id"], t, t),
        )
        sid = int(cur.lastrowid)  # type: ignore[arg-type]
    return {"source": _source_out(_get_source(ctx, sid)), "token": token}


@admin_router.patch("/sources/{sid}")
async def patch_source(sid: int, request: Request, ctx: Ctx = Depends(require("sync.manage"))):
    data = _parse(SourcePatch, await request.body())
    _get_source(ctx, sid)
    sets: dict[str, Any] = {}
    if data.name is not None:
        sets["name"] = data.name
    if data.isActive is not None:
        sets["is_active"] = int(data.isActive)
    if data.autoCreateUsers is not None:
        sets["auto_create_users"] = int(data.autoCreateUsers)
    if sets:
        sets["updated_at"] = ctx.now()
        ctx.db.execute(
            f"UPDATE sync_sources SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", (*sets.values(), sid)
        )
    return {"source": _source_out(_get_source(ctx, sid))}


@admin_router.post("/sources/{sid}/token")
def regenerate_token(sid: int, ctx: Ctx = Depends(require("sync.manage"))):
    """重新產生金鑰：舊金鑰立即失效；新金鑰只在此回應中出現一次"""
    _get_source(ctx, sid)
    token = sp.generate_token()
    ctx.db.execute(
        "UPDATE sync_sources SET token_hash = ?, token_hint = ?, updated_at = ? WHERE id = ?",
        (sp.hash_token(token), token[-4:], ctx.now(), sid),
    )
    return {"source": _source_out(_get_source(ctx, sid)), "token": token}


@admin_router.delete("/sources/{sid}")
def delete_source(sid: int, ctx: Ctx = Depends(require("sync.manage"))):
    """刪除來源（金鑰立即失效）。已上傳的資料不受影響；衝突紀錄保留（來源顯示為已刪除）。"""
    _get_source(ctx, sid)
    ctx.db.execute("DELETE FROM sync_sources WHERE id = ?", (sid,))
    return {"ok": True}


# ── 管理：衝突 ──────────────────────────────────────────────


def _user_names(ctx: Ctx) -> dict[int, str]:
    return {r["id"]: r["display_name"] for r in ctx.db.all("SELECT id, display_name FROM users")}


@admin_router.get("/conflicts")
def list_conflicts(request: Request, ctx: Ctx = Depends(require("sync.resolve"))):
    status = request.query_params.get("status") or "pending"
    if status not in ("pending", "resolved"):
        raise bad_request("status 只能是 pending 或 resolved")
    order = "created_at, id" if status == "pending" else "resolved_at DESC, id DESC"
    rows = ctx.db.all(f"SELECT * FROM sync_conflicts WHERE status = ? ORDER BY {order} LIMIT 500", (status,))
    counts = {r["status"]: r["n"] for r in ctx.db.all("SELECT status, count(*) AS n FROM sync_conflicts GROUP BY status")}
    names = _user_names(ctx)
    return {
        "conflicts": [sp.conflict_summary(r, names) for r in rows],
        "counts": {"pending": counts.get("pending", 0), "resolved": counts.get("resolved", 0)},
    }


@admin_router.get("/conflicts/{cid}")
def get_conflict(cid: int, ctx: Ctx = Depends(require("sync.resolve"))):
    out = sp.conflict_detail(ctx.db, cid)
    if out is None:
        raise not_found("找不到這筆衝突")
    return out


Field_ = Annotated[str, StringConstraints(min_length=1, max_length=64)]


class ResolveInput(BaseModel):
    model_config = {"extra": "forbid"}
    resolution: Literal["keep_local", "use_incoming", "merged"]
    #: merged 時逐欄位選擇（未列出的欄位保留中央）
    choices: Annotated[dict[Field_, Literal["local", "incoming"]], Field(max_length=100)] | None = None


class BulkInput(BaseModel):
    model_config = {"extra": "forbid"}
    ids: Annotated[list[DbId], Field(min_length=1, max_length=500)]
    resolution: Literal["keep_local", "use_incoming"]


@admin_router.post("/conflicts/resolve-bulk")
async def resolve_bulk(request: Request, ctx: Ctx = Depends(require("sync.resolve"))):
    data = _parse(BulkInput, await request.body())
    try:
        return await run_in_threadpool(sp.resolve_bulk, ctx.db, data.ids, data.resolution, ctx.user, ctx.now())
    except sp.SyncError as e:
        raise _sync_error(e) from None


@admin_router.post("/conflicts/{cid}/resolve")
async def resolve(cid: int, request: Request, ctx: Ctx = Depends(require("sync.resolve"))):
    data = _parse(ResolveInput, await request.body())
    try:
        await run_in_threadpool(
            sp.resolve_conflict, ctx.db, cid, data.resolution, dict(data.choices or {}), ctx.user, ctx.now()
        )
    except sp.SyncError as e:
        raise _sync_error(e) from None
    return sp.conflict_detail(ctx.db, cid)
