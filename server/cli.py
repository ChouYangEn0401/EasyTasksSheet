"""管理指令。

用法：python -m server.cli user-add <帳號> [--name 顯示名稱] [--admin] [--password 密碼]
未給密碼則產生隨機密碼並顯示一次；新帳號首次登入需改密碼。
"""

from __future__ import annotations

import argparse
import sqlite3
import sys

from .app.config import config
from .app.db import create_db, run_migrations
from .app.features.users import create_user
from .app.security import random_password

USAGE = "用法：python -m server.cli user-add <帳號> [--name 顯示名稱] [--admin] [--password 密碼]"


def user_add(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="python -m server.cli user-add", usage=USAGE)
    p.add_argument("username", nargs="?")
    p.add_argument("--name")
    p.add_argument("--admin", action="store_true")
    p.add_argument("--password")
    args = p.parse_args(argv)

    username = (args.username or "").strip()
    if not username:
        print(USAGE, file=sys.stderr)
        return 1
    if args.password is not None and len(args.password) < 8:
        print("密碼至少 8 個字元", file=sys.stderr)
        return 1

    db = create_db(config.DATABASE_PATH)
    try:
        run_migrations(db)
        password = args.password or random_password()
        try:
            user = create_user(
                db,
                username=username,
                display_name=args.name,
                password=password,
                role="admin" if args.admin else "member",
            )
        except sqlite3.IntegrityError as e:
            print(f"帳號 {username} 已存在" if "UNIQUE" in str(e) else str(e), file=sys.stderr)
            return 1
        role = "管理員" if user["role"] == "admin" else "成員"
        print(f"[user:add] 已建立 {role} {user['username']}（id {user['id']}）")
        if args.password is None:
            print(f"[user:add] 初始密碼：{password}（只顯示這一次，首次登入需變更）")
        return 0
    finally:
        db.close()


def main(argv: list[str]) -> int:
    if not argv or argv[0] != "user-add":
        print(USAGE, file=sys.stderr)
        return 1
    return user_add(argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
