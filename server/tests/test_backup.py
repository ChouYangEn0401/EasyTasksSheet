"""server/app/backup.py 與 `python -m server.cli backup / restore`。"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from server import cli
from server.app import backup as bk
from server.app.db import create_db, run_migrations, run_seed

T0 = datetime(2026, 1, 1, 3, 0, 0)


def projects(path: Path) -> list[tuple]:
    with closing(sqlite3.connect(path)) as c:
        return c.execute("SELECT id, name FROM projects ORDER BY id").fetchall()


@pytest.fixture
def live(tmp_path: Path):
    """模擬運行中的服務：真實 schema、WAL 模式、連線保持開啟、資料尚未 checkpoint"""
    db = create_db(str(tmp_path / "data" / "app.db"))
    db.execute("PRAGMA wal_autocheckpoint = 0")
    run_migrations(db)
    run_seed(db)
    for i in range(3):
        db.execute(
            "INSERT INTO projects (name, color, sort_order, created_at, updated_at) VALUES (?, 'blue', ?, 0, 0)",
            (f"專案 {i}", i + 2),
        )
    yield db
    try:
        db.close()
    except sqlite3.ProgrammingError:
        pass


def test_backup_while_running_includes_wal(live, tmp_path):
    db_path = Path(live.path)
    assert Path(f"{db_path}-wal").stat().st_size > 0
    r = bk.backup(db_path, tmp_path / "backups", keep=3, now=T0)
    assert r.file.name == "app-20260101-030000.db"
    assert r.removed == []
    assert projects(r.file) == [tuple(x) for x in live.all("SELECT id, name FROM projects ORDER BY id")]
    assert len(projects(r.file)) == 4
    # 單一檔案、沒有半成品
    assert not Path(f"{r.file}-wal").exists()
    assert not list((tmp_path / "backups").glob("*.partial"))
    with closing(sqlite3.connect(r.file)) as c:
        assert c.execute("PRAGMA journal_mode").fetchone()[0] == "delete"


def test_same_second_gets_suffix_and_keep_rotation(live, tmp_path):
    out = tmp_path / "backups"
    a = bk.backup(live.path, out, keep=2, now=T0)
    b = bk.backup(live.path, out, keep=2, now=T0)
    assert b.file.name == "app-20260101-030000-2.db"
    c = bk.backup(live.path, out, keep=2, now=T0 + timedelta(days=1))
    assert c.removed == [a.file]
    assert bk.list_backups(live.path, out) == [b.file, c.file]
    # 其他檔案不受保留份數影響
    (out / "notes.txt").write_text("x")
    (out / "other-20250101-000000.db").write_text("x")
    bk.backup(live.path, out, keep=1, now=T0 + timedelta(days=2))
    assert (out / "notes.txt").exists() and (out / "other-20250101-000000.db").exists()
    assert len(bk.list_backups(live.path, out)) == 1


def test_backup_errors(tmp_path):
    with pytest.raises(bk.BackupError, match="找不到資料庫"):
        bk.backup(tmp_path / "nope.db", tmp_path / "b")
    db = tmp_path / "x.db"
    sqlite3.connect(db).close()
    with pytest.raises(bk.BackupError, match="保留份數"):
        bk.backup(db, tmp_path / "b", keep=0)


def test_restore_round_trip(live, tmp_path):
    db_path = Path(live.path)
    out = tmp_path / "backups"
    expected = projects(bk.backup(db_path, out, keep=5, now=T0).file)
    live.execute(
        "INSERT INTO projects (name, color, sort_order, created_at, updated_at) VALUES ('備份後', 'red', 9, 0, 0)"
    )
    live.close()  # 停止服務

    previous = bk.restore(bk.list_backups(db_path, out)[-1], db_path, now=T0 + timedelta(hours=1))
    assert previous == db_path.with_name("app.db.before-restore-20260101-040000")
    assert previous.exists()
    assert ("備份後",) in [(n,) for _, n in projects(previous)]
    assert projects(db_path) == expected
    for suffix in ("-wal", "-shm", "-journal"):
        assert not Path(f"{db_path}{suffix}").exists()
    # 還原後服務可正常開啟並寫入
    db = create_db(str(db_path))
    try:
        run_migrations(db)
        assert db.scalar("PRAGMA journal_mode") == "wal"
        db.execute(
            "INSERT INTO projects (name, color, sort_order, created_at, updated_at) VALUES ('新', 'red', 9, 0, 0)"
        )
        assert db.scalar("SELECT count(*) FROM projects") == len(expected) + 1
    finally:
        db.close()


def test_restore_rejects_corrupt_backup(tmp_path):
    db_path = tmp_path / "app.db"
    with closing(sqlite3.connect(db_path)) as c:
        c.execute("CREATE TABLE t (x)")
        c.execute("INSERT INTO t VALUES (1)")
        c.commit()
    bad = tmp_path / "bad.db"
    bad.write_bytes(b"garbage" * 1000)
    with pytest.raises(bk.BackupError, match="integrity_check"):
        bk.restore(bad, db_path)
    with pytest.raises(bk.BackupError, match="找不到備份檔"):
        bk.restore(tmp_path / "missing.db", db_path)
    # 資料庫未被動到、也沒有留下 before-restore
    with closing(sqlite3.connect(db_path)) as c:
        assert c.execute("SELECT x FROM t").fetchall() == [(1,)]
    assert not list(tmp_path.glob("*.before-restore-*"))


def test_restore_into_missing_db(tmp_path, live):
    b = bk.backup(live.path, tmp_path / "b", now=T0)
    target = tmp_path / "new" / "app.db"
    assert bk.restore(b.file, target) is None
    assert projects(target) == projects(b.file)


def test_cli_backup_and_restore(live, tmp_path, monkeypatch, capsys):
    db_path = Path(live.path)
    out = tmp_path / "bk"
    monkeypatch.setenv("BACKUP_DIR", str(out))
    monkeypatch.setenv("BACKUP_KEEP", "2")
    for _ in range(3):
        assert cli.main(["backup", "--db", str(db_path)]) == 0
    files = bk.list_backups(db_path, out)
    assert len(files) == 2  # BACKUP_KEEP 生效（同一秒的檔名以 -2、-3 區分）
    assert "[backup]" in capsys.readouterr().out

    assert cli.main(["backup", "--db", str(db_path), "--keep", "abc"]) == 1
    assert "保留份數" in capsys.readouterr().err

    expected = projects(files[-1])
    live.execute("DELETE FROM projects WHERE id > 1")
    live.close()

    # 未加 --yes 拒絕執行，資料庫不變
    assert cli.main(["restore", str(files[-1]), "--db", str(db_path)]) == 1
    assert "--yes" in capsys.readouterr().err
    assert len(projects(db_path)) == 1

    assert cli.main(["restore", str(files[-1]), "--db", str(db_path), "--yes"]) == 0
    assert "before-restore" in capsys.readouterr().out
    assert projects(db_path) == expected

    # 舊寫法 backup restore 亦可
    assert cli.main(["backup", "restore", str(files[0]), "--db", str(db_path), "--yes"]) == 0


def test_cli_unknown_command(capsys):
    assert cli.main([]) == 1
    assert cli.main(["nope"]) == 1
    assert "用法" in capsys.readouterr().err


def test_self_test(capsys):
    bk.self_test()
    assert "自我測試通過" in capsys.readouterr().out
