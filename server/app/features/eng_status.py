"""/api/eng/statuses：工程追蹤的可自訂狀態（問題 / 工作樹；docs/design/eng-tracking.md §自訂狀態）。

- kind = issue | worktree；key 為穩定識別（內建沿用既有字串：open / doing / closed、active / idle / merged / lost / cleaned），
  manual_issues.status 與 worktree_records.status 存的就是 key，改名不影響既有資料
- category：issue 為 open / closed；worktree 為 active / idle / attention / done（統計與「顯示已結案 / 已清理」切換用）
- 內建：可改名 / 改色 / 排序 / 封存，key 與類別不可改、不可刪除
- 自訂：無使用時可刪除；有使用時只能封存（封存的狀態不出現在新選單，但既有資料仍可顯示、保留）
- 讀取：登入即可；寫入：eng.status.manage（預設 user 以上，root 可在權限設定頁調整）
"""

from __future__ import annotations

import secrets
import sqlite3
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, StringConstraints

from ..changes import record_change
from ..context import Ctx, get_ctx
from ..errors import HttpError, bad_request, not_found
from ..permissions import require
from ..validate import parse_id, present, read_json

router = APIRouter()

Kind = Literal["issue", "worktree"]
Color = Literal["gray", "blue", "purple", "green", "yellow", "orange", "red", "teal"]

CATEGORIES: dict[str, tuple[str, ...]] = {
    "issue": ("open", "closed"),
    "worktree": ("active", "idle", "attention", "done"),
}
#: 建立時未指定狀態的預設 key（被封存時改用同類別第一個未封存者）
DEFAULT_KEY = {"issue": "open", "worktree": "active"}
DEFAULT_CATEGORY = {"issue": "open", "worktree": "active"}
_TABLE = {"issue": "manual_issues", "worktree": "worktree_records"}

_NOT_FOUND = "此狀態不存在或已被刪除"


class _Input(BaseModel):
    model_config = {"extra": "ignore"}


Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]


class StatusCreateInput(_Input):
    kind: Kind
    label: Label
    color: Color = "gray"
    category: Annotated[str, StringConstraints(max_length=20)] | None = None


class StatusUpdateInput(_Input):
    label: Label = None  # type: ignore[assignment]
    color: Color = None  # type: ignore[assignment]
    category: Annotated[str, StringConstraints(max_length=20)] = None  # type: ignore[assignment]
    sortOrder: float = None  # type: ignore[assignment]
    isArchived: bool = None  # type: ignore[assignment]


def to_json(r: sqlite3.Row, usage: int | None = None) -> dict[str, Any]:
    out = {
        "id": r["id"],
        "kind": r["kind"],
        "key": r["key"],
        "label": r["label"],
        "color": r["color"],
        "category": r["category"],
        "sortOrder": r["sort_order"],
        "isBuiltin": bool(r["is_builtin"]),
        "isArchived": bool(r["is_archived"]),
        "updatedAt": r["updated_at"],
        "updatedBy": r["updated_by"],
    }
    if usage is not None:
        out["usage"] = usage
    return out


# ── 其他模組使用的查詢 ──


def statuses_of(conn: sqlite3.Connection, kind: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM eng_statuses WHERE kind = ? ORDER BY sort_order, id", (kind,)
    ).fetchall()


def keys_in_category(conn: sqlite3.Connection, kind: str, *categories: str) -> set[str]:
    marks = ", ".join("?" * len(categories))
    rows = conn.execute(
        f"SELECT key FROM eng_statuses WHERE kind = ? AND category IN ({marks})", (kind, *categories)
    ).fetchall()
    return {r[0] for r in rows}


def default_key(conn: sqlite3.Connection, kind: str, category: str | None = None) -> str:
    """新資料的預設狀態：內建預設值（未封存時），否則該類別第一個未封存的狀態"""
    category = category or DEFAULT_CATEGORY[kind]
    rows = [r for r in statuses_of(conn, kind) if not r["is_archived"]]
    for r in rows:
        if r["key"] == DEFAULT_KEY[kind] and r["category"] == category:
            return r["key"]
    for r in rows:
        if r["category"] == category:
            return r["key"]
    return rows[0]["key"] if rows else DEFAULT_KEY[kind]


def check_value(conn: sqlite3.Connection, kind: str, value: str, current: str | None = None) -> None:
    """manual_status 值必須存在於 eng_statuses；封存的狀態只能「保留既有值」，不可新設"""
    if current is not None and value == current:
        return
    row = conn.execute("SELECT is_archived FROM eng_statuses WHERE kind = ? AND key = ?", (kind, value)).fetchone()
    if row is None:
        raise HttpError(400, "VALIDATION_ERROR", "狀態不存在", {"field": "status"})
    if row["is_archived"]:
        raise HttpError(400, "VALIDATION_ERROR", "此狀態已封存，無法再選用", {"field": "status"})


def _usage(conn: sqlite3.Connection, kind: str) -> dict[str, int]:
    # 工作樹含回收區中的紀錄（還原後仍會用到）
    rows = conn.execute(f"SELECT status, count(*) FROM {_TABLE[kind]} GROUP BY status").fetchall()
    return {r[0]: r[1] for r in rows}


# ── API ──


@router.get("/statuses")
async def list_statuses(request: Request, kind: str | None = None):
    db = get_ctx(request).db
    if kind is not None and kind not in CATEGORIES:
        raise bad_request("kind 須為 issue 或 worktree")
    kinds = [kind] if kind else list(CATEGORIES)
    out: list[dict[str, Any]] = []
    with db.tx() as conn:
        for k in kinds:
            usage = _usage(conn, k)
            out += [to_json(r, usage.get(r["key"], 0)) for r in statuses_of(conn, k)]
    return {"statuses": out, "categories": {k: list(v) for k, v in CATEGORIES.items()}}


def _check_category(kind: str, category: str) -> None:
    if category not in CATEGORIES[kind]:
        raise HttpError(400, "VALIDATION_ERROR", "類別不正確", {"field": "category"})


def _check_label(conn: sqlite3.Connection, kind: str, label: str, self_id: int | None = None) -> None:
    row = conn.execute(
        "SELECT id FROM eng_statuses WHERE kind = ? AND lower(label) = lower(?) AND id IS NOT ?", (kind, label, self_id)
    ).fetchone()
    if row is not None:
        raise HttpError(409, "CONFLICT", "已有同名的狀態", {"field": "label"})


@router.post("/statuses")
async def create_status(request: Request, ctx: Ctx = Depends(require("eng.status.manage"))):
    data = await read_json(request, StatusCreateInput)
    category = data.category or DEFAULT_CATEGORY[data.kind]
    _check_category(data.kind, category)
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        _check_label(conn, data.kind, data.label)
        key = "c_" + secrets.token_hex(4)
        order = conn.execute("SELECT coalesce(max(sort_order), 0) + 1 FROM eng_statuses WHERE kind = ?", (data.kind,)).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO eng_statuses (kind, key, label, color, category, sort_order, is_builtin, created_at, updated_at, updated_by) "
            "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
            (data.kind, key, data.label, data.color, category, order, t, t, uid),
        )
        sid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "repo", sid, "create", uid, t)
        row = conn.execute("SELECT * FROM eng_statuses WHERE id = ?", (sid,)).fetchone()
    return JSONResponse(to_json(row, 0), status_code=201)


@router.patch("/statuses/{id}")
async def update_status(request: Request, id: str, ctx: Ctx = Depends(require("eng.status.manage"))):
    sid = parse_id(id)
    fields = present(await read_json(request, StatusUpdateInput))
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        row = conn.execute("SELECT * FROM eng_statuses WHERE id = ?", (sid,)).fetchone()
        if row is None:
            raise not_found(_NOT_FOUND)
        kind = row["kind"]
        sets: dict[str, Any] = {}
        if "label" in fields:
            _check_label(conn, kind, fields["label"], sid)
            sets["label"] = fields["label"]
        if "color" in fields:
            sets["color"] = fields["color"]
        if "category" in fields and fields["category"] != row["category"]:
            if row["is_builtin"]:
                raise bad_request("內建狀態的類別不可變更")
            _check_category(kind, fields["category"])
            sets["category"] = fields["category"]
        if "sortOrder" in fields:
            sets["sort_order"] = fields["sortOrder"]
        if "isArchived" in fields and bool(fields["isArchived"]) != bool(row["is_archived"]):
            if fields["isArchived"]:
                remaining = conn.execute(
                    "SELECT count(*) FROM eng_statuses WHERE kind = ? AND is_archived = 0 AND id != ?", (kind, sid)
                ).fetchone()[0]
                if remaining == 0:
                    raise bad_request("至少需保留一個未封存的狀態")
            sets["is_archived"] = int(bool(fields["isArchived"]))
        if sets:
            sets.update(updated_at=t, updated_by=uid)
            conn.execute(f"UPDATE eng_statuses SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?", (*sets.values(), sid))
            record_change(conn, "repo", sid, "update", uid, t)
        row = conn.execute("SELECT * FROM eng_statuses WHERE id = ?", (sid,)).fetchone()
        usage = _usage(conn, kind).get(row["key"], 0)
    return to_json(row, usage)


@router.delete("/statuses/{id}")
async def delete_status(request: Request, id: str, ctx: Ctx = Depends(require("eng.status.manage"))):
    sid = parse_id(id)
    with ctx.db.tx() as conn:
        row = conn.execute("SELECT * FROM eng_statuses WHERE id = ?", (sid,)).fetchone()
        if row is None:
            raise not_found(_NOT_FOUND)
        if row["is_builtin"]:
            raise bad_request("內建狀態不可刪除，可改為封存")
        used = _usage(conn, row["kind"]).get(row["key"], 0)
        if used > 0:
            raise HttpError(409, "IN_USE", f"有 {used} 筆資料使用此狀態，只能封存", {"usage": used})
        conn.execute("DELETE FROM eng_statuses WHERE id = ?", (sid,))
        record_change(conn, "repo", sid, "delete", ctx.user["id"], ctx.now())
    return {"ok": True}
