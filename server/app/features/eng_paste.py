"""/api/eng/worktrees/paste：貼上 `git worktree list` 輸出 → 預覽 → 登記（eng.edit；docs/design/eng-tracking.md §14）。

不執行任何 git、不讀檔案系統、不需要 WORKTREE_SCAN_ROOTS；解析在 server/app/worktree_paste.py。
apply 一律重新解析 text，不採信前端送來的解析結果；單一 transaction；來源標記 `paste`。
"""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, StringConstraints

from ..changes import record_change
from ..context import Ctx
from ..errors import bad_request
from ..permissions import require
from ..validate import read_json
from .. import worktree_paste as wp
from ..schemas import DbId, SqlInt
from .eng import _same_machine, check_active_owner, path_key
from .eng_status import check_value, default_key

router = APIRouter()

DEFAULT_MACHINE = "我的電腦"
NOTE_PREFIX = "由貼上匯入"


class _PasteBase(BaseModel):
    model_config = {"extra": "ignore"}
    text: Annotated[str, StringConstraints(max_length=wp.MAX_BYTES + 1000)]
    repo: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] | None = None


class PreviewInput(_PasteBase):
    machine: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] | None = None


class ApplyInput(_PasteBase):
    machine: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    #: 行號（int）或路徑（str）；伺服器只用來從「自己重新解析的結果」挑選
    selected: Annotated[list[SqlInt | Annotated[str, StringConstraints(max_length=1000)]], Field(max_length=wp.MAX_ENTRIES)]
    updateExisting: bool = False
    status: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)] | None = None
    #: 新登記紀錄的負責人（選填；預設為呼叫者；必須存在且啟用）
    ownerId: DbId | None = None


def _parse(text: str) -> wp.ParseResult:
    try:
        return wp.parse_worktree_list(text)
    except wp.PasteError as e:
        raise bad_request(str(e)) from None


def _sha_match(a: str | None, b: str | None) -> bool:
    """縮寫與完整 sha 都能比（至少 7 碼的前綴相同）"""
    if not a or not b:
        return False
    a, b = a.lower(), b.lower()
    return a.startswith(b) or b.startswith(a)


def plan(conn: sqlite3.Connection, machine: str, entries: list[wp.ParsedWorktree]) -> list[dict[str, Any]]:
    """貼上的項目 × 既有紀錄：new / existing（同電腦 + 同路徑）/ moved（同分支 + 同 sha、路徑不同）"""
    recs = [
        r
        for r in conn.execute("SELECT * FROM worktree_records WHERE deleted_at IS NULL").fetchall()
        if _same_machine(r, machine, None)
    ]
    by_path = {path_key(r["path"]): r for r in recs}
    pasted = {path_key(e.path) for e in entries}
    used: set[int] = set()
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for e in entries:
        k = path_key(e.path)
        item = {**e.to_dict(), "key": k, "action": "new", "recordId": None, "recordPath": None, "duplicate": k in seen}
        seen.add(k)
        rec = by_path.get(k)
        if rec is not None:
            item.update(action="existing", recordId=rec["id"], recordPath=rec["path"])
        elif e.branch and e.sha:
            moved = next(
                (
                    r
                    for r in recs
                    if r["id"] not in used
                    and path_key(r["path"]) not in pasted
                    and (r["branch"] or "") == e.branch
                    and _sha_match(r["head_sha"], e.sha)
                ),
                None,
            )
            if moved is not None:
                used.add(moved["id"])
                item.update(action="moved", recordId=moved["id"], recordPath=moved["path"])
        items.append(item)
    return items


def build_note(e: dict[str, Any]) -> str:
    parts = [NOTE_PREFIX]
    if e["sha"]:
        parts.append(f"sha {e['sha'][:8]}")
    if e["isBare"]:
        parts.append("bare")
    if e["isLocked"]:
        parts.append("locked" + (f"：{e['lockReason'][:200]}" if e["lockReason"] else ""))
    if e["isDetached"]:
        parts.append("detached HEAD")
    if e["isPrunable"]:
        parts.append("prunable" + (f"：{e['prunableReason'][:200]}" if e["prunableReason"] else ""))
    return "；".join(parts)[:2000]


def _counts(items: list[dict[str, Any]]) -> dict[str, int]:
    return {a: sum(1 for i in items if i["action"] == a) for a in ("new", "existing", "moved")}


@router.post("/worktrees/paste/preview")
async def paste_preview(request: Request, ctx: Ctx = Depends(require("eng.edit"))):
    """預覽（不寫入）：解析 → 與既有紀錄比對"""
    data = await read_json(request, PreviewInput)
    result = _parse(data.text)
    machine = data.machine or DEFAULT_MACHINE
    with ctx.db.tx() as conn:
        items = plan(conn, machine, result.entries)
    return {
        "machine": machine,
        "repo": data.repo or result.repo,
        "repoGuess": result.repo,
        "truncated": result.truncated,
        "counts": _counts(items),
        "items": items,
        "unparsed": result.unparsed,
        "unparsedCount": result.unparsedCount,
    }


@router.post("/worktrees/paste/apply")
async def paste_apply(request: Request, ctx: Ctx = Depends(require("eng.edit"))):
    """重新解析 text（不採信前端的解析結果）後，登記勾選的項目；冪等"""
    data = await read_json(request, ApplyInput)
    result = _parse(data.text)
    machine = data.machine
    uid = ctx.user["id"]
    t = ctx.now()
    want_lines = {s for s in data.selected if isinstance(s, int) and not isinstance(s, bool)}
    want_paths = {path_key(s) for s in data.selected if isinstance(s, str)}
    created = updated = skipped = 0
    with ctx.db.tx() as conn:
        if data.status is not None:
            check_value(conn, "worktree", data.status)
        status = data.status or default_key(conn, "worktree")
        owner_id = data.ownerId if data.ownerId is not None else uid
        check_active_owner(conn, owner_id)
        repo = data.repo or result.repo
        items = plan(conn, machine, result.entries)
        for it in items:
            if it["lineNo"] not in want_lines and it["key"] not in want_paths:
                continue
            if it["duplicate"]:
                skipped += 1
                continue
            note = build_note(it)
            if it["action"] == "new":
                cur = conn.execute(
                    "INSERT INTO worktree_records (machine, machine_id, path, branch, status, note, repo, head_sha, "
                    "source, owner_id, created_by, updated_by, created_at, updated_at) "
                    "VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'paste', ?, ?, ?, ?, ?)",
                    (
                        machine, it["path"][:500], (it["branch"] or "")[:200], status, note, repo, it["sha"],
                        owner_id, uid, uid, t, t,
                    ),
                )
                record_change(conn, "worktree_plan", int(cur.lastrowid), "create", uid, t)  # type: ignore[arg-type]
                created += 1
            elif data.updateExisting or it["action"] == "moved":
                rec = conn.execute("SELECT * FROM worktree_records WHERE id = ?", (it["recordId"],)).fetchone()
                sets: dict[str, Any] = {}
                if it["action"] == "moved":  # 與掃描一致：勾選「可能搬動」＝把舊紀錄的路徑改成新路徑
                    sets["path"] = it["path"][:500]
                branch = (it["branch"] or "")[:200]
                if branch != rec["branch"]:
                    sets["branch"] = branch
                if it["sha"] and not _sha_match(rec["head_sha"], it["sha"]):
                    sets["head_sha"] = it["sha"]
                # 備註只在空白或先前也是貼上匯入時覆寫，不蓋掉使用者自己寫的內容
                if note != rec["note"] and (not rec["note"] or rec["note"].startswith(NOTE_PREFIX)):
                    sets["note"] = note
                if data.repo and data.repo != rec["repo"]:
                    sets["repo"] = data.repo
                if not sets:
                    skipped += 1
                    continue
                sets.update(updated_by=uid, updated_at=t)
                conn.execute(
                    f"UPDATE worktree_records SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?",
                    (*sets.values(), it["recordId"]),
                )
                record_change(conn, "worktree_plan", it["recordId"], "update", uid, t)
                updated += 1
            else:
                skipped += 1
    return {
        "ok": True,
        "machine": machine,
        "repo": repo,
        "created": created,
        "updated": updated,
        "skipped": skipped,
    }
