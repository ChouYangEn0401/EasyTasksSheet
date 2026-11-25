"""稽核紀錄的還原（docs/design/audit-log.md「還原」）。

- `plan_revert()`：還原前的預覽（要還原的欄位、目前值、是否衝突）與不可還原的原因
- `revert_action()`：在單一 transaction 內還原（含衝突保護），並寫一筆 source = revert 的新稽核

欄位定義、快照、寫入與顯示文字在 audit.py；本模組只放還原流程。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from .audit import (
    _BOOL_FIELDS,
    _JSON_FIELDS,
    ENTITY_CAPABILITY,
    ENTITY_FIELDS,
    ENTITY_TABLES,
    LINK_FIELDS,
    Labeler,
    _row_get,
    get_entry,
    link_snapshot,
    load_fields,
    permission_cells,
    record_audit,
    same_value,
    snapshot,
    touch_tasks,
)
from .changes import record_change
from .db import Database, now_ms


class RevertError(Exception):
    def __init__(self, status: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


@dataclass
class RevertPlan:
    kind: str = "none"  # set_fields | soft_delete | undelete | delete_row | recreate_row | none
    fields: list[dict[str, Any]] = field(default_factory=list)
    blocked: str | None = None
    current_label: str | None = None

    @property
    def conflicts(self) -> list[dict[str, Any]]:
        return [f for f in self.fields if f["conflict"]]

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "fields": self.fields, "blocked": self.blocked, "hasConflict": bool(self.conflicts)}


def _load_row(conn: sqlite3.Connection, entity_type: str, entity_id: Any) -> Any:
    table = ENTITY_TABLES.get(entity_type)
    if table is None or entity_id is None:
        return None
    return conn.execute(f"SELECT * FROM {table} WHERE id = ?", (entity_id,)).fetchone()


def _exists(conn: sqlite3.Connection, table: str, id_: Any) -> bool:
    return id_ is None or conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (id_,)).fetchone() is not None


def _field_rows(
    lab: Labeler, et: str, before: dict[str, Any], after: dict[str, Any], current: dict[str, Any]
) -> list[dict[str, Any]]:
    out = []
    for k, bv in before.items():
        av = after.get(k)
        cv = current.get(k)
        out.append(
            {
                "field": k,
                "label": lab.field_label(et, k),
                "before": bv,
                "after": av,
                "current": cv,
                "beforeText": lab.value_text(et, k, bv),
                "afterText": lab.value_text(et, k, av),
                "currentText": lab.value_text(et, k, cv),
                "long": lab.is_long(et, k),
                "conflict": not same_value(cv, av),
            }
        )
    return out


def plan_revert(conn: sqlite3.Connection, entry: Any, lab: Labeler | None = None) -> RevertPlan:
    """還原預覽：要還原的欄位（含目前值、是否衝突）與無法還原的原因"""
    lab = lab or Labeler(conn)
    plan = RevertPlan()
    if entry["reverted_at"] is not None:
        plan.blocked = "這筆紀錄已經還原過了"
        return plan
    if not entry["revertable"]:
        plan.blocked = entry["note"] or "此類操作無法自動還原"
        return plan
    et, action, eid = entry["entity_type"], entry["action"], entry["entity_id"]
    before, _ = load_fields(entry["before_json"])
    after, _ = load_fields(entry["after_json"])
    before, after = before or {}, after or {}

    if et == "permission":
        plan.kind = "set_fields"
        plan.fields = _field_rows(lab, et, before, after, permission_cells(conn))
        return plan

    row = _load_row(conn, et, eid)
    plan.current_label = _label_of(et, row)

    if et in LINK_FIELDS:
        return _plan_link(conn, plan, et, action, row, before)

    if et == "comment" and action == "restore":
        # 「還原管理刪除的留言」的再還原：重新刪除
        if row is None:
            plan.blocked = "這則留言已不存在"
        elif row["deleted_at"] is not None:
            plan.blocked = "這則留言已經是刪除狀態"
        else:
            plan.kind = "delete_comment"
        return plan

    if et == "comment" and action == "delete":
        if row is None:
            plan.blocked = "這則留言已不存在"
        elif row["deleted_at"] is None:
            plan.blocked = "這則留言目前沒有被刪除"
        elif conn.execute("SELECT 1 FROM tasks WHERE id = ? AND deleted_at IS NULL", (row["task_id"],)).fetchone() is None:
            plan.blocked = "留言所屬的任務已刪除，請先還原任務"
        else:
            plan.kind = "undelete_comment"
        return plan

    if action in ("update", "reorder"):
        if row is None:
            plan.blocked = "這筆資料已不存在，無法還原"
            return plan
        if et == "task" and row["deleted_at"] is not None:
            plan.blocked = "任務目前已刪除，請先還原刪除，再還原這次修改"
            return plan
        plan.kind = "set_fields"
        plan.fields = _field_rows(lab, et, before, after, snapshot(et, row))
        plan.blocked = _check_refs(conn, et, before)
        if plan.blocked is None and et == "user":
            plan.blocked = _check_user_revert(conn, row, before)
        return plan

    if et == "task" and action in ("create", "restore"):
        if row is None:
            plan.blocked = "任務已不存在"
        elif row["deleted_at"] is not None:
            plan.blocked = "任務已經是刪除狀態"
        else:
            plan.kind = "soft_delete"
        return plan

    if et == "task" and action == "delete":
        if row is None:
            plan.blocked = "任務已不存在"
        elif row["deleted_at"] is None:
            plan.blocked = "任務目前沒有被刪除"
        elif not _exists(conn, "projects", row["project_id"]) or not _exists(conn, "statuses", row["status_id"]):
            plan.blocked = "任務的專案或狀態已不存在，無法還原"
        else:
            plan.kind = "undelete"
        return plan

    if et in ("status", "property") and action in ("create", "restore"):
        if row is None:
            plan.blocked = "這筆資料已被刪除"
            return plan
        if et == "status":
            used = conn.execute("SELECT count(*) FROM tasks WHERE status_id = ?", (eid,)).fetchone()[0]
            if used:
                plan.blocked = f"已有 {used} 筆任務使用此狀態（含已刪除的任務），無法自動還原"
                return plan
            if conn.execute("SELECT count(*) FROM statuses").fetchone()[0] <= 1:
                plan.blocked = "至少需保留一個狀態"
                return plan
        plan.kind = "delete_row"
        return plan

    if et in ("status", "property") and action == "delete":
        if row is not None:
            plan.blocked = "同一編號的資料已存在，無法還原"
        elif et == "property" and not _exists(conn, "projects", before.get("projectId")):
            plan.blocked = "此欄位所屬的專案已不存在"
        else:
            plan.kind = "recreate_row"
        return plan

    plan.blocked = entry["note"] or "此類操作無法自動還原"
    return plan


def _link_tasks(et: str, snap: Mapping[str, Any]) -> tuple[Any, Any]:
    if et == "relation":
        return snap.get("taskAId"), snap.get("taskBId")
    return snap.get("blockerTaskId"), snap.get("blockedTaskId")


def _plan_link(
    conn: sqlite3.Connection, plan: RevertPlan, et: str, action: str, row: Any, before: dict[str, Any]
) -> RevertPlan:
    """相關任務 / 依賴：建立（或「移除」的還原）→ 移除；移除 → 以原編號重新建立"""
    if action in ("create", "restore"):
        if row is None:
            plan.blocked = "這個連結已經被移除了"
        else:
            plan.kind = "delete_link"
        return plan
    if action != "delete":
        plan.blocked = "此類操作無法自動還原"
        return plan
    if row is not None:
        plan.blocked = "同一編號的連結已存在，無法還原"
        return plan
    a, b = _link_tasks(et, before)
    for tid in (a, b):
        r = conn.execute("SELECT deleted_at FROM tasks WHERE id = ?", (tid,)).fetchone()
        if r is None or r["deleted_at"] is not None:
            plan.blocked = "連結的任務已不存在或已刪除，無法還原"
            return plan
    if et == "relation":
        dup = conn.execute(
            "SELECT 1 FROM task_relations WHERE task_a_id = ? AND task_b_id = ? AND type = ?",
            (a, b, before.get("type") or "related"),
        ).fetchone()
    else:
        dup = conn.execute(
            "SELECT 1 FROM task_dependencies WHERE blocker_task_id = ? AND blocked_task_id = ?", (a, b)
        ).fetchone()
        if dup is None:
            from .features.dependencies import find_cycle

            pairs = [(r[0], r[1]) for r in conn.execute("SELECT blocker_task_id, blocked_task_id FROM task_dependencies")]
            if find_cycle(pairs, a, b) is not None:
                plan.blocked = "重新建立會形成循環依賴，無法還原"
                return plan
    if dup is not None:
        plan.blocked = "這兩個任務之間已經有相同的連結"
        return plan
    plan.kind = "recreate_link"
    return plan


def _label_of(et: str, row: Any) -> str | None:
    if row is None:
        return None
    if et == "task":
        return row["title"]
    if et == "user":
        return row["display_name"]
    return _row_get(row, "name")


def _check_refs(conn: sqlite3.Connection, et: str, values: dict[str, Any]) -> str | None:
    if et == "task":
        if "statusId" in values and not _exists(conn, "statuses", values["statusId"]):
            return "原本的狀態已被刪除，無法還原"
        if "projectId" in values and not _exists(conn, "projects", values["projectId"]):
            return "原本的專案已不存在，無法還原"
        if "assigneeId" in values and not _exists(conn, "users", values["assigneeId"]):
            return "原本的負責人已不存在，無法還原"
    if et == "property" and "projectId" in values and not _exists(conn, "projects", values["projectId"]):
        return "原本的專案已不存在，無法還原"
    return None


def _check_user_revert(conn: sqlite3.Connection, row: Any, before: dict[str, Any]) -> str | None:
    """不可讓系統沒有啟用中的超級管理員；帳號不可與他人重複"""
    role = before.get("role", row["role"])
    active = before.get("isActive", bool(row["is_active"]))
    if row["role"] == "root" and row["is_active"] and (role != "root" or not active):
        others = conn.execute(
            "SELECT count(*) FROM users WHERE role = 'root' AND is_active = 1 AND id <> ?", (row["id"],)
        ).fetchone()[0]
        if not others:
            return "至少需保留一位超級管理員，無法還原"
    if "username" in before and conn.execute(
        "SELECT 1 FROM users WHERE username = ? AND id <> ?", (before["username"], row["id"])
    ).fetchone():
        return "原本的帳號已被其他成員使用，無法還原"
    return None


def _is_done(conn: sqlite3.Connection, status_id: Any) -> bool:
    r = conn.execute("SELECT category FROM statuses WHERE id = ?", (status_id,)).fetchone()
    return r is not None and r["category"] == "done"


_INVERSE = {"update": "update", "reorder": "reorder", "create": "delete", "restore": "delete", "delete": "restore"}


def revert_action(
    db: Database,
    audit_id: int,
    actor: Any,
    force: bool = False,
    *,
    now: int | None = None,
    can: Callable[[str], bool] | None = None,
) -> dict[str, Any]:
    """還原一筆稽核紀錄（單一 transaction）。成功時回傳 { revertId, summary, entityType, entityId, taskId }。

    - 欄位更新：把有變動的欄位設回 before；若欄位目前值 ≠ 該次的 after → 衝突，需 force=True 才覆蓋
    - 任務建立 / 還原 → 軟刪除；任務刪除 → 還原；狀態 / 自訂欄位的新增 ↔ 刪除互為反向
    - 還原本身寫一筆新稽核（source = revert、revert_of = 原 id），並標記原筆 reverted_by / reverted_at
    失敗時拋 RevertError（404 / 403 / 409，衝突時 code = REVERT_CONFLICT、details.conflicts）。
    """
    t = now_ms() if now is None else now
    allowed = can or (lambda _cap: True)
    touched_permission = False
    try:
        with db.tx() as conn:
            entry = get_entry(conn, audit_id)
            if entry is None:
                raise RevertError(404, "NOT_FOUND", "找不到這筆稽核紀錄")
            if entry["reverted_at"] is not None:
                raise RevertError(409, "ALREADY_REVERTED", "這筆紀錄已經還原過了")
            cap = ENTITY_CAPABILITY.get(entry["entity_type"])
            if cap is not None and not allowed(cap):
                raise RevertError(403, "FORBIDDEN", "沒有權限執行此操作")
            plan = plan_revert(conn, entry)
            if plan.blocked:
                raise RevertError(409, "NOT_REVERTABLE", plan.blocked)
            if plan.conflicts and not force:
                raise RevertError(
                    409,
                    "REVERT_CONFLICT",
                    "部分欄位在這次修改之後又被改過",
                    {"conflicts": plan.conflicts, "fields": plan.fields},
                )
            if entry["entity_type"] == "task" and not allowed("tasks.lock"):
                # 描述鎖定：切換鎖、或改回已鎖定任務的描述，需 tasks.lock（同 PATCH /api/tasks 的規則）
                row = _load_row(conn, "task", entry["entity_id"])
                fields_ = {f["field"] for f in plan.fields}
                if "descriptionLocked" in fields_ or (
                    "description" in fields_ and row is not None and _row_get(row, "description_locked")
                ):
                    raise RevertError(403, "FORBIDDEN", "沒有權限執行此操作")
            if entry["entity_type"] == "user" and not allowed("roles.assign_root"):
                row = _load_row(conn, "user", entry["entity_id"])
                before, _ = load_fields(entry["before_json"])
                if row is not None and "root" in (row["role"], (before or {}).get("role")):
                    raise RevertError(403, "FORBIDDEN", "沒有權限執行此操作")
            touched_permission = entry["entity_type"] == "permission"
            new_id = _execute(conn, entry, plan, actor, t)
            conn.execute(
                "UPDATE audit_log SET reverted_by = ?, reverted_at = ? WHERE id = ?",
                (_row_get(actor, "id"), t, audit_id),
            )
    finally:
        if touched_permission:
            from .permissions import invalidate

            invalidate(db)
    return {
        "ok": True,
        "revertId": new_id,
        "summary": entry["summary"],
        "entityType": entry["entity_type"],
        "entityId": entry["entity_id"],
        "taskId": entry["task_id"],
    }


def _write_permission(conn: sqlite3.Connection, key: str, allowed: bool, actor_id: Any, t: int) -> None:
    from .permissions import CAPABILITIES, CONFIGURABLE_ROLES, PROTECTED_CAPABILITIES, role_can

    role, _, cap = key.partition(":")
    if role not in CONFIGURABLE_ROLES or cap not in CAPABILITIES or cap in PROTECTED_CAPABILITIES:
        return
    if bool(allowed) == role_can(role, cap):
        conn.execute("DELETE FROM role_permissions WHERE role = ? AND capability = ?", (role, cap))
    else:
        conn.execute(
            "INSERT INTO role_permissions (role, capability, allowed, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (role, capability) DO UPDATE SET allowed = excluded.allowed, "
            "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
            (role, cap, int(bool(allowed)), t, actor_id),
        )


def _set_fields(conn: sqlite3.Connection, entry: Any, plan: RevertPlan, actor_id: Any, t: int) -> None:
    et, eid = entry["entity_type"], entry["entity_id"]
    values = {f["field"]: f["before"] for f in plan.fields}
    if et == "permission":
        for key, v in values.items():
            _write_permission(conn, key, bool(v), actor_id, t)
        record_change(conn, "permission", 0, "update", actor_id, t)
        return
    cols = ENTITY_FIELDS[et]
    sets: dict[str, Any] = {}
    custom_patch: dict[str, Any] = {}
    for k, v in values.items():
        if k.startswith("custom."):
            custom_patch[k.split(".", 1)[1]] = v
        elif k in _BOOL_FIELDS:
            sets[cols[k]] = int(bool(v))
        elif k in _JSON_FIELDS:
            sets[cols[k]] = json.dumps(v if v is not None else [], ensure_ascii=False)
        elif k in cols:
            sets[cols[k]] = v
    row = _load_row(conn, et, eid)
    if et == "task":
        if custom_patch:
            custom = json.loads(row["custom"] or "{}")
            for k, v in custom_patch.items():
                if v is None:
                    custom.pop(k, None)
                else:
                    custom[k] = v
            sets["custom"] = json.dumps(custom, ensure_ascii=False)
        if "description_locked" in sets:
            sets["locked_by"] = actor_id if sets["description_locked"] else None
            sets["locked_at"] = t if sets["description_locked"] else None
        if "status_id" in sets:
            was_done, now_done = _is_done(conn, row["status_id"]), _is_done(conn, sets["status_id"])
            if now_done and not was_done:
                sets["completed_at"] = t
            elif was_done and not now_done:
                sets["completed_at"] = None
        sets["updated_by"] = actor_id
    sets["updated_at"] = t
    conn.execute(f"UPDATE {ENTITY_TABLES[et]} SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?", (*sets.values(), eid))
    if et == "user" and values.get("isActive") is False:
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (eid,))
    record_change(conn, et, eid, "update", actor_id, t)  # type: ignore[arg-type]


def _execute(conn: sqlite3.Connection, entry: Any, plan: RevertPlan, actor: Any, t: int) -> int | None:
    et, eid, task_id = entry["entity_type"], entry["entity_id"], entry["task_id"]
    actor_id = _row_get(actor, "id")
    before, _ = load_fields(entry["before_json"])
    new_before: dict[str, Any] | None = None
    new_after: dict[str, Any] | None = None

    if plan.kind == "set_fields":
        _set_fields(conn, entry, plan, actor_id, t)
        new_before = {f["field"]: f["current"] for f in plan.fields}
        new_after = {f["field"]: f["before"] for f in plan.fields}
    elif plan.kind == "soft_delete":
        conn.execute(
            "UPDATE tasks SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?", (t, actor_id, t, eid)
        )
        record_change(conn, "task", eid, "delete", actor_id, t)
    elif plan.kind == "undelete":
        conn.execute(
            "UPDATE tasks SET deleted_at = NULL, updated_by = ?, updated_at = ? WHERE id = ?", (actor_id, t, eid)
        )
        record_change(conn, "task", eid, "create", actor_id, t)
    elif plan.kind == "delete_row":
        row = _load_row(conn, et, eid)
        new_before = snapshot(et, row)
        conn.execute(f"DELETE FROM {ENTITY_TABLES[et]} WHERE id = ?", (eid,))
        record_change(conn, et, eid, "delete", actor_id, t)  # type: ignore[arg-type]
    elif plan.kind == "recreate_row":
        snap = dict(before or {})
        cols = ENTITY_FIELDS[et]
        values: dict[str, Any] = {"id": eid}
        for k, col in cols.items():
            v = snap.get(k)
            if k in _JSON_FIELDS:
                v = json.dumps(v if v is not None else [], ensure_ascii=False)
            elif k in _BOOL_FIELDS:
                v = int(bool(v))
            values[col] = v
        if et == "status":
            values["color"] = values.get("color") or "gray"
            values["category"] = values.get("category") or "todo"
        values["created_at"] = t
        values["updated_at"] = t
        conn.execute(
            f"INSERT INTO {ENTITY_TABLES[et]} ({', '.join(values)}) VALUES ({', '.join('?' * len(values))})",
            tuple(values.values()),
        )
        record_change(conn, et, eid, "create", actor_id, t)  # type: ignore[arg-type]
        new_after = snap
    elif plan.kind == "undelete_comment":
        conn.execute(
            "UPDATE task_comments SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?", (t, eid)
        )
        record_change(conn, "task_comment", eid, "update", actor_id, t)
        new_after = dict(before or {})
    elif plan.kind == "delete_comment":
        conn.execute(
            "UPDATE task_comments SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?",
            (t, actor_id, t, eid),
        )
        record_change(conn, "task_comment", eid, "update", actor_id, t)
        after_, _ = load_fields(entry["after_json"])
        new_before = dict(after_ or {})
    elif plan.kind == "delete_link":
        row = _load_row(conn, et, eid)
        new_before = link_snapshot(et, row)
        conn.execute(f"DELETE FROM {ENTITY_TABLES[et]} WHERE id = ?", (eid,))
        touch_tasks(conn, _link_tasks(et, new_before), actor_id, t)
    elif plan.kind == "recreate_link":
        snap = dict(before or {})
        values = {"id": eid, "uid": entry["entity_uid"]}
        values.update({col: snap.get(k) for k, col in LINK_FIELDS[et].items()})
        if et == "relation":
            values["type"] = values.get("type") or "related"
        else:
            values["type"] = "finish_to_start"
            values["lag_days"] = values.get("lag_days") or 0
            values["note"] = values.get("note") or ""
        values.update({"created_by": actor_id, "created_at": t, "updated_at": t})
        conn.execute(
            f"INSERT INTO {ENTITY_TABLES[et]} ({', '.join(values)}) VALUES ({', '.join('?' * len(values))})",
            tuple(values.values()),
        )
        touch_tasks(conn, _link_tasks(et, snap), actor_id, t)
        new_after = snap
    else:  # pragma: no cover - plan_revert 已擋下
        raise RevertError(409, "NOT_REVERTABLE", "此類操作無法自動還原")

    label = plan.current_label or entry["entity_label"]
    return record_audit(
        conn,
        actor=actor,
        entity_type=et,
        entity_id=eid,
        action=_INVERSE.get(entry["action"], "update"),
        summary=f"還原：{entry['summary']}",
        before=new_before,
        after=new_after,
        task_id=task_id,
        source="revert",
        revertable=True,
        entity_label=label,
        entity_uid=entry["entity_uid"],
        revert_of=entry["id"],
        ts=t,
    )
