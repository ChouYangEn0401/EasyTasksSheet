"""多台電腦同步：本機 → 中央的增量上傳（docs/sync.md、docs/design/sync.md）。

- 本機以 `python -m server.cli sync-push` 匯出「自上次成功同步之後有變動」的業務資料（格式沿用
  data_transfer 的 tasks-sheets-export / schemaVersion，另加 source、incremental、batch），分批 POST 到
  `/api/sync/push`，以同步來源的金鑰驗證。
- 中央套用規則（apply_push，單批單一 transaction）：
  - **不刪除**：只新增與更新；來源沒送到的資料一律不動。任務的 deletedAt 屬一般欄位，來源明確軟刪除才會套用。
  - 同 uid（狀態 / 專案另以「名稱完全相同且唯一」對應並記錄 alias）兩邊內容不同時，比較 updatedAt：
    差距 > SYNC_AUTO_RESOLVE_MINUTES → 自動採較新者；差距在門檻內 → 不套用，寫入 sync_conflicts 待確認。
  - 冪等：相同內容重送 → 「相同」，不寫資料、不寫變更流水；相同的待確認衝突不重複建立。
  - 缺少的成員：預設略過指派（必要欄位缺成員則略過該筆），來源開啟 auto_create_users 時才建立帳號。
- 衝突處理（resolve_conflict）：keep_local / use_incoming / merged（逐欄位選擇），單一 transaction。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal, Optional

from pydantic import Field, StringConstraints, ValidationError, create_model

from . import audit_events
from . import data_transfer as dt
from .backup import DEFAULT_KEEP
from .changes import record_change
from .db import Database
from .errors import pydantic_issues

TOKEN_PREFIX = "tss_"
#: 單一請求最多筆數（CLI 預設每批 500）
MAX_BATCH_ITEMS = 5_000
DEFAULT_BATCH_SIZE = 500
RESOLUTIONS = ("keep_local", "use_incoming", "merged")
Resolution = Literal["keep_local", "use_incoming", "merged"]

SPECS = dt.SPECS
SPEC_BY_KEY = dt.SPEC_BY_KEY


class SyncError(ValueError):
    """上傳內容或處理請求有誤（訊息可直接顯示）"""

    def __init__(self, message: str, details: Any = None, status: int = 400, code: str = "SYNC_INVALID"):
        super().__init__(message)
        self.message = message
        self.details = details
        self.status = status
        self.code = code


# ── 金鑰 ──────────────────────────────────────────────────


def generate_token() -> str:
    return TOKEN_PREFIX + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


_DUMMY_HASH = hash_token("tss_dummy-token-for-constant-time-compare")


def authenticate(db: Database, token: str | None) -> sqlite3.Row | None:
    """以金鑰找出啟用中的同步來源；任何失敗一律回 None（呼叫端回同一種 403，不洩漏差異）"""
    if not token or len(token) > 256:
        hmac.compare_digest(_DUMMY_HASH, _DUMMY_HASH)
        return None
    given = hash_token(token)
    row = db.one("SELECT * FROM sync_sources WHERE token_hash = ?", (given,))
    expected = row["token_hash"] if row is not None else _DUMMY_HASH
    ok = hmac.compare_digest(given, expected)
    if not ok or row is None or not row["is_active"]:
        return None
    return row


def token_from_headers(headers: Any) -> str | None:
    auth = headers.get("authorization") or ""
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip() or None
    return (headers.get("x-sync-token") or "").strip() or None


class RateLimiter:
    """記憶體內滑動視窗（單一行程）。hit() 記錄一次並回傳是否仍在上限內。"""

    def __init__(self) -> None:
        self._hits: dict[str, deque[int]] = {}
        self._lock = threading.Lock()

    def count(self, key: str, now: int, window_ms: int) -> int:
        with self._lock:
            q = self._hits.get(key)
            if not q:
                return 0
            while q and q[0] <= now - window_ms:
                q.popleft()
            return len(q)

    def hit(self, key: str, now: int, limit: int, window_ms: int) -> bool:
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and q[0] <= now - window_ms:
                q.popleft()
            q.append(now)
            if len(self._hits) > 10_000:  # 避免無限成長
                for k in [k for k, v in self._hits.items() if not v][:5_000]:
                    self._hits.pop(k, None)
            return len(q) <= limit


# ── 上傳文件驗證 ─────────────────────────────────────────────

_PushSource = create_model(
    "PushSource",
    __config__=dt._STRICT,
    machineName=(Annotated[str, StringConstraints(min_length=1, max_length=200)], ...),
    exportedAt=(dt._Int, ...),
    since=(Optional[dt._Int], None),
    pushId=(Optional[Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")]], None),
)
_PushBatch = create_model(
    "PushBatch",
    __config__=dt._STRICT,
    index=(Annotated[int, Field(ge=0, le=1_000_000)], ...),
    total=(Annotated[int, Field(ge=1, le=1_000_000)], ...),
)
PushDoc = create_model(
    "PushDoc",
    __config__=dt._STRICT,
    format=(Literal[dt.FORMAT], ...),  # type: ignore[valid-type]
    schemaVersion=(int, ...),
    exportedAt=(dt._Int, ...),
    source=(_PushSource, ...),
    incremental=(bool, True),
    batch=(Optional[_PushBatch], None),
    users=dt._list_of(dt.UserItem),
    **{s.key: dt._list_of(dt._item_model(s)) for s in SPECS},
)


def parse_push(raw: bytes | str | dict[str, Any]) -> dict[str, Any]:
    """驗證上傳內容；與匯出檔不同的是參照可指向中央既有資料（不要求在同一批內）"""
    if isinstance(raw, dict):
        obj: Any = raw
    else:
        try:
            obj = json.loads(raw)
        except (ValueError, RecursionError, UnicodeDecodeError):
            raise SyncError("上傳內容不是有效的 JSON") from None
    if not isinstance(obj, dict) or obj.get("format") != dt.FORMAT:
        raise SyncError("上傳內容格式不正確（缺少 format: tasks-sheets-export）")
    version = obj.get("schemaVersion")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise SyncError("schemaVersion 無效")
    if version > dt.SCHEMA_VERSION:
        raise SyncError(f"本機版本較新（schemaVersion {version}），中央只支援到 {dt.SCHEMA_VERSION}，請先更新中央系統")
    try:
        doc = PushDoc.model_validate(obj).model_dump()
    except ValidationError as e:
        raise SyncError("上傳內容驗證失敗", pydantic_issues(e)[:50]) from None
    except RecursionError:
        raise SyncError("上傳內容結構過深") from None
    total = sum(len(doc[s.key]) for s in SPECS)
    if total > MAX_BATCH_ITEMS:
        raise SyncError(f"單批最多 {MAX_BATCH_ITEMS} 筆（收到 {total} 筆），請分批上傳")
    for p in doc["personalItems"]:
        if p["status"] is None:
            p["status"] = "done" if p["isDone"] else "todo"
        p["isDone"] = p["status"] == "done"
    issues = []
    for spec in SPECS:
        seen: set[str] = set()
        for item in doc[spec.key]:
            k = dt._natural_key(spec, item)
            if k in seen:
                issues.append(f"{spec.label}：識別碼重複（{k}）")
            seen.add(k)
    if issues:
        raise SyncError("上傳內容有重複資料", issues[:50])
    return doc


# ── 套用 ────────────────────────────────────────────────────


def _canon(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, sort_keys=True)


def _content(item: dict[str, Any]) -> str:
    return _canon({k: v for k, v in item.items() if k not in dt._META_FIELDS})


def _empty_stats() -> dict[str, dict[str, Any]]:
    return {
        s.key: {"key": s.key, "label": s.label, "created": 0, "updated": 0, "unchanged": 0, "conflict": 0, "skipped": 0, "older": 0}
        for s in SPECS
    }


TOTAL_KEYS = ("created", "updated", "unchanged", "conflict", "skipped", "older")


@dataclass
class _Ctx:
    """中央資料的對照（uid ↔ id、成員、alias）；一個 transaction 內使用"""

    conn: sqlite3.Connection
    source_id: int | None
    now: int
    actor_id: int | None
    idx: dt.LocalIndex
    ids: dict[str, dict[str, int]]
    aliases: dict[tuple[str, str], str]
    writer: dt._Writer
    missing_users: set[str] = field(default_factory=set)
    created_users: list[str] = field(default_factory=list)


def _load_ctx(conn: sqlite3.Connection, source_id: int | None, now: int, actor_id: int | None) -> _Ctx:
    users = conn.execute("SELECT id, username FROM users").fetchall()
    user_id = {u["username"]: u["id"] for u in users}
    ids: dict[str, dict[str, int]] = {}
    uid_by_id: dict[str, dict[int, str]] = {}
    for spec in SPECS:
        if spec.natural == "uid":
            rows = conn.execute(f"SELECT id, uid FROM {spec.table}").fetchall()
            ids[spec.key] = {r["uid"]: r["id"] for r in rows}
            uid_by_id[spec.key] = {r["id"]: r["uid"] for r in rows}
        else:
            ids[spec.key] = {}
    props = {r["id"]: (r["uid"], r["type"]) for r in conn.execute("SELECT id, uid, type FROM property_defs")}
    idx = dt.LocalIndex(
        user_by_id={u["id"]: u["username"] for u in users}, user_id=user_id, rows={}, uid_by_id=uid_by_id, props=props
    )
    aliases: dict[tuple[str, str], str] = {}
    if source_id is not None:
        for r in conn.execute(
            "SELECT category, source_uid, central_uid FROM sync_uid_aliases WHERE source_id = ?", (source_id,)
        ):
            aliases[(r["category"], r["source_uid"])] = r["central_uid"]
    writer = dt._Writer(conn, {"propertyDefs": []}, actor_id, now)
    writer.user_id = user_id
    writer.maps = ids
    writer.prop_types = {uid: t for uid, t in props.values()}
    return _Ctx(conn, source_id, now, actor_id, idx, ids, aliases, writer)


def _resolve_uid(c: _Ctx, category: str, uid: str) -> str | None:
    if uid in c.ids[category]:
        return uid
    a = c.aliases.get((category, uid))
    return a if a is not None and a in c.ids[category] else None


def _register(c: _Ctx, spec: dt.Spec, uid: str, new_id: int, item: dict[str, Any]) -> None:
    if spec.natural != "uid":
        return
    c.ids[spec.key][uid] = new_id
    c.idx.uid_by_id[spec.key][new_id] = uid
    if spec.key == "propertyDefs":
        c.idx.props[new_id] = (uid, item["type"])
        c.writer.prop_types[uid] = item["type"]


class _Applier:
    def __init__(self, c: _Ctx, source: sqlite3.Row, doc: dict[str, Any], threshold_ms: int):
        self.c = c
        self.source = source
        self.threshold = threshold_ms
        self.stats = _empty_stats()
        self.reasons: list[str] = []
        self.display_names = {u["username"]: u["displayName"] for u in doc["users"]}
        self.in_overview = {u["username"]: u.get("inOverview") for u in doc["users"]}
        #: 中央任務描述已鎖定、因此未套用來源描述的筆數（docs/sync.md）
        self.lock_skipped = 0
        self.auto_create = bool(source["auto_create_users"])

    # 成員 ------------------------------------------------------------
    def _user_ok(self, username: str) -> bool:
        c = self.c
        if username in c.writer.user_id:
            return True
        if not self.auto_create:
            c.missing_users.add(username)
            return False
        from .features.admin import check_username, generate_temp_password
        from .security import hash_password

        try:
            check_username(username)
        except ValueError:
            c.missing_users.add(username)
            return False
        display = (self.display_names.get(username) or username)[:100]
        ov = self.in_overview.get(username)
        cur = c.conn.execute(
            "INSERT INTO users (username, display_name, password_hash, role, is_active, must_change_password, "
            "created_at, updated_at, in_overview) VALUES (?, ?, ?, 'user', 1, 1, ?, ?, ?)",
            (username, display, hash_password(generate_temp_password()), c.now, c.now, 1 if ov is None or ov else 0),
        )
        new_id = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(c.conn, "user", new_id, "create", None, c.now)
        c.writer.user_id[username] = new_id
        c.idx.user_by_id[new_id] = username
        c.created_users.append(username)
        return True

    # 正規化：把來源的參照換成中央的 uid / 帳號 ------------------------------
    def normalize(self, spec: dt.Spec, item: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
        c = self.c
        norm = dict(item)
        for f in spec.fields:
            v = norm[f.name]
            if v is None:
                continue
            if f.kind == "user":
                if not self._user_ok(v):
                    if not f.nullable:
                        return None, f"缺少成員 {v}"
                    norm[f.name] = None
            elif f.kind == "ref":
                r = _resolve_uid(c, f.extra, v)
                if r is None:
                    return None, f"參照的{SPEC_BY_KEY[f.extra].label}在中央不存在"
                norm[f.name] = r
            elif f.kind == "custom":
                out: dict[str, Any] = {}
                for k, val in v.items():
                    pk = _resolve_uid(c, "propertyDefs", k)
                    if pk is None:
                        continue
                    if c.writer.prop_types.get(pk) == "person":
                        if not isinstance(val, str) or not self._user_ok(val):
                            continue
                    out[pk] = val
                norm[f.name] = out
        return norm, None

    def find_central(self, spec: dt.Spec, norm: dict[str, Any], batch_keys: set[str]) -> sqlite3.Row | None:
        c = self.c
        if spec.natural != "uid":
            return c.conn.execute(
                f"SELECT * FROM {spec.table} WHERE lower({spec.natural}) = ?", (str(norm[spec.natural]).lower(),)
            ).fetchone()
        cu = _resolve_uid(c, spec.key, norm["uid"])
        if cu is not None:
            return c.conn.execute(f"SELECT * FROM {spec.table} WHERE uid = ?", (cu,)).fetchone()
        if spec.name_fallback:
            taken = {v for (cat, _), v in c.aliases.items() if cat == spec.key}
            cands = [
                r
                for r in c.conn.execute(f"SELECT * FROM {spec.table} WHERE name = ?", (norm["name"],)).fetchall()
                if r["uid"] not in batch_keys and r["uid"] not in taken
            ]
            if len(cands) == 1 and c.source_id is not None:
                c.conn.execute(
                    "INSERT OR REPLACE INTO sync_uid_aliases (source_id, category, source_uid, central_uid, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (c.source_id, spec.key, norm["uid"], cands[0]["uid"], c.now),
                )
                c.aliases[(spec.key, norm["uid"])] = cands[0]["uid"]
                return cands[0]
        return None

    def _pending(self, category: str, key: str) -> sqlite3.Row | None:
        return self.c.conn.execute(
            "SELECT * FROM sync_conflicts WHERE source_id = ? AND category = ? AND entity_uid = ? AND status = 'pending'",
            (self.c.source_id, category, key),
        ).fetchone()

    def _close(self, pending: sqlite3.Row | None, resolution: str) -> None:
        """新上傳的版本讓待確認衝突不再需要決定：由系統標記為已解決（resolved_by = NULL）"""
        if pending is None:
            return
        self.c.conn.execute(
            "UPDATE sync_conflicts SET status = 'resolved', resolution = ?, resolved_by = NULL, resolved_at = ?, "
            "updated_at = ? WHERE id = ?",
            (resolution, self.c.now, self.c.now, pending["id"]),
        )

    def skip(self, spec: dt.Spec, item: dict[str, Any], reason: str) -> None:
        self.stats[spec.key]["skipped"] += 1
        if len(self.reasons) < 50:
            self.reasons.append(f"{spec.label}「{str(item.get(spec.title, ''))[:60]}」：{reason}")

    def process(self, spec: dt.Spec, item: dict[str, Any], batch_keys: set[str]) -> None:
        c = self.c
        s = self.stats[spec.key]
        norm, reason = self.normalize(spec, item)
        if norm is None:
            self.skip(spec, item, reason or "無法套用")
            return
        row = self.find_central(spec, norm, batch_keys)
        if row is None:
            if spec.key == "tasks":
                _unlocked(norm)
            new_id = c.writer.insert(spec, norm)
            if new_id is None:
                self.skip(spec, item, _unapplied_reason(spec))
                return
            s["created"] += 1
            if spec.natural == "uid":
                _register(c, spec, norm["uid"], new_id, norm)
            return
        key = row["uid"] if spec.natural == "uid" else str(row[spec.natural]).lower()
        if spec.natural == "uid":
            norm["uid"] = key
        view = dt._export_row(spec, row, c.idx)
        if spec.key == "tasks" and _keep_lock(view, norm):
            self.lock_skipped += 1
        diff = dt._diff(spec, view, norm)
        pending = self._pending(spec.key, key)
        if not diff:
            s["unchanged"] += 1
            self._close(pending, "keep_local")
            return
        lu, iu = view.get("updatedAt") or 0, norm.get("updatedAt") or 0
        if abs(iu - lu) > self.threshold:
            if iu > lu:
                if c.writer.update(spec, norm, row["id"]):
                    s["updated"] += 1
                    self._close(pending, "use_incoming")
                else:
                    self.skip(spec, item, _unapplied_reason(spec))
            else:
                s["older"] += 1
                self._close(pending, "keep_local")
            return
        self._conflict(spec, key, view, norm, diff, pending)

    def _conflict(
        self,
        spec: dt.Spec,
        key: str,
        view: dict[str, Any],
        norm: dict[str, Any],
        diff: list[str],
        pending: sqlite3.Row | None,
    ) -> None:
        c = self.c
        incoming = _canon(norm)
        args = (_canon(view), incoming, view.get("updatedAt"), norm.get("updatedAt"), json.dumps(diff))
        if pending is not None:
            if pending["incoming_json"] != incoming:
                c.conn.execute(
                    "UPDATE sync_conflicts SET local_json = ?, incoming_json = ?, local_updated_at = ?, "
                    "incoming_updated_at = ?, diff_fields = ?, updated_at = ? WHERE id = ?",
                    (*args, c.now, pending["id"]),
                )
            self.stats[spec.key]["conflict"] += 1
            return
        # 同一份內容（不計建立 / 更新時間）先前已決定過 → 尊重當時的決定，不再詢問
        content = _content(norm)
        decided = any(
            _content(json.loads(r["incoming_json"])) == content
            for r in c.conn.execute(
                "SELECT incoming_json FROM sync_conflicts WHERE source_id = ? AND category = ? AND entity_uid = ? "
                "AND status = 'resolved' AND resolved_by IS NOT NULL",
                (c.source_id, spec.key, key),
            )
        )
        if decided:
            self.skip(spec, norm, "同一份內容先前已決定過")
            return
        c.conn.execute(
            "INSERT INTO sync_conflicts (source_id, source_name, category, entity_uid, local_json, incoming_json, "
            "local_updated_at, incoming_updated_at, diff_fields, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            (c.source_id, self.source["name"], spec.key, key, *args, c.now, c.now),
        )
        self.stats[spec.key]["conflict"] += 1


def _unapplied_reason(spec: dt.Spec) -> str:
    """_Writer.insert / update 回傳 None / False 的原因（依類別）"""
    if spec.key == "personalItems":
        return "同一成員的個人清單已對應此任務（或缺少成員）"
    if spec.key == "taskChecklistItems":
        return "空白的待辦項目無法存入"
    return "缺少必要的成員"


_LOCK_FIELDS = ("descriptionLocked", "lockedByUsername", "lockedAt")


def _unlocked(norm: dict[str, Any]) -> None:
    """同步新建的任務一律不帶描述鎖定（鎖定只能由中央有 tasks.lock 權限的人設定）"""
    norm["descriptionLocked"] = False
    norm["lockedByUsername"] = None
    norm["lockedAt"] = None


def _keep_lock(central: dict[str, Any], norm: dict[str, Any]) -> bool:
    """同步不得改變描述鎖定：鎖定欄位一律沿用中央；中央已鎖定時也保留中央的描述。
    回傳是否因此略過了不同的描述（摘要計數用）。"""
    for k in _LOCK_FIELDS:
        norm[k] = central.get(k)
    if not central.get("descriptionLocked"):
        return False
    changed = norm.get("description") != central.get("description")
    norm["description"] = central.get("description")
    return changed


def totals_of(categories: list[dict[str, Any]]) -> dict[str, int]:
    return {k: sum(int(cat.get(k, 0)) for cat in categories) for k in TOTAL_KEYS}


def _local_day(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def _backup_keep() -> int:
    try:
        return max(1, int(os.environ.get("BACKUP_KEEP") or DEFAULT_KEEP))
    except ValueError:
        return DEFAULT_KEEP


def _sync_backup(db: Database, backup_dir: str | Path, source_uid: str) -> Path:
    label = f"pre-sync-{source_uid[:8]}"
    file = dt.snapshot(db, backup_dir, label)
    stem = Path(db.path).stem if db.path != ":memory:" else "memory"
    pat = re.compile(rf"^{re.escape(stem)}-{re.escape(label)}-\d{{8}}-\d{{6}}(-\d+)?\.db$")
    files = sorted((p for p in Path(backup_dir).iterdir() if pat.match(p.name)), key=lambda p: (p.stat().st_mtime, p.name))
    for old in files[: max(0, len(files) - _backup_keep())]:
        old.unlink(missing_ok=True)
    return file


def apply_push(
    db: Database,
    source_id: int,
    doc: dict[str, Any],
    *,
    now: int,
    threshold_ms: int,
    backup_dir: str | Path | None,
) -> dict[str, Any]:
    """套用一批上傳。同一天同一來源只在第一批前自動備份；資料寫入為單一 transaction，任何錯誤全數回滾。"""
    with db.lock:
        source = db.one("SELECT * FROM sync_sources WHERE id = ?", (source_id,))
        if source is None or not source["is_active"]:
            raise SyncError("同步來源不存在或已停用", status=403, code="FORBIDDEN")
        backup_file: Path | None = None
        if backup_dir is not None and (
            source["last_backup_at"] is None or _local_day(source["last_backup_at"]) != _local_day(now)
        ):
            backup_file = _sync_backup(db, backup_dir, source["uid"])
        with db.tx() as conn:
            c = _load_ctx(conn, source_id, now, None)
            ap = _Applier(c, source, doc, threshold_ms)
            for spec in SPECS:
                keys = {dt._natural_key(spec, it) for it in doc[spec.key]}
                for item in doc[spec.key]:
                    ap.process(spec, item, keys)
            categories = [ap.stats[s.key] for s in SPECS]
            totals = totals_of(categories)
            src = doc["source"]
            batch = doc.get("batch") or {"index": 0, "total": 1}
            prev = json.loads(source["last_push_summary"]) if source["last_push_summary"] else None
            acc = dict(totals)
            batches = 1
            if prev and src.get("pushId") and prev.get("pushId") == src["pushId"]:
                acc = {k: acc[k] + int(prev.get("totals", {}).get(k, 0)) for k in TOTAL_KEYS}
                batches = int(prev.get("batches", 0)) + 1
            pending = conn.execute(
                "SELECT count(*) FROM sync_conflicts WHERE source_id = ? AND status = 'pending'", (source_id,)
            ).fetchone()[0]
            summary = {
                "pushId": src.get("pushId"),
                "machineName": src["machineName"],
                "sourceName": source["name"],
                "at": now,
                "since": src.get("since"),
                "full": not doc.get("incremental", True),
                "batches": batches,
                "batchTotal": batch["total"],
                "totals": acc,
                "pendingConflicts": pending,
                "missingUsers": sorted(c.missing_users)[:50],
                "descriptionLockSkipped": ap.lock_skipped,
            }
            conn.execute(
                "UPDATE sync_sources SET last_push_at = ?, last_push_summary = ?, "
                "last_backup_at = COALESCE(?, last_backup_at) WHERE id = ?",
                (now, _canon(summary), now if backup_file else None, source_id),
            )
            audit_events.sync_applied(conn, source, src["machineName"], totals, now)
    return {
        "source": {"name": source["name"]},
        "batch": batch,
        "categories": categories,
        "totals": totals,
        "pendingConflicts": pending,
        "skipped": ap.reasons,
        #: 中央描述已鎖定而未套用來源描述的任務數
        "descriptionLockSkipped": ap.lock_skipped,
        "missingUsers": sorted(c.missing_users),
        "createdUsers": c.created_users,
        "backupFile": backup_file.name if backup_file else None,
    }


# ── 衝突檢視與處理 ──────────────────────────────────────────


def _central_row(conn: sqlite3.Connection, spec: dt.Spec, key: str) -> sqlite3.Row | None:
    if spec.natural == "uid":
        return conn.execute(f"SELECT * FROM {spec.table} WHERE uid = ?", (key,)).fetchone()
    return conn.execute(f"SELECT * FROM {spec.table} WHERE lower({spec.natural}) = ?", (key,)).fetchone()


_PRIORITY_LABELS = {"none": "無", "low": "低", "medium": "中", "high": "高", "urgent": "緊急"}


def _display(conn: sqlite3.Connection, spec: dt.Spec, name: str, value: Any, users: dict[str, str]) -> Any:
    """參照與成員欄位的可讀文字（uid → 名稱 / 標題；帳號 → 顯示名稱）"""
    f = next((x for x in spec.fields if x.name == name), None)
    if f is None or value is None:
        return None
    if name == "priority":
        return _PRIORITY_LABELS.get(value)
    if f.kind == "user":
        return f"{users.get(value, value)}（@{value}）"
    if f.kind == "ref":
        ref = SPEC_BY_KEY[f.extra]
        r = conn.execute(f"SELECT {ref.title} AS t FROM {ref.table} WHERE uid = ?", (value,)).fetchone()
        return r["t"] if r else f"（不存在：{value}）"
    if f.kind == "custom":
        out = {}
        for k, v in value.items():
            r = conn.execute("SELECT name, type FROM property_defs WHERE uid = ?", (k,)).fetchone()
            label = r["name"] if r else k
            out[label] = f"{users.get(v, v)}（@{v}）" if r is not None and r["type"] == "person" and isinstance(v, str) else v
        return out
    return None


def _conflict_title(spec: dt.Spec, incoming: dict[str, Any]) -> str:
    return str(incoming.get(spec.title) or "")


def conflict_summary(r: sqlite3.Row, users: dict[int, str] | None = None) -> dict[str, Any]:
    spec = SPEC_BY_KEY.get(r["category"])
    incoming = json.loads(r["incoming_json"])
    diff = json.loads(r["diff_fields"] or "[]")
    lu, iu = r["local_updated_at"], r["incoming_updated_at"]
    out = {
        "id": r["id"],
        "category": r["category"],
        "categoryLabel": spec.label if spec else r["category"],
        "title": _conflict_title(spec, incoming) if spec else r["entity_uid"],
        "entityUid": r["entity_uid"],
        "sourceId": r["source_id"],
        "sourceName": r["source_name"],
        "localUpdatedAt": lu,
        "incomingUpdatedAt": iu,
        "diffMinutes": round(abs((iu or 0) - (lu or 0)) / 60_000, 1),
        "diffFields": [{"name": n, "label": dt.FIELD_LABELS.get(n, n)} for n in diff],
        "status": r["status"],
        "resolution": r["resolution"],
        "resolvedBy": r["resolved_by"],
        "resolvedByName": (users or {}).get(r["resolved_by"]) if r["resolved_by"] is not None else None,
        "resolvedAt": r["resolved_at"],
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
    }
    if r["merged_json"]:
        try:
            out["choices"] = json.loads(r["merged_json"]).get("choices")
        except (ValueError, AttributeError):
            out["choices"] = None
    return out


def conflict_detail(db: Database, conflict_id: int) -> dict[str, Any] | None:
    with db.tx() as conn:
        r = conn.execute("SELECT * FROM sync_conflicts WHERE id = ?", (conflict_id,)).fetchone()
        if r is None:
            return None
        users_rows = conn.execute("SELECT id, username, display_name FROM users").fetchall()
        by_name = {u["username"]: u["display_name"] for u in users_rows}
        by_id = {u["id"]: u["display_name"] for u in users_rows}
        out = conflict_summary(r, by_id)
        spec = SPEC_BY_KEY.get(r["category"])
        incoming = json.loads(r["incoming_json"])
        if spec is None:
            return {**out, "centralExists": False, "fields": []}
        row = _central_row(conn, spec, r["entity_uid"])
        if row is not None and r["status"] == "pending":
            c = _load_ctx(conn, None, 0, None)
            local = dt._export_row(spec, row, c.idx)
            out["localUpdatedAt"] = local.get("updatedAt")
            out["diffMinutes"] = round(abs((out["incomingUpdatedAt"] or 0) - (local.get("updatedAt") or 0)) / 60_000, 1)
        else:
            local = json.loads(r["local_json"])
        names = [f.name for f in spec.fields if f.name not in dt._META_FIELDS]
        diff = [n for n in names if not dt._same(local.get(n), incoming.get(n))]
        if r["status"] == "resolved":
            diff = json.loads(r["diff_fields"] or "[]")
        out["centralExists"] = row is not None
        out["fields"] = [
            {
                "name": n,
                "label": dt.FIELD_LABELS.get(n, n),
                "local": local.get(n),
                "incoming": incoming.get(n),
                "localDisplay": _display(conn, spec, n, local.get(n), by_name),
                "incomingDisplay": _display(conn, spec, n, incoming.get(n), by_name),
            }
            for n in diff
        ]
        out["diffFields"] = [{"name": n, "label": dt.FIELD_LABELS.get(n, n)} for n in diff]
        return out


Choice = Literal["local", "incoming"]


def _resolve_one(
    conn: sqlite3.Connection,
    r: sqlite3.Row,
    resolution: Resolution,
    choices: dict[str, Choice] | None,
    actor: sqlite3.Row,
    now: int,
) -> dict[str, Any]:
    if r["status"] != "pending":
        raise SyncError("這筆衝突已經處理過了", status=409, code="ALREADY_RESOLVED")
    spec = SPEC_BY_KEY.get(r["category"])
    if spec is None:
        raise SyncError("未知的資料類別", status=409, code="CONFLICT")
    c = _load_ctx(conn, None, now, actor["id"])
    incoming = json.loads(r["incoming_json"])
    row = _central_row(conn, spec, r["entity_uid"])
    local = dt._export_row(spec, row, c.idx) if row is not None else None
    record: dict[str, Any] = {"resolution": resolution}
    if resolution in ("use_incoming", "merged"):
        if resolution == "merged":
            if local is None:
                item = dict(incoming)
            else:
                valid = {f.name for f in spec.fields if f.name not in dt._META_FIELDS}
                bad = [k for k in (choices or {}) if k not in valid]
                if bad:
                    raise SyncError(f"未知的欄位：{'、'.join(bad)}")
                item = dict(local)
                for name, side in (choices or {}).items():
                    if side == "incoming":
                        item[name] = incoming.get(name)
            item["updatedAt"] = now
            item["updatedByUsername"] = actor["username"]
            record["choices"] = choices or {}
        else:
            item = dict(incoming)
            if local is not None:
                item["updatedAt"] = max(int(incoming.get("updatedAt") or 0), int(local.get("updatedAt") or 0))
        if spec.natural == "uid":
            item["uid"] = r["entity_uid"]
        if spec.key == "tasks":
            # 衝突內容來自同步來源：同樣不得改變描述鎖定或已鎖定的描述
            if local is None:
                _unlocked(item)
            else:
                _keep_lock(local, item)
        try:
            if row is None:
                new_id = c.writer.insert(spec, item)
                ok = new_id is not None
            else:
                ok = c.writer.update(spec, item, row["id"])
        except dt.TransferError as e:
            raise SyncError(f"無法套用：{e.message}", status=409, code="CONFLICT") from None
        if not ok:
            raise SyncError("無法套用：相關的成員或任務對應已不存在", status=409, code="CONFLICT")
        record["result"] = item
    conn.execute(
        "UPDATE sync_conflicts SET status = 'resolved', resolution = ?, merged_json = ?, resolved_by = ?, "
        "resolved_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        (resolution, _canon(record), actor["id"], now, now, r["id"]),
    )
    return record


def resolve_conflict(
    db: Database, conflict_id: int, resolution: Resolution, choices: dict[str, Choice] | None, actor: sqlite3.Row, now: int
) -> None:
    with db.tx() as conn:
        r = conn.execute("SELECT * FROM sync_conflicts WHERE id = ?", (conflict_id,)).fetchone()
        if r is None:
            raise SyncError("找不到這筆衝突", status=404, code="NOT_FOUND")
        _resolve_one(conn, r, resolution, choices, actor, now)


def resolve_bulk(
    db: Database, ids: list[int], resolution: Literal["keep_local", "use_incoming"], actor: sqlite3.Row, now: int
) -> dict[str, Any]:
    """對多筆套用同一選擇（單一 transaction；任一筆無法套用則全部不變）。已處理過的略過並回報。"""
    resolved: list[int] = []
    skipped: list[int] = []
    with db.tx() as conn:
        for cid in dict.fromkeys(ids):
            r = conn.execute("SELECT * FROM sync_conflicts WHERE id = ?", (cid,)).fetchone()
            if r is None or r["status"] != "pending":
                skipped.append(cid)
                continue
            _resolve_one(conn, r, resolution, None, actor, now)
            resolved.append(cid)
    return {"resolved": resolved, "skipped": skipped}


# ── 本機端：增量匯出（CLI sync-push 使用） ────────────────────

#: 增量匯出時往前多取的時間，涵蓋「匯出當下仍在寫入」的資料（重複上傳為冪等，不影響結果）
OVERLAP_MS = 60_000


def export_changes(db: Database, since: int | None) -> tuple[list[tuple[str, dict[str, Any]]], dict[str, str]]:
    """本機資料中 updated_at >= since - OVERLAP 的業務資料（since=None 為全量），依類別順序（被參照者在前）。
    回傳 (資料, 帳號 → 顯示名稱)。"""
    out: list[tuple[str, dict[str, Any]]] = []
    with db.tx() as conn:
        idx = dt._index(conn)
        for spec in SPECS:
            for row in idx.rows[spec.key]:
                if since is not None and (row["updated_at"] or 0) < since - OVERLAP_MS:
                    continue
                out.append((spec.key, dt._export_row(spec, row, idx)))
        users = {
            r["username"]: r["display_name"] for r in conn.execute("SELECT username, display_name FROM users")
        }
    return out, users


def export_user_flags(db: Database) -> dict[str, bool]:
    """本機帳號 → 是否列入總覽統計（中央「自動建立缺少的成員」時沿用；既有帳號不受影響）"""
    return {r["username"]: bool(r["in_overview"]) for r in db.all("SELECT username, in_overview FROM users")}


def _referenced(items: list[tuple[str, dict[str, Any]]]) -> set[str]:
    names: set[str] = set()
    for key, item in items:
        spec = SPEC_BY_KEY[key]
        for f in spec.fields:
            if f.kind == "user" and item[f.name] is not None:
                names.add(item[f.name])
            elif f.kind == "custom":
                names.update(v for v in item[f.name].values() if isinstance(v, str))
    return names


def build_batches(
    items: list[tuple[str, dict[str, Any]]],
    users: dict[str, str],
    *,
    machine_name: str,
    exported_at: int,
    since: int | None,
    push_id: str,
    batch_size: int = DEFAULT_BATCH_SIZE,
    in_overview: dict[str, bool] | None = None,
) -> list[dict[str, Any]]:
    """切成每批 batch_size 筆的上傳文件（至少一批，空批用來回報「有同步但無變動」）"""
    chunks = [items[i : i + batch_size] for i in range(0, len(items), batch_size)] or [[]]
    docs = []
    for i, chunk in enumerate(chunks):
        doc: dict[str, Any] = {
            "format": dt.FORMAT,
            "schemaVersion": dt.SCHEMA_VERSION,
            "exportedAt": exported_at,
            "source": {"machineName": machine_name[:200], "exportedAt": exported_at, "since": since, "pushId": push_id},
            "incremental": since is not None,
            "batch": {"index": i, "total": len(chunks)},
            "users": [
                {
                    "username": u,
                    "displayName": (users.get(u) or u)[:100],
                    **({"inOverview": in_overview[u]} if in_overview and u in in_overview else {}),
                }
                for u in sorted(_referenced(chunk))
                if u in users
            ],
        }
        for spec in SPECS:
            doc[spec.key] = [item for key, item in chunk if key == spec.key]
        docs.append(doc)
    return docs
