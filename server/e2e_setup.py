"""E2E 前準備（Python 後端版）：清除 E2E 專用 DB → migration + seed → 建立固定測試帳號。

用法：python -m server.e2e_setup（DATABASE_PATH 須為 E2E 專用檔）。帳密同 tests/helpers/e2eUsers.ts。
"""

from __future__ import annotations

import os
import re
import sys

from .app.config import config
from .app.db import create_db, run_migrations, run_seed
from .app.features.users import create_user

#: 與 tests/helpers/e2eUsers.ts 一致
E2E_USERS = {
    "admin": {"username": "admin", "password": "e2e-admin-pass", "display_name": "管理員"},
    "member": {"username": "member", "password": "e2e-member-pass", "display_name": "一般成員"},
    "newbie": {"username": "newbie", "password": "e2e-newbie-pass", "display_name": "新成員"},
}


def main() -> int:
    path = config.DATABASE_PATH
    if not re.search("e2e", path):
        print(f"[e2e] DATABASE_PATH（{path}）不是 E2E 專用檔，拒絕執行", file=sys.stderr)
        return 1
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(path + suffix)
        except FileNotFoundError:
            pass

    db = create_db(path)
    run_migrations(db)
    run_seed(db)
    create_user(db, **E2E_USERS["admin"], role="admin", must_change_password=False)
    create_user(db, **E2E_USERS["member"], role="member", must_change_password=False)
    create_user(db, **E2E_USERS["newbie"], role="member", must_change_password=True)
    db.close()
    print(f"[e2e] 已重建 {path} 並建立測試帳號", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
