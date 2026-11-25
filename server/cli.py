"""管理指令（於專案根目錄執行，會讀取工作目錄的 .env）。

  python -m server.cli user-add <帳號> [--name 顯示名稱] [--admin] [--password 密碼] [--db 資料庫]
      預設建立一般成員（--admin 為管理員）。給 --password 直接使用該密碼（至少 8 字元），
      未給則產生隨機密碼並顯示一次；兩種情況首次登入都必須改密碼。帳號已存在時 exit code 1。
  python -m server.cli backup [--db 資料庫] [--out 備份目錄] [--keep 保留份數]
      線上備份（服務運行中可執行）；預設取 DATABASE_PATH / BACKUP_DIR（backups）/ BACKUP_KEEP（14）。
  python -m server.cli backup --self-test
      在暫存目錄演練 備份 → 保留份數 → 還原 → 驗證一致。
  python -m server.cli restore <備份檔> [--db 資料庫] --yes
      以備份檔還原（必須先停止服務）；原資料庫保留為 <db>.before-restore-<時間>。
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys

from .app.config import config

USAGE = (
    "用法：\n"
    "  python -m server.cli user-add <帳號> [--name 顯示名稱] [--admin] [--password 密碼] [--db 資料庫]\n"
    "      建立一般帳號（--admin 為管理員）；未給 --password 則隨機產生，首次登入須改密碼\n"
    "  python -m server.cli backup [--db 資料庫] [--out 備份目錄] [--keep 保留份數]\n"
    "  python -m server.cli backup --self-test\n"
    "  python -m server.cli restore <備份檔> [--db 資料庫] --yes"
)


def _env(name: str) -> str | None:
    v = os.environ.get(name)
    return v if v else None


MIN_PASSWORD = 8
MAX_PASSWORD = 256


def user_add(argv: list[str]) -> int:
    from .app.db import create_db, run_migrations
    from .app.features.admin import check_username, generate_temp_password
    from .app.features.users import create_user

    p = argparse.ArgumentParser(
        prog="python -m server.cli user-add",
        description="建立帳號（預設為一般成員）。新帳號首次登入一律須變更密碼。",
    )
    p.add_argument("username", nargs="?", help="帳號：3–32 個英文字母、數字或 . _ -，以字母或數字開頭")
    p.add_argument("--name", help="顯示名稱（預設同帳號）")
    p.add_argument("--admin", action="store_true", help="建立為管理員（預設為一般成員）")
    p.add_argument(
        "--password",
        help=f"初始密碼（至少 {MIN_PASSWORD} 個字元）；省略則產生隨機密碼並顯示一次",
    )
    p.add_argument("--db", help="資料庫檔（預設 DATABASE_PATH）")
    args = p.parse_args(argv)

    if not (args.username or "").strip():
        print(USAGE, file=sys.stderr)
        return 1
    try:
        username = check_username(args.username)
    except ValueError as e:
        print(f"[user-add] 錯誤：{e}", file=sys.stderr)
        return 1
    if args.password is not None and not (MIN_PASSWORD <= len(args.password) <= MAX_PASSWORD):
        print(f"[user-add] 錯誤：密碼須為 {MIN_PASSWORD}–{MAX_PASSWORD} 個字元", file=sys.stderr)
        return 1
    display_name = (args.name or "").strip() or None

    db = create_db(args.db or config.DATABASE_PATH)
    try:
        run_migrations(db)
        if db.one("SELECT id FROM users WHERE username = ?", (username,)):
            print(f"[user-add] 錯誤：帳號 {username} 已存在", file=sys.stderr)
            return 1
        password = args.password if args.password is not None else generate_temp_password()
        try:
            user = create_user(
                db,
                username=username,
                display_name=display_name,
                password=password,
                role="admin" if args.admin else "member",
                must_change_password=True,
            )
        except sqlite3.IntegrityError:
            print(f"[user-add] 錯誤：帳號 {username} 已存在", file=sys.stderr)
            return 1
        role = "管理員" if user["role"] == "admin" else "一般成員"
        print(f"[user-add] 已建立{role}帳號 {user['username']}（顯示名稱：{user['display_name']}，id {user['id']}）")
        if args.password is None:
            print(f"[user-add] 隨機初始密碼：{password}（只顯示這一次，請轉交本人）")
        else:
            print("[user-add] 初始密碼為 --password 指定的密碼")
        print("[user-add] 首次登入後須立即變更密碼")
        return 0
    finally:
        db.close()


def backup_cmd(argv: list[str]) -> int:
    from .app import backup as bk

    if argv[:1] == ["restore"]:  # 相容舊寫法：backup restore <檔> --yes
        return restore_cmd(argv[1:])
    p = argparse.ArgumentParser(prog="python -m server.cli backup")
    p.add_argument("--db", help="資料庫檔（預設 DATABASE_PATH）")
    p.add_argument("--out", help="備份目錄（預設 BACKUP_DIR，否則 backups）")
    p.add_argument("--keep", help="保留份數（預設 BACKUP_KEEP，否則 14）")
    p.add_argument("--self-test", action="store_true", help="在暫存目錄演練備份與還原")
    args = p.parse_args(argv)

    if args.self_test:
        bk.self_test()
        return 0
    db_path = args.db or config.DATABASE_PATH
    out_dir = args.out or _env("BACKUP_DIR") or bk.DEFAULT_DIR
    keep_raw = args.keep or _env("BACKUP_KEEP") or str(bk.DEFAULT_KEEP)
    try:
        keep = int(keep_raw)
    except ValueError:
        raise bk.BackupError(f"保留份數必須是正整數：{keep_raw}") from None
    result = bk.backup(db_path, out_dir, keep=keep)
    print(f"[backup] {db_path} → {result.file}")
    for f in result.removed:
        print(f"[backup] 已刪除超過保留份數的舊備份：{f}")
    return 0


def restore_cmd(argv: list[str]) -> int:
    from .app import backup as bk

    p = argparse.ArgumentParser(prog="python -m server.cli restore")
    p.add_argument("backup_file", help="備份檔")
    p.add_argument("--db", help="資料庫檔（預設 DATABASE_PATH）")
    p.add_argument("--yes", action="store_true", help="確認覆蓋資料庫（必須先停止服務）")
    args = p.parse_args(argv)

    db_path = args.db or config.DATABASE_PATH
    if not args.yes:
        print(f"[restore] 還原會覆蓋 {db_path}。請先停止服務，確認後加上 --yes 再執行。", file=sys.stderr)
        return 1
    previous = bk.restore(args.backup_file, db_path)
    print(f"[restore] 已用 {args.backup_file} 還原 {db_path}")
    if previous:
        print(f"[restore] 原資料庫保留為 {previous}（確認無誤後可刪除）")
    return 0


COMMANDS = {"user-add": user_add, "backup": backup_cmd, "restore": restore_cmd}


def main(argv: list[str]) -> int:
    if argv[:1] in (["-h"], ["--help"]):
        print(USAGE)
        return 0
    if not argv or argv[0] not in COMMANDS:
        print(USAGE, file=sys.stderr)
        return 1
    from .app.backup import BackupError

    try:
        return COMMANDS[argv[0]](argv[1:])
    except BackupError as e:
        print(f"[{argv[0]}] 錯誤：{e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
