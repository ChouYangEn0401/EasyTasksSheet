"""變更流水（changes 表）：所有寫入 API 都必須在同一個 transaction 內呼叫 record_change()。"""

from __future__ import annotations

import sqlite3
from typing import Literal

from .db import now_ms

EntityType = Literal["user", "project", "status", "task", "property", "feedback", "personal", "repo", "worktree_plan"]
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
    return int(cur.lastrowid)  # type: ignore[arg-type]


def prune_changes(conn: sqlite3.Connection, cutoff: int) -> int:
    """刪除早於 cutoff（unix ms）的變更流水，回傳刪除筆數"""
    return conn.execute("DELETE FROM changes WHERE created_at < ?", (cutoff,)).rowcount
