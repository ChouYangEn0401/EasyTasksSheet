"""/api/changes 與 /api/events（SSE）。

- GET /api/changes?since=<id>：SSE 斷線補漏、輪詢後備
  （回應 { changes, latestId, hasMore, reset }；since 未給時只回 latestId）
- GET /api/events：SSE
  - 連線時送 `ready`（data: { latestId, reset }，retry: 3000）；若帶 ?since= 或 Last-Event-ID，先重播其後的流水
    （無法完整重播時 reset = true，前端應全部重抓）
  - 每筆變更送 `change`（id = change id，data = Change JSON）
  - 在線狀態變化送 `presence`（data = { members: [...] }，見 features/presence.py；無 id、不參與重播）
  - 每 heartbeat_ms 送 `ping` 心跳，並重新檢查 session；失效時送 `expired` 後關閉
  - 本連線屬 GET，不刷新閒置計時（require_session 只對非 GET 刷新）
"""

from __future__ import annotations

import asyncio
import json
import math
import re
from typing import Any, AsyncIterator

import anyio
from anyio import to_thread
from fastapi import APIRouter, Request
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from ..context import get_ctx
from ..db import Database
from ..errors import validation_error
from ..presence import PresenceEvent, registry_for
from ..sync_hub import Change, changes_since, first_change_id, hub_for, latest_change_id, sync_options
from ..validate import ID_MAX

changes_router = APIRouter()
events_router = APIRouter()


# ── since 參數（對應 z.coerce.number().int().min(0).optional()）──

_JS_NUMBER = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|[+-]?Infinity")
_JS_RADIX = re.compile(r"0([xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)")


def js_number(value: str | None) -> float:
    """JavaScript Number(value) 的近似：前後空白忽略、空字串為 0、無法解析為 NaN"""
    if value is None:
        return math.nan
    s = value.strip()
    if not s:
        return 0.0
    if _JS_RADIX.fullmatch(s):
        return float(int(s, 0))
    if _JS_NUMBER.fullmatch(s):
        return float(s.replace("Infinity", "inf"))
    return math.nan


def _read_since(request: Request) -> int | None:
    raw = request.query_params.get("since")
    if raw is None:
        return None
    n = js_number(raw)
    if not math.isfinite(n) or n != int(n):
        raise validation_error([{"path": ["since"], "message": "須為整數", "code": "invalid_type"}])
    if n < 0:
        raise validation_error([{"path": ["since"], "message": "不得小於 0", "code": "too_small"}])
    return min(int(n), ID_MAX)


# ── 讀流水 ──


def read_changes(db: Database, since: int | None) -> dict[str, Any]:
    """取 since 之後的流水；since 未給時只回 latestId（用來取得起點）"""
    latest_id = latest_change_id(db)
    if since is None or since >= latest_id:
        return {"changes": [], "latestId": latest_id, "hasMore": False, "reset": False}
    first = first_change_id(db)
    reset = first is not None and since < first - 1
    rows = changes_since(db, since, sync_options.max_batch + 1)
    has_more = len(rows) > sync_options.max_batch
    lst = rows[: sync_options.max_batch] if has_more else rows
    return {
        "changes": lst,
        "latestId": lst[-1]["id"] if has_more else latest_id,
        "hasMore": has_more,
        "reset": reset,
    }


@changes_router.get("")
async def get_changes(request: Request) -> dict[str, Any]:
    since = _read_since(request)
    return await to_thread.run_sync(read_changes, get_ctx(request).db, since)


# ── SSE ──


def _json(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def sse_event(event: str, data: str, id: int | None = None, retry: int | None = None) -> bytes:
    """格式同 hono 的 writeSSE：event、data（多行拆開）、id、retry，以空行結尾"""
    lines = [f"event: {event}"]
    lines += [f"data: {line}" for line in data.split("\n")]
    if id is not None:
        lines.append(f"id: {id}")
    if retry:
        lines.append(f"retry: {retry}")
    return ("\n".join(lines) + "\n\n").encode("utf-8")


def session_still_valid(db: Database, session_id: str, t: int, idle_timeout_ms: int) -> bool:
    """SSE 連線期間 session 是否仍有效（GET 不刷新閒置計時，所以逾時後會被斷開）"""
    s = db.one("SELECT user_id, expires_at, last_active_at FROM sessions WHERE id = ?", (session_id,))
    if s is None:
        return False
    if t >= s["expires_at"] or t - s["last_active_at"] >= idle_timeout_ms:
        return False
    u = db.one("SELECT is_active FROM users WHERE id = ?", (s["user_id"],))
    return bool(u and u["is_active"])


class SSEResponse(StreamingResponse):
    """一律同時監聽 http.disconnect：客戶端斷線時立即取消串流（觸發 generator 的 finally 釋放訂閱），
    而不是等到下一次寫入（最長一個心跳）才發現。"""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async with anyio.create_task_group() as tg:

            async def stream() -> None:
                try:
                    await self.stream_response(send)
                except OSError:
                    pass  # 寫入時連線已斷
                tg.cancel_scope.cancel()

            tg.start_soon(stream)
            await self.listen_for_disconnect(receive)
            tg.cancel_scope.cancel()


SSE_HEADERS = {
    # 代理（Caddy / nginx）不得緩衝或壓縮此回應
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
}


@events_router.get("")
async def events(request: Request) -> SSEResponse:
    since_param = _read_since(request)
    leid = js_number(request.headers.get("last-event-id"))
    since = min(int(leid), ID_MAX) if math.isfinite(leid) and leid == int(leid) and leid > 0 else since_param
    ctx = get_ctx(request)
    db, now, idle_ms, session_id = ctx.db, ctx.now, ctx.settings.idle_timeout_ms, ctx.session.id

    async def stream() -> AsyncIterator[bytes]:
        queue: asyncio.Queue[list[Change] | PresenceEvent] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        # presence 變化（features/presence.py）可能由其他執行緒觸發 → 以 call_soon_threadsafe 放入同一佇列
        unsubscribe_presence = registry_for(db).subscribe(
            lambda members: loop.call_soon_threadsafe(queue.put_nowait, PresenceEvent(members)), now
        )
        # 先訂閱再重播（hub 起點在 subscribe 回傳前已確定，不會漏；以 sent 過濾重複）
        try:
            unsubscribe = await hub_for(db).subscribe(queue.put_nowait)
        except BaseException:
            unsubscribe_presence()
            raise
        try:
            latest_id = await to_thread.run_sync(latest_change_id, db)
            replay = await to_thread.run_sync(read_changes, db, since) if since is not None else None
            complete = replay is not None and not replay["reset"] and not replay["hasMore"]
            yield sse_event(
                "ready", _json({"latestId": latest_id, "reset": replay is not None and not complete}), retry=3000
            )
            sent = since if complete else latest_id
            assert sent is not None
            pending: list[Change] = replay["changes"] if complete and replay else []

            deadline = loop.time() + sync_options.heartbeat_ms / 1000
            while True:
                for row in pending:
                    if row["id"] > sent:
                        sent = row["id"]
                        yield sse_event("change", _json(row), id=row["id"])
                pending = []
                try:
                    item = await asyncio.wait_for(queue.get(), max(0.0, deadline - loop.time()))
                    if isinstance(item, PresenceEvent):
                        yield sse_event("presence", _json({"members": item.members}))
                    else:
                        pending = item
                    continue
                except asyncio.TimeoutError:
                    pass
                deadline = loop.time() + sync_options.heartbeat_ms / 1000
                if not await to_thread.run_sync(session_still_valid, db, session_id, now(), idle_ms):
                    yield sse_event("expired", "{}")
                    return
                # 以具名事件送心跳（前端可據此偵測半開連線；EventSource 看不到註解行）
                yield sse_event("ping", "")
        finally:
            unsubscribe()
            unsubscribe_presence()

    return SSEResponse(stream(), media_type="text/event-stream", headers=SSE_HEADERS)
