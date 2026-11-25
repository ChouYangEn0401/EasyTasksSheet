"""請求 JSON / 路徑參數驗證。"""

from __future__ import annotations

import json
import re
from typing import TypeVar

from fastapi import Request
from pydantic import BaseModel, ValidationError

from .errors import bad_request, pydantic_issues, validation_error

M = TypeVar("M", bound=BaseModel)


async def read_json(request: Request, model: type[M]) -> M:
    """讀取並以 pydantic（strict）驗證 JSON body；非 JSON 回 400 BAD_REQUEST，驗證失敗回 400 VALIDATION_ERROR。"""
    raw = await request.body()
    try:
        json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise bad_request("請求內容須為 JSON") from None
    try:
        return model.model_validate_json(raw, strict=True)
    except ValidationError as e:
        raise validation_error(pydantic_issues(e)) from None


#: 路徑／查詢參數中的 id：只接受十進位數字（拒絕 1e30、+1、1.0、前後空白）
_ID_RE = re.compile(r"[0-9]{1,19}")
#: SQLite INTEGER 上限（超過會在查詢時 OverflowError → 500）
ID_MAX = 2**63 - 1


def parse_positive_int(value: str | None) -> int | None:
    """嚴格的正整數解析：十進位數字、1 ≤ n ≤ 2^63-1；不合格回 None"""
    if value is None or not _ID_RE.fullmatch(value):
        return None
    n = int(value)
    return n if 1 <= n <= ID_MAX else None


def parse_id(value: str) -> int:
    """路徑 id：嚴格正整數（見 parse_positive_int）；不合格 400 VALIDATION_ERROR"""
    n = parse_positive_int(value)
    if n is None:
        raise validation_error([{"path": [], "message": "須為正整數 id", "code": "invalid_id"}])
    return n


def present(model: BaseModel) -> dict:
    """只取請求中有送來的欄位（PATCH 用）"""
    return {k: getattr(model, k) for k in model.model_fields_set}
