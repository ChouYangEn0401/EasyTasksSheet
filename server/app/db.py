"""SQLite 連線、migration、seed 與資料列轉換。

- 單一連線（check_same_thread=False）＋ RLock 序列化存取；autocommit 模式，寫入以 tx() 包成 transaction。
- schema 與 TS 版（drizzle/*.sql）完全相同，可直接開啟既有 DB 檔。
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"

#: drizzle journal 的 `when`（寫入 __drizzle_migrations，讓 TS 版仍能開啟由 Python 建立的 DB）
DRIZZLE_WHEN = {
    "0000_init": 1795515081096,
    "0001_worktree_is_merged": 1795533617781,
}


def now_ms() -> int:
    return int(time.time() * 1000)


class Database:
    """包裝 sqlite3 連線；所有存取經過同一把鎖。"""

    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA busy_timeout = 5000")
        self.lock = threading.RLock()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """transaction；巢狀呼叫時沿用外層 transaction。例外時 rollback。"""
        with self.lock:
            if self.conn.in_transaction:
                yield self.conn
                return
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            else:
                self.conn.execute("COMMIT")

    def execute(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Cursor:
        with self.lock:
            return self.conn.execute(sql, params)

    def one(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute(sql, params).fetchone()

    def all(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, params).fetchall()

    def scalar(self, sql: str, params: Sequence[Any] = ()) -> Any:
        row = self.one(sql, params)
        return None if row is None else row[0]

    def close(self) -> None:
        with self.lock:
            self.conn.close()


def create_db(path: str) -> Database:
    return Database(path)


# ── migration ──────────────────────────────────────────────

_BREAKPOINT = re.compile(r"-->\s*statement-breakpoint")


def _migration_files(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.sql"))


def run_migrations(db: Database, directory: Path = MIGRATIONS_DIR) -> list[str]:
    """套用尚未執行的 migration（記錄於 _migrations）；可重複執行。回傳本次套用的名稱。

    既有由 TS 版（drizzle）建立的 DB：第一次執行時依 __drizzle_migrations 的筆數視為已套用。
    """
    applied_now: list[str] = []
    with db.tx() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)"
        )
        conn.execute(
            'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" '
            "(id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)"
        )
        files = _migration_files(directory)
        applied = {r[0] for r in conn.execute("SELECT name FROM _migrations")}
        if not applied:
            # 沿用 drizzle 的紀錄：created_at 為 journal 的 when
            done_when = {r[0] for r in conn.execute('SELECT created_at FROM "__drizzle_migrations"')}
            for f in files:
                when = DRIZZLE_WHEN.get(f.stem)
                if when is not None and any(int(w) >= when for w in done_when if w is not None):
                    conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", (f.stem, now_ms()))
                    applied.add(f.stem)
        for f in files:
            if f.stem in applied:
                continue
            sql = f.read_text(encoding="utf-8")
            for stmt in _BREAKPOINT.split(sql):
                if stmt.strip():
                    conn.execute(stmt)
            conn.execute("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)", (f.stem, now_ms()))
            when = DRIZZLE_WHEN.get(f.stem)
            if when is not None:
                conn.execute(
                    'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
                    (hashlib.sha256(sql.encode("utf-8")).hexdigest(), when),
                )
            applied_now.append(f.stem)
    return applied_now


# ── seed ───────────────────────────────────────────────────

DEFAULT_STATUSES = [
    {"name": "待辦", "color": "gray", "category": "todo", "sort_order": 1},
    {"name": "進行中", "color": "blue", "category": "doing", "sort_order": 2},
    {"name": "審查中", "color": "purple", "category": "doing", "sort_order": 3},
    {"name": "完成", "color": "green", "category": "done", "sort_order": 4},
]
DEFAULT_PROJECT = {"name": "預設專案", "color": "blue", "sort_order": 1}


def run_seed(db: Database) -> None:
    """寫入預設資料；只在資料表為空時寫入，可重複執行。"""
    t = now_ms()
    with db.tx() as conn:
        if conn.execute("SELECT count(*) FROM statuses").fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO statuses (name, color, category, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                [(s["name"], s["color"], s["category"], s["sort_order"], t, t) for s in DEFAULT_STATUSES],
            )
        if conn.execute("SELECT count(*) FROM projects").fetchone()[0] == 0:
            p = DEFAULT_PROJECT
            conn.execute(
                "INSERT INTO projects (name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (p["name"], p["color"], p["sort_order"], t, t),
            )


# ── 資料列轉換（snake_case → camelCase，布林與 JSON 欄位還原）──

_BOOL_COLUMNS = {
    "is_active",
    "must_change_password",
    "is_archived",
    "success",
    "is_done",
    "is_dirty",
    "is_prunable",
    "is_merged",
}
_JSON_COLUMNS = {"custom", "options", "labels"}


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def row_to_dict(row: sqlite3.Row | None, exclude: Iterable[str] = ()) -> dict[str, Any] | None:
    if row is None:
        return None
    skip = set(exclude)
    out: dict[str, Any] = {}
    for key in row.keys():
        if key in skip:
            continue
        v = row[key]
        if key in _BOOL_COLUMNS and v is not None:
            v = bool(v)
        elif key in _JSON_COLUMNS and isinstance(v, str):
            v = json.loads(v)
        out[camel(key)] = v
    return out


def rows_to_dicts(rows: Iterable[sqlite3.Row], exclude: Iterable[str] = ()) -> list[dict[str, Any]]:
    return [row_to_dict(r, exclude) for r in rows]  # type: ignore[misc]


def next_sort_order(conn: sqlite3.Connection, table: str) -> float:
    """新項目排在最後：目前最大 sort_order + 1"""
    m = conn.execute(f"SELECT max(sort_order) FROM {table}").fetchone()[0]
    return float(m or 0) + 1
