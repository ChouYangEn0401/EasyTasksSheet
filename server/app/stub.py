"""尚未實作的 feature router：任何路徑、任何方法都回 501（而非 404）。"""

from __future__ import annotations

from fastapi import APIRouter

from .errors import not_implemented

ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]


def stub_router(feature: str) -> APIRouter:
    router = APIRouter()

    async def _stub() -> None:
        raise not_implemented(f"{feature} 尚未實作")

    router.add_api_route("", _stub, methods=ALL_METHODS, include_in_schema=False)
    router.add_api_route("/{rest:path}", _stub, methods=ALL_METHODS, include_in_schema=False)
    return router
