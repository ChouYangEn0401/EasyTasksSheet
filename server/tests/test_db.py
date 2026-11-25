import shutil
import sqlite3

import pytest

from server.app.changes import prune_changes, record_change
from server.app.db import DEFAULT_STATUSES, DRIZZLE_WHEN, MIGRATIONS_DIR, create_db, run_migrations, run_seed

from .helpers import create_test_db, create_test_user

#: 依檔名排序的全部 migration（新增 migration 不需改測試）
ALL_MIGRATIONS = [f.stem for f in sorted(MIGRATIONS_DIR.glob("*.sql"))]

ALL_TABLES = [
    "changes",
    "eng_github_links",
    "feedback_items",
    "git_issues_cache",
    "login_attempts",
    "manual_issues",
    "personal_items",
    "projects",
    "property_defs",
    "repos",
    "role_permissions",
    "sessions",
    "statuses",
    "tasks",
    "users",
    "worktree_plans",
    "worktree_records",
    "worktree_reports",
    "worktree_snapshots",
]


def table_names(db):
    return [
        r[0]
        for r in db.all(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
            "AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name"
        )
    ]


def test_fresh_db_full_schema_and_idempotent(tmp_path):
    path = str(tmp_path / "sub" / "test.db")
    db = create_db(path)
    assert run_migrations(db) == ALL_MIGRATIONS
    run_seed(db)
    assert table_names(db) == ALL_TABLES
    db.close()

    db2 = create_db(path)
    assert run_migrations(db2) == []
    run_seed(db2)
    run_seed(db2)
    assert db2.scalar("SELECT count(*) FROM statuses") == len(DEFAULT_STATUSES)
    assert db2.scalar("SELECT count(*) FROM projects") == 1
    assert db2.scalar("PRAGMA journal_mode") == "wal"
    assert db2.scalar("PRAGMA foreign_keys") == 1
    # TS 版（drizzle）也能辨識已套用的 migration
    assert db2.scalar('SELECT max(created_at) FROM "__drizzle_migrations"') == 1795533617781
    db2.close()


def test_seed_values():
    db = create_test_db()
    rows = db.all("SELECT name, color, category, sort_order FROM statuses ORDER BY sort_order")
    assert [tuple(r) for r in rows] == [
        ("待辦", "gray", "todo", 1),
        ("進行中", "blue", "doing", 2),
        ("審查中", "purple", "doing", 3),
        ("完成", "green", "done", 4),
    ]
    p = db.one("SELECT name, color, is_archived FROM projects")
    assert tuple(p) == ("預設專案", "blue", 0)


def test_upgrade_old_db_adds_is_merged(tmp_path):
    """舊 DB（只套用 0000）升級：worktree_snapshots 補上 is_merged（預設 0），既有資料保留"""
    old_dir = tmp_path / "old"
    old_dir.mkdir()
    shutil.copy(MIGRATIONS_DIR / "0000_init.sql", old_dir / "0000_init.sql")
    path = str(tmp_path / "test.db")

    db = create_db(path)
    run_migrations(db, old_dir)
    run_seed(db)

    def columns(d):
        return [r[0] for r in d.all("SELECT name FROM pragma_table_info('worktree_snapshots')")]

    assert "is_merged" not in columns(db)
    db.execute("INSERT INTO repos (name, created_at, updated_at) VALUES ('r', 1, 1)")
    repo_id = db.scalar("SELECT id FROM repos")
    db.execute(
        "INSERT INTO worktree_snapshots (repo_id, path, branch, ahead, reported_at) VALUES (?, ?, ?, ?, ?)",
        (repo_id, "/dev/wt", "feat/x", 0, 1),
    )
    db.close()

    db2 = create_db(path)
    assert run_migrations(db2) == ALL_MIGRATIONS[1:]
    assert run_migrations(db2) == []
    assert "is_merged" in columns(db2)
    rows = db2.all("SELECT * FROM worktree_snapshots")
    assert len(rows) == 1
    assert (rows[0]["repo_id"], rows[0]["path"], rows[0]["branch"], rows[0]["is_merged"]) == (
        repo_id,
        "/dev/wt",
        "feat/x",
        0,
    )
    db2.close()


def test_adopts_existing_drizzle_db(tmp_path):
    """由 TS 版（drizzle）建立的 DB：依 __drizzle_migrations 視為已套用，不重跑"""
    path = str(tmp_path / "ts.db")
    raw = sqlite3.connect(path)
    # TS 版只認得 drizzle 的 migration（0000、0001）
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if f.stem not in DRIZZLE_WHEN:
            continue
        for stmt in f.read_text(encoding="utf-8").split("--> statement-breakpoint"):
            if stmt.strip():
                raw.execute(stmt)
    raw.execute('CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)')
    raw.execute('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)', ("x", 1795515081096))
    raw.execute('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)', ("y", 1795533617781))
    raw.commit()
    raw.close()

    db = create_db(path)
    # drizzle 已套用者不重跑，只補上 Python 端新增的 migration
    assert run_migrations(db) == ALL_MIGRATIONS[2:]
    assert run_migrations(db) == []
    assert db.scalar("SELECT count(*) FROM _migrations") == len(ALL_MIGRATIONS)
    assert db.scalar("SELECT count(*) FROM manual_issues") == 0
    db.close()


def test_foreign_keys_enforced():
    db = create_test_db()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO tasks (title, project_id, status_id, created_at, updated_at) VALUES ('x', 999, 999, 1, 1)"
        )


def test_task_defaults():
    db = create_test_db()
    user = create_test_user(db)
    db.execute(
        "INSERT INTO tasks (title, project_id, status_id, created_by, created_at, updated_at) VALUES (?, 1, 1, ?, 1, 1)",
        ("寫報告", user["id"]),
    )
    row = db.one("SELECT * FROM tasks")
    assert row["custom"] == "{}"
    assert row["progress"] == 0
    assert row["deleted_at"] is None
    assert row["priority"] == "none"


# ── recordChange ──


def test_record_change_increments():
    db = create_test_db()
    with db.tx() as conn:
        a = record_change(conn, "task", 1, "create", None)
        b = record_change(conn, "task", 1, "update", None)
    assert b > a
    assert [r[0] for r in db.all("SELECT action FROM changes ORDER BY id")] == ["create", "update"]


def test_record_change_rolls_back_with_transaction():
    db = create_test_db()
    with pytest.raises(RuntimeError, match="rollback"):
        with db.tx() as conn:
            record_change(conn, "project", 1, "update", None)
            raise RuntimeError("rollback")
    assert db.scalar("SELECT count(*) FROM changes") == 0


def test_prune_changes():
    db = create_test_db()
    with db.tx() as conn:
        record_change(conn, "task", 1, "create", None, created_at=1000)
        record_change(conn, "task", 2, "create", None, created_at=5000)
        assert prune_changes(conn, 2000) == 1
    assert [r[0] for r in db.all("SELECT entity_id FROM changes")] == [2]
