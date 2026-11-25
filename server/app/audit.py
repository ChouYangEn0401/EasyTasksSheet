"""稽核紀錄（audit_log；docs/design/audit-log.md）。

用途是「還原失誤與追溯原因」，不是評比個人：只保存資料本身的前後值，不提供任何個人統計或排名。

- `record_audit()`：與主操作在同一個 transaction 內寫入（以 SAVEPOINT 包住）；稽核寫入本身失敗時
  只記警告、不讓主操作失敗。即時更新沿用主操作本身的 record_change（每次寫入恰好一筆流水的不變式不變）：
  前端收到 task / project / status / property / user / permission 變更時一併重抓稽核查詢（src/web/lib/sync.ts）。
  還原同樣對被還原的資料呼叫 record_change。
- `diff_fields()`：只留下有變動的欄位；`snapshot()`：把資料列轉成可比較的欄位字典（API 欄位名）。
- 還原（`revert_action()` / `plan_revert()`，含衝突保護）在 audit_revert.py。
- `prune_audit()` / `maybe_prune()`：保留期限（AUDIT_RETENTION_DAYS，預設 365 天）。

與 changes 表的差異：changes 只記「誰動了哪一筆」（無前後值、保留 30 天、供即時同步）；audit_log 另存前後值。
"""

from __future__ import annotations

import json
import logging
import math
import sqlite3
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from .changes import record_change
from .db import Database, now_ms
from .timeutil import DAY_MS, MINUTE_MS

log = logging.getLogger("server.audit")

#: 單一欄位值的保存上限（字元數；任務描述最多 20000 字，可完整保存）。超過時截斷並標記 truncated。
MAX_FIELD_CHARS = 20_000
TRUNCATED_KEY = "__truncated__"
#: 連續「調整順序」在此時間內（同一人、同一筆、尚未還原）合併為一筆
REORDER_MERGE_MS = 10 * MINUTE_MS

SOURCES = ("web", "api", "import", "sync", "system", "revert")
ENTITY_TYPES = (
    "task",
    "project",
    "status",
    "property",
    "user",
    "permission",
    "import",
    "sync",
    "relation",
    "dependency",
    "checklist",
    "comment",
)
ACTIONS = ("create", "update", "delete", "restore", "reorder", "reset_password", "unlock", "apply")

# ── 欄位定義（API 欄位名 → DB 欄位）──────────────────────────────

ENTITY_TABLES = {
    "task": "tasks",
    "project": "projects",
    "status": "statuses",
    "property": "property_defs",
    "user": "users",
    "relation": "task_relations",
    "dependency": "task_dependencies",
    "comment": "task_comments",
}

#: 任務之間的連結（相關任務 / 依賴）：稽核快照欄位（API 名 → DB 欄位）。建立 ↔ 移除可互相還原
LINK_FIELDS: dict[str, dict[str, str]] = {
    "relation": {"taskAId": "task_a_id", "taskBId": "task_b_id", "type": "type"},
    "dependency": {
        "blockerTaskId": "blocker_task_id",
        "blockedTaskId": "blocked_task_id",
        "lagDays": "lag_days",
        "note": "note",
    },
}
_LINK_TASK_FIELDS = {"taskAId", "taskBId", "blockerTaskId", "blockedTaskId"}

ENTITY_FIELDS: dict[str, dict[str, str]] = {
    "task": {
        "title": "title",
        "projectId": "project_id",
        "description": "description",
        "statusId": "status_id",
        "assigneeId": "assignee_id",
        "priority": "priority",
        "startDate": "start_date",
        "dueDate": "due_date",
        "estimateHours": "estimate_hours",
        "progress": "progress",
        "sortOrder": "sort_order",
        "descriptionLocked": "description_locked",
    },
    "project": {"name": "name", "color": "color", "isArchived": "is_archived", "sortOrder": "sort_order"},
    "status": {"name": "name", "color": "color", "category": "category", "sortOrder": "sort_order"},
    "property": {"name": "name", "type": "type", "projectId": "project_id", "options": "options", "sortOrder": "sort_order"},
    "user": {
        "username": "username",
        "displayName": "display_name",
        "role": "role",
        "isActive": "is_active",
        "inOverview": "in_overview",
    },
}
_BOOL_FIELDS = {"isArchived", "isActive", "descriptionLocked", "inOverview"}
_JSON_FIELDS = {"options"}

#: 還原時需同時具備的權限（除 audit.revert 外）
ENTITY_CAPABILITY = {
    "task": "tasks.edit",
    "project": "projects.manage",
    "status": "statuses.manage",
    "property": "properties.edit",
    "user": "members.manage",
    "permission": "permissions.configure",
    "relation": "tasks.edit",
    "dependency": "tasks.edit",
    "checklist": "tasks.edit",
    "comment": "comments.moderate",
}

FIELD_LABELS: dict[str, dict[str, str]] = {
    "task": {
        "title": "標題",
        "projectId": "專案",
        "description": "描述",
        "statusId": "狀態",
        "assigneeId": "負責人",
        "priority": "優先度",
        "startDate": "開始日",
        "dueDate": "到期日",
        "estimateHours": "預估工時",
        "progress": "進度",
        "sortOrder": "順序",
        "descriptionLocked": "描述鎖定",
    },
    "comment": {"excerpt": "內容（前 200 字）", "authorName": "發表者"},
    "project": {"name": "名稱", "color": "顏色", "isArchived": "封存", "sortOrder": "順序"},
    "status": {"name": "名稱", "color": "顏色", "category": "類別", "sortOrder": "順序"},
    "property": {"name": "名稱", "type": "型別", "projectId": "適用專案", "options": "選項", "sortOrder": "順序"},
    "user": {"username": "帳號", "displayName": "顯示名稱", "role": "角色", "isActive": "帳號狀態", "inOverview": "列入總覽統計"},
    "relation": {"taskAId": "任務", "taskBId": "相關任務", "type": "類型"},
    "dependency": {"blockerTaskId": "前置任務", "blockedTaskId": "等待中的任務", "lagDays": "間隔天數", "note": "備註"},
    "checklist": {"items": "項目", "completed": "完成", "reopened": "取消完成", "count": "項數"},
    "import": {
        "mode": "方式",
        "strategy": "衝突處理",
        "created": "新增",
        "updated": "更新",
        "deleted": "刪除",
        "skipped": "略過",
        "unchanged": "未變更",
    },
    "sync": {
        "machine": "電腦",
        "created": "新增",
        "updated": "更新",
        "conflict": "待確認",
        "skipped": "略過",
        "unchanged": "未變更",
        "older": "較舊未套用",
    },
}

PRIORITY_LABELS = {"none": "無", "low": "低", "medium": "中", "high": "高", "urgent": "緊急"}
CATEGORY_LABELS = {"todo": "待處理", "doing": "進行中", "done": "已完成"}
COLOR_LABELS = {
    "gray": "灰色",
    "blue": "藍色",
    "purple": "紫色",
    "green": "綠色",
    "yellow": "黃色",
    "orange": "橘色",
    "red": "紅色",
    "teal": "青色",
}
ROLE_LABELS = {"root": "超級管理員", "manager": "管理者", "user": "成員"}
PROPERTY_TYPE_LABELS = {
    "text": "文字",
    "number": "數字",
    "select": "單選",
    "multi_select": "多選",
    "date": "日期",
    "checkbox": "勾選",
    "url": "網址",
    "person": "成員",
}
MODE_LABELS = {"merge": "合併", "replace": "取代全部"}
STRATEGY_LABELS = {"keep_newer": "保留較新的", "keep_local": "保留本機", "use_import": "使用匯入檔"}


# ── 小工具 ───────────────────────────────────────────────


def _row_get(row: Any, key: str) -> Any:
    if row is None:
        return None
    if isinstance(row, sqlite3.Row):
        return row[key] if key in row.keys() else None
    if isinstance(row, Mapping):
        return row.get(key)
    return None


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def same_value(a: Any, b: Any) -> bool:
    """欄位值是否相同（1 與 1.0 視為相同；物件 / 陣列以正規化 JSON 比較）"""
    if _is_number(a) and _is_number(b):
        return math.isclose(float(a), float(b), rel_tol=0, abs_tol=1e-9)
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return json.dumps(a, sort_keys=True, ensure_ascii=False) == json.dumps(b, sort_keys=True, ensure_ascii=False)
    return a == b and type(a) is type(b) if isinstance(a, bool) or isinstance(b, bool) else a == b


def is_empty(v: Any) -> bool:
    return v is None or v == "" or v == []


def clip(text: Any, n: int = 40) -> str:
    s = "" if text is None else str(text)
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def quote(text: Any, n: int = 40) -> str:
    return f"『{clip(text, n)}』"


def snapshot(entity_type: str, row: Any) -> dict[str, Any]:
    """資料列 → {API 欄位: 值}；任務的自訂欄位展開為 custom.<propertyId>"""
    out: dict[str, Any] = {}
    for f, col in ENTITY_FIELDS[entity_type].items():
        v = _row_get(row, col)
        if f in _BOOL_FIELDS and v is not None:
            v = bool(v)
        elif f in _JSON_FIELDS and isinstance(v, str):
            v = json.loads(v)
        out[f] = v
    if entity_type == "task":
        raw = _row_get(row, "custom")
        custom = json.loads(raw) if isinstance(raw, str) and raw else (raw or {})
        for k, v in custom.items():
            out[f"custom.{k}"] = v
    return out


def diff_fields(
    before_row: Mapping[str, Any] | None,
    after_row: Mapping[str, Any] | None,
    fields: Iterable[str] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """比較兩個欄位字典，回傳 (before, after)——只含有變動的欄位。fields 未給時取兩邊所有鍵。"""
    b_src = before_row or {}
    a_src = after_row or {}
    keys = list(fields) if fields is not None else list(dict.fromkeys([*b_src.keys(), *a_src.keys()]))
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    for k in keys:
        bv, av = b_src.get(k), a_src.get(k)
        if not same_value(bv, av):
            before[k] = bv
            after[k] = av
    return before, after


def _cap_value(v: Any) -> tuple[Any, bool]:
    if isinstance(v, str):
        return (v[:MAX_FIELD_CHARS], True) if len(v) > MAX_FIELD_CHARS else (v, False)
    if isinstance(v, (dict, list)):
        s = json.dumps(v, ensure_ascii=False)
        if len(s) > MAX_FIELD_CHARS:
            return s[:MAX_FIELD_CHARS], True
    return v, False


def _dump(fields: Mapping[str, Any] | None) -> tuple[str | None, list[str]]:
    if fields is None:
        return None, []
    out: dict[str, Any] = {}
    truncated: list[str] = []
    for k, v in fields.items():
        out[k], t = _cap_value(v)
        if t:
            truncated.append(k)
    if truncated:
        out[TRUNCATED_KEY] = truncated
    return json.dumps(out, ensure_ascii=False), truncated


def load_fields(raw: str | None) -> tuple[dict[str, Any] | None, set[str]]:
    if not raw:
        return None, set()
    data = json.loads(raw)
    truncated = set(data.pop(TRUNCATED_KEY, []) or [])
    return data, truncated


def _actor_info(actor: Any) -> tuple[int | None, str | None, str | None]:
    if actor is None:
        return None, None, None
    return _row_get(actor, "id"), _row_get(actor, "display_name"), _row_get(actor, "username")


# ── 寫入 ─────────────────────────────────────────────────


def _insert(conn: sqlite3.Connection, values: dict[str, Any]) -> int:
    cols = ", ".join(values)
    cur = conn.execute(f"INSERT INTO audit_log ({cols}) VALUES ({', '.join('?' * len(values))})", tuple(values.values()))
    return int(cur.lastrowid)  # type: ignore[arg-type]


def record_audit(
    conn: sqlite3.Connection,
    *,
    actor: Any,
    entity_type: str,
    entity_id: int | None,
    action: str,
    summary: str,
    before: Mapping[str, Any] | None = None,
    after: Mapping[str, Any] | None = None,
    task_id: int | None = None,
    source: str = "web",
    revertable: bool = False,
    entity_label: str | None = None,
    entity_uid: str | None = None,
    note: str | None = None,
    revert_of: int | None = None,
    request_id: str | None = None,
    actor_name: str | None = None,
    ts: int | None = None,
) -> int | None:
    """寫入一筆稽核紀錄（須在主操作的 transaction 內呼叫）。回傳 audit id；稽核寫入失敗時回傳 None（不拋出）。"""
    t = now_ms() if ts is None else ts
    aid, aname, auser = _actor_info(actor)
    if actor_name is not None:
        aname = actor_name
    try:
        conn.execute("SAVEPOINT audit_write")
    except sqlite3.Error:
        log.warning("稽核紀錄寫入失敗（無法建立 savepoint）：%s", summary, exc_info=True)
        return None
    try:
        before_json, truncated = _dump(before)
        after_json, _ = _dump(after)
        if truncated and revertable:
            revertable = False
            note = note or "修改前的內容過長，只保存了部分內容，無法自動還原"
        audit_id = _insert(
            conn,
            {
                "ts": t,
                "actor_id": aid,
                "actor_name": aname,
                "actor_username": auser,
                "source": source,
                "entity_type": entity_type,
                "entity_id": entity_id,
                "entity_uid": entity_uid,
                "entity_label": entity_label,
                "task_id": task_id,
                "action": action,
                "summary": summary,
                "before_json": before_json,
                "after_json": after_json,
                "revertable": 1 if revertable else 0,
                "note": note,
                "revert_of": revert_of,
                "request_id": request_id,
            },
        )
        conn.execute("RELEASE audit_write")
    except Exception:
        log.warning("稽核紀錄寫入失敗（主操作仍照常完成）：%s", summary, exc_info=True)
        try:
            conn.execute("ROLLBACK TO audit_write")
            conn.execute("RELEASE audit_write")
        except sqlite3.Error:
            pass
        return None
    try:
        maybe_prune(conn, t)
    except sqlite3.Error:
        log.warning("稽核紀錄修剪失敗", exc_info=True)
    return audit_id


def record_reorder(
    conn: sqlite3.Connection,
    *,
    actor: Any,
    entity_type: str,
    entity_id: int,
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    summary: str,
    entity_label: str | None = None,
    task_id: int | None = None,
    ts: int | None = None,
) -> int | None:
    """「調整順序」：同一人在 REORDER_MERGE_MS 內對同一筆連續調整時合併為一筆（保留最初的 before）"""
    t = now_ms() if ts is None else ts
    aid = _row_get(actor, "id")
    prev = conn.execute(
        "SELECT id, ts, actor_id, action, reverted_at, after_json FROM audit_log "
        "WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1",
        (entity_type, entity_id),
    ).fetchone()
    if (
        prev is not None
        and prev["action"] == "reorder"
        and prev["actor_id"] == aid
        and prev["reverted_at"] is None
        and 0 <= t - prev["ts"] <= REORDER_MERGE_MS
    ):
        try:
            prev_after, _ = load_fields(prev["after_json"])
            merged = {**(prev_after or {}), **dict(after)}
            conn.execute(
                "UPDATE audit_log SET ts = ?, after_json = ?, summary = ? WHERE id = ?",
                (t, _dump(merged)[0], summary, prev["id"]),
            )
            return int(prev["id"])
        except sqlite3.Error:
            log.warning("稽核紀錄合併失敗", exc_info=True)
            return None
    return record_audit(
        conn,
        actor=actor,
        entity_type=entity_type,
        entity_id=entity_id,
        action="reorder",
        summary=summary,
        before=before,
        after=after,
        task_id=task_id,
        revertable=True,
        entity_label=entity_label,
        ts=t,
    )


def record_merged_count(
    conn: sqlite3.Connection,
    *,
    actor: Any,
    entity_type: str,
    entity_id: int,
    merge_tag: str,
    counts: Mapping[str, int],
    summary_of: Callable[[dict[str, int]], str],
    entity_label: str | None = None,
    task_id: int | None = None,
    ts: int | None = None,
    note: str | None = None,
) -> int | None:
    """高頻小動作（例如勾選待辦項目）：同一人在 REORDER_MERGE_MS 內對同一筆的同類動作合併為一筆並累加次數。
    merge_tag 存在 request_id 欄位作為合併鍵；不可還原。"""
    t = now_ms() if ts is None else ts
    aid = _row_get(actor, "id")
    prev = conn.execute(
        "SELECT id, ts, actor_id, request_id, after_json FROM audit_log "
        "WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1",
        (entity_type, entity_id),
    ).fetchone()
    if (
        prev is not None
        and prev["request_id"] == merge_tag
        and prev["actor_id"] == aid
        and 0 <= t - prev["ts"] <= REORDER_MERGE_MS
    ):
        try:
            prev_after, _ = load_fields(prev["after_json"])
            merged = {k: int((prev_after or {}).get(k) or 0) for k in counts}
            for k, v in counts.items():
                merged[k] += int(v)
            conn.execute(
                "UPDATE audit_log SET ts = ?, after_json = ?, summary = ? WHERE id = ?",
                (t, _dump(merged)[0], summary_of(merged), prev["id"]),
            )
            return int(prev["id"])
        except sqlite3.Error:
            log.warning("稽核紀錄合併失敗", exc_info=True)
            return None
    first = {k: int(v) for k, v in counts.items()}
    return record_audit(
        conn,
        actor=actor,
        entity_type=entity_type,
        entity_id=entity_id,
        action="update",
        summary=summary_of(first),
        after=first,
        task_id=task_id,
        revertable=False,
        note=note,
        entity_label=entity_label,
        request_id=merge_tag,
        ts=t,
    )


def link_snapshot(entity_type: str, row: Any) -> dict[str, Any]:
    """相關任務 / 依賴資料列 → 稽核快照"""
    return {f: _row_get(row, col) for f, col in LINK_FIELDS[entity_type].items()}


def touch_tasks(conn: sqlite3.Connection, task_ids: Any, actor_id: Any, t: int) -> None:
    """連結變動：兩端（未刪除）任務更新 updated_at 並寫 task update 流水（SSE 即時更新）"""
    for tid in dict.fromkeys(task_ids):
        cur = conn.execute(
            "UPDATE tasks SET updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL", (t, actor_id, tid)
        )
        if cur.rowcount:
            record_change(conn, "task", tid, "update", actor_id, t)


# ── 保留期限 ─────────────────────────────────────────────

_last_prune: dict[int, int] = {}


def retention_ms(days: float | None = None) -> int:
    if days is None:
        from .config import config

        days = config.AUDIT_RETENTION_DAYS
    return int(days * DAY_MS)


def prune_audit(conn: sqlite3.Connection, cutoff: int) -> int:
    """刪除早於 cutoff（unix ms）的稽核紀錄；回傳刪除筆數"""
    return conn.execute("DELETE FROM audit_log WHERE ts < ?", (cutoff,)).rowcount


def maybe_prune(conn: sqlite3.Connection, t: int, days: float | None = None) -> int:
    """每日至多修剪一次（寫入稽核時順便檢查）"""
    key = id(conn)
    last = _last_prune.get(key)
    if last is not None and 0 <= t - last < DAY_MS:
        return 0
    _last_prune[key] = t
    return prune_audit(conn, t - retention_ms(days))


def prune_on_startup(db: Database, now: int | None = None, days: float | None = None) -> int:
    t = now_ms() if now is None else now
    try:
        with db.tx() as conn:
            n = prune_audit(conn, t - retention_ms(days))
        _last_prune[id(db.conn)] = t
        return n
    except sqlite3.OperationalError:  # 尚未套用 0018 migration
        return 0


# ── 顯示文字 ─────────────────────────────────────────────


def _fmt_number(v: Any) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


class Labeler:
    """欄位名稱與值的中文顯示（讀取時計算；名稱已變更或刪除時以目前資料 / 編號顯示）"""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self._cache: dict[str, dict[int, Any]] = {}

    def _table(self, name: str, sql: str) -> dict[int, Any]:
        if name not in self._cache:
            self._cache[name] = {int(r["id"]): r for r in self.conn.execute(sql).fetchall()}
        return self._cache[name]

    def statuses(self) -> dict[int, Any]:
        return self._table("statuses", "SELECT id, name FROM statuses")

    def projects(self) -> dict[int, Any]:
        return self._table("projects", "SELECT id, name FROM projects")

    def users(self) -> dict[int, Any]:
        return self._table("users", "SELECT id, display_name FROM users")

    def tasks(self) -> dict[int, Any]:
        return self._table("tasks", "SELECT id, title FROM tasks")

    def properties(self) -> dict[int, Any]:
        return self._table("properties", "SELECT id, name, type, options FROM property_defs")

    def _prop(self, field: str) -> Any:
        try:
            return self.properties().get(int(field.split(".", 1)[1]))
        except (ValueError, IndexError):
            return None

    def field_label(self, entity_type: str, field: str) -> str:
        if field.startswith("custom."):
            p = self._prop(field)
            return p["name"] if p is not None else "自訂欄位（已刪除）"
        if entity_type == "permission":
            from .permissions import capability_info

            role, _, cap = field.partition(":")
            return f"{ROLE_LABELS.get(role, role)}・{capability_info(cap)['label']}"
        return FIELD_LABELS.get(entity_type, {}).get(field, field)

    def is_long(self, entity_type: str, field: str) -> bool:
        if entity_type == "task" and field == "description":
            return True
        if field.startswith("custom."):
            p = self._prop(field)
            return p is not None and p["type"] == "text"
        return False

    def _name(self, table: dict[int, Any], v: Any, col: str, missing: str) -> str:
        try:
            r = table.get(int(v))
        except (TypeError, ValueError):
            r = None
        return r[col] if r is not None else f"{missing} #{v}"

    def value_text(self, entity_type: str, field: str, v: Any) -> str:
        if entity_type == "permission":
            return "允許" if v else "不允許"
        if field.startswith("custom."):
            return self._custom_text(field, v)
        if field == "assigneeId" and v is None:
            return "未指派"
        if field == "projectId" and v is None:
            return "全部專案" if entity_type == "property" else "（空）"
        if field in ("startDate", "dueDate") and v is None:
            return "未設定"
        if is_empty(v):
            return "（空）"
        if field in _LINK_TASK_FIELDS:
            return self._name(self.tasks(), v, "title", "任務")
        if entity_type == "relation" and field == "type":
            return "相關" if v == "related" else str(v)
        if entity_type == "dependency" and field == "lagDays":
            return f"{_fmt_number(v)} 天"
        if entity_type == "checklist" and field == "items" and isinstance(v, list):
            return "、".join(clip(x, 60) for x in v)
        if field == "statusId":
            return self._name(self.statuses(), v, "name", "已刪除的狀態")
        if field == "projectId":
            return self._name(self.projects(), v, "name", "已刪除的專案")
        if field == "assigneeId":
            return self._name(self.users(), v, "display_name", "成員")
        if field == "priority":
            return PRIORITY_LABELS.get(v, str(v))
        if field == "estimateHours":
            return f"{_fmt_number(v)} 小時"
        if field == "progress":
            return f"{_fmt_number(v)}%"
        if field == "color":
            return COLOR_LABELS.get(v, str(v))
        if field == "isArchived":
            return "已封存" if v else "未封存"
        if field == "descriptionLocked":
            return "已鎖定" if v else "未鎖定"
        if field == "isActive":
            return "啟用" if v else "停用"
        if field == "inOverview":
            return "列入" if v else "不列入"
        if field == "role":
            return ROLE_LABELS.get(v, str(v))
        if field == "category":
            return CATEGORY_LABELS.get(v, str(v))
        if field == "type" and entity_type == "property":
            return PROPERTY_TYPE_LABELS.get(v, str(v))
        if field == "options" and isinstance(v, list):
            return "、".join(str(o.get("label", "")) for o in v if isinstance(o, dict)) or "（無選項）"
        if field == "mode":
            return MODE_LABELS.get(v, str(v))
        if field == "strategy":
            return STRATEGY_LABELS.get(v, str(v))
        if isinstance(v, bool):
            return "是" if v else "否"
        if _is_number(v):
            return _fmt_number(v)
        if isinstance(v, (dict, list)):
            return json.dumps(v, ensure_ascii=False)
        return str(v)

    def _custom_text(self, field: str, v: Any) -> str:
        if is_empty(v):
            return "（空）"
        p = self._prop(field)
        if p is None:
            return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
        options = {o.get("id"): o.get("label") for o in json.loads(p["options"] or "[]") if isinstance(o, dict)}
        t = p["type"]
        if t == "select":
            return str(options.get(v, v))
        if t == "multi_select" and isinstance(v, list):
            return "、".join(str(options.get(x, x)) for x in v)
        if t == "checkbox":
            return "已勾選" if v else "未勾選"
        if t == "person":
            return self._name(self.users(), v, "display_name", "成員")
        if _is_number(v):
            return _fmt_number(v)
        return str(v)


# ── 讀取 / 序列化 ─────────────────────────────────────────

_SELECT = (
    "SELECT a.*, r.id AS revert_entry_id, r.actor_name AS reverted_by_name FROM audit_log a "
    "LEFT JOIN audit_log r ON r.id = (SELECT max(x.id) FROM audit_log x WHERE x.revert_of = a.id)"
)


def changes_of(lab: Labeler, row: Any) -> list[dict[str, Any]]:
    before, tb = load_fields(row["before_json"])
    after, ta = load_fields(row["after_json"])
    et = row["entity_type"]
    keys = list(dict.fromkeys([*(before or {}).keys(), *(after or {}).keys()]))
    out = []
    for k in keys:
        b = (before or {}).get(k)
        a = (after or {}).get(k)
        out.append(
            {
                "field": k,
                "label": lab.field_label(et, k),
                "before": b,
                "after": a,
                "beforeText": None if before is None else lab.value_text(et, k, b),
                "afterText": None if after is None else lab.value_text(et, k, a),
                "long": lab.is_long(et, k),
                "truncated": k in tb or k in ta,
            }
        )
    return out


#: 任務歷史（audit.view_task_history，預設全員可看）不回傳內容的類型：留言內容（含已刪除 / 編輯前）只在
#: 全站稽核頁（audit.view）可見，避免已刪除留言的內容仍可被一般成員讀到。docs/design/audit-log.md
CONTENT_HIDDEN_IN_TASK_HISTORY = frozenset({"comment"})


def entry_to_dict(lab: Labeler, row: Any, *, redact: bool = False) -> dict[str, Any]:
    """redact=True（任務歷史）：CONTENT_HIDDEN_IN_TASK_HISTORY 類型的紀錄不帶 changes（只留摘要句）"""
    hide = redact and row["entity_type"] in CONTENT_HIDDEN_IN_TASK_HISTORY
    return {
        "id": row["id"],
        "ts": row["ts"],
        "actorId": row["actor_id"],
        "actorName": row["actor_name"],
        "actorUsername": row["actor_username"],
        "source": row["source"],
        "entityType": row["entity_type"],
        "entityId": row["entity_id"],
        "entityLabel": row["entity_label"],
        "taskId": row["task_id"],
        "action": row["action"],
        "summary": row["summary"],
        "revertable": bool(row["revertable"]),
        "note": row["note"],
        "revertOf": row["revert_of"],
        "revertedAt": row["reverted_at"],
        "revertedBy": row["reverted_by"],
        "revertedByName": row["reverted_by_name"],
        "revertEntryId": row["revert_entry_id"],
        "changes": [] if hide else changes_of(lab, row),
    }


@dataclass
class AuditQuery:
    from_ts: int | None = None
    to_ts: int | None = None
    actor: int | None = None
    entity_type: str | None = None
    action: str | None = None
    task_id: int | None = None
    q: str | None = None
    revertable: bool | None = None
    limit: int = 50
    before: int | None = None
    #: 任務歷史：隱藏留言內容（見 CONTENT_HIDDEN_IN_TASK_HISTORY）
    redact_content: bool = False


def query_audit(conn: sqlite3.Connection, f: AuditQuery) -> dict[str, Any]:
    """游標分頁（id 由新到舊）；回傳 { items, nextBefore }"""
    conds: list[str] = []
    params: list[Any] = []
    if f.from_ts is not None:
        conds.append("a.ts >= ?")
        params.append(f.from_ts)
    if f.to_ts is not None:
        conds.append("a.ts < ?")
        params.append(f.to_ts)
    if f.actor is not None:
        conds.append("a.actor_id = ?")
        params.append(f.actor)
    if f.entity_type:
        conds.append("a.entity_type = ?")
        params.append(f.entity_type)
    if f.action:
        conds.append("a.action = ?")
        params.append(f.action)
    if f.task_id is not None:
        conds.append("a.task_id = ?")
        params.append(f.task_id)
    if f.q:
        conds.append("(instr(lower(a.summary), lower(?)) > 0 OR instr(lower(coalesce(a.entity_label, '')), lower(?)) > 0)")
        params.extend([f.q, f.q])
    if f.revertable is True:
        conds.append("a.revertable = 1 AND a.reverted_at IS NULL")
    elif f.revertable is False:
        conds.append("(a.revertable = 0 OR a.reverted_at IS NOT NULL)")
    if f.before is not None:
        conds.append("a.id < ?")
        params.append(f.before)
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    rows = conn.execute(f"{_SELECT} {where} ORDER BY a.id DESC LIMIT ?", (*params, f.limit + 1)).fetchall()
    has_more = len(rows) > f.limit
    rows = rows[: f.limit]
    lab = Labeler(conn)
    return {
        "items": [entry_to_dict(lab, r, redact=f.redact_content) for r in rows],
        "nextBefore": rows[-1]["id"] if has_more and rows else None,
    }


def get_entry(conn: sqlite3.Connection, audit_id: int) -> Any:
    return conn.execute(f"{_SELECT} WHERE a.id = ?", (audit_id,)).fetchone()


# ── 權限矩陣（權限設定的稽核與還原共用）──────────────────


def permission_cells(conn: sqlite3.Connection) -> dict[str, bool]:
    """目前有效的權限矩陣（可調整的角色 × 非受保護權限），鍵為 "role:capability" """
    from .permissions import CAPABILITIES, CONFIGURABLE_ROLES, PROTECTED_CAPABILITIES, role_can

    try:
        rows = conn.execute("SELECT role, capability, allowed FROM role_permissions").fetchall()
    except sqlite3.OperationalError:
        rows = []
    overrides = {(r["role"], r["capability"]): bool(r["allowed"]) for r in rows}
    return {
        f"{role}:{cap}": overrides.get((role, cap), role_can(role, cap))
        for role in CONFIGURABLE_ROLES
        for cap in CAPABILITIES
        if cap not in PROTECTED_CAPABILITIES
    }
