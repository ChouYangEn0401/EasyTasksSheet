"""統一錯誤格式：{ "error": { "code", "message", "details"? } }"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("server")

_UNSET: Any = object()


class HttpError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Any = _UNSET,
        headers: dict[str, str] | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.headers = headers


def bad_request(message: str = "請求格式錯誤", details: Any = _UNSET) -> HttpError:
    return HttpError(400, "BAD_REQUEST", message, details)


def validation_error(details: Any) -> HttpError:
    return HttpError(400, "VALIDATION_ERROR", "資料驗證失敗", details)


def unauthorized(message: str = "請先登入") -> HttpError:
    return HttpError(401, "UNAUTHORIZED", message)


def forbidden(message: str = "沒有權限") -> HttpError:
    return HttpError(403, "FORBIDDEN", message)


def not_found(message: str = "找不到資源") -> HttpError:
    return HttpError(404, "NOT_FOUND", message)


def conflict(message: str = "資料衝突") -> HttpError:
    return HttpError(409, "CONFLICT", message)


def too_many_requests(message: str = "嘗試次數過多，請稍後再試") -> HttpError:
    return HttpError(429, "TOO_MANY_REQUESTS", message)


def not_implemented(message: str = "尚未實作") -> HttpError:
    return HttpError(501, "NOT_IMPLEMENTED", message)


def error_body(code: str, message: str, details: Any = _UNSET) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if details is not _UNSET:
        err["details"] = details
    return {"error": err}


def error_response(err: HttpError) -> JSONResponse:
    return JSONResponse(error_body(err.code, err.message, err.details), status_code=err.status, headers=err.headers)


def pydantic_issues(e: ValidationError) -> list[dict[str, Any]]:
    """pydantic 錯誤轉為精簡格式（path / message / code），對應 zod issues 的用途"""
    return [{"path": list(i["loc"]), "message": i["msg"], "code": i["type"]} for i in e.errors()]


_HTTP_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    429: "TOO_MANY_REQUESTS",
    501: "NOT_IMPLEMENTED",
}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(HttpError)
    async def _http_error(_req: Request, err: HttpError) -> JSONResponse:
        return error_response(err)

    @app.exception_handler(ValidationError)
    async def _pydantic(_req: Request, err: ValidationError) -> JSONResponse:
        return error_response(validation_error(pydantic_issues(err)))

    @app.exception_handler(RequestValidationError)
    async def _request_validation(_req: Request, err: RequestValidationError) -> JSONResponse:
        issues = [{"path": list(i["loc"]), "message": i["msg"], "code": i["type"]} for i in err.errors()]
        return error_response(validation_error(issues))

    @app.exception_handler(StarletteHTTPException)
    async def _starlette(_req: Request, err: StarletteHTTPException) -> JSONResponse:
        code = _HTTP_CODES.get(err.status_code, "BAD_REQUEST")
        return JSONResponse(error_body(code, str(err.detail) or "請求錯誤"), status_code=err.status_code)

    @app.exception_handler(Exception)
    async def _unexpected(_req: Request, err: Exception) -> JSONResponse:
        log.exception("unhandled error", exc_info=err)
        return JSONResponse(error_body("INTERNAL_ERROR", "伺服器發生錯誤"), status_code=500)
