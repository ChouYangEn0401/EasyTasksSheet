"""/api/presence：在線感知（docs/design/presence.md）。

- PUT  /api/presence：回報目前頁面（view）與任務（entity）；**不刷新閒置計時**（security.IDLE_EXEMPT_PATHS），
  前端只在使用者實際操作時送出，因此 presence 不會讓 session 永不逾時。
  body：{ view?: string|null, entity?: {type:'task', id, mode:'viewing'|'editing'}|null,
          state?: 'active'|'idle'|'away', hidden?: boolean }
  hidden = true（使用者選擇「隱藏我的動態」）時伺服器一律把 view / entity 置空，只顯示在線。
- GET  /api/presence：所有啟用成員 { members: [{userId, status, view, entity, lastSeenAt, lastView}],
  onlineMs, idleMs, keepaliveMs }。GET 不刷新閒置計時。
- 狀態變化另以 SSE `presence` 事件推送（features/sync.py）。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, StringConstraints

from ..context import get_ctx
from ..presence import TITLE_MAX, VIEW_MAX, presence_options, registry_for
from ..validate import read_json
from ..schemas import DbId

router = APIRouter()


class PresenceEntityInput(BaseModel):
    model_config = {"extra": "ignore"}
    type: Literal["task"]
    id: DbId
    mode: Literal["viewing", "editing"] = "viewing"


class PresenceInput(BaseModel):
    model_config = {"extra": "ignore"}
    view: Annotated[str, StringConstraints(strip_whitespace=True, max_length=VIEW_MAX)] | None = None
    entity: PresenceEntityInput | None = None
    state: Literal["active", "idle", "away"] = "active"
    hidden: bool = False


def _summary(title: str) -> str:
    return title if len(title) <= TITLE_MAX else title[: TITLE_MAX - 1] + "…"


@router.put("")
async def report_presence(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    data = await read_json(request, PresenceInput)
    view = None if data.hidden else (data.view or None)
    entity: dict[str, Any] | None = None
    if not data.hidden and data.entity is not None:
        # 標題由伺服器查（不信任前端）；任務不存在或已刪除就不顯示
        row = ctx.db.one("SELECT title FROM tasks WHERE id = ? AND deleted_at IS NULL", (data.entity.id,))
        if row is not None:
            entity = {"type": "task", "id": data.entity.id, "title": _summary(row["title"]), "mode": data.entity.mode}
    registry_for(ctx.db).report(ctx.user["id"], ctx.now(), view=view, entity=entity, state=data.state)
    return {"ok": True}


@router.get("")
async def list_presence(request: Request) -> dict[str, Any]:
    ctx = get_ctx(request)
    return {
        "members": registry_for(ctx.db).snapshot(ctx.now()),
        "onlineMs": presence_options.online_ms,
        "idleMs": presence_options.idle_ms,
        "keepaliveMs": presence_options.keepalive_ms,
    }
