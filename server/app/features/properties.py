"""/api/properties：自訂 property 定義（projectId = null 為全域）。刪除定義不清任務資料，讀取時忽略未知 key。

另提供 merge_custom_values()：依 property 型別驗證 tasks.custom 的值並逐鍵合併（null = 清除）。
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..changes import record_change
from ..context import get_ctx
from ..errors import bad_request, not_found, validation_error
from ..schemas import DATE_PATTERN, PropertyCreateInput, PropertyUpdateInput, SelectOption, dump_options
from ..db import next_sort_order, row_to_dict, rows_to_dicts
from ..validate import parse_id, present, read_json

router = APIRouter()

_DATE_RE = re.compile(DATE_PATTERN)


def _is_int(v: Any) -> bool:
    return (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer())


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_url(v: str) -> bool:
    if len(v) > 2_000 or any(ch.isspace() for ch in v):
        return False
    try:
        parts = urlsplit(v)
    except ValueError:
        return False
    return bool(re.fullmatch(r"[A-Za-z][A-Za-z0-9+.-]*", parts.scheme or "")) and bool(parts.netloc)


def _check_value(type_: str, options: list[dict[str, Any]], v: Any) -> str | None:
    """回傳錯誤訊息；None 表示合法"""
    option_ids = {o["id"] for o in options}
    if type_ == "text":
        return None if isinstance(v, str) and len(v) <= 10_000 else "須為文字（最多 10000 字）"
    if type_ == "number":
        return None if _is_number(v) else "須為數字"
    if type_ == "select":
        return None if isinstance(v, str) and v in option_ids else "須為既有選項"
    if type_ == "multi_select":
        if not isinstance(v, list) or not all(isinstance(x, str) and x in option_ids for x in v):
            return "須為既有選項的陣列"
        return None if len(set(v)) == len(v) else "選項不可重複"
    if type_ == "date":
        return None if isinstance(v, str) and _DATE_RE.fullmatch(v) else "日期格式須為 YYYY-MM-DD"
    if type_ == "checkbox":
        return None if isinstance(v, bool) else "須為布林值"
    if type_ == "url":
        return None if isinstance(v, str) and _is_url(v) else "須為網址"
    if type_ == "person":
        return None if _is_int(v) and v > 0 else "須為成員 id"
    return "未知的型別"


def merge_custom_values(
    conn: sqlite3.Connection, project_id: int, current: dict[str, Any], patch: dict[str, Any]
) -> dict[str, Any]:
    """依 property_defs 的型別驗證自訂欄位值，並與既有值合併（null = 清除）。
    只接受全域或屬於該任務專案的 property；驗證失敗回 400 VALIDATION_ERROR。"""
    if not patch:
        return current
    defs = conn.execute(
        "SELECT id, type, options FROM property_defs WHERE project_id IS NULL OR project_id = ?", (project_id,)
    ).fetchall()
    by_id = {str(d["id"]): (d["type"], json.loads(d["options"])) for d in defs}

    issues: list[dict[str, Any]] = []
    person_ids: set[int] = set()
    for key, value in patch.items():
        d = by_id.get(key)
        if d is None:
            issues.append({"path": [key], "message": "未知的自訂欄位", "code": "unknown_property"})
            continue
        if value is None:
            continue
        msg = _check_value(d[0], d[1], value)
        if msg:
            issues.append({"path": [key], "message": msg, "code": "invalid_value"})
        elif d[0] == "person":
            person_ids.add(int(value))
    if issues:
        raise validation_error(issues)

    # person 型別需指向存在的使用者
    if person_ids:
        marks = ",".join("?" * len(person_ids))
        found = conn.execute(f"SELECT count(*) FROM users WHERE id IN ({marks})", tuple(person_ids)).fetchone()[0]
        if found != len(person_ids):
            raise bad_request("自訂欄位指定的成員不存在")

    merged = dict(current)
    for key, value in patch.items():
        if value is None:
            merged.pop(key, None)
        elif by_id[key][0] == "person":
            merged[key] = int(value)
        else:
            merged[key] = value
    return merged


def _check_options(options: list[SelectOption] | None) -> None:
    if options and len({o.id for o in options}) != len(options):
        raise bad_request("選項 id 不可重複")


@router.get("")
async def list_properties(request: Request):
    return rows_to_dicts(get_ctx(request).db.all("SELECT * FROM property_defs ORDER BY sort_order, id"))


@router.post("")
async def create_property(request: Request):
    ctx = get_ctx(request)
    data = await read_json(request, PropertyCreateInput)
    _check_options(data.options)
    with ctx.db.tx() as conn:
        if data.projectId is not None and not conn.execute(
            "SELECT 1 FROM projects WHERE id = ?", (data.projectId,)
        ).fetchone():
            raise bad_request("專案不存在")
        t = ctx.now()
        cur = conn.execute(
            "INSERT INTO property_defs (project_id, name, type, options, sort_order, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                data.projectId,
                data.name,
                data.type,
                json.dumps(dump_options(data.options), ensure_ascii=False),
                next_sort_order(conn, "property_defs"),
                t,
                t,
            ),
        )
        pid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "property", pid, "create", ctx.user["id"], t)
        row = conn.execute("SELECT * FROM property_defs WHERE id = ?", (pid,)).fetchone()
    return JSONResponse(row_to_dict(row), status_code=201)


@router.patch("/{id}")
async def update_property(request: Request, id: str):
    ctx = get_ctx(request)
    pid = parse_id(id)
    data = await read_json(request, PropertyUpdateInput)
    _check_options(data.options)
    t = ctx.now()
    fields: dict[str, Any] = {}
    for k, v in present(data).items():
        if k == "name":
            fields["name"] = v
        elif k == "options":
            fields["options"] = json.dumps(dump_options(v), ensure_ascii=False)
        elif k == "sortOrder":
            fields["sort_order"] = v
    fields["updated_at"] = t
    with ctx.db.tx() as conn:
        sets = ", ".join(f"{col} = ?" for col in fields)
        cur = conn.execute(f"UPDATE property_defs SET {sets} WHERE id = ?", (*fields.values(), pid))
        if cur.rowcount == 0:
            raise not_found("找不到自訂欄位")
        record_change(conn, "property", pid, "update", ctx.user["id"], t)
        row = conn.execute("SELECT * FROM property_defs WHERE id = ?", (pid,)).fetchone()
    return row_to_dict(row)


@router.delete("/{id}")
async def delete_property(request: Request, id: str):
    ctx = get_ctx(request)
    pid = parse_id(id)
    with ctx.db.tx() as conn:
        cur = conn.execute("DELETE FROM property_defs WHERE id = ?", (pid,))
        if cur.rowcount == 0:
            raise not_found("找不到自訂欄位")
        record_change(conn, "property", pid, "delete", ctx.user["id"], ctx.now())
    return {"ok": True}
