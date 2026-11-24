"""/api/feedback：問題 / 回饋；所有成員可讀寫，刪除為實際刪除。

status 由後端推導：排入日期即 scheduled、清空即 open、resolved 保留排程日（重新開啟時依排程日回復）。
"""

from __future__ import annotations

import re
import sqlite3
from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import AfterValidator, BaseModel, StringConstraints

from ..changes import record_change
from ..context import get_ctx
from ..db import row_to_dict, rows_to_dicts
from ..errors import bad_request, not_found, validation_error
from ..schemas import DATE_PATTERN, DateString, Title
from ..validate import parse_id, present, read_json

router = APIRouter()

NOT_FOUND = "此項目不存在或已被刪除"
FEEDBACK_KINDS = ("problem", "feedback")
FEEDBACK_STATUSES = ("open", "scheduled", "resolved")

FeedbackKind = Literal["problem", "feedback"]


def _check_calendar_date(s: str) -> str:
    """合法的日曆日期（YYYY-MM-DD 且確實存在，例如排除 2026-02-30）"""
    try:
        date.fromisoformat(s)
    except ValueError:
        raise ValueError("日期不存在") from None
    return s


CalendarDate = Annotated[DateString, AfterValidator(_check_calendar_date)]
Body = Annotated[str, StringConstraints(max_length=20_000)]


class FeedbackCreateInput(BaseModel):
    model_config = {"extra": "ignore"}
    kind: FeedbackKind
    title: Title
    body: Body = None  # type: ignore[assignment]
    projectId: int | None = None
    assigneeId: int | None = None
    scheduledDate: CalendarDate | None = None


class FeedbackUpdateInput(BaseModel):
    """PATCH 只送改動欄位；status 不可直接寫入，由 resolved 與 scheduledDate 推導"""

    model_config = {"extra": "ignore"}
    kind: FeedbackKind = None  # type: ignore[assignment]
    title: Title = None  # type: ignore[assignment]
    body: Body = None  # type: ignore[assignment]
    projectId: int | None = None
    assigneeId: int | None = None
    scheduledDate: CalendarDate | None = None
    resolved: bool = None  # type: ignore[assignment]


_COLUMNS = {
    "kind": "kind",
    "title": "title",
    "body": "body",
    "projectId": "project_id",
    "assigneeId": "assignee_id",
    "scheduledDate": "scheduled_date",
}


def derive_feedback_status(resolved: bool, scheduled_date: str | None) -> str:
    """由「是否已解決」與排程日推導狀態"""
    if resolved:
        return "resolved"
    return "scheduled" if scheduled_date else "open"


def _check_refs(conn: sqlite3.Connection, fields: dict[str, Any]) -> None:
    """外鍵欄位需指向存在的資料，否則回 400"""
    if fields.get("projectId") is not None and not conn.execute(
        "SELECT 1 FROM projects WHERE id = ?", (fields["projectId"],)
    ).fetchone():
        raise bad_request("專案不存在")
    if fields.get("assigneeId") is not None and not conn.execute(
        "SELECT 1 FROM users WHERE id = ?", (fields["assigneeId"],)
    ).fetchone():
        raise bad_request("負責人不存在")


def _find(conn: sqlite3.Connection, item_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM feedback_items WHERE id = ?", (item_id,)).fetchone()


def _enum_list(name: str, raw: str, allowed: tuple[str, ...]) -> list[str]:
    values = [v for v in raw.split(",") if v]
    for i, v in enumerate(values):
        if v not in allowed:
            raise validation_error(
                [{"path": [name, i], "message": f"須為 {' | '.join(allowed)}", "code": "invalid_enum_value"}]
            )
    return values


@router.get("")
async def list_feedback(request: Request):
    """篩選：kind、status 皆為逗號分隔多值；from / to 限制排程日區間（含）"""
    qp = request.query_params
    conds: list[str] = []
    params: list[Any] = []
    for name, column, allowed in (("kind", "kind", FEEDBACK_KINDS), ("status", "status", FEEDBACK_STATUSES)):
        raw = qp.get(name)
        if raw is None:
            continue
        values = _enum_list(name, raw, allowed)
        if values:
            conds.append(f"{column} IN ({','.join('?' * len(values))})")
            params.extend(values)
    for name, op in (("from", ">="), ("to", "<=")):
        raw = qp.get(name)
        if raw is None:
            continue
        if not re.fullmatch(DATE_PATTERN, raw):
            raise validation_error([{"path": [name], "message": "日期格式須為 YYYY-MM-DD", "code": "invalid_string"}])
        conds.append(f"scheduled_date {op} ?")
        params.append(raw)
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    rows = get_ctx(request).db.all(
        f"SELECT * FROM feedback_items {where} ORDER BY created_at DESC, id DESC", tuple(params)
    )
    return rows_to_dicts(rows)


@router.post("")
async def create_feedback(request: Request):
    ctx = get_ctx(request)
    data = await read_json(request, FeedbackCreateInput)
    fields = present(data)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        _check_refs(conn, fields)
        t = ctx.now()
        scheduled = fields.get("scheduledDate")
        sets = {_COLUMNS[k]: v for k, v in fields.items()}
        sets.update(
            scheduled_date=scheduled,
            status=derive_feedback_status(False, scheduled),
            reporter_id=uid,
            updated_by=uid,
            created_at=t,
            updated_at=t,
        )
        cur = conn.execute(
            f"INSERT INTO feedback_items ({', '.join(sets)}) VALUES ({', '.join('?' * len(sets))})",
            tuple(sets.values()),
        )
        fid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "feedback", fid, "create", uid, t)
        row = _find(conn, fid)
    return JSONResponse(row_to_dict(row), status_code=201)


@router.get("/{id}")
async def get_feedback(request: Request, id: str):
    ctx = get_ctx(request)
    fid = parse_id(id)
    with ctx.db.lock:
        row = _find(ctx.db.conn, fid)
    if row is None:
        raise not_found(NOT_FOUND)
    return row_to_dict(row)


@router.patch("/{id}")
async def update_feedback(request: Request, id: str):
    ctx = get_ctx(request)
    fid = parse_id(id)
    data = await read_json(request, FeedbackUpdateInput)
    fields = present(data)
    resolved = fields.pop("resolved", None)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        current = _find(conn, fid)
        if current is None:
            raise not_found(NOT_FOUND)
        _check_refs(conn, fields)
        scheduled = fields["scheduledDate"] if "scheduledDate" in fields else current["scheduled_date"]
        is_resolved = resolved if resolved is not None else current["status"] == "resolved"
        t = ctx.now()
        sets = {_COLUMNS[k]: v for k, v in fields.items()}
        sets.update(status=derive_feedback_status(is_resolved, scheduled), updated_by=uid, updated_at=t)
        conn.execute(
            f"UPDATE feedback_items SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?", (*sets.values(), fid)
        )
        record_change(conn, "feedback", fid, "update", uid, t)
        row = _find(conn, fid)
    return row_to_dict(row)


@router.delete("/{id}")
async def delete_feedback(request: Request, id: str):
    ctx = get_ctx(request)
    fid = parse_id(id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        if _find(conn, fid) is None:
            raise not_found(NOT_FOUND)
        conn.execute("DELETE FROM feedback_items WHERE id = ?", (fid,))
        record_change(conn, "feedback", fid, "delete", uid, ctx.now())
    return {"ok": True}
