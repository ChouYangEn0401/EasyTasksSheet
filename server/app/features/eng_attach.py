"""工程問題的附件與連結預覽（docs/design/eng-tracking.md §8、§9）。

- POST   /api/eng/issues/:id/attachments   multipart/form-data（可多檔，欄位名稱不限）
- POST   /api/eng/issues/:id/preview       重新取得連結預覽（同步，回傳預覽）
- GET    /api/attachments/:id              下載 / 顯示（支援 Range；?download=1 強制下載）
- GET    /api/attachments/:id/thumb        圖片縮圖（未安裝 Pillow 時回傳原圖，由前端 CSS 縮放）
- DELETE /api/attachments/:id

附件機制本身是通用的（entity_type + entity_id），目前只接到 manual_issue；要擴到任務時在 ENTITIES 加一筆即可。
設定可由 app.state 覆寫（測試用）：attachments_dir、attachment_limits、link_preview_enabled、link_fetcher。
"""

from __future__ import annotations

import io
import re
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .. import attachments as att
from ..changes import EntityType, record_change
from ..config import config
from ..context import get_ctx
from ..db import Database
from ..errors import HttpError, bad_request, not_found
from ..github import parse_issue_url
from ..link_preview import PreviewError, SafeFetcher
from ..validate import parse_id

router = APIRouter()
files_router = APIRouter()

#: entity_type → (資料表, 變更流水的實體類型)
ENTITIES: dict[str, tuple[str, EntityType]] = {"manual_issue": ("manual_issues", "repo")}
ISSUE = "manual_issue"
_ISSUE_NOT_FOUND = "此問題不存在或已被刪除"
_ATT_NOT_FOUND = "此附件不存在或已被刪除"


# ── 設定 ────────────────────────────────────────────────────


def attachments_dir(state: Any) -> Path:
    return Path(getattr(state, "attachments_dir", None) or config.ATTACHMENTS_DIR)


def limits(state: Any) -> att.Limits:
    custom = getattr(state, "attachment_limits", None)
    if custom is not None:
        return custom
    return att.Limits(
        max_bytes=int(config.ATTACHMENT_MAX_MB * att.MB),
        video_max_bytes=int(config.ATTACHMENT_VIDEO_MAX_MB * att.MB),
        max_files=config.ATTACHMENT_MAX_PER_ITEM,
    )


def preview_enabled(state: Any) -> bool:
    return bool(getattr(state, "link_preview_enabled", config.LINK_PREVIEW_ENABLED))


def fetcher(state: Any) -> Any:
    return getattr(state, "link_fetcher", None) or SafeFetcher(allow_private=config.LINK_PREVIEW_ALLOW_PRIVATE)


# ── 轉換 ────────────────────────────────────────────────────


def attachment_json(r: sqlite3.Row) -> dict[str, Any]:
    kind = att.kind_of_mime(r["mime"])
    return {
        "id": r["id"],
        "entityType": r["entity_type"],
        "entityId": r["entity_id"],
        "name": r["original_name"],
        "mime": r["mime"],
        "kind": kind,
        "size": r["size"],
        "uploadedBy": r["uploaded_by"],
        "createdAt": r["created_at"],
        "url": f"/api/attachments/{r['id']}",
        "thumbUrl": f"/api/attachments/{r['id']}/thumb" if kind == "image" else None,
    }


def preview_json(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "url": r["url"],
        "status": r["status"],
        "title": r["title"],
        "description": r["description"],
        "imageUrl": r["image_url"],
        "faviconUrl": r["favicon_url"],
        "siteName": r["site_name"],
        "summary": r["summary"],
        "contentType": r["content_type"],
        "error": r["error"],
        "fetchedAt": r["fetched_at"],
    }


def issue_extras(request: Request) -> dict[str, Any]:
    """GET /api/eng/issues 附帶的資料：各問題的附件清單與連結預覽（以問題 id 字串為鍵）、上傳限制"""
    state = request.app.state
    db: Database = state.db
    files: dict[str, list[dict[str, Any]]] = {}
    for r in db.all("SELECT * FROM attachments WHERE entity_type = ? ORDER BY created_at, id", (ISSUE,)):
        files.setdefault(str(r["entity_id"]), []).append(attachment_json(r))
    previews = {
        str(r["entity_id"]): preview_json(r)
        for r in db.all("SELECT * FROM link_previews WHERE entity_type = ?", (ISSUE,))
    }
    return {
        "attachments": files,
        "previews": previews,
        "attachmentLimits": _limits_json(limits(state)),
        "linkPreviewEnabled": preview_enabled(state),
    }


def _limits_json(lim: att.Limits) -> dict[str, Any]:
    return {"maxBytes": lim.max_bytes, "videoMaxBytes": lim.video_max_bytes, "maxFiles": lim.max_files}


# ── 給 eng.py 呼叫的掛勾 ─────────────────────────────────────


def issue_stored_names(conn: sqlite3.Connection, iid: int) -> list[str]:
    return [
        r[0]
        for r in conn.execute(
            "SELECT stored_name FROM attachments WHERE entity_type = ? AND entity_id = ?", (ISSUE, iid)
        )
    ]


def remove_stored(request: Request, names: list[str]) -> None:
    """問題實際刪除後（資料列由 trigger 刪除）刪除檔案本體"""
    att.remove_files(attachments_dir(request.app.state), names)


def schedule_preview(request: Request, background: BackgroundTasks, iid: int, url: str | None) -> None:
    """問題的連結新增 / 變更後：回應送出後在 threadpool 抓取預覽（失敗不影響問題的儲存）。
    沒有連結或為 GitHub issue（沿用 GitHub 同步）時清除舊預覽。"""
    state = request.app.state
    if not url or parse_issue_url(url) is not None or not preview_enabled(state):
        with state.db.tx() as conn:
            conn.execute("DELETE FROM link_previews WHERE entity_type = ? AND entity_id = ?", (ISSUE, iid))
        return
    background.add_task(refresh_preview, state.db, fetcher(state), state.now, iid, url, None)


def refresh_preview(
    db: Database, fetch: Any, now: Any, iid: int, url: str, actor_id: int | None
) -> dict[str, Any] | None:
    """抓取並寫入預覽（同步函式；呼叫端負責放到 threadpool）。問題已刪除或連結已改則不寫入"""
    data: dict[str, Any] = {}
    error: str | None = None
    try:
        data = fetch.fetch(url)
    except PreviewError as e:
        error = e.message
    except Exception:  # noqa: BLE001（任何意外都只記為無法取得）
        error = "無法取得預覽"
    t = now()
    with db.tx() as conn:
        row = conn.execute("SELECT url FROM manual_issues WHERE id = ?", (iid,)).fetchone()
        if row is None or row["url"] != url:
            return None
        conn.execute(
            "INSERT OR REPLACE INTO link_previews (entity_type, entity_id, url, status, title, description, "
            "image_url, favicon_url, site_name, summary, content_type, error, fetched_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                ISSUE,
                iid,
                url,
                "error" if error else "ok",
                data.get("title"),
                data.get("description"),
                data.get("imageUrl"),
                data.get("faviconUrl"),
                data.get("siteName"),
                data.get("summary"),
                data.get("contentType"),
                error,
                t,
            ),
        )
        record_change(conn, "repo", iid, "update", actor_id, t)
        r = conn.execute(
            "SELECT * FROM link_previews WHERE entity_type = ? AND entity_id = ?", (ISSUE, iid)
        ).fetchone()
    return preview_json(r)


# ── 問題的附件上傳 / 預覽 ────────────────────────────────────


def _issue_exists(conn: sqlite3.Connection, iid: int) -> bool:
    return conn.execute("SELECT 1 FROM manual_issues WHERE id = ?", (iid,)).fetchone() is not None


def _count(conn: sqlite3.Connection, entity_type: str, eid: int) -> int:
    return conn.execute(
        "SELECT count(*) FROM attachments WHERE entity_type = ? AND entity_id = ?", (entity_type, eid)
    ).fetchone()[0]


@router.post("/issues/{id}/attachments")
async def upload_issue_attachments(request: Request, id: str):
    ctx = get_ctx(request)
    iid = parse_id(id)
    lim = limits(request.app.state)
    with ctx.db.tx() as conn:
        if not _issue_exists(conn, iid):
            raise not_found(_ISSUE_NOT_FOUND)
        allowed = lim.max_files - _count(conn, ISSUE, iid)
    if allowed <= 0:
        raise bad_request(f"每筆問題最多 {lim.max_files} 個附件，請先刪除不需要的附件")
    root = att.ensure_dir(attachments_dir(request.app.state))
    staged = await att.receive_multipart(
        request.headers.get("content-type", ""),
        request.headers.get("content-length"),
        request.stream(),
        root,
        lim,
        allowed,
    )
    errors = [e for f in staged if (e := att.validate(f)) is not None]
    if errors:
        att.discard(staged)
        raise bad_request(errors[0], {"files": errors})

    uid = ctx.user["id"]
    t = ctx.now()
    moved: list[str] = []
    try:
        with ctx.db.tx() as conn:
            if not _issue_exists(conn, iid):
                raise not_found(_ISSUE_NOT_FOUND)
            if _count(conn, ISSUE, iid) + len(staged) > lim.max_files:
                raise bad_request(f"每筆問題最多 {lim.max_files} 個附件")
            ids: list[int] = []
            for f in staged:
                stored = att.move_into_place(f, root)
                moved.append(stored)
                cur = conn.execute(
                    "INSERT INTO attachments (entity_type, entity_id, original_name, stored_name, mime, size, "
                    "sha256, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (ISSUE, iid, f.original_name, stored, f.mime, f.size, f.sha256, uid, t),
                )
                ids.append(int(cur.lastrowid))  # type: ignore[arg-type]
            record_change(conn, "repo", iid, "update", uid, t)
            rows = conn.execute(
                f"SELECT * FROM attachments WHERE id IN ({', '.join('?' * len(ids))}) ORDER BY id", ids
            ).fetchall()
    except BaseException:
        att.discard(staged)
        att.remove_files(root, moved)
        raise
    return JSONResponse({"attachments": [attachment_json(r) for r in rows]}, status_code=201)


@router.post("/issues/{id}/preview")
async def refresh_issue_preview(request: Request, id: str):
    """手動「重新取得預覽」"""
    ctx = get_ctx(request)
    iid = parse_id(id)
    state = request.app.state
    row = ctx.db.one("SELECT url FROM manual_issues WHERE id = ?", (iid,))
    if row is None:
        raise not_found(_ISSUE_NOT_FOUND)
    url = row["url"]
    if not url:
        raise bad_request("此問題沒有連結")
    if parse_issue_url(url) is not None:
        raise bad_request("GitHub issue 連結請使用「同步 GitHub」")
    if not preview_enabled(state):
        raise HttpError(503, "LINK_PREVIEW_DISABLED", "伺服器已停用連結預覽（LINK_PREVIEW_ENABLED=false）")
    preview = await run_in_threadpool(refresh_preview, ctx.db, fetcher(state), ctx.now, iid, url, ctx.user["id"])
    if preview is None:
        raise HttpError(409, "CONFLICT", "連結在取得預覽期間已變更，請重試")
    return {"preview": preview}


# ── 附件下載 / 刪除 ──────────────────────────────────────────


def _attachment(db: Database, aid: int) -> sqlite3.Row:
    row = db.one("SELECT * FROM attachments WHERE id = ?", (aid,))
    if row is None:
        raise not_found(_ATT_NOT_FOUND)
    return row


def _file(request: Request, row: sqlite3.Row) -> Path:
    path = att.stored_path(attachments_dir(request.app.state), row["stored_name"])
    if not path.is_file():
        raise not_found("附件檔案遺失（可能尚未從備份還原附件目錄）")
    return path


_RANGE_SPEC = re.compile(r"^\s*(\d*)\s*-\s*(\d*)\s*$")


def _range_ok(header: str, size: int) -> bool:
    """Range 標頭是否可滿足（格式錯誤、起點大於終點、起點超過檔尾 → False，回 416）"""
    unit, _, specs = header.partition("=")
    if unit.strip().lower() != "bytes" or not specs.strip():
        return False
    for spec in specs.split(","):
        m = _RANGE_SPEC.match(spec)
        if m is None or (m.group(1) == "" and m.group(2) == ""):
            return False
        start, end = m.group(1), m.group(2)
        if start == "":
            if int(end) == 0:
                return False
            continue
        if int(start) >= size or (end != "" and int(end) < int(start)):
            return False
    return True


@files_router.get("/{id}")
async def download_attachment(request: Request, id: str):
    """下載 / 顯示；支援 Range（206 / 416），讓影片可拖曳進度條"""
    row = _attachment(get_ctx(request).db, parse_id(id))
    path = _file(request, row)
    range_header = request.headers.get("range")
    if range_header is not None and not _range_ok(range_header, path.stat().st_size):
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{path.stat().st_size}", "Accept-Ranges": "bytes"},
        )
    force = request.query_params.get("download") in ("1", "true")
    return FileResponse(
        path,
        media_type=row["mime"],
        headers=att.download_headers(row["mime"], row["original_name"], force),
        content_disposition_type="inline",
    )


_THUMB_PX = 480


def _make_thumb(path: Path) -> bytes | None:
    try:
        from PIL import Image  # type: ignore[import-not-found]
    except ImportError:
        return None
    try:
        with Image.open(path) as im:
            im.thumbnail((_THUMB_PX, _THUMB_PX))
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA")
            buf = io.BytesIO()
            im.save(buf, "WEBP", quality=80)
            return buf.getvalue()
    except Exception:  # noqa: BLE001（壞圖就退回原圖）
        return None


@files_router.get("/{id}/thumb")
async def attachment_thumb(request: Request, id: str):
    """圖片縮圖；未安裝 Pillow 或無法產生時直接回傳原圖"""
    row = _attachment(get_ctx(request).db, parse_id(id))
    if att.kind_of_mime(row["mime"]) != "image":
        raise not_found("此附件沒有縮圖")
    path = _file(request, row)
    data = await run_in_threadpool(_make_thumb, path)
    headers = att.download_headers(row["mime"], row["original_name"])
    if data is None:
        return FileResponse(path, media_type=row["mime"], headers=headers, content_disposition_type="inline")
    headers["Content-Disposition"] = "inline"
    return Response(data, media_type="image/webp", headers=headers)


@files_router.delete("/{id}")
async def delete_attachment(request: Request, id: str):
    ctx = get_ctx(request)
    aid = parse_id(id)
    with ctx.db.tx() as conn:
        row = conn.execute("SELECT * FROM attachments WHERE id = ?", (aid,)).fetchone()
        if row is None:
            raise not_found(_ATT_NOT_FOUND)
        conn.execute("DELETE FROM attachments WHERE id = ?", (aid,))
        entity = ENTITIES.get(row["entity_type"])
        if entity is not None:
            record_change(conn, entity[1], row["entity_id"], "update", ctx.user["id"], ctx.now())
    att.remove_files(attachments_dir(request.app.state), [row["stored_name"]])
    return {"ok": True}
