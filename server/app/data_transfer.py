"""資料匯出 / 匯入（API `/api/admin/data/*` 與 CLI `python -m server.cli export|import` 共用）。

- 匯出（export_document）：JSON「業務資料」，跨資料庫以 uid（users 以 username、GitHub 連動以 project）表示關聯，
  不含 password_hash、sessions、login_attempts、changes 流水與快取 / 快照類資料表。
  軟刪除的任務也匯出（帶 deletedAt），讓搬移後的資料與來源一致。
- 匯入分兩階段：plan_import()（預覽，不改資料）與 apply_import()（單一 transaction，任何錯誤全數回滾）。
  - 對應規則：同 uid 視為同一筆；狀態與專案在 uid 找不到時，再以「名稱完全相同且唯一」對應（讓新安裝的預設狀態 / 專案不會重複）。
  - 相同（略過）：除 createdAt / updatedAt / updatedByUsername 外所有欄位相同。
  - 衝突：兩邊都存在但內容不同。全域策略 keep_newer（預設，updatedAt 較新者為準，同時間保留本機）/ keep_local / use_import，
    可逐筆覆寫。
  - 缺少成員（匯入檔的成員在本機不存在）：skip（相關指派清空；個人清單因必須有擁有者而略過）或 create
    （建立為啟用中的一般成員、隨機臨時密碼、首次登入須改密碼；臨時密碼只在結果中回傳一次）。
  - mode=replace：先刪除本機全部業務資料（成員保留）再匯入，需輸入確認字樣。
- 任務關聯（taskRelations，0013）：不在 SPECS 中（sync-push 不同步，已知限制），兩端以任務 uid 表示；
  匯入時冪等、同一對不重複建立，對方任務不在匯入檔也不在本機時略過並記錄於 skippedRelations。
"""

from __future__ import annotations

import json
import math
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError, create_model

from .backup import integrity_check, timestamp
from .changes import record_change
from .db import Database
from .errors import pydantic_issues
from .schemas import DATE_PATTERN, TAG_COLORS

FORMAT = "tasks-sheets-export"
SCHEMA_VERSION = 1
STRATEGIES = ("keep_newer", "keep_local", "use_import")
REPLACE_CONFIRM = "取代全部資料"
#: 單一類別最多筆數（防止惡意檔案）
MAX_ITEMS = 200_000

Strategy = Literal["keep_newer", "keep_local", "use_import"]
Resolution = Literal["keep_local", "use_import"]
MissingUsers = Literal["skip", "create"]
Mode = Literal["merge", "replace"]


class TransferError(ValueError):
    """匯入檔或參數有誤（訊息可直接顯示）"""

    def __init__(self, message: str, details: Any = None):
        super().__init__(message)
        self.message = message
        self.details = details


# ── 資料類別定義 ──────────────────────────────────────────


@dataclass(frozen=True)
class F:
    """JSON 欄位 ↔ DB 欄位。kind：str / int / float / bool / options / custom / user / ref"""

    name: str
    column: str
    kind: str
    nullable: bool = False
    #: str：最大長度或允許值；ref：參照的類別 key
    extra: Any = None
    #: 匯入時缺少此欄位的預設值（Ellipsis = 必填）；供後來新增的欄位相容舊匯出檔
    default: Any = ...


@dataclass(frozen=True)
class Spec:
    key: str
    table: str
    label: str
    entity: str
    fields: tuple[F, ...]
    title: str
    #: 自然鍵：uid，或 eng_github_links 的 project（不分大小寫）
    natural: str = "uid"
    #: uid 對不到時以名稱對應（狀態、專案）
    name_fallback: bool = False


def _ts(name: str, column: str, nullable: bool = False) -> F:
    return F(name, column, "int", nullable)


_CREATED = _ts("createdAt", "created_at")
_UPDATED = _ts("updatedAt", "updated_at")

SPECS: tuple[Spec, ...] = (
    Spec(
        "statuses",
        "statuses",
        "狀態",
        "status",
        (
            F("name", "name", "str", extra=100),
            F("color", "color", "str", extra=TAG_COLORS),
            F("category", "category", "str", extra=("todo", "doing", "done")),
            F("sortOrder", "sort_order", "float"),
            _CREATED,
            _UPDATED,
        ),
        title="name",
        name_fallback=True,
    ),
    Spec(
        "projects",
        "projects",
        "專案",
        "project",
        (
            F("name", "name", "str", extra=100),
            F("color", "color", "str", extra=TAG_COLORS),
            F("isArchived", "is_archived", "bool"),
            F("sortOrder", "sort_order", "float"),
            _CREATED,
            _UPDATED,
        ),
        title="name",
        name_fallback=True,
    ),
    Spec(
        "propertyDefs",
        "property_defs",
        "自訂欄位",
        "property",
        (
            F("projectUid", "project_id", "ref", True, "projects"),
            F("name", "name", "str", extra=100),
            F(
                "type",
                "type",
                "str",
                extra=("text", "number", "select", "multi_select", "date", "checkbox", "url", "person"),
            ),
            F("options", "options", "options"),
            F("sortOrder", "sort_order", "float"),
            _CREATED,
            _UPDATED,
        ),
        title="name",
    ),
    Spec(
        "tasks",
        "tasks",
        "任務",
        "task",
        (
            F("projectUid", "project_id", "ref", extra="projects"),
            F("statusUid", "status_id", "ref", extra="statuses"),
            F("title", "title", "str", extra=500),
            F("description", "description", "str", extra=100_000),
            F("assigneeUsername", "assignee_id", "user", True),
            F("priority", "priority", "str", extra=("none", "low", "medium", "high", "urgent")),
            F("startDate", "start_date", "date", True),
            F("dueDate", "due_date", "date", True),
            F("estimateHours", "estimate_hours", "float", True),
            F("progress", "progress", "int"),
            F("sortOrder", "sort_order", "float"),
            F("custom", "custom", "custom"),
            F("createdByUsername", "created_by", "user", True),
            F("updatedByUsername", "updated_by", "user", True),
            _CREATED,
            _UPDATED,
            _ts("completedAt", "completed_at", True),
            _ts("deletedAt", "deleted_at", True),
        ),
        title="title",
    ),
    Spec(
        "feedbackItems",
        "feedback_items",
        "問題回饋",
        "feedback",
        (
            F("projectUid", "project_id", "ref", True, "projects"),
            F("kind", "kind", "str", extra=("problem", "feedback")),
            F("title", "title", "str", extra=500),
            F("body", "body", "str", extra=100_000),
            F("status", "status", "str", extra=("open", "scheduled", "resolved")),
            F("scheduledDate", "scheduled_date", "date", True),
            F("reporterUsername", "reporter_id", "user", True),
            F("assigneeUsername", "assignee_id", "user", True),
            F("updatedByUsername", "updated_by", "user", True),
            _CREATED,
            _UPDATED,
        ),
        title="title",
    ),
    Spec(
        "personalItems",
        "personal_items",
        "個人清單",
        "personal",
        (
            F("username", "user_id", "user"),
            F("title", "title", "str", extra=500),
            F("note", "note", "str", extra=100_000),
            F("isDone", "is_done", "bool"),
            F("status", "status", "str", extra=("todo", "doing", "deferred", "cancelled", "done"), default=None),
            F("dueDate", "due_date", "date", True),
            F("detail", "detail", "str", extra=100_000, default=""),
            F("doneAt", "done_at", "int", True, default=None),
            F("taskUid", "task_id", "ref", True, "tasks"),
            F("sortOrder", "sort_order", "float"),
            _CREATED,
            _UPDATED,
        ),
        title="title",
    ),
    Spec(
        "manualIssues",
        "manual_issues",
        "工程問題",
        "repo",
        (
            F("title", "title", "str", extra=500),
            F("description", "description", "str", extra=100_000),
            F("project", "project", "str", extra=200),
            # 狀態為 eng_statuses 的 key（可自訂，0011）
            F("status", "status", "str", extra=100),
            F("assigneeUsername", "assignee_id", "user", True),
            F("url", "url", "str", True, 2_000),
            F("createdByUsername", "created_by", "user", True),
            F("updatedByUsername", "updated_by", "user", True),
            F("githubRepo", "github_repo", "str", True, 200),
            F("githubNumber", "github_number", "int", True),
            F("githubState", "github_state", "str", True, 50),
            F("githubTitle", "github_title", "str", True, 1_000),
            _ts("githubSyncedAt", "github_synced_at", True),
            _CREATED,
            _UPDATED,
        ),
        title="title",
    ),
    Spec(
        "worktreeRecords",
        "worktree_records",
        "Worktree 紀錄",
        "worktree_plan",
        (
            F("machine", "machine", "str", extra=200),
            F("path", "path", "str", extra=2_000),
            F("branch", "branch", "str", extra=500),
            F("ownerUsername", "owner_id", "user", True),
            F("purpose", "purpose", "str", extra=10_000),
            F("status", "status", "str", extra=100),
            F("note", "note", "str", extra=100_000),
            F("createdByUsername", "created_by", "user", True),
            F("updatedByUsername", "updated_by", "user", True),
            _CREATED,
            _UPDATED,
            # eng-v2（0011）新增欄位：舊匯出檔沒有時用預設值
            F("machineId", "machine_id", "str", True, 64, default=None),
            F("source", "source", "str", extra=("manual", "report", "scan"), default="manual"),
            F("repo", "repo", "str", extra=200, default=""),
            F("headSha", "head_sha", "str", True, 64, default=None),
            F("deletedAt", "deleted_at", "int", True, default=None),
        ),
        title="path",
    ),
    Spec(
        "engGithubLinks",
        "eng_github_links",
        "GitHub 連動",
        "repo",
        (
            F("project", "project", "str", extra=200),
            F("githubRepo", "github_repo", "str", extra=200),
            F("updatedByUsername", "updated_by", "user", True),
            _UPDATED,
        ),
        title="project",
        natural="project",
    ),
)

SPEC_BY_KEY = {s.key: s for s in SPECS}

#: 比較內容時忽略的欄位（只代表「誰、何時」建立 / 改過）
_META_FIELDS = {"createdAt", "updatedAt", "updatedByUsername"}

FIELD_LABELS = {
    "name": "名稱",
    "color": "顏色",
    "category": "類別",
    "sortOrder": "排序",
    "isArchived": "封存",
    "projectUid": "專案",
    "statusUid": "狀態",
    "type": "型別",
    "options": "選項",
    "title": "標題",
    "description": "描述",
    "assigneeUsername": "負責人",
    "priority": "優先度",
    "startDate": "開始日",
    "dueDate": "到期日",
    "estimateHours": "預估工時",
    "progress": "進度",
    "custom": "自訂欄位",
    "createdByUsername": "建立者",
    "createdAt": "建立時間",
    "completedAt": "完成時間",
    "doneAt": "完成時間",
    "deletedAt": "刪除時間",
    "kind": "類型",
    "body": "內容",
    "status": "狀態",
    "scheduledDate": "排定日",
    "reporterUsername": "回報者",
    "username": "擁有者",
    "note": "備註",
    "isDone": "完成",
    "taskUid": "對應任務",
    "project": "專案 / Repo",
    "url": "連結",
    "githubRepo": "GitHub Repo",
    "githubNumber": "GitHub 編號",
    "githubState": "GitHub 狀態",
    "githubTitle": "GitHub 標題",
    "githubSyncedAt": "GitHub 同步時間",
    "machine": "電腦",
    "path": "路徑",
    "branch": "分支",
    "ownerUsername": "負責人",
    "purpose": "用途",
}

# ── pydantic 模型（匯入檔驗證） ─────────────────────────────

Uid = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{8,64}$")]
UsernameRef = Annotated[str, StringConstraints(min_length=1, max_length=64)]
_Int = Annotated[int, Field(ge=-(2**63), le=2**63 - 1)]
_Float = Annotated[float, Field(allow_inf_nan=False)]
_STRICT = ConfigDict(extra="forbid", strict=True)


def _py_type(f: F) -> Any:
    if f.kind == "str":
        if isinstance(f.extra, tuple):
            return Literal[f.extra]  # type: ignore[valid-type]
        return Annotated[str, StringConstraints(max_length=f.extra)]
    if f.kind == "date":
        return Annotated[str, StringConstraints(pattern=DATE_PATTERN)]
    if f.kind == "int":
        return _Int
    if f.kind == "float":
        return _Float
    if f.kind == "bool":
        return bool
    if f.kind == "options":
        return Annotated[list[dict[str, Any]], Field(max_length=1_000)]
    if f.kind == "custom":
        return Annotated[dict[str, Any], Field(max_length=1_000)]
    if f.kind == "user":
        return UsernameRef
    if f.kind == "ref":
        return Uid
    raise AssertionError(f.kind)


def _item_model(spec: Spec) -> type[BaseModel]:
    defs: dict[str, Any] = {}
    if spec.natural == "uid":
        defs["uid"] = (Uid, ...)
    for f in spec.fields:
        t = _py_type(f)
        if f.default is not ...:
            defs[f.name] = (Optional[t] if f.nullable else t, f.default)
        else:
            defs[f.name] = (Optional[t], None) if f.nullable else (t, ...)
    return create_model(f"Import_{spec.key}", __config__=_STRICT, **defs)


UserItem = create_model(
    "Import_users",
    __config__=_STRICT,
    username=(UsernameRef, ...),
    displayName=(Annotated[str, StringConstraints(max_length=100)], ...),
    # admin / member 為 0006_roles 之前的舊匯出檔；匯入建立的成員一律為 user，不沿用此值
    role=(Literal["root", "manager", "user", "admin", "member"], "user"),
    isActive=(bool, True),
    # 是否列入總覽統計；舊匯出檔沒有此欄位（匯入建立的成員為 user，預設列入）
    inOverview=(Optional[bool], None),
    createdAt=(Optional[_Int], None),
    updatedAt=(Optional[_Int], None),
)


#: 任務關聯（taskRelations）：兩端以任務 uid 表示；related 為對稱關係
RELATIONS_KEY = "taskRelations"
RELATIONS_LABEL = "任務關聯"
RelationItem = create_model(
    "Import_taskRelations",
    __config__=_STRICT,
    uid=(Uid, ...),
    taskAUid=(Uid, ...),
    taskBUid=(Uid, ...),
    type=(Literal["related"], "related"),
    createdByUsername=(Optional[UsernameRef], None),
    createdAt=(Optional[_Int], None),
    updatedAt=(Optional[_Int], None),
)


def _list_of(model: Any) -> Any:
    return (Annotated[list[model], Field(max_length=MAX_ITEMS)], [])  # type: ignore[valid-type]


ExportDoc = create_model(
    "ExportDoc",
    __config__=_STRICT,
    format=(Literal[FORMAT], ...),  # type: ignore[valid-type]
    schemaVersion=(int, ...),
    exportedAt=(_Int, ...),
    users=_list_of(UserItem),
    **{s.key: _list_of(_item_model(s)) for s in SPECS},
    #: 任務依賴（feat/delay-link；見檔尾 taskDependencies 段落）。舊匯出檔沒有時為空
    taskDependencies=(Annotated[list[dict[str, Any]], Field(max_length=MAX_ITEMS)], []),
    #: 附件清單（只有元資料，不含檔案本體；匯入時忽略——附件檔案請用完整備份帶走）
    attachments=(Annotated[list[dict[str, Any]], Field(max_length=MAX_ITEMS)], []),
    #: 任務關聯（0013；不在 SPECS 中，sync-push 不同步）。舊匯出檔沒有此鍵時為空
    taskRelations=(Annotated[list[RelationItem], Field(max_length=MAX_ITEMS)], []),  # type: ignore[valid-type]
)


def parse_document(raw: bytes | str | dict[str, Any]) -> dict[str, Any]:
    """驗證匯入檔（JSON 文字或已解析的 dict），回傳正規化後的 dict；有誤時拋 TransferError"""
    if isinstance(raw, dict):
        obj: Any = raw
    else:
        try:
            obj = json.loads(raw)
        except (ValueError, RecursionError, UnicodeDecodeError):
            raise TransferError("檔案不是有效的 JSON") from None
    if not isinstance(obj, dict) or obj.get("format") != FORMAT:
        raise TransferError("這不是 TasksSheets 的匯出檔（缺少 format: tasks-sheets-export）")
    version = obj.get("schemaVersion")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise TransferError("匯出檔的 schemaVersion 無效")
    if version > SCHEMA_VERSION:
        raise TransferError(
            f"此檔案由較新版本匯出（schemaVersion {version}），目前系統只支援到 {SCHEMA_VERSION}，請先更新系統後再匯入"
        )
    try:
        doc = ExportDoc.model_validate(obj).model_dump()
    except ValidationError as e:
        raise TransferError("匯出檔內容驗證失敗", pydantic_issues(e)[:50]) from None
    except RecursionError:
        raise TransferError("匯出檔結構過深") from None
    for p in doc["personalItems"]:
        # 舊匯出檔沒有 status：由 isDone 推得；同時保持 status 與 isDone 一致
        if p["status"] is None:
            p["status"] = "done" if p["isDone"] else "todo"
        p["isDone"] = p["status"] == "done"
        # doneAt：缺漏時 done 的待辦以 updatedAt 推得；非 done 一律為 null
        if p["isDone"] and p.get("doneAt") is None and p["taskUid"] is None:
            p["doneAt"] = p["updatedAt"]
        elif not p["isDone"]:
            p["doneAt"] = None
    _check_integrity(doc)
    doc[DEP_KEY] = _parse_dependencies(doc.get(DEP_KEY) or [])
    return doc


def _check_integrity(doc: dict[str, Any]) -> None:
    """同類別內 uid / 自然鍵不可重複；uid 參照必須指向檔案內存在的資料"""
    issues: list[str] = []
    keys: dict[str, set[str]] = {}
    for spec in SPECS:
        seen: set[str] = set()
        for item in doc[spec.key]:
            k = _natural_key(spec, item)
            if k in seen:
                issues.append(f"{spec.label}：識別碼重複（{k}）")
            seen.add(k)
        keys[spec.key] = seen
    seen_users: set[str] = set()
    for u in doc["users"]:
        if u["username"] in seen_users:
            issues.append(f"成員：帳號重複（{u['username']}）")
        seen_users.add(u["username"])
    for spec in SPECS:
        for f in spec.fields:
            if f.kind != "ref":
                continue
            for item in doc[spec.key]:
                v = item[f.name]
                if v is not None and v not in keys[f.extra]:
                    issues.append(f"{spec.label}「{item[spec.title]}」的 {f.name} 指向不存在的資料（{v}）")
    if issues:
        raise TransferError("匯出檔的資料關聯不一致", issues[:50])


def _natural_key(spec: Spec, item: dict[str, Any]) -> str:
    return item["uid"] if spec.natural == "uid" else str(item[spec.natural]).lower()


# ── 本機索引與匯出 ──────────────────────────────────────────


@dataclass
class LocalIndex:
    """本機資料：id ↔ uid / username 對照"""

    user_by_id: dict[int, str]
    user_id: dict[str, int]
    rows: dict[str, list[sqlite3.Row]]
    uid_by_id: dict[str, dict[int, str]]
    #: property id → (uid, type)
    props: dict[int, tuple[str, str]]


def _index(conn: sqlite3.Connection) -> LocalIndex:
    users = conn.execute("SELECT id, username FROM users").fetchall()
    rows: dict[str, list[sqlite3.Row]] = {}
    uid_by_id: dict[str, dict[int, str]] = {}
    for spec in SPECS:
        rs = conn.execute(f"SELECT * FROM {spec.table} ORDER BY id").fetchall()
        rows[spec.key] = rs
        if spec.natural == "uid":
            uid_by_id[spec.key] = {r["id"]: r["uid"] for r in rs}
    props = {r["id"]: (r["uid"], r["type"]) for r in rows["propertyDefs"]}
    return LocalIndex(
        user_by_id={u["id"]: u["username"] for u in users},
        user_id={u["username"]: u["id"] for u in users},
        rows=rows,
        uid_by_id=uid_by_id,
        props=props,
    )


def _export_custom(raw: str, idx: LocalIndex) -> dict[str, Any]:
    try:
        custom = json.loads(raw or "{}")
    except ValueError:
        return {}
    out: dict[str, Any] = {}
    for key, value in custom.items() if isinstance(custom, dict) else ():
        try:
            prop = idx.props.get(int(key))
        except ValueError:
            prop = None
        if prop is None:
            continue  # 已刪除的自訂欄位：讀取時本來就忽略
        if prop[1] == "person":
            name = idx.user_by_id.get(value) if isinstance(value, int) else None
            if name is None:
                continue
            value = name
        out[prop[0]] = value
    return out


def _export_row(spec: Spec, row: sqlite3.Row, idx: LocalIndex) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if spec.natural == "uid":
        out["uid"] = row["uid"]
    for f in spec.fields:
        v = row[f.column]
        if f.kind == "bool":
            v = bool(v)
        elif f.kind == "options":
            v = json.loads(v) if v else []
        elif f.kind == "custom":
            v = _export_custom(v, idx)
        elif f.kind == "user":
            v = None if v is None else idx.user_by_id.get(v)
        elif f.kind == "ref":
            v = None if v is None else idx.uid_by_id[f.extra].get(v)
        elif f.kind == "float" and v is not None:
            v = float(v)
        out[f.name] = v
    return out


def export_document(db: Database, now: int) -> dict[str, Any]:
    """匯出全部業務資料（一致的快照）"""
    with db.tx() as conn:
        idx = _index(conn)
        users = conn.execute(
            "SELECT username, display_name, role, is_active, in_overview, created_at, updated_at FROM users ORDER BY id"
        ).fetchall()
        doc: dict[str, Any] = {
            "format": FORMAT,
            "schemaVersion": SCHEMA_VERSION,
            "exportedAt": now,
            "users": [
                {
                    "username": u["username"],
                    "displayName": u["display_name"],
                    "role": u["role"],
                    "isActive": bool(u["is_active"]),
                    "inOverview": bool(u["in_overview"]),
                    "createdAt": u["created_at"],
                    "updatedAt": u["updated_at"],
                }
                for u in users
            ],
        }
        for spec in SPECS:
            doc[spec.key] = [_export_row(spec, r, idx) for r in idx.rows[spec.key]]
        doc["attachments"] = _export_attachments(conn, idx)
        doc[RELATIONS_KEY] = _export_relations(conn, idx)
        doc[DEP_KEY] = _export_dependencies(conn, idx)
    return doc


def _export_relations(conn: sqlite3.Connection, idx: LocalIndex) -> list[dict[str, Any]]:
    """任務關聯：兩端以任務 uid 表示（含軟刪除任務的關聯，與任務一併匯出）"""
    task_uid = idx.uid_by_id["tasks"]
    out = []
    for r in conn.execute("SELECT * FROM task_relations ORDER BY id"):
        a, b = task_uid.get(r["task_a_id"]), task_uid.get(r["task_b_id"])
        if a is None or b is None:
            continue
        out.append(
            {
                "uid": r["uid"],
                "taskAUid": a,
                "taskBUid": b,
                "type": r["type"],
                "createdByUsername": idx.user_by_id.get(r["created_by"]) if r["created_by"] else None,
                "createdAt": r["created_at"],
                "updatedAt": r["updated_at"],
            }
        )
    return out


def _export_attachments(conn: sqlite3.Connection, idx: LocalIndex) -> list[dict[str, Any]]:
    """附件元資料（不含檔案本體）：所屬項目以 uid 表示"""
    owners = {"manual_issue": idx.uid_by_id["manualIssues"]}
    out = []
    for r in conn.execute("SELECT * FROM attachments ORDER BY id"):
        owner = owners.get(r["entity_type"], {}).get(r["entity_id"])
        out.append(
            {
                "uid": r["uid"],
                "entityType": r["entity_type"],
                "entityUid": owner,
                "name": r["original_name"],
                "mime": r["mime"],
                "size": r["size"],
                "sha256": r["sha256"],
                "uploadedByUsername": idx.user_by_id.get(r["uploaded_by"]) if r["uploaded_by"] else None,
                "createdAt": r["created_at"],
            }
        )
    return out


def export_filename(prefix: str, ext: str, d: datetime | None = None) -> str:
    return f"{prefix}-{timestamp(d)}.{ext}"


# ── 匯入計畫 ────────────────────────────────────────────────


@dataclass
class ItemPlan:
    spec: Spec
    item: dict[str, Any]
    key: str
    action: str  # new / same / conflict / skip
    local: sqlite3.Row | None = None
    local_view: dict[str, Any] | None = None
    diff: list[str] = field(default_factory=list)
    reason: str | None = None


@dataclass
class Plan:
    items: list[ItemPlan]
    missing_users: list[dict[str, Any]]
    local_counts: dict[str, int]
    #: 任務關聯的預覽統計（new / same / skip / total / local）
    relations: dict[str, Any] = field(default_factory=dict)
    #: 任務依賴的預覽統計（new / same / conflict；不列入逐筆衝突清單）
    dependencies: dict[str, int] = field(default_factory=dict)


def _relation_end(uid: str, local_task_ids: dict[str, int], file_task_uids: set[str]) -> str | None:
    """關聯一端：本機已有（local）/ 只在匯入檔（file）/ 都沒有（None）"""
    if uid in local_task_ids:
        return "local"
    if uid in file_task_uids:
        return "file"
    return None


def plan_relations(conn: sqlite3.Connection, doc: dict[str, Any]) -> dict[str, Any]:
    """任務關聯預覽：兩端都在本機且本機已有同一對關聯 → same；任一端兩邊都找不到 → skip；其餘 new"""
    local_task_ids = {r["uid"]: r["id"] for r in conn.execute("SELECT id, uid FROM tasks")}
    file_task_uids = {t["uid"] for t in doc["tasks"]}
    local_pairs = {
        (r["task_a_id"], r["task_b_id"], r["type"])
        for r in conn.execute("SELECT task_a_id, task_b_id, type FROM task_relations")
    }
    local_uids = {r[0] for r in conn.execute("SELECT uid FROM task_relations")}
    stats = {"new": 0, "same": 0, "skip": 0}
    seen: set[tuple[str, str, str]] = set()
    for rel in doc[RELATIONS_KEY]:
        ends = [_relation_end(u, local_task_ids, file_task_uids) for u in (rel["taskAUid"], rel["taskBUid"])]
        if None in ends or rel["taskAUid"] == rel["taskBUid"]:
            stats["skip"] += 1
            continue
        key = (*sorted((rel["taskAUid"], rel["taskBUid"])), rel["type"])
        if key in seen:
            stats["same"] += 1
            continue
        seen.add(key)  # type: ignore[arg-type]
        if rel["uid"] in local_uids:
            stats["same"] += 1
        elif ends == ["local", "local"]:
            a, b = sorted((local_task_ids[rel["taskAUid"]], local_task_ids[rel["taskBUid"]]))
            stats["same" if (a, b, rel["type"]) in local_pairs else "new"] += 1
        else:
            stats["new"] += 1
    return {**stats, "total": len(doc[RELATIONS_KEY]), "local": len(local_uids)}


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, float) or isinstance(b, float):
        try:
            return a is not None and b is not None and math.isclose(float(a), float(b), rel_tol=0, abs_tol=1e-9)
        except (TypeError, ValueError):
            return False
    return a == b


def _diff(spec: Spec, local: dict[str, Any], incoming: dict[str, Any]) -> list[str]:
    return [
        f.name
        for f in spec.fields
        if f.name not in _META_FIELDS and not _same(local.get(f.name), incoming.get(f.name))
    ]


def _referenced_usernames(doc: dict[str, Any]) -> dict[str, int]:
    """匯入檔中引用到的帳號 → 引用次數（含自訂欄位的 person 值）"""
    counts: dict[str, int] = {}
    person_props = {p["uid"] for p in doc["propertyDefs"] if p["type"] == "person"}
    for spec in SPECS:
        for item in doc[spec.key]:
            for f in spec.fields:
                if f.kind == "user" and item[f.name] is not None:
                    counts[item[f.name]] = counts.get(item[f.name], 0) + 1
            if spec.key == "tasks":
                for k, v in item["custom"].items():
                    if k in person_props and isinstance(v, str):
                        counts[v] = counts.get(v, 0) + 1
    return counts


def plan_import(conn: sqlite3.Connection, doc: dict[str, Any]) -> Plan:
    idx = _index(conn)
    items: list[ItemPlan] = []
    for spec in SPECS:
        local_rows = idx.rows[spec.key]
        by_key = {
            (r["uid"] if spec.natural == "uid" else str(r[spec.natural]).lower()): r for r in local_rows
        }
        incoming = doc[spec.key]
        matched: dict[int, sqlite3.Row] = {}
        claimed: set[int] = set()
        for i, item in enumerate(incoming):
            r = by_key.get(_natural_key(spec, item))
            if r is not None:
                matched[i] = r
                claimed.add(r["id"])
        if spec.name_fallback:
            by_name: dict[str, list[sqlite3.Row]] = {}
            for r in local_rows:
                if r["id"] not in claimed:
                    by_name.setdefault(r["name"], []).append(r)
            for i, item in enumerate(incoming):
                if i in matched:
                    continue
                cands = [r for r in by_name.get(item["name"], []) if r["id"] not in claimed]
                if len(cands) == 1:
                    matched[i] = cands[0]
                    claimed.add(cands[0]["id"])
        for i, item in enumerate(incoming):
            key = f"{spec.key}:{_natural_key(spec, item)}"
            r = matched.get(i)
            if r is None:
                items.append(ItemPlan(spec, item, key, "new"))
                continue
            view = _export_row(spec, r, idx)
            diff = _diff(spec, view, item)
            items.append(ItemPlan(spec, item, key, "conflict" if diff else "same", r, view, diff))

    refs = _referenced_usernames(doc)
    names = {u["username"]: u["displayName"] for u in doc["users"]}
    missing = []
    for username in sorted(set(refs) | set(names)):
        if username not in idx.user_id:
            missing.append(
                {"username": username, "displayName": names.get(username) or username, "references": refs.get(username, 0)}
            )
    local_counts = {spec.key: len(idx.rows[spec.key]) for spec in SPECS}
    return Plan(
        items,
        missing,
        local_counts,
        relations=plan_relations(conn, doc),
        dependencies=_plan_dependencies(conn, doc, idx),
    )


def _clip(v: Any, n: int = 200) -> Any:
    if isinstance(v, str) and len(v) > n:
        return v[:n] + "…"
    if isinstance(v, (dict, list)):
        s = json.dumps(v, ensure_ascii=False)
        return s if len(s) <= n else s[:n] + "…"
    return v


def newer_side(local_updated: int | None, import_updated: int | None) -> str:
    lu, iu = local_updated or 0, import_updated or 0
    return "import" if iu > lu else "local" if lu > iu else "same"


def _relations_category(rel: dict[str, Any]) -> dict[str, Any]:
    """任務關聯的預覽統計列（與其他類別同格式；skip 為兩端任務都找不到而將略過的筆數）"""
    return {
        "key": RELATIONS_KEY,
        "label": RELATIONS_LABEL,
        "new": rel.get("new", 0),
        "same": rel.get("same", 0),
        "conflict": 0,
        "skip": rel.get("skip", 0),
        "total": rel.get("total", 0),
        "local": rel.get("local", 0),
    }


def preview_summary(plan: Plan, doc: dict[str, Any]) -> dict[str, Any]:
    """預覽回應：逐類別統計、衝突清單（含雙方 updatedAt 與差異欄位）、缺少成員"""
    stats = {s.key: {"key": s.key, "label": s.label, "new": 0, "same": 0, "conflict": 0} for s in SPECS}
    conflicts = []
    for p in plan.items:
        stats[p.spec.key][p.action] += 1
        if p.action != "conflict":
            continue
        assert p.local_view is not None
        lu, iu = p.local_view.get("updatedAt"), p.item.get("updatedAt")
        conflicts.append(
            {
                "key": p.key,
                "category": p.spec.key,
                "categoryLabel": p.spec.label,
                "title": str(p.item[p.spec.title]),
                "localUpdatedAt": lu,
                "importUpdatedAt": iu,
                "newer": newer_side(lu, iu),
                "fields": [
                    {
                        "name": n,
                        "label": FIELD_LABELS.get(n, n),
                        "local": _clip(p.local_view.get(n)),
                        "import": _clip(p.item.get(n)),
                    }
                    for n in p.diff
                ],
            }
        )
    missing_names = {m["username"] for m in plan.missing_users}
    existing_users = sum(1 for u in doc["users"] if u["username"] not in missing_names)
    return {
        "file": {"schemaVersion": doc["schemaVersion"], "exportedAt": doc["exportedAt"]},
        "categories": [
            {**stats[s.key], "total": len(doc[s.key]), "local": plan.local_counts[s.key]} for s in SPECS
        ]
        + [_relations_category(plan.relations), _dependency_preview(plan, doc)],
        "users": {"total": len(doc["users"]), "existing": existing_users, "missing": len(plan.missing_users)},
        "conflicts": conflicts,
        "missingUsers": plan.missing_users,
    }


# ── 套用 ────────────────────────────────────────────────────


@dataclass
class ApplyOptions:
    strategy: Strategy = "keep_newer"
    overrides: dict[str, Resolution] = field(default_factory=dict)
    missing_users: MissingUsers = "skip"
    mode: Mode = "merge"
    confirm: str | None = None


def resolve(strategy: Strategy, override: Resolution | None, local_updated: Any, import_updated: Any) -> Resolution:
    if override:
        return override
    if strategy == "keep_newer":
        return "use_import" if newer_side(local_updated, import_updated) == "import" else "keep_local"
    return strategy


def snapshot(db: Database, out_dir: str | Path, label: str) -> Path:
    """VACUUM INTO 產生一致的單檔快照（服務運行中可執行）。檔名：<db>-<label>-<時間>.db"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stem = Path(db.path).stem if db.path != ":memory:" else "memory"
    ts = timestamp()
    file = out / f"{stem}-{label}-{ts}.db"
    i = 2
    while file.exists():
        file = out / f"{stem}-{label}-{ts}-{i}.db"
        i += 1
    partial = file.with_name(file.name + ".partial")
    partial.unlink(missing_ok=True)
    try:
        with db.lock:
            db.conn.execute("VACUUM INTO ?", (str(partial),))
        integrity_check(partial, to_single_file=True)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    partial.replace(file)
    return file


_BUSINESS_DELETE_ORDER = (
    "personalItems",
    "feedbackItems",
    "tasks",
    "propertyDefs",
    "projects",
    "statuses",
    "manualIssues",
    "worktreeRecords",
    "engGithubLinks",
)


class _Writer:
    def __init__(self, conn: sqlite3.Connection, doc: dict[str, Any], actor_id: int | None, now: int):
        self.conn = conn
        self.doc = doc
        self.actor = actor_id
        self.now = now
        self.user_id = {r["username"]: r["id"] for r in conn.execute("SELECT id, username FROM users")}
        #: 類別 → 匯入 uid → 本機 id
        self.maps: dict[str, dict[str, int]] = {s.key: {} for s in SPECS}
        self.prop_types = {p["uid"]: p["type"] for p in doc["propertyDefs"]}

    def custom(self, value: dict[str, Any]) -> str:
        out: dict[str, Any] = {}
        for puid, v in value.items():
            pid = self.maps["propertyDefs"].get(puid)
            if pid is None:
                continue
            if self.prop_types.get(puid) == "person":
                uid = self.user_id.get(v) if isinstance(v, str) else None
                if uid is None:
                    continue
                v = uid
            out[str(pid)] = v
        return json.dumps(out, ensure_ascii=False)

    def columns(self, spec: Spec, item: dict[str, Any]) -> dict[str, Any] | None:
        """匯入資料 → DB 欄位；必要的成員不存在時回傳 None（略過此筆）"""
        cols: dict[str, Any] = {}
        for f in spec.fields:
            v = item[f.name]
            if f.kind == "user":
                if v is not None:
                    v = self.user_id.get(v)
                    if v is None and not f.nullable:
                        return None
            elif f.kind == "ref":
                if v is not None:
                    ref = self.maps[f.extra].get(v)
                    if ref is None:
                        raise TransferError(f"{spec.label}「{item[spec.title]}」參照的資料不存在")
                    v = ref
            elif f.kind == "bool":
                v = 1 if v else 0
            elif f.kind == "options":
                v = json.dumps(v, ensure_ascii=False)
            elif f.kind == "custom":
                v = self.custom(v)
            cols[f.column] = v
        return cols

    def personal_clash(self, cols: dict[str, Any], own_id: int | None) -> bool:
        if cols.get("task_id") is None:
            return False
        r = self.conn.execute(
            "SELECT id FROM personal_items WHERE user_id = ? AND task_id = ?", (cols["user_id"], cols["task_id"])
        ).fetchone()
        return r is not None and r["id"] != own_id

    def insert(self, spec: Spec, item: dict[str, Any]) -> int | None:
        cols = self.columns(spec, item)
        if cols is None or (spec.key == "personalItems" and self.personal_clash(cols, None)):
            return None
        if spec.natural == "uid":
            cols["uid"] = item["uid"]
        cur = self.conn.execute(
            f"INSERT INTO {spec.table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
            tuple(cols.values()),
        )
        new_id = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(self.conn, spec.entity, new_id, "create", self.actor, self.now)  # type: ignore[arg-type]
        return new_id

    def update(self, spec: Spec, item: dict[str, Any], local_id: int) -> bool:
        cols = self.columns(spec, item)
        if cols is None or (spec.key == "personalItems" and self.personal_clash(cols, local_id)):
            return False
        self.conn.execute(
            f"UPDATE {spec.table} SET {', '.join(f'{c} = ?' for c in cols)} WHERE id = ?",
            (*cols.values(), local_id),
        )
        record_change(self.conn, spec.entity, local_id, "update", self.actor, self.now)  # type: ignore[arg-type]
        return True


def _create_missing_users(w: _Writer, missing: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from .features.admin import generate_temp_password
    from .security import hash_password

    created = []
    for m in missing:
        temp = generate_temp_password()
        cur = w.conn.execute(
            "INSERT INTO users (username, display_name, password_hash, role, is_active, must_change_password, "
            "created_at, updated_at) VALUES (?, ?, ?, 'user', 1, 1, ?, ?)",
            (m["username"], (m["displayName"] or m["username"])[:100], hash_password(temp), w.now, w.now),
        )
        uid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(w.conn, "user", uid, "create", w.actor, w.now)
        w.user_id[m["username"]] = uid
        created.append({"username": m["username"], "displayName": m["displayName"], "tempPassword": temp})
    return created


def check_options(opts: ApplyOptions) -> None:
    if opts.mode == "replace" and (opts.confirm or "").strip() != REPLACE_CONFIRM:
        raise TransferError(f"取代模式需輸入確認字樣「{REPLACE_CONFIRM}」")


def apply_import(
    db: Database,
    doc: dict[str, Any],
    opts: ApplyOptions,
    *,
    actor_id: int | None,
    now: int,
    backup_dir: str | Path | None,
) -> dict[str, Any]:
    """套用匯入：先自動備份（backup_dir 為 None 時略過），再於單一 transaction 內寫入；任何錯誤全數回滾"""
    check_options(opts)
    with db.lock:
        backup_file = snapshot(db, backup_dir, "pre-import") if backup_dir is not None else None
        with db.tx() as conn:
            result = _apply_in_tx(conn, doc, opts, actor_id, now)
    result["backupFile"] = backup_file.name if backup_file else None
    result["backupPath"] = str(backup_file) if backup_file else None
    return result


def _apply_relations(w: _Writer, s: dict[str, Any]) -> list[str]:
    """套用任務關聯（任務已寫入後）：冪等、不重複；對方任務不在匯入檔也不在本機時略過並記錄。
    不改動兩端任務的 updatedAt（避免匯入後內容與來源不同），但寫一筆 task update 變更讓畫面重抓。"""
    local_task_ids = {r["uid"]: r["id"] for r in w.conn.execute("SELECT id, uid FROM tasks")}
    task_ids = {**local_task_ids, **w.maps["tasks"]}
    skipped: list[str] = []
    for rel in w.doc[RELATIONS_KEY]:
        x, y = task_ids.get(rel["taskAUid"]), task_ids.get(rel["taskBUid"])
        if x is None or y is None or x == y:
            s["skipped"] += 1
            missing = [u for u in (rel["taskAUid"], rel["taskBUid"]) if u not in task_ids]
            skipped.append(
                f"關聯 {rel['uid']}：找不到任務 {', '.join(missing)}" if missing else f"關聯 {rel['uid']}：兩端為同一任務"
            )
            continue
        a, b = (x, y) if x < y else (y, x)
        exists = w.conn.execute(
            "SELECT 1 FROM task_relations WHERE (task_a_id = ? AND task_b_id = ? AND type = ?) OR uid = ?",
            (a, b, rel["type"], rel["uid"]),
        ).fetchone()
        if exists:
            s["unchanged"] += 1
            continue
        created_by = w.user_id.get(rel["createdByUsername"]) if rel["createdByUsername"] else None
        created_at = rel["createdAt"] if rel["createdAt"] is not None else w.now
        updated_at = rel["updatedAt"] if rel["updatedAt"] is not None else created_at
        w.conn.execute(
            "INSERT INTO task_relations (uid, task_a_id, task_b_id, type, created_by, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (rel["uid"], a, b, rel["type"], created_by, created_at, updated_at),
        )
        s["created"] += 1
        for tid in (a, b):
            record_change(w.conn, "task", tid, "update", w.actor, w.now)
    return skipped[:50]


def _apply_in_tx(
    conn: sqlite3.Connection, doc: dict[str, Any], opts: ApplyOptions, actor_id: int | None, now: int
) -> dict[str, Any]:
    stats = {
        s.key: {"key": s.key, "label": s.label, "created": 0, "updated": 0, "unchanged": 0, "skipped": 0, "deleted": 0}
        for s in SPECS
    }
    rel_stats = {
        "key": RELATIONS_KEY,
        "label": RELATIONS_LABEL,
        "created": 0,
        "updated": 0,
        "unchanged": 0,
        "skipped": 0,
        "deleted": 0,
    }
    dep_stats = _dependency_stats()
    if opts.mode == "replace":
        rel_stats["deleted"] = conn.execute("DELETE FROM task_relations").rowcount
        # 任務刪除時依賴關係由外鍵 ON DELETE CASCADE 一併刪除；先記下筆數
        dep_stats["deleted"] = conn.execute("SELECT count(*) FROM task_dependencies").fetchone()[0]
        for key in _BUSINESS_DELETE_ORDER:
            spec = SPEC_BY_KEY[key]
            ids = [r[0] for r in conn.execute(f"SELECT id FROM {spec.table}")]
            conn.execute(f"DELETE FROM {spec.table}")
            for i in ids:
                record_change(conn, spec.entity, i, "delete", actor_id, now)  # type: ignore[arg-type]
            stats[key]["deleted"] = len(ids)

    plan = plan_import(conn, doc)
    w = _Writer(conn, doc, actor_id, now)
    created_users = _create_missing_users(w, plan.missing_users) if opts.missing_users == "create" else []

    for p in plan.items:
        s = stats[p.spec.key]
        uid_key = _natural_key(p.spec, p.item)
        if p.action == "new":
            new_id = w.insert(p.spec, p.item)
            if new_id is None:
                s["skipped"] += 1
            else:
                s["created"] += 1
                w.maps[p.spec.key][uid_key] = new_id
            continue
        assert p.local is not None
        w.maps[p.spec.key][uid_key] = p.local["id"]
        if p.action == "same":
            s["unchanged"] += 1
            continue
        choice = resolve(
            opts.strategy,
            opts.overrides.get(p.key),
            p.local_view.get("updatedAt") if p.local_view else None,
            p.item.get("updatedAt"),
        )
        if choice == "keep_local":
            s["unchanged"] += 1
        elif w.update(p.spec, p.item, p.local["id"]):
            s["updated"] += 1
        else:
            s["skipped"] += 1

    skipped_relations = _apply_relations(w, rel_stats)
    dep_issues = _apply_dependencies(w, doc, opts, dep_stats)

    return {
        "mode": opts.mode,
        "strategy": opts.strategy,
        "categories": [stats[s.key] for s in SPECS] + [rel_stats, dep_stats],
        "skippedRelations": skipped_relations,
        "dependencyIssues": dep_issues,
        "createdUsers": created_users,
        "missingUsersSkipped": [m["username"] for m in plan.missing_users] if opts.missing_users == "skip" else [],
    }



# ── 任務依賴（feat/delay-link）──────────────────────────────
# 不放進 SPECS：多台電腦同步（sync_push）沿用 SPECS，依賴目前不同步（見 docs/design/delay-link.md 已知限制）。
# 以兩端任務的 uid 表示；冪等（同 uid 或同一對任務視為同一筆）；會形成循環或任務不存在時略過並記錄。

DEP_KEY = "taskDependencies"
DEP_LABEL = "任務依賴"

DependencyItem = create_model(
    "Import_taskDependencies",
    __config__=_STRICT,
    uid=(Uid, ...),
    blockerTaskUid=(Uid, ...),
    blockedTaskUid=(Uid, ...),
    type=(Literal["finish_to_start"], "finish_to_start"),
    lagDays=(Annotated[int, Field(ge=0, le=365)], 0),
    note=(Annotated[str, StringConstraints(max_length=500)], ""),
    createdByUsername=(Optional[UsernameRef], None),
    createdAt=(Optional[_Int], None),
    updatedAt=(Optional[_Int], None),
)


def _parse_dependencies(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    seen: set[str] = set()
    issues: list[Any] = []
    for i, raw in enumerate(items):
        try:
            item = DependencyItem.model_validate(raw).model_dump()
        except ValidationError as e:
            issues.extend({**x, "path": [DEP_KEY, i, *x["path"]]} for x in pydantic_issues(e))
            continue
        if item["uid"] in seen:
            issues.append({"path": [DEP_KEY, i], "message": f"{DEP_LABEL}：識別碼重複（{item['uid']}）"})
        seen.add(item["uid"])
        out.append(item)
    if issues:
        raise TransferError("匯出檔內容驗證失敗", issues[:50])
    return out


def _export_dependencies(conn: sqlite3.Connection, idx: LocalIndex) -> list[dict[str, Any]]:
    task_uid = idx.uid_by_id["tasks"]
    out = []
    for r in conn.execute("SELECT * FROM task_dependencies ORDER BY id"):
        out.append(
            {
                "uid": r["uid"],
                "blockerTaskUid": task_uid.get(r["blocker_task_id"]),
                "blockedTaskUid": task_uid.get(r["blocked_task_id"]),
                "type": r["type"],
                "lagDays": r["lag_days"],
                "note": r["note"],
                "createdByUsername": idx.user_by_id.get(r["created_by"]) if r["created_by"] else None,
                "createdAt": r["created_at"],
                "updatedAt": r["updated_at"],
            }
        )
    return out


def _dependency_stats() -> dict[str, Any]:
    return {"key": DEP_KEY, "label": DEP_LABEL, "created": 0, "updated": 0, "unchanged": 0, "skipped": 0, "deleted": 0}


def _plan_dependencies(conn: sqlite3.Connection, doc: dict[str, Any], idx: LocalIndex) -> dict[str, int]:
    """預覽：同 uid 且 lagDays / note 相同為 same，不同為 conflict，其餘為 new"""
    local = {r["uid"]: r for r in conn.execute("SELECT uid, lag_days, note FROM task_dependencies")}
    stats = {"new": 0, "same": 0, "conflict": 0, "local": len(local)}
    for item in doc.get(DEP_KEY) or []:
        r = local.get(item["uid"])
        if r is None:
            stats["new"] += 1
        elif r["lag_days"] == item["lagDays"] and r["note"] == item["note"]:
            stats["same"] += 1
        else:
            stats["conflict"] += 1
    return stats


def _dependency_preview(plan: Plan, doc: dict[str, Any]) -> dict[str, Any]:
    d = plan.dependencies
    return {
        "key": DEP_KEY,
        "label": DEP_LABEL,
        "new": d.get("new", 0),
        "same": d.get("same", 0),
        "conflict": d.get("conflict", 0),
        "total": len(doc.get(DEP_KEY) or []),
        "local": d.get("local", 0),
    }


def _apply_dependencies(w: _Writer, doc: dict[str, Any], opts: ApplyOptions, stats: dict[str, Any]) -> list[str]:
    """在任務套用完成後寫入依賴；回傳略過原因（例如會形成循環）"""
    from .dependency_calc import find_cycle

    conn = w.conn
    issues: list[str] = []
    local_task = {r["uid"]: r["id"] for r in conn.execute("SELECT id, uid FROM tasks")}
    titles = {r["id"]: r["title"] for r in conn.execute("SELECT id, title FROM tasks")}

    def task_id(uid: str) -> int | None:
        return w.maps["tasks"].get(uid) or local_task.get(uid)

    for item in doc.get(DEP_KEY) or []:
        blocker, blocked = task_id(item["blockerTaskUid"]), task_id(item["blockedTaskUid"])
        if blocker is None or blocked is None or blocker == blocked:
            stats["skipped"] += 1
            issues.append(f"{DEP_LABEL}（{item['uid']}）：對應的任務不存在，已略過")
            continue
        existing = conn.execute(
            "SELECT * FROM task_dependencies WHERE uid = ? OR (blocker_task_id = ? AND blocked_task_id = ?)",
            (item["uid"], blocker, blocked),
        ).fetchone()
        if existing is not None:
            same_pair = existing["blocker_task_id"] == blocker and existing["blocked_task_id"] == blocked
            same = same_pair and existing["lag_days"] == item["lagDays"] and existing["note"] == item["note"]
            choice = resolve(opts.strategy, None, existing["updated_at"], item["updatedAt"])
            if same or choice == "keep_local" or not same_pair:
                stats["unchanged"] += 1
                continue
            conn.execute(
                "UPDATE task_dependencies SET lag_days = ?, note = ?, updated_at = ? WHERE id = ?",
                (item["lagDays"], item["note"], item["updatedAt"] or w.now, existing["id"]),
            )
            record_change(conn, "task", blocked, "update", w.actor, w.now)
            stats["updated"] += 1
            continue
        pairs = [(r[0], r[1]) for r in conn.execute("SELECT blocker_task_id, blocked_task_id FROM task_dependencies")]
        cycle = find_cycle(pairs, blocker, blocked)
        if cycle is not None:
            stats["skipped"] += 1
            names = " → ".join(f"「{titles.get(i, i)}」" for i in cycle)
            issues.append(f"{DEP_LABEL}：{names} 會形成循環，已略過")
            continue
        created_by = w.user_id.get(item["createdByUsername"]) if item["createdByUsername"] else None
        conn.execute(
            "INSERT INTO task_dependencies (uid, blocker_task_id, blocked_task_id, type, lag_days, note, created_by, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                item["uid"],
                blocker,
                blocked,
                item["type"],
                item["lagDays"],
                item["note"],
                created_by,
                item["createdAt"] or w.now,
                item["updatedAt"] or w.now,
            ),
        )
        record_change(conn, "task", blocked, "update", w.actor, w.now)
        stats["created"] += 1
    return issues