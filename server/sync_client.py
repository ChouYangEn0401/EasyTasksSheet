"""`python -m server.cli sync-push`：把本機資料庫的變動增量上傳到中央（docs/sync.md）。

  python -m server.cli sync-push --server https://中央網址 --token <金鑰>
         [--db 本機資料庫] [--full] [--dry-run] [--batch-size 500] [--machine-name 名稱] [--state 水位檔]

- 水位（watermark）：data/.sync-state.json（與 --db 同目錄），以 server 網址為鍵；
  只在「全部批次都被伺服器確認成功」後才前進。--full 忽略水位全量上傳。
- 網路中斷可直接重跑：伺服器端冪等（同一份資料重送不產生變更）。
- 只允許 HTTPS（localhost / 127.0.0.1 例外，供本機測試）；--allow-http 可強制允許（不建議）。
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .app.config import config

STATE_FILE = ".sync-state.json"
RETRIES = 3


def _normalize_server(url: str) -> str:
    return url.strip().rstrip("/")


def _is_local(host: str | None) -> bool:
    return (host or "").lower() in ("localhost", "127.0.0.1", "::1")


def load_state(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


class PushFailed(RuntimeError):
    pass


def post_batch(server: str, token: str, doc: dict[str, Any], timeout: float = 120) -> dict[str, Any]:
    body = json.dumps(doc, ensure_ascii=False).encode("utf-8")
    last: Exception | None = None
    for attempt in range(RETRIES):
        req = urllib.request.Request(
            f"{server}/api/sync/push",
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
                "User-Agent": "tasks-sheets-sync-push/1",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310（網址已檢查 scheme）
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8")).get("error", {})
            except (ValueError, AttributeError):
                err = {}
            msg = err.get("message") or f"HTTP {e.code}"
            if e.code >= 500 or e.code == 429:
                last = PushFailed(f"{msg}（HTTP {e.code}）")
            else:
                details = err.get("details")
                extra = f"：{json.dumps(details, ensure_ascii=False)[:500]}" if details else ""
                raise PushFailed(f"{msg}（HTTP {e.code}）{extra}") from None
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last = PushFailed(f"無法連線到伺服器：{getattr(e, 'reason', e)}")
        if attempt < RETRIES - 1:
            time.sleep(2 * (attempt + 1))
    raise last or PushFailed("上傳失敗")


def sync_push_cmd(argv: list[str]) -> int:
    from .app import sync_push as sp
    from .app.db import create_db, now_ms, run_migrations

    p = argparse.ArgumentParser(prog="python -m server.cli sync-push", description="把本機資料增量上傳到中央伺服器")
    p.add_argument("--server", required=True, help="中央伺服器網址（https://…）")
    p.add_argument("--token", help="同步金鑰（亦可用環境變數 SYNC_TOKEN）")
    p.add_argument("--db", help="本機資料庫（預設 DATABASE_PATH）")
    p.add_argument("--full", action="store_true", help="忽略水位，全量上傳")
    p.add_argument("--dry-run", action="store_true", help="只列出將上傳的筆數，不連線")
    p.add_argument("--batch-size", type=int, default=sp.DEFAULT_BATCH_SIZE, help="每批筆數（預設 500）")
    p.add_argument("--machine-name", help="電腦名稱（預設主機名稱）")
    p.add_argument("--state", help=f"水位檔（預設與資料庫同目錄的 {STATE_FILE}）")
    p.add_argument("--allow-http", action="store_true", help="允許非 HTTPS 網址（金鑰會以明文傳送，不建議）")
    args = p.parse_args(argv)

    server = _normalize_server(args.server)
    parts = urlsplit(server)
    if parts.scheme not in ("https", "http") or not parts.netloc:
        print(f"[sync-push] 錯誤：伺服器網址無效：{args.server}", file=sys.stderr)
        return 1
    if parts.scheme == "http" and not _is_local(parts.hostname) and not args.allow_http:
        print("[sync-push] 錯誤：為保護金鑰，只允許 https:// 網址（本機 localhost 例外）", file=sys.stderr)
        return 1
    token = args.token or os.environ.get("SYNC_TOKEN")
    if not token and not args.dry_run:
        print("[sync-push] 錯誤：請以 --token 或環境變數 SYNC_TOKEN 提供同步金鑰", file=sys.stderr)
        return 1
    if not 1 <= args.batch_size <= sp.MAX_BATCH_ITEMS:
        print(f"[sync-push] 錯誤：--batch-size 須介於 1–{sp.MAX_BATCH_ITEMS}", file=sys.stderr)
        return 1

    db_path = args.db or config.DATABASE_PATH
    if not Path(db_path).is_file():
        print(f"[sync-push] 錯誤：找不到本機資料庫 {db_path}", file=sys.stderr)
        return 1
    state_path = Path(args.state) if args.state else Path(db_path).resolve().parent / STATE_FILE
    state = load_state(state_path)
    entry = state.get(server) if isinstance(state.get(server), dict) else {}
    since = None if args.full else entry.get("watermark")
    if since is not None and not isinstance(since, int):
        since = None

    db = create_db(db_path)
    try:
        run_migrations(db)
        exported_at = now_ms()
        items, users = sp.export_changes(db, since)
        flags = sp.export_user_flags(db)
    finally:
        db.close()

    machine = args.machine_name or socket.gethostname() or "unknown"
    docs = sp.build_batches(
        items,
        users,
        machine_name=machine,
        exported_at=exported_at,
        since=since,
        push_id=secrets.token_urlsafe(12),
        batch_size=args.batch_size,
        in_overview=flags,
    )
    mode = "全量" if since is None else f"增量（自 {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(since / 1000))} 起）"
    counts = {s.key: 0 for s in sp.SPECS}
    for key, _ in items:
        counts[key] += 1
    listing = "、".join(f"{s.label} {counts[s.key]}" for s in sp.SPECS if counts[s.key]) or "無變動"
    print(f"[sync-push] {mode}：共 {len(items)} 筆（{listing}），分 {len(docs)} 批 → {server}")
    if args.dry_run:
        print("[sync-push] --dry-run：未上傳任何資料，水位不變")
        return 0

    grand = {k: 0 for k in sp.TOTAL_KEYS}
    pending = 0
    for doc in docs:
        b = doc["batch"]
        try:
            res = post_batch(server, token, doc)  # type: ignore[arg-type]
        except PushFailed as e:
            print(f"[sync-push] 第 {b['index'] + 1}/{b['total']} 批失敗：{e}", file=sys.stderr)
            print("[sync-push] 水位未前進；修正後可直接重跑（重複上傳不會產生重複資料）", file=sys.stderr)
            return 1
        t = res.get("totals", {})
        for k in grand:
            grand[k] += int(t.get(k, 0))
        pending = int(res.get("pendingConflicts", 0))
        print(
            f"[sync-push] 第 {b['index'] + 1}/{b['total']} 批：新增 {t.get('created', 0)}、更新 {t.get('updated', 0)}、"
            f"相同 {t.get('unchanged', 0)}、衝突 {t.get('conflict', 0)}、略過 {t.get('skipped', 0)}"
            f"（中央較新而保留 {t.get('older', 0)}）"
        )
        for r in res.get("skipped", [])[:10]:
            print(f"    略過：{r}")
        if res.get("missingUsers"):
            print(f"    中央缺少的成員（已略過指派）：{'、'.join(res['missingUsers'])}")
        if res.get("createdUsers"):
            print(f"    已在中央建立成員：{'、'.join(res['createdUsers'])}（需由管理者重設密碼後才能登入）")
        if res.get("backupFile"):
            print(f"    中央已先自動備份：{res['backupFile']}")

    state[server] = {"watermark": exported_at, "lastPushAt": now_ms(), "machineName": machine}
    save_state(state_path, state)
    print(
        f"[sync-push] 完成：新增 {grand['created']}、更新 {grand['updated']}、相同 {grand['unchanged']}、"
        f"衝突 {grand['conflict']}、略過 {grand['skipped'] + grand['older']}；水位已更新（{state_path}）"
    )
    if pending:
        print(f"[sync-push] 中央有 {pending} 筆待確認衝突，請管理者到「資料同步 → 待確認衝突」處理")
    return 0
