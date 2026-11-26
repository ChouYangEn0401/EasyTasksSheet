"""E2E 前準備（Python 後端版）：清除 E2E 專用 DB → migration + seed → 建立固定測試帳號。

用法：python -m server.e2e_setup（DATABASE_PATH 須為 E2E 專用檔）。帳密與 tests/e2e/helpers.py 共用（這裡是單一來源）。
"""

from __future__ import annotations

import os
import re
import shutil
import sys

from .app.config import config
from .app.db import create_db, run_migrations, run_seed
from .app.features.users import create_user

#: E2E 帳號的單一來源（tests/e2e 直接 import 這裡）
E2E_USERS = {
    # 鍵名與帳號沿用 admin / member（其他 spec 以此參照）；角色為 root / user
    "admin": {"username": "admin", "password": "e2e-admin-pass", "display_name": "管理員"},
    "member": {"username": "member", "password": "e2e-member-pass", "display_name": "一般成員"},
    "manager": {"username": "manager", "password": "e2e-manager-pass", "display_name": "管理者"},
    "newbie": {"username": "newbie", "password": "e2e-newbie-pass", "display_name": "新成員"},
    # 模擬首次啟動的預設管理員：E2E 伺服器以 ADMIN_USERNAME=bootstrap 啟動（見 tests/e2e/conftest.py）
    "bootstrap": {"username": "bootstrap", "password": "password", "display_name": "首次啟動"},
    # 多人在線感知（presence spec）的第三位使用者
    "peer": {"username": "peer", "password": "e2e-peer-pass", "display_name": "晴恩"},
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
    # E2E 專用的附件目錄一併清空（名稱必須含 e2e，避免誤刪正式資料）
    if re.search("e2e", config.ATTACHMENTS_DIR):
        shutil.rmtree(config.ATTACHMENTS_DIR, ignore_errors=True)
    # 掃描本機專案的允許資料夾與電腦識別設定：E2E 專用者（名稱含 e2e）清空後重建
    for d in [*(config.WORKTREE_SCAN_ROOTS or "").split(","), os.environ.get("TASKS_SHEETS_HOME", "")]:
        d = d.strip()
        if d and re.search("e2e", d):
            shutil.rmtree(d, ignore_errors=True)
            os.makedirs(d, exist_ok=True)

    db = create_db(path)
    run_migrations(db)
    run_seed(db)
    create_user(db, **E2E_USERS["admin"], role="root", must_change_password=False)
    create_user(db, **E2E_USERS["member"], role="user", must_change_password=False)
    create_user(db, **E2E_USERS["manager"], role="manager", must_change_password=False)
    create_user(db, **E2E_USERS["newbie"], role="user", must_change_password=True)
    create_user(db, **E2E_USERS["peer"], role="user", must_change_password=False)
    # 角色設為 user：admin-users spec 依賴「admin 為唯一 root」；重設帳號流程只看帳號與 must_change_password
    create_user(db, **E2E_USERS["bootstrap"], role="user", must_change_password=True)
    db.close()
    print(f"[e2e] 已重建 {path} 並建立測試帳號", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
