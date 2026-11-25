"""資料匯出 / 匯入的類別定義（data_transfer.py 與 sync_push.py 共用）。

每個 Spec 描述一種業務資料：JSON 鍵、資料表、顯示名稱、欄位對應（F）與自然鍵。
FIELD_LABELS 是預覽 / 衝突畫面用的欄位中文名稱。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .schemas import TAG_COLORS


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


def _ts_default(name: str, column: str) -> F:
    """後來新增、可為 null 的時間欄位（舊匯出檔沒有時為 None）"""
    return F(name, column, "int", True, default=None)


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
            # 描述鎖定（0017）：舊匯出檔沒有時視為未鎖定
            F("descriptionLocked", "description_locked", "bool", default=False),
            F("lockedByUsername", "locked_by", "user", True, default=None),
            _ts_default("lockedAt", "locked_at"),
        ),
        title="title",
    ),
    # 任務待辦清單（0014）：以任務 uid 關聯；寫入時的變更流水記在所屬任務上（entity=task）
    Spec(
        "taskChecklistItems",
        "task_checklist_items",
        "待辦清單",
        "task",
        (
            F("taskUid", "task_id", "ref", extra="tasks"),
            F("text", "text", "str", extra=500),
            F("isDone", "is_done", "bool"),
            F("sortOrder", "sort_order", "float"),
            _ts("doneAt", "done_at", True),
            F("doneByUsername", "done_by", "user", True),
            F("createdByUsername", "created_by", "user", True),
            F("updatedByUsername", "updated_by", "user", True),
            _CREATED,
            _UPDATED,
        ),
        title="text",
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
    "text": "內容",
    "doneByUsername": "完成者",
    "descriptionLocked": "描述鎖定",
    "lockedByUsername": "鎖定者",
    "lockedAt": "鎖定時間",
}
