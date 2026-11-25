"""管理指令（於專案根目錄執行，會讀取工作目錄的 .env）。

  python -m server.cli user-add <帳號> [--name 顯示名稱] [--role root|manager|user] [--password 密碼] [--db 資料庫]
      預設建立 user（成員）；--role 指定角色（--admin 為舊寫法，等同 --role root）。給 --password 直接使用該密碼（至少 8 字元），
      未給則產生隨機密碼並顯示一次；兩種情況首次登入都必須改密碼。帳號已存在時 exit code 1。
  python -m server.cli backup [--db 資料庫] [--out 備份目錄] [--keep 保留份數]
      線上備份（服務運行中可執行）；預設取 DATABASE_PATH / BACKUP_DIR（backups）/ BACKUP_KEEP（14）。
      附件檔案（ATTACHMENTS_DIR）一併備份到 <備份檔>.attachments/；restore 時同步還原。
  python -m server.cli backup --self-test
      在暫存目錄演練 備份 → 保留份數 → 還原 → 驗證一致。
  python -m server.cli restore <備份檔> [--db 資料庫] --yes
      以備份檔還原（必須先停止服務）；原資料庫保留為 <db>.before-restore-<時間>。
  python -m server.cli export <檔.json> [--db 資料庫]
      匯出可攜 JSON（業務資料，不含密碼雜湊 / session）。
  python -m server.cli import <檔.json> [--strategy keep_newer|keep_local|use_import] [--dry-run]
                             [--create-missing-users] [--replace --yes] [--db 資料庫] [--out 備份目錄]
      匯入（與網頁「資料管理」同一份邏輯：server/app/data_transfer.py）；寫入前自動備份到 BACKUP_DIR。
  python -m server.cli sync-push --server <https://網址> --token <金鑰> [--db 本機資料庫] [--full] [--dry-run]
      把本機資料增量上傳到中央（server/sync_client.py、docs/sync.md）。
  python -m server.cli scan-worktrees <專案資料夾> [--machine 電腦名稱] [--repo 專案名稱] [--db 資料庫] [--dry-run] [--yes]
      掃描本機專案的所有 git worktree（唯讀 git），列出新發現 / 已登記 / 路徑改變，確認後登記（來源 scan）。
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys

from .app.config import config

USAGE = (
    "用法：\n"
    "  python -m server.cli user-add <帳號> [--name 顯示名稱] [--role root|manager|user] [--password 密碼] [--db 資料庫]\n"
    "      建立帳號（預設 user；--admin 等同 --role root）；未給 --password 則隨機產生，首次登入須改密碼\n"
    "  python -m server.cli backup [--db 資料庫] [--out 備份目錄] [--keep 保留份數] [--attachments 附件目錄 | --no-attachments]\n"
    "  python -m server.cli backup --self-test\n"
    "  python -m server.cli restore <備份檔> [--db 資料庫] --yes\n"
    "  python -m server.cli export <檔.json> [--db 資料庫]\n"
    "  python -m server.cli import <檔.json> [--strategy keep_newer|keep_local|use_import] [--dry-run]\n"
    "      [--create-missing-users] [--replace --yes] [--db 資料庫] [--out 備份目錄]\n"
    "  python -m server.cli sync-push --server <https://網址> --token <金鑰> [--db 本機資料庫] [--full] [--dry-run]\n"
    "  python -m server.cli scan-worktrees <專案資料夾> [--machine 電腦名稱] [--repo 專案名稱] [--db 資料庫] [--dry-run] [--yes]\n"
    "      掃描專案的所有 git worktree（唯讀），列出新發現 / 已登記 / 路徑改變，確認後登記到 worktree 紀錄"
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
    from .app.permissions import ROLE_LABELS, ROLES

    p = argparse.ArgumentParser(
        prog="python -m server.cli user-add",
        description="建立帳號（預設角色 user）。新帳號首次登入一律須變更密碼。",
    )
    p.add_argument("username", nargs="?", help="帳號：3–32 個英文字母、數字或 . _ -，以字母或數字開頭")
    p.add_argument("--name", help="顯示名稱（預設同帳號）")
    p.add_argument(
        "--role",
        choices=ROLES,
        help="角色：root（超級管理員）、manager（管理者）、user（成員，預設）",
    )
    p.add_argument("--admin", action="store_true", help="舊寫法，等同 --role root")
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
    if args.admin:
        if args.role and args.role != "root":
            print(f"[user-add] 錯誤：--admin（等同 --role root）與 --role {args.role} 衝突", file=sys.stderr)
            return 1
        print("[user-add] 提示：--admin 已改為 --role root（舊寫法仍可使用）", file=sys.stderr)
    role = "root" if args.admin else (args.role or "user")

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
                role=role,
                must_change_password=True,
            )
        except sqlite3.IntegrityError:
            print(f"[user-add] 錯誤：帳號 {username} 已存在", file=sys.stderr)
            return 1
        label = f"{ROLE_LABELS[user['role']]}（{user['role']}）"
        print(f"[user-add] 已建立{label}帳號 {user['username']}（顯示名稱：{user['display_name']}，id {user['id']}）")
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
    p.add_argument("--attachments", help="附件目錄（預設 ATTACHMENTS_DIR，否則 data/attachments）")
    p.add_argument("--no-attachments", action="store_true", help="只備份資料庫，不備份附件檔案")
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
    att_dir = None if args.no_attachments else (args.attachments or _env("ATTACHMENTS_DIR") or config.ATTACHMENTS_DIR)
    result = bk.backup(db_path, out_dir, keep=keep, attachments_dir=att_dir)
    print(f"[backup] {db_path} → {result.file}")
    if result.attachments is not None:
        print(f"[backup] 附件 {att_dir} → {result.attachments}")
    for name in result.missing_attachments:
        print(f"[backup] 警告：資料庫有紀錄但找不到附件檔 {name}", file=sys.stderr)
    for f in result.removed:
        print(f"[backup] 已刪除超過保留份數的舊備份：{f}")
    return 0


def restore_cmd(argv: list[str]) -> int:
    from .app import backup as bk

    p = argparse.ArgumentParser(prog="python -m server.cli restore")
    p.add_argument("backup_file", help="備份檔")
    p.add_argument("--db", help="資料庫檔（預設 DATABASE_PATH）")
    p.add_argument("--yes", action="store_true", help="確認覆蓋資料庫（必須先停止服務）")
    p.add_argument("--attachments", help="附件目錄（預設 ATTACHMENTS_DIR，否則 data/attachments）")
    args = p.parse_args(argv)

    db_path = args.db or config.DATABASE_PATH
    if not args.yes:
        print(f"[restore] 還原會覆蓋 {db_path}。請先停止服務，確認後加上 --yes 再執行。", file=sys.stderr)
        return 1
    previous = bk.restore(args.backup_file, db_path)
    print(f"[restore] 已用 {args.backup_file} 還原 {db_path}")
    if previous:
        print(f"[restore] 原資料庫保留為 {previous}（確認無誤後可刪除）")
    att_dir = args.attachments or _env("ATTACHMENTS_DIR") or config.ATTACHMENTS_DIR
    if bk.attachments_backup_dir(args.backup_file).is_dir():
        prev_att = bk.restore_attachments(args.backup_file, att_dir)
        print(f"[restore] 已還原附件目錄 {att_dir}")
        if prev_att:
            print(f"[restore] 原附件目錄保留為 {prev_att}（確認無誤後可刪除）")
    else:
        print(f"[restore] 此備份沒有附件資料夾，附件目錄 {att_dir} 維持不變")
    return 0


def export_cmd(argv: list[str]) -> int:
    import json

    from .app import data_transfer as dt
    from .app.db import create_db, now_ms, run_migrations

    p = argparse.ArgumentParser(prog="python -m server.cli export", description="匯出業務資料為可攜 JSON（不含密碼雜湊）")
    p.add_argument("file", help="輸出檔（.json）")
    p.add_argument("--db", help="資料庫檔（預設 DATABASE_PATH）")
    args = p.parse_args(argv)
    db = create_db(args.db or config.DATABASE_PATH)
    try:
        run_migrations(db)
        doc = dt.export_document(db, now_ms())
    finally:
        db.close()
    with open(args.file, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    counts = "、".join(f"{s.label} {len(doc[s.key])}" for s in dt.SPECS)
    print(f"[export] 已匯出到 {args.file}（成員 {len(doc['users'])}、{counts}）")
    return 0


def import_cmd(argv: list[str]) -> int:
    from .app import data_transfer as dt
    from .app.db import create_db, now_ms, run_migrations

    p = argparse.ArgumentParser(prog="python -m server.cli import", description="匯入 export 產生的 JSON（預設合併）")
    p.add_argument("file", help="匯出檔（.json）")
    p.add_argument("--db", help="資料庫檔（預設 DATABASE_PATH）")
    p.add_argument("--strategy", choices=dt.STRATEGIES, default="keep_newer", help="衝突處理（預設 keep_newer）")
    p.add_argument("--create-missing-users", action="store_true", help="自動建立缺少的成員（預設略過指派）")
    p.add_argument("--replace", action="store_true", help="取代模式：先刪除本機全部業務資料（成員保留）")
    p.add_argument("--yes", action="store_true", help="取代模式的確認")
    p.add_argument("--out", help="匯入前自動備份的目錄（預設 BACKUP_DIR，否則 backups）")
    p.add_argument("--dry-run", action="store_true", help="只預覽，不寫入")
    args = p.parse_args(argv)

    try:
        with open(args.file, "rb") as fh:
            doc = dt.parse_document(fh.read())
    except OSError as e:
        print(f"[import] 錯誤：無法讀取 {args.file}：{e}", file=sys.stderr)
        return 1
    except dt.TransferError as e:
        print(f"[import] 錯誤：{e.message}", file=sys.stderr)
        for d in e.details or []:
            print(f"  - {d}", file=sys.stderr)
        return 1

    db = create_db(args.db or config.DATABASE_PATH)
    try:
        run_migrations(db)
        with db.tx() as conn:
            summary = dt.preview_summary(dt.plan_import(conn, doc), doc)
        print("[import] 預覽（新增 / 相同 / 衝突）：")
        for c in summary["categories"]:
            print(f"  {c['label']}：{c['new']} / {c['same']} / {c['conflict']}")
        for c in summary["conflicts"]:
            fields = "、".join(f["label"] for f in c["fields"])
            print(f"  衝突 {c['categoryLabel']}「{c['title']}」：{fields}（較新：{c['newer']}）")
        if summary["missingUsers"]:
            names = "、".join(m["username"] for m in summary["missingUsers"])
            print(f"  缺少成員：{names}")
        if args.dry_run:
            print("[import] --dry-run：未寫入任何資料")
            return 0
        if args.replace and not args.yes:
            print("[import] 取代模式會刪除本機全部業務資料，確認後加上 --yes 再執行。", file=sys.stderr)
            return 1
        opts = dt.ApplyOptions(
            strategy=args.strategy,
            missing_users="create" if args.create_missing_users else "skip",
            mode="replace" if args.replace else "merge",
            confirm=dt.REPLACE_CONFIRM if args.replace else None,
        )
        try:
            result = dt.apply_import(
                db, doc, opts, actor_id=None, now=now_ms(), backup_dir=args.out or _env("BACKUP_DIR") or "backups"
            )
        except dt.TransferError as e:
            print(f"[import] 錯誤：{e.message}（未寫入任何資料）", file=sys.stderr)
            return 1
    finally:
        db.close()
    print(f"[import] 匯入前備份：{result['backupPath']}")
    for c in result["categories"]:
        print(
            f"  {c['label']}：新增 {c['created']}、更新 {c['updated']}、未變更 {c['unchanged']}、"
            f"略過 {c['skipped']}、刪除 {c['deleted']}"
        )
    for u in result["createdUsers"]:
        print(f"  已建立成員 {u['username']}，臨時密碼：{u['tempPassword']}（只顯示這一次）")
    print("[import] 完成")
    return 0


def attachments_prune_cmd(argv: list[str]) -> int:
    from .app.attachments import prune_orphans
    from .app.db import create_db, run_migrations

    p = argparse.ArgumentParser(
        prog="python -m server.cli attachments-prune",
        description="刪除附件目錄中沒有資料庫紀錄的檔案（例如匯入取代模式刪除問題後留下的檔案）",
    )
    p.add_argument("--db", help="資料庫檔（預設 DATABASE_PATH）")
    p.add_argument("--attachments", help="附件目錄（預設 ATTACHMENTS_DIR）")
    args = p.parse_args(argv)
    db = create_db(args.db or config.DATABASE_PATH)
    try:
        run_migrations(db)
        with db.tx() as conn:
            removed = prune_orphans(conn, args.attachments or config.ATTACHMENTS_DIR)
    finally:
        db.close()
    print(f"[attachments-prune] 已刪除 {len(removed)} 個孤兒檔案")
    return 0


_ACTION_LABELS = {"new": "新發現（未登記）", "existing": "已登記", "moved": "路徑改變（可能搬動）"}


def scan_worktrees_cmd(argv: list[str], input_fn=input) -> int:  # type: ignore[no-untyped-def]
    """掃描本機專案的所有 worktree，確認後登記到 worktree 紀錄（來源 scan）。
    在操作者自己的電腦上執行，不受 WORKTREE_SCAN_ROOTS 限制；git 一律唯讀（server/app/worktree_scan.py）"""
    from .app import worktree_scan as ws
    from .app.db import create_db, now_ms, run_migrations
    from .app.features.eng import apply_scan, path_key, plan_scan

    p = argparse.ArgumentParser(
        prog="python -m server.cli scan-worktrees",
        description="掃描專案資料夾的 git worktree，列出新發現 / 已登記 / 路徑改變，確認後登記",
    )
    p.add_argument("folder", help="專案資料夾（主工作目錄或任一 worktree）")
    p.add_argument("--machine", help="電腦名稱（預設 ~/.tasks-sheets/machine.json 的名稱或主機名稱）")
    p.add_argument("--repo", help="專案名稱（預設為主工作目錄的資料夾名稱）")
    p.add_argument("--db", help="資料庫檔（預設 DATABASE_PATH）")
    p.add_argument("--dry-run", action="store_true", help="只列出，不寫入")
    p.add_argument("--yes", action="store_true", help="不詢問，直接登記新發現與路徑改變的項目")
    args = p.parse_args(argv)

    try:
        target = ws.resolve_target(os.path.abspath(args.folder), None)
        result = ws.scan_repo(target, ws.Git(config.GIT_TIMEOUT_MS), (args.repo or "").strip() or None)
    except ws.ScanError as e:
        print(f"[scan-worktrees] 錯誤：{e.message}", file=sys.stderr)
        return 1
    local = ws.local_machine(create=True)
    machine = (args.machine or "").strip() or local["machineName"] or "本機"
    same = not args.machine or machine.lower() == (local["machineName"] or "").strip().lower()
    machine_id = local["machineId"] if same else None

    db = create_db(args.db or config.DATABASE_PATH)
    try:
        run_migrations(db)
        with db.tx() as conn:
            items = plan_scan(conn, machine, machine_id, result)
        print(f"[scan-worktrees] 專案 {result.repo}（{result.repoPath}），電腦 {machine}，共 {len(items)} 個 worktree")
        if result.truncated:
            print(f"[scan-worktrees] 注意：worktree 超過 {ws.MAX_WORKTREES} 個，只處理前 {ws.MAX_WORKTREES} 個")
        for action in ("new", "moved", "existing"):
            group = [i for i in items if i["action"] == action]
            if not group:
                continue
            print(f"  {_ACTION_LABELS[action]}：{len(group)}")
            for i in group:
                flags = [f for f, on in (("未提交變更", i["isDirty"]), ("已併入主分支", i["isMerged"]), ("目錄不存在", i["isPrunable"])) if on]
                extra = f"（原路徑 {i['recordPath']}）" if action == "moved" else ""
                print(f"    - {i['branch'] or '（分離 HEAD）'}  {i['path']}{extra}{'  · ' + '、'.join(flags) if flags else ''}")
        todo = [i for i in items if i["action"] in ("new", "moved")]
        if args.dry_run:
            print("[scan-worktrees] --dry-run：未寫入任何資料")
            return 0
        if not todo:
            print("[scan-worktrees] 沒有需要登記的項目")
            return 0
        if not args.yes:
            answer = input_fn(f"登記 {len(todo)} 筆（新增 / 更新路徑）？[y/N] ").strip().lower()
            if answer not in ("y", "yes"):
                print("[scan-worktrees] 已取消，未寫入任何資料")
                return 1
        with db.tx() as conn:
            items = plan_scan(conn, machine, machine_id, result)
            out = apply_scan(conn, items, {path_key(i["path"]) for i in todo}, machine, machine_id, result.repo, None, now_ms())
    finally:
        db.close()
    print(f"[scan-worktrees] 已新增 {out['created']} 筆、更新路徑 {out['moved']} 筆")
    return 0


COMMANDS = {
    "scan-worktrees": scan_worktrees_cmd,
    "attachments-prune": attachments_prune_cmd,
    "user-add": user_add,
    "backup": backup_cmd,
    "restore": restore_cmd,
    "export": export_cmd,
    "import": import_cmd,
    "sync-push": lambda argv: _sync_push(argv),
}


def _sync_push(argv: list[str]) -> int:
    from .sync_client import sync_push_cmd

    return sync_push_cmd(argv)


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
