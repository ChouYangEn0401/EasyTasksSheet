"""SQLite 線上備份 / 還原（跨平台：Windows、Linux、macOS）。

CLI 見 server/cli.py：
  python -m server.cli backup [--db <資料庫>] [--out <備份目錄>] [--keep <保留份數>]
  python -m server.cli restore <備份檔> [--db <資料庫>] --yes      （必須先停止服務）
  python -m server.cli backup --self-test

一致性：`VACUUM INTO` 在單一讀取交易內把資料庫（含尚未 checkpoint 的 WAL 內容）寫成
一個獨立、壓實過的 .db 檔；先寫到 .partial，PRAGMA integrity_check 通過後才改名，
失敗不會留下半成品。備份檔改為 rollback journal（DELETE），不依賴 -wal / -shm。
"""

from __future__ import annotations

import os
import re
import shutil
import sqlite3
import tempfile
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

DEFAULT_KEEP = 14
DEFAULT_DIR = "backups"


class BackupError(RuntimeError):
    pass


def timestamp(d: datetime | None = None) -> str:
    """本地時間 YYYYMMDD-HHMMSS"""
    return (d or datetime.now()).strftime("%Y%m%d-%H%M%S")


def _connect(path: str | Path) -> sqlite3.Connection:
    # autocommit：避免 Python sqlite3 自動開交易，干擾 VACUUM / PRAGMA
    return sqlite3.connect(str(path), isolation_level=None)


def _backup_pattern(db_path: Path) -> re.Pattern[str]:
    return re.compile(rf"^{re.escape(db_path.stem)}-(\d{{8}}-\d{{6}})(?:-(\d+))?\.db$")


def list_backups(db_path: str | Path, out_dir: str | Path) -> list[Path]:
    """列出某資料庫的備份檔（舊 → 新；依檔名中的時間，同一秒再依 -2、-3… 序號）"""
    out = Path(out_dir)
    if not out.is_dir():
        return []
    pat = _backup_pattern(Path(db_path))
    found = [(m.group(1), int(m.group(2) or 1), n) for n in os.listdir(out) if (m := pat.match(n))]
    return [out / n for *_, n in sorted(found)]


def integrity_check(file: str | Path, *, to_single_file: bool = False) -> None:
    """PRAGMA integrity_check 必須為 ok。

    不用唯讀連線：WAL 模式的檔案在沒有 -shm 時唯讀開不起來。
    to_single_file=True 時同時改為 rollback journal，讓檔案不依賴 -wal / -shm。
    """
    if not Path(file).is_file():
        raise BackupError(f"找不到檔案：{file}")
    try:
        with closing(_connect(file)) as db:
            if to_single_file:
                db.execute("PRAGMA journal_mode = DELETE")
            rows = [r[0] for r in db.execute("PRAGMA integrity_check").fetchall()]
    except sqlite3.DatabaseError as e:
        raise BackupError(f"integrity_check 失敗（{file}）：{e}") from e
    if rows != ["ok"]:
        raise BackupError(f"integrity_check 失敗（{file}）：{rows[:10]}")


@dataclass
class BackupResult:
    file: Path
    removed: list[Path] = field(default_factory=list)


def backup(
    db_path: str | Path,
    out_dir: str | Path,
    keep: int = DEFAULT_KEEP,
    now: datetime | None = None,
) -> BackupResult:
    """產生一份一致的備份並依保留份數清除舊檔。服務運行中可執行。"""
    db_path, out_dir = Path(db_path), Path(out_dir)
    if not db_path.is_file():
        raise BackupError(f"找不到資料庫：{db_path}")
    if not isinstance(keep, int) or isinstance(keep, bool) or keep < 1:
        raise BackupError(f"保留份數必須是正整數：{keep}")
    out_dir.mkdir(parents=True, exist_ok=True)

    ts = timestamp(now)
    file = out_dir / f"{db_path.stem}-{ts}.db"
    i = 2
    while file.exists():
        file = out_dir / f"{db_path.stem}-{ts}-{i}.db"
        i += 1
    partial = file.with_name(file.name + ".partial")
    partial.unlink(missing_ok=True)

    try:
        # 此連線不做任何寫入；busy_timeout 讓它在服務正在 checkpoint 時等待
        with closing(_connect(db_path)) as src:
            src.execute("PRAGMA busy_timeout = 10000")
            src.execute("VACUUM INTO ?", (str(partial),))
        integrity_check(partial, to_single_file=True)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    os.replace(partial, file)

    all_files = list_backups(db_path, out_dir)
    removed = all_files[: max(0, len(all_files) - keep)]
    for f in removed:
        f.unlink(missing_ok=True)
    return BackupResult(file=file, removed=removed)


def restore(backup_file: str | Path, db_path: str | Path, now: datetime | None = None) -> Path | None:
    """以備份檔覆蓋資料庫。呼叫前務必停止服務。

    原資料庫先 checkpoint 再改名為 <db>.before-restore-<時間> 保留（可手動回退），
    並刪除殘留的 -wal / -shm / -journal。回傳保留下來的舊檔路徑（原本不存在則為 None）。
    """
    backup_file, db_path = Path(backup_file), Path(db_path)
    if not backup_file.is_file():
        raise BackupError(f"找不到備份檔：{backup_file}")
    if backup_file.resolve() == db_path.resolve():
        raise BackupError("備份檔與資料庫是同一個檔案")
    integrity_check(backup_file)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    previous: Path | None = None
    if db_path.exists():
        # 把 WAL 併回主檔，讓保留下來的舊檔是完整的單一檔案
        with closing(_connect(db_path)) as cur:
            cur.execute("PRAGMA busy_timeout = 10000")
            cur.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        ts = timestamp(now)
        previous = db_path.with_name(f"{db_path.name}.before-restore-{ts}")
        i = 2
        while previous.exists():
            previous = db_path.with_name(f"{db_path.name}.before-restore-{ts}-{i}")
            i += 1
        os.replace(db_path, previous)
    for suffix in ("-wal", "-shm", "-journal"):
        Path(f"{db_path}{suffix}").unlink(missing_ok=True)

    tmp = db_path.with_name(db_path.name + ".restoring")
    shutil.copyfile(backup_file, tmp)
    os.replace(tmp, db_path)
    return previous


# ── 自我測試 ─────────────────────────────────────────────


def _rows(conn: sqlite3.Connection) -> list[tuple]:
    return conn.execute("SELECT id, title, n FROM items ORDER BY id").fetchall()


def _snapshot(file: Path) -> list[tuple]:
    with closing(_connect(file)) as db:
        return _rows(db)


def self_test(log=print) -> None:
    """在暫存目錄演練：服務運行中（資料仍在 WAL）備份 → 保留份數 → 停機還原 → 驗證一致。"""

    def check(cond: bool, msg: str) -> None:
        if not cond:
            raise BackupError(f"自我測試失敗：{msg}")
        log(f"  ✓ {msg}")

    with tempfile.TemporaryDirectory(prefix="tasks-sheets-backup-") as tmp:
        d = Path(tmp)
        db_path = d / "data" / "app.db"
        out_dir = d / "backups"
        db_path.parent.mkdir(parents=True)

        # 模擬運行中的服務：WAL 模式、連線保持開啟、資料尚未 checkpoint
        live = _connect(db_path)
        try:
            live.execute("PRAGMA journal_mode = WAL")
            live.execute("PRAGMA wal_autocheckpoint = 0")
            live.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, n INTEGER NOT NULL)")
            live.execute("BEGIN")
            live.executemany(
                "INSERT INTO items (title, n) VALUES (?, ?)", [(f"任務 {i}", i * 7) for i in range(500)]
            )
            live.execute("COMMIT")
            wal = Path(f"{db_path}-wal")
            check(wal.exists() and wal.stat().st_size > 0, "資料仍在 WAL 中（模擬服務運行中）")
            expected = _rows(live)

            t0 = datetime(2026, 1, 1, 3, 0, 0)
            b1 = backup(db_path, out_dir, keep=2, now=t0)
            check(_snapshot(b1.file) == expected, "第一份備份內容與服務中資料一致（含 WAL 內容）")
            check(
                not Path(f"{b1.file}-wal").exists() and not b1.file.with_name(b1.file.name + ".partial").exists(),
                "備份為單一檔案，未留下 .partial / -wal",
            )
            live.execute("UPDATE items SET n = -1 WHERE id = 1")  # b2 會包含這筆異動
            b2 = backup(db_path, out_dir, keep=2, now=t0 + timedelta(days=1))
            b3 = backup(db_path, out_dir, keep=2, now=t0 + timedelta(days=2))
            check(b3.removed == [b1.file] and not b1.file.exists(), "超過保留份數時刪除最舊的備份")
            check(list_backups(db_path, out_dir) == [b2.file, b3.file], "備份目錄只保留 2 份")

            # 備份後的異動，還原後應消失
            live.execute("DELETE FROM items WHERE id > 100")
        finally:
            live.close()

        previous = restore(b2.file, db_path)
        check(previous is not None and previous.exists(), "還原前保留原資料庫（.before-restore-*）")
        check(len(_snapshot(previous)) == 100, "保留的原資料庫包含還原前的最新狀態")
        expected_b2 = [(1, "任務 0", -1), *expected[1:]]
        check(_snapshot(db_path) == expected_b2, "還原後資料與備份一致（500 筆，含備份前最後異動）")
        integrity_check(db_path)
        check(True, "還原後資料庫 integrity_check = ok")

        with closing(_connect(db_path)) as after:
            after.execute("PRAGMA journal_mode = WAL")
            after.execute("INSERT INTO items (title, n) VALUES (?, ?)", ("還原後新增", 1))
            check(after.execute("SELECT count(*) FROM items").fetchone()[0] == 501, "還原後可繼續以 WAL 模式寫入")

        bad = d / "bad.db"
        bad.write_bytes(b"not a sqlite database" * 100)
        try:
            restore(bad, db_path)
        except BackupError:
            check(len(_snapshot(db_path)) == 501, "損毀的備份檔會被拒絕，資料庫不受影響")
        else:
            check(False, "損毀的備份檔應被拒絕")
    log("自我測試通過")
