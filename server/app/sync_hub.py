"""變更廣播中心（每個 Database 一個）。

record_change() 屬凍結的 core lib，不能在寫入當下直接通知；因此 hub 在「有訂閱者時」
以短間隔查 changes 表的新流水（id > last_id，走主鍵索引，成本極低），再推給所有 SSE 連線。
沒有訂閱者時停止輪詢。同一行程內所有連線共用一次查詢。

- 輪詢以 asyncio task 執行（綁定第一個訂閱者所在的事件迴圈；uvicorn 只有一個迴圈）。
- sqlite3 查詢一律丟到 threadpool（anyio.to_thread），避免 DB 鎖被寫入佔用時阻塞事件迴圈。
"""

from __future__ import annotations

import asyncio
import contextlib
import weakref
from dataclasses import dataclass
from typing import Any, Callable

from anyio import to_thread

from .db import Database


@dataclass
class SyncOptions:
    #: hub 查新流水的間隔
    poll_ms: int = 250
    #: SSE 心跳間隔（避免代理 / 瀏覽器判定逾時，同時重新檢查 session）
    heartbeat_ms: int = 25_000
    #: 單次補漏 / 重播的上限筆數
    max_batch: int = 500


#: 可在測試中調整（測試結束後還原）
sync_options = SyncOptions()

Change = dict[str, Any]
Listener = Callable[[list[Change]], None]


def _to_change(r: Any) -> Change:
    return {
        "id": r["id"],
        "entityType": r["entity_type"],
        "entityId": r["entity_id"],
        "action": r["action"],
        "actorId": r["actor_id"],
        "createdAt": r["created_at"],
    }


def latest_change_id(db: Database) -> int:
    """目前最新的 change id（無流水時為 0）"""
    return int(db.scalar("SELECT id FROM changes ORDER BY id DESC LIMIT 1") or 0)


def first_change_id(db: Database) -> int | None:
    v = db.scalar("SELECT id FROM changes ORDER BY id ASC LIMIT 1")
    return None if v is None else int(v)


def changes_since(db: Database, since: int, limit: int | None = None) -> list[Change]:
    """取 id > since 的流水（依 id 遞增，最多 limit 筆）"""
    n = sync_options.max_batch if limit is None else limit
    rows = db.all(
        "SELECT id, entity_type, entity_id, action, actor_id, created_at FROM changes WHERE id > ? ORDER BY id ASC LIMIT ?",
        (since, n),
    )
    return [_to_change(r) for r in rows]


class ChangeHub:
    def __init__(self, db: Database):
        self.db = db
        self.listeners: set[Listener] = set()
        self.last_id = 0
        self._task: asyncio.Task[None] | None = None
        self._ready: asyncio.Event | None = None

    @property
    def size(self) -> int:
        return len(self.listeners)

    async def subscribe(self, fn: Listener) -> Callable[[], None]:
        """訂閱；回傳取消訂閱函式。回傳時 hub 的起點（last_id）已確定，之後的流水不會漏。"""
        self.listeners.add(fn)
        if self._task is None or self._task.done():
            self._ready = asyncio.Event()
            self._task = asyncio.get_running_loop().create_task(self._run(self._ready))
        ready = self._ready
        assert ready is not None
        await ready.wait()

        def unsubscribe() -> None:
            self.listeners.discard(fn)
            if not self.listeners:
                self._stop()

        return unsubscribe

    def _dispatch(self, rows: list[Change]) -> None:
        if not rows:
            return
        self.last_id = rows[-1]["id"]
        for fn in list(self.listeners):
            try:
                fn(rows)
            except Exception:  # noqa: BLE001 — 單一連線出錯不影響其他連線
                pass

    async def poll(self) -> None:
        """立即檢查一次新流水（測試與計時器共用）"""
        try:
            rows = await to_thread.run_sync(changes_since, self.db, self.last_id)
        except Exception:  # noqa: BLE001 — DB 已關閉（測試結束）等情況：靜默略過
            return
        self._dispatch(rows)

    async def _run(self, ready: asyncio.Event) -> None:
        try:
            try:
                self.last_id = await to_thread.run_sync(latest_change_id, self.db)
            except Exception:  # noqa: BLE001 — DB 已關閉等情況：沿用舊起點
                pass
            finally:
                ready.set()
            while self.listeners:
                await asyncio.sleep(sync_options.poll_ms / 1000)
                if not self.listeners:
                    break
                await self.poll()
        except asyncio.CancelledError:
            pass

    def _stop(self) -> None:
        task, self._task, self._ready = self._task, None, None
        if task is not None and not task.done():
            with contextlib.suppress(RuntimeError):  # 迴圈已關閉
                task.cancel()


_hubs: "weakref.WeakKeyDictionary[Database, ChangeHub]" = weakref.WeakKeyDictionary()


def hub_for(db: Database) -> ChangeHub:
    hub = _hubs.get(db)
    if hub is None:
        hub = ChangeHub(db)
        _hubs[db] = hub
    return hub
