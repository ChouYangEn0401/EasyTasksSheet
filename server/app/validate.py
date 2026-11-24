"""請求 JSON / 路徑參數驗證。"""

from __future__ import annotations

import json
import math
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


def parse_id(value: str) -> int:
    """對應 z.coerce.number().int().positive()"""
    try:
        f = float(value.strip()) if value.strip() else 0.0
    except ValueError:
        f = math.nan
    if not math.isfinite(f) or f != int(f) or f <= 0:
        raise validation_error([{"path": [], "message": "須為正整數 id", "code": "invalid_id"}])
    return int(f)


def present(model: BaseModel) -> dict:
    """只取請求中有送來的欄位（PATCH 用）"""
    return {k: getattr(model, k) for k in model.model_fields_set}
