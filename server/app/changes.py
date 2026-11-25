"""變更流水（changes 表）：所有寫入 API 都必須在同一個 transaction 內呼叫 record_change()。"""

from __future__ import annotations

import logging
import sqlite3
from typing import Literal

from .db import Database, now_ms
from .timeutil import DAY_MS

log = logging.getLogger(__name__)

#: permission：權限設定（entity_id 固定為 0；前端收到後重抓 /api/auth/me）
EntityType = Literal[
    "user", "project", "status", "task", "property", "feedback", "personal", "repo", "worktree_plan", "permission",
    # 任務討論區的留言（entity_id = 留言 id；前端據此重抓討論區與任務清單的留言徽章）
    "task_comment",
]
ChangeAction = Literal["create", "update", "delete"]


def record_change(
    conn: sqlite3.Connection,
    entity_type: EntityType,
    entity_id: int,
    action: ChangeAction,
    actor_id: int | None,
    created_at: int | None = None,
) -> int:
    """寫入一筆變更流水，回傳 change id。created_at 預設為目前時間（可傳入注入的時鐘）。"""
    cur = conn.execute(
        "INSERT INTO changes (entity_type, entity_id, action, actor_id, created_at) VALUES (?, ?, ?, ?, ?)",
        (entity_type, entity_id, action, actor_id, now_ms() if created_at is None else created_at),
    )
    t = now_ms() if created_at is None else created_at
    try:
        maybe_prune(conn, t)
    except sqlite3.Error:
        log.warning("changes 流水修剪失敗", exc_info=True)
    return int(cur.lastrowid)  # type: ignore[arg-type]


def prune_changes(conn: sqlite3.Connection, cutoff: int) -> int:
    """刪除早於 cutoff（unix ms）的變更流水，回傳刪除筆數"""
    return conn.execute("DELETE FROM changes WHERE created_at < ?", (cutoff,)).rowcount


# ── 保留期限 ─────────────────────────────────────────────
# 與稽核紀錄（audit.maybe_prune / prune_on_startup）同一套做法：啟動時修剪一次，之後寫入時每日至多一次。
# 修剪後 `GET /api/changes?since=` / SSE 重播若 since 早於最小 id，由 features/sync.py 回 reset = true。

_last_prune: dict[int, int] = {}


def retention_ms(days: float | None = None) -> int | None:
    """保留毫秒數；days <= 0 表示不修剪（回傳 None；設定檔本身拒絕 <= 0，此為程式內部防呆）。未給時取 config.CHANGES_RETENTION_DAYS"""
    if days is None:
        from .config import config

        days = config.CHANGES_RETENTION_DAYS
    return int(days * DAY_MS) if days > 0 else None


def maybe_prune(conn: sqlite3.Connection, t: int, days: float | None = None) -> int:
    """每日至多修剪一次（寫入流水時順便檢查）；不修剪時回 0"""
    keep = retention_ms(days)
    if keep is None:
        return 0
    key = id(conn)
    last = _last_prune.get(key)
    if last is not None and 0 <= t - last < DAY_MS:
        return 0
    _last_prune[key] = t
    return prune_changes(conn, t - keep)


def prune_on_startup(db: Database, now: int | None = None, days: float | None = None) -> int:
    keep = retention_ms(days)
    if keep is None:
        return 0
    t = now_ms() if now is None else now
    with db.tx() as conn:
        n = prune_changes(conn, t - keep)
    _last_prune[id(db.conn)] = t
    return n
