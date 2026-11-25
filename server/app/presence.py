"""在線感知（presence）登錄：誰在線、正在看哪個頁面 / 哪個任務（docs/multi-user.md、docs/design/presence.md）。

- 即時狀態只存在記憶體（單一 worker；伺服器重啟後清空）；「最後上線時間 / 最後看的頁面」寫入
  user_presence 表（0009），重啟後由 DB 補上。
- 狀態：最後一次回報在 online_ms 內 = online；idle_ms 內（或前端回報 state=idle）= idle；否則 offline。
- 只在某人的「狀態 / 頁面 / 任務」有變化時才廣播（SSE `presence` 事件），keepalive 只更新時間、不廣播。
- 有 SSE 訂閱者時每 sweep_ms 掃描一次，把逾時者轉為 idle / offline 並廣播；沒有訂閱者時不掃描
  （GET / PUT 時也會順手掃描）。
- presence 回報（PUT /api/presence）**不刷新閒置計時**（security.IDLE_EXEMPT_PATHS）。
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import threading
import weakref
from dataclasses import dataclass
from typing import Any, Callable, Literal

from . import config as _config  # noqa: F401 — 確保 .env 已載入，再讀下方環境變數
from .db import Database

Status = Literal["online", "idle", "offline"]
Member = dict[str, Any]
Listener = Callable[[list[Member]], None]


def _env_seconds(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        v = float(raw) if raw else default
    except ValueError:
        v = default
    return v if v > 0 else default


@dataclass
class PresenceOptions:
    #: 最後一次回報在此時間內 = 在線（PRESENCE_ONLINE_SECONDS，預設 45 秒）
    online_ms: int
    #: 最後一次回報在此時間內 = 閒置，超過 = 離線（PRESENCE_IDLE_SECONDS，預設 300 秒）
    idle_ms: int
    #: 有 SSE 訂閱者時的逾時掃描間隔
    sweep_ms: int = 1000
    #: 「最後上線」寫入 DB 的最短間隔（頁面改變時立即寫入）
    persist_ms: int = 60_000

    @property
    def keepalive_ms(self) -> int:
        """前端在使用者有操作時的 keepalive 間隔：20 秒，且不超過在線門檻的一半"""
        return max(1000, min(20_000, self.online_ms // 2))


def _load_options() -> PresenceOptions:
    online = round(_env_seconds("PRESENCE_ONLINE_SECONDS", 45) * 1000)
    idle = round(_env_seconds("PRESENCE_IDLE_SECONDS", 300) * 1000)
    return PresenceOptions(online_ms=online, idle_ms=max(idle, online))


#: 可在測試中調整（測試結束後還原）
presence_options = _load_options()

VIEW_MAX = 40
TITLE_MAX = 60


@dataclass
class Entry:
    user_id: int
    last_seen: int
    state: str  # active | idle
    view: str | None
    #: {type, id, title, mode}
    entity: dict[str, Any] | None
    persisted_at: int = 0
    persisted_view: str | None = None


class PresenceEvent:
    """SSE 佇列中的 presence 項目（與 change 批次共用同一個佇列）"""

    __slots__ = ("members",)

    def __init__(self, members: list[Member]):
        self.members = members


def status_of(entry: Entry | None, now: int) -> Status:
    if entry is None:
        return "offline"
    age = now - entry.last_seen
    if age >= presence_options.idle_ms:
        return "offline"
    if entry.state == "idle" or age >= presence_options.online_ms:
        return "idle"
    return "online"


def _signature(status: Status, entry: Entry | None) -> tuple[Any, ...]:
    if status == "offline" or entry is None:
        return ("offline",)
    e = entry.entity
    return (status, entry.view, (e["id"], e["mode"], e["title"]) if e else None)


def _member(user_id: int, status: Status, entry: Entry | None, last_seen: int | None, last_view: str | None) -> Member:
    live = status != "offline" and entry is not None
    return {
        "userId": user_id,
        "status": status,
        "view": entry.view if live and entry else None,
        "entity": dict(entry.entity) if live and entry and entry.entity else None,
        "lastSeenAt": entry.last_seen if entry is not None else last_seen,
        "lastView": entry.view if entry is not None else last_view,
    }


class PresenceRegistry:
    def __init__(self, db: Database):
        self.db = db
        self.entries: dict[int, Entry] = {}
        #: 最後一次廣播的狀態簽章（只在改變時廣播）
        self.published: dict[int, tuple[Any, ...]] = {}
        self.lock = threading.Lock()
        self.listeners: set[Listener] = set()
        self._task: asyncio.Task[None] | None = None
        self._now: Callable[[], int] | None = None

    @property
    def size(self) -> int:
        return len(self.listeners)

    # ── 回報 ──

    def report(
        self,
        user_id: int,
        now: int,
        *,
        view: str | None,
        entity: dict[str, Any] | None,
        state: str = "active",
    ) -> None:
        """使用者回報目前頁面 / 任務。state=away（關閉分頁）立即轉離線。entity 需已含 title。"""
        if state == "away":
            self.leave(user_id, now)
            return
        with self.lock:
            entry = self.entries.get(user_id)
            if entry is None:
                entry = Entry(user_id, now, state, view, entity)
                self.entries[user_id] = entry
            else:
                entry.last_seen, entry.state, entry.view, entry.entity = now, state, view, entity
            should_persist = entry.persisted_at == 0 or entry.persisted_view != view or (
                now - entry.persisted_at >= presence_options.persist_ms
            )
            if should_persist:
                entry.persisted_at, entry.persisted_view = now, view
        if should_persist:
            self._persist(user_id, now, view)
        self.sweep(now)

    def leave(self, user_id: int, now: int) -> None:
        with self.lock:
            entry = self.entries.pop(user_id, None)
        if entry is not None:
            self._persist(user_id, now, entry.view)
        self.sweep(now)

    def _persist(self, user_id: int, t: int, view: str | None) -> None:
        try:
            self.db.execute(
                "INSERT INTO user_presence (user_id, last_seen_at, last_view) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, last_view = excluded.last_view",
                (user_id, t, view),
            )
        except Exception:  # noqa: BLE001 — 只是「最後上線」紀錄，失敗不影響主要功能
            pass

    # ── 查詢 ──

    def snapshot(self, now: int) -> list[Member]:
        """所有啟用中成員的狀態（依 id 排序）"""
        self.sweep(now)
        rows = self.db.all(
            "SELECT u.id, p.last_seen_at, p.last_view FROM users u "
            "LEFT JOIN user_presence p ON p.user_id = u.id WHERE u.is_active = 1 ORDER BY u.id"
        )
        with self.lock:
            out = []
            for r in rows:
                entry = self.entries.get(r["id"])
                out.append(_member(r["id"], status_of(entry, now), entry, r["last_seen_at"], r["last_view"]))
            return out

    # ── 逾時掃描與廣播 ──

    def sweep(self, now: int) -> list[Member]:
        """把逾時者轉為 idle / offline；回傳並廣播狀態有變化的成員"""
        changed: list[Member] = []
        gone: list[Entry] = []
        with self.lock:
            ids = set(self.entries) | set(self.published)
            for uid in sorted(ids):
                entry = self.entries.get(uid)
                status = status_of(entry, now)
                if status == "offline" and entry is not None:
                    del self.entries[uid]
                    gone.append(entry)
                sig = _signature(status, entry)
                if self.published.get(uid, ("offline",)) == sig:
                    if status == "offline":
                        self.published.pop(uid, None)
                    continue
                if status == "offline":
                    self.published.pop(uid, None)
                else:
                    self.published[uid] = sig
                changed.append(_member(uid, status, entry, None, None))
        for entry in gone:
            # 逾時離線：把最後一次回報時間寫回（keepalive 之間最多差 persist_ms）
            self._persist(entry.user_id, entry.last_seen, entry.view)
        if changed:
            self._dispatch(changed)
        return changed

    def _dispatch(self, members: list[Member]) -> None:
        for fn in list(self.listeners):
            try:
                fn(members)
            except Exception:  # noqa: BLE001 — 單一連線出錯不影響其他連線
                pass

    def subscribe(self, fn: Listener, now: Callable[[], int]) -> Callable[[], None]:
        """SSE 連線訂閱 presence 變化（須在事件迴圈中呼叫）；回傳取消訂閱函式"""
        self.listeners.add(fn)
        self._now = now
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._run())

        def unsubscribe() -> None:
            self.listeners.discard(fn)
            if not self.listeners:
                task, self._task = self._task, None
                if task is not None and not task.done():
                    with contextlib.suppress(RuntimeError):  # 迴圈已關閉
                        task.cancel()

        return unsubscribe

    async def _run(self) -> None:
        try:
            while self.listeners:
                await asyncio.sleep(presence_options.sweep_ms / 1000)
                if not self.listeners or self._now is None:
                    break
                try:
                    self.sweep(self._now())
                except Exception:  # noqa: BLE001 — DB 已關閉（測試結束）等情況
                    pass
        except asyncio.CancelledError:
            pass


_registries: "weakref.WeakKeyDictionary[Database, PresenceRegistry]" = weakref.WeakKeyDictionary()


def registry_for(db: Database) -> PresenceRegistry:
    reg = _registries.get(db)
    if reg is None:
        reg = PresenceRegistry(db)
        _registries[db] = reg
    return reg
