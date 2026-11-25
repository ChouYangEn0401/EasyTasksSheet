"""各核心操作的稽核寫入（摘要文字與前後值）。呼叫點在各 features/*.py 的 transaction 內，只需一行。

語氣：中性、描述事實（「把『X』的狀態從『待辦』改為『進行中』」），不加評價。docs/design/audit-log.md
"""

from __future__ import annotations

import sqlite3
from typing import Any, Mapping

from .audit import (
    MODE_LABELS,
    Labeler,
    diff_fields,
    is_empty,
    permission_cells,
    quote,
    record_audit,
    link_snapshot,
    record_merged_count,
    record_reorder,
    snapshot,
)

__all__ = [
    "task_created",
    "task_updated",
    "task_deleted",
    "task_restored",
    "project_created",
    "project_updated",
    "status_created",
    "status_updated",
    "status_deleted",
    "status_migrated",
    "property_created",
    "property_updated",
    "property_deleted",
    "user_created",
    "user_updated",
    "user_password_reset",
    "user_unlocked",
    "profile_updated",
    "permission_cells",
    "permissions_changed",
    "import_applied",
    "sync_applied",
    "link_created",
    "link_deleted",
    "checklist_added",
    "checklist_toggled",
    "checklist_item_deleted",
    "checklist_cleared",
    "comment_created",
    "comment_edited",
    "comment_deleted",
    "comment_resolved",
]


def _field_names(lab: Labeler, et: str, fields: list[str]) -> str:
    names = [lab.field_label(et, f) for f in fields]
    if len(names) > 4:
        return f"{'、'.join(names[:4])} 等 {len(names)} 個欄位"
    return "、".join(names)


def _change_sentence(lab: Labeler, et: str, subject: str, field: str, b: Any, a: Any) -> str:
    """單一欄位變更的句子（subject 已含『』）"""
    flabel = lab.field_label(et, field)
    if lab.is_long(et, field):
        return f"修改了{subject}的{flabel}"
    bt, at = lab.value_text(et, field, b), lab.value_text(et, field, a)
    if is_empty(b) and field != "assigneeId":
        return f"把{subject}的{flabel}設為{quote(at)}"
    if is_empty(a) and field != "assigneeId":
        return f"清除了{subject}的{flabel}（原為{quote(bt)}）"
    return f"把{subject}的{flabel}從{quote(bt)}改為{quote(at)}"


def _compact(snap: dict[str, Any]) -> dict[str, Any]:
    """建立 / 刪除時保存的內容：去掉空值與順序"""
    return {
        k: v
        for k, v in snap.items()
        if k != "sortOrder" and not is_empty(v) and not (k == "descriptionLocked" and not v)
    }


# ── 任務 ─────────────────────────────────────────────────


def task_created(conn: sqlite3.Connection, actor: Any, row: Any, ts: int, source: str = "web") -> int | None:
    return record_audit(
        conn,
        actor=actor,
        entity_type="task",
        entity_id=row["id"],
        entity_uid=row["uid"] if "uid" in row.keys() else None,
        action="create",
        summary=f"建立任務{quote(row['title'])}",
        after=_compact(snapshot("task", row)),
        task_id=row["id"],
        source=source,
        revertable=True,
        entity_label=row["title"],
        ts=ts,
    )


def task_updated(conn: sqlite3.Connection, actor: Any, before_row: Any, after_row: Any, ts: int) -> int | None:
    b, a = diff_fields(snapshot("task", before_row), snapshot("task", after_row))
    if not b:
        return None
    tid, title = after_row["id"], after_row["title"]
    if set(b) == {"sortOrder"}:
        return record_reorder(
            conn,
            actor=actor,
            entity_type="task",
            entity_id=tid,
            before=b,
            after=a,
            summary=f"調整了{quote(title)}的順序",
            entity_label=title,
            task_id=tid,
            ts=ts,
        )
    # 順序跟著其他欄位一起變（例如看板拖曳換欄）時只記錄有意義的欄位
    b.pop("sortOrder", None)
    a.pop("sortOrder", None)
    lab = Labeler(conn)
    fields = list(b)
    if fields == ["descriptionLocked"]:
        summary = f"鎖定了{quote(title)}的描述" if a["descriptionLocked"] else f"解除了{quote(title)}的描述鎖定"
    elif fields == ["title"]:
        summary = f"把任務標題從{quote(b['title'])}改為{quote(a['title'])}"
    elif len(fields) == 1:
        summary = _change_sentence(lab, "task", quote(title), fields[0], b[fields[0]], a[fields[0]])
    else:
        summary = f"修改了{quote(title)}的{_field_names(lab, 'task', fields)}"
    return record_audit(
        conn,
        actor=actor,
        entity_type="task",
        entity_id=tid,
        action="update",
        summary=summary,
        before=b,
        after=a,
        task_id=tid,
        revertable=True,
        entity_label=title,
        ts=ts,
    )


def task_deleted(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    return record_audit(
        conn,
        actor=actor,
        entity_type="task",
        entity_id=row["id"],
        action="delete",
        summary=f"刪除任務{quote(row['title'])}",
        before=_compact(snapshot("task", row)),
        task_id=row["id"],
        revertable=True,
        entity_label=row["title"],
        ts=ts,
    )


def task_restored(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    """復原刪除（/api/tasks/:id/restore，前端「復原」）：還原此筆 = 再次軟刪除"""
    return record_audit(
        conn,
        actor=actor,
        entity_type="task",
        entity_id=row["id"],
        action="restore",
        summary=f"還原了已刪除的任務{quote(row['title'])}",
        task_id=row["id"],
        revertable=True,
        entity_label=row["title"],
        ts=ts,
    )


# ── 專案 / 狀態 / 自訂欄位 ─────────────────────────────────

_NOUN = {"project": "專案", "status": "狀態", "property": "自訂欄位"}


def _entity_update(
    conn: sqlite3.Connection, actor: Any, et: str, before_row: Any, after_row: Any, ts: int
) -> int | None:
    b, a = diff_fields(snapshot(et, before_row), snapshot(et, after_row))
    if not b:
        return None
    noun = _NOUN[et]
    eid, name = after_row["id"], after_row["name"]
    subject = f"{noun}{quote(name)}"
    if set(b) == {"sortOrder"}:
        return record_reorder(
            conn,
            actor=actor,
            entity_type=et,
            entity_id=eid,
            before=b,
            after=a,
            summary=f"調整了{subject}的順序",
            entity_label=name,
            ts=ts,
        )
    b.pop("sortOrder", None)
    a.pop("sortOrder", None)
    lab = Labeler(conn)
    fields = list(b)
    if fields == ["name"]:
        summary = f"把{noun}{quote(b['name'])}改名為{quote(a['name'])}"
    elif fields == ["isArchived"]:
        summary = f"封存了專案{quote(name)}" if a["isArchived"] else f"取消封存專案{quote(name)}"
    elif fields == ["options"]:
        summary = f"修改了{subject}的選項"
    elif fields == ["color"]:
        summary = f"把{subject}的顏色從{quote(lab.value_text(et, 'color', b['color']))}改為{quote(lab.value_text(et, 'color', a['color']))}"
    elif len(fields) == 1:
        summary = _change_sentence(lab, et, subject, fields[0], b[fields[0]], a[fields[0]])
    else:
        summary = f"修改了{subject}的{_field_names(lab, et, fields)}"
    return record_audit(
        conn,
        actor=actor,
        entity_type=et,
        entity_id=eid,
        action="update",
        summary=summary,
        before=b,
        after=a,
        revertable=True,
        entity_label=name,
        ts=ts,
    )


def project_created(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    return record_audit(
        conn,
        actor=actor,
        entity_type="project",
        entity_id=row["id"],
        action="create",
        summary=f"建立專案{quote(row['name'])}",
        after=snapshot("project", row),
        revertable=False,
        note="專案無法刪除；如不再使用，可改為封存",
        entity_label=row["name"],
        ts=ts,
    )


def project_updated(conn: sqlite3.Connection, actor: Any, before_row: Any, after_row: Any, ts: int) -> int | None:
    return _entity_update(conn, actor, "project", before_row, after_row, ts)


def status_created(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    return record_audit(
        conn,
        actor=actor,
        entity_type="status",
        entity_id=row["id"],
        action="create",
        summary=f"新增狀態{quote(row['name'])}",
        after=snapshot("status", row),
        revertable=True,
        entity_label=row["name"],
        ts=ts,
    )


def status_updated(conn: sqlite3.Connection, actor: Any, before_row: Any, after_row: Any, ts: int) -> int | None:
    return _entity_update(conn, actor, "status", before_row, after_row, ts)


def status_deleted(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    return record_audit(
        conn,
        actor=actor,
        entity_type="status",
        entity_id=row["id"],
        action="delete",
        summary=f"刪除狀態{quote(row['name'])}",
        before=snapshot("status", row),
        revertable=True,
        entity_label=row["name"],
        ts=ts,
    )


def status_migrated(
    conn: sqlite3.Connection, actor: Any, row: Any, target: Any, moved: list[Any], ts: int
) -> int | None:
    """刪除狀態並把任務改移：一筆狀態摘要 + 每筆任務一筆（不可還原，供任務活動歷史查看）"""
    note = "刪除狀態時一併改移的任務，請改以個別任務修改還原"
    for t in moved:
        record_audit(
            conn,
            actor=actor,
            entity_type="task",
            entity_id=t["id"],
            action="update",
            summary=f"把{quote(t['title'])}的狀態從{quote(row['name'])}改為{quote(target['name'])}（刪除狀態時一併改移）",
            before={"statusId": row["id"]},
            after={"statusId": target["id"]},
            task_id=t["id"],
            revertable=False,
            note=note,
            entity_label=t["title"],
            ts=ts,
        )
    return record_audit(
        conn,
        actor=actor,
        entity_type="status",
        entity_id=row["id"],
        action="delete",
        summary=f"刪除狀態{quote(row['name'])}，並把 {len(moved)} 筆任務改為{quote(target['name'])}",
        before=snapshot("status", row),
        revertable=False,
        note="已將任務改移到其他狀態，無法自動還原；可重新新增狀態後再調整任務",
        entity_label=row["name"],
        ts=ts,
    )


def property_created(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    return record_audit(
        conn,
        actor=actor,
        entity_type="property",
        entity_id=row["id"],
        action="create",
        summary=f"新增自訂欄位{quote(row['name'])}",
        after=snapshot("property", row),
        revertable=True,
        entity_label=row["name"],
        ts=ts,
    )


def property_updated(conn: sqlite3.Connection, actor: Any, before_row: Any, after_row: Any, ts: int) -> int | None:
    return _entity_update(conn, actor, "property", before_row, after_row, ts)


def property_deleted(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    return record_audit(
        conn,
        actor=actor,
        entity_type="property",
        entity_id=row["id"],
        action="delete",
        summary=f"刪除自訂欄位{quote(row['name'])}",
        before=snapshot("property", row),
        revertable=True,
        entity_label=row["name"],
        ts=ts,
    )


# ── 成員 ─────────────────────────────────────────────────

_USER_FIELDS = ("displayName", "role", "isActive", "inOverview")


def user_created(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    lab = Labeler(conn)
    return record_audit(
        conn,
        actor=actor,
        entity_type="user",
        entity_id=row["id"],
        action="create",
        summary=f"新增成員{quote(row['display_name'])}（帳號 {row['username']}，{lab.value_text('user', 'role', row['role'])}）",
        after={k: v for k, v in snapshot("user", row).items() if k != "isActive"},
        revertable=False,
        note="帳號無法刪除；如不再使用，可改為停用",
        entity_label=row["display_name"],
        ts=ts,
    )


def user_updated(conn: sqlite3.Connection, actor: Any, before_row: Any, after_row: Any, ts: int) -> int | None:
    b, a = diff_fields(snapshot("user", before_row), snapshot("user", after_row), _USER_FIELDS)
    if not b:
        return None
    lab = Labeler(conn)
    name = after_row["display_name"]
    fields = list(b)
    if fields == ["isActive"]:
        summary = f"重新啟用成員{quote(name)}" if a["isActive"] else f"停用了成員{quote(name)}"
    elif fields == ["inOverview"]:
        summary = f"把成員{quote(name)}列入總覽統計" if a["inOverview"] else f"把成員{quote(name)}設為不列入總覽統計"
    elif fields == ["displayName"]:
        summary = f"把成員{quote(b['displayName'])}的顯示名稱改為{quote(a['displayName'])}"
    elif len(fields) == 1:
        summary = _change_sentence(lab, "user", quote(name), fields[0], b[fields[0]], a[fields[0]])
    else:
        summary = f"修改了成員{quote(name)}的{_field_names(lab, 'user', fields)}"
    return record_audit(
        conn,
        actor=actor,
        entity_type="user",
        entity_id=after_row["id"],
        action="update",
        summary=summary,
        before=b,
        after=a,
        revertable=True,
        entity_label=name,
        ts=ts,
    )


def user_password_reset(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    """不保存任何密碼內容"""
    return record_audit(
        conn,
        actor=actor,
        entity_type="user",
        entity_id=row["id"],
        action="reset_password",
        summary=f"重設了{quote(row['display_name'])}的密碼",
        revertable=False,
        note="密碼無法還原；如有需要請再重設一次",
        entity_label=row["display_name"],
        ts=ts,
    )


def user_unlocked(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    return record_audit(
        conn,
        actor=actor,
        entity_type="user",
        entity_id=row["id"],
        action="unlock",
        summary=f"解除了{quote(row['display_name'])}的登入鎖定",
        revertable=False,
        note="解除登入鎖定不需要還原",
        entity_label=row["display_name"],
        ts=ts,
    )


def profile_updated(conn: sqlite3.Connection, actor: Any, before_row: Any, after_row: Any, ts: int) -> int | None:
    """個人設定：帳號 / 顯示名稱（不保存密碼）"""
    b, a = diff_fields(snapshot("user", before_row), snapshot("user", after_row), ("username", "displayName"))
    if not b:
        return None
    parts = []
    if "displayName" in b:
        parts.append(f"顯示名稱從{quote(b['displayName'])}改為{quote(a['displayName'])}")
    if "username" in b:
        parts.append(f"帳號從 {b['username']} 改為 {a['username']}")
    return record_audit(
        conn,
        actor=actor,
        entity_type="user",
        entity_id=after_row["id"],
        action="update",
        summary=f"在個人設定把{'，'.join(parts)}",
        before=b,
        after=a,
        revertable=False,
        note="個人帳號設定需由本人在「個人設定」修改",
        entity_label=after_row["display_name"],
        ts=ts,
    )


# ── 權限設定 ─────────────────────────────────────────────


def permissions_changed(
    conn: sqlite3.Connection,
    actor: Any,
    before_cells: Mapping[str, bool],
    ts: int,
    reset: str | None = None,
) -> int | None:
    """before_cells：寫入前的 permission_cells()；寫入後自動讀取目前矩陣比較。reset：'all' / 角色 / None"""
    b, a = diff_fields(before_cells, permission_cells(conn))
    if not b:
        return None
    lab = Labeler(conn)
    if reset is not None:
        who = "所有角色" if reset == "all" else lab.value_text("user", "role", reset)
        summary = f"把{who}的權限還原為預設（{len(b)} 項變更）"
    else:
        items = [f"{lab.field_label('permission', k)}改為{'允許' if a[k] else '不允許'}" for k in b]
        more = f" 等 {len(items)} 項" if len(items) > 3 else ""
        summary = f"調整權限設定：{'、'.join(items[:3])}{more}"
    return record_audit(
        conn,
        actor=actor,
        entity_type="permission",
        entity_id=0,
        action="update",
        summary=summary,
        before=b,
        after=a,
        revertable=True,
        entity_label="權限設定",
        ts=ts,
    )


# ── 匯入 / 同步（只記一筆摘要，不可還原）─────────────────────


def import_applied(conn: sqlite3.Connection, actor: Any, result: Mapping[str, Any], ts: int) -> int | None:
    cats = result.get("categories") or []
    total = {k: sum(int(c.get(k, 0)) for c in cats) for k in ("created", "updated", "deleted", "skipped", "unchanged")}
    mode = result.get("mode", "merge")
    parts = [f"新增 {total['created']} 筆", f"更新 {total['updated']} 筆"]
    if total["deleted"]:
        parts.append(f"刪除 {total['deleted']} 筆")
    return record_audit(
        conn,
        actor=actor,
        entity_type="import",
        entity_id=None,
        action="apply",
        summary=f"套用資料匯入（{MODE_LABELS.get(mode, mode)}）：{'、'.join(parts)}",
        after={"mode": mode, "strategy": result.get("strategy"), **total},
        source="import",
        revertable=False,
        note="匯入為整批套用，無法逐筆還原；如需復原請使用匯入前的自動備份",
        entity_label="資料匯入",
        ts=ts,
    )


def sync_applied(
    conn: sqlite3.Connection, source: Any, machine: str, totals: Mapping[str, int], ts: int
) -> int | None:
    """同步上傳一批：有新增 / 更新 / 待確認時才記錄（避免定期同步產生大量空紀錄）"""
    if not (totals.get("created") or totals.get("updated") or totals.get("conflict")):
        return None
    parts = [f"新增 {totals.get('created', 0)} 筆", f"更新 {totals.get('updated', 0)} 筆"]
    if totals.get("conflict"):
        parts.append(f"{totals['conflict']} 筆待確認")
    return record_audit(
        conn,
        actor=None,
        actor_name=f"同步：{source['name']}",
        entity_type="sync",
        entity_id=source["id"],
        action="apply",
        summary=f"同步來源{quote(source['name'])}（{machine}）上傳：{'、'.join(parts)}",
        after={"machine": machine, **{k: int(v) for k, v in totals.items()}},
        source="sync",
        revertable=False,
        note="同步為整批套用，無法逐筆還原；如需復原請使用同步前的自動備份",
        entity_label=source["name"],
        ts=ts,
    )


# ── 相關任務 / 依賴（建立 ↔ 移除可還原）──────────────────────────


def _task_title(conn: sqlite3.Connection, task_id: Any) -> str:
    r = conn.execute("SELECT title FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return r["title"] if r is not None else f"任務 #{task_id}"


def _link_sentence(conn: sqlite3.Connection, et: str, snap: Mapping[str, Any], created: bool) -> str:
    if et == "relation":
        a, b = quote(_task_title(conn, snap["taskAId"])), quote(_task_title(conn, snap["taskBId"]))
        return f"把{a}與{b}設為相關任務" if created else f"移除了{a}與{b}的相關連結"
    blocker = quote(_task_title(conn, snap["blockerTaskId"]))
    blocked = quote(_task_title(conn, snap["blockedTaskId"]))
    return f"設定{blocked}等待{blocker}完成" if created else f"移除了{blocked}對{blocker}的依賴"


def _link_task_id(et: str, snap: Mapping[str, Any], context_task_id: int | None) -> Any:
    if context_task_id is not None:
        return context_task_id
    return snap["taskAId"] if et == "relation" else snap["blockedTaskId"]


def link_created(
    conn: sqlite3.Connection, actor: Any, et: str, row: Any, ts: int, task_id: int | None = None
) -> int | None:
    """et：relation / dependency；task_id 為操作所在的任務（出現在其活動歷史）"""
    snap = link_snapshot(et, row)
    return record_audit(
        conn,
        actor=actor,
        entity_type=et,
        entity_id=row["id"],
        entity_uid=row["uid"] if "uid" in row.keys() else None,
        action="create",
        summary=_link_sentence(conn, et, snap, True),
        after=snap,
        task_id=_link_task_id(et, snap, task_id),
        revertable=True,
        entity_label=_task_title(conn, _link_task_id(et, snap, task_id)),
        ts=ts,
    )


def link_deleted(
    conn: sqlite3.Connection, actor: Any, et: str, row: Any, ts: int, task_id: int | None = None
) -> int | None:
    snap = link_snapshot(et, row)
    return record_audit(
        conn,
        actor=actor,
        entity_type=et,
        entity_id=row["id"],
        entity_uid=row["uid"] if "uid" in row.keys() else None,
        action="delete",
        summary=_link_sentence(conn, et, snap, False),
        before=snap,
        task_id=_link_task_id(et, snap, task_id),
        revertable=True,
        entity_label=_task_title(conn, _link_task_id(et, snap, task_id)),
        ts=ts,
    )


# ── 待辦清單（不可還原；勾選合併為一筆）──────────────────────────

_CHECKLIST_NOTE = "待辦清單的異動不提供自動還原"
_ITEMS_KEEP = 20


def checklist_added(conn: sqlite3.Connection, actor: Any, task_id: int, texts: list[str], ts: int) -> int | None:
    """批次建立（貼上多行）才記錄；單項新增屬於高頻小動作，不記錄"""
    if len(texts) < 2:
        return None
    title = _task_title(conn, task_id)
    return record_audit(
        conn,
        actor=actor,
        entity_type="checklist",
        entity_id=task_id,
        action="create",
        summary=f"在{quote(title)}一次新增了 {len(texts)} 項待辦",
        after={"count": len(texts), "items": texts[:_ITEMS_KEEP]},
        task_id=task_id,
        revertable=False,
        note=_CHECKLIST_NOTE,
        entity_label=title,
        ts=ts,
    )


def checklist_toggled(conn: sqlite3.Connection, actor: Any, task_id: int, done: bool, ts: int) -> int | None:
    """勾選 / 取消勾選：同一人 10 分鐘內對同一任務的勾選合併為一筆（「完成了『X』的待辦項目 3 項」）"""
    title = _task_title(conn, task_id)

    def summary_of(c: dict[str, int]) -> str:
        parts = []
        if c.get("completed"):
            parts.append(f"完成了{quote(title)}的待辦項目 {c['completed']} 項")
        if c.get("reopened"):
            parts.append(f"取消完成 {c['reopened']} 項" if parts else f"把{quote(title)}的待辦項目取消完成 {c['reopened']} 項")
        return "，".join(parts) or f"調整了{quote(title)}的待辦項目"

    return record_merged_count(
        conn,
        actor=actor,
        entity_type="checklist",
        entity_id=task_id,
        merge_tag="checklist:toggle",
        counts={"completed": 1 if done else 0, "reopened": 0 if done else 1},
        summary_of=summary_of,
        entity_label=title,
        task_id=task_id,
        note=_CHECKLIST_NOTE,
        ts=ts,
    )


def checklist_item_deleted(conn: sqlite3.Connection, actor: Any, task_id: int, text: str, ts: int) -> int | None:
    title = _task_title(conn, task_id)
    return record_audit(
        conn,
        actor=actor,
        entity_type="checklist",
        entity_id=task_id,
        action="delete",
        summary=f"刪除了{quote(title)}的待辦項目{quote(text)}",
        before={"items": [text]},
        task_id=task_id,
        revertable=False,
        note=_CHECKLIST_NOTE,
        entity_label=title,
        ts=ts,
    )


def checklist_cleared(conn: sqlite3.Connection, actor: Any, task_id: int, texts: list[str], ts: int) -> int | None:
    if not texts:
        return None
    title = _task_title(conn, task_id)
    return record_audit(
        conn,
        actor=actor,
        entity_type="checklist",
        entity_id=task_id,
        action="delete",
        summary=f"清除了{quote(title)}已完成的待辦 {len(texts)} 項",
        before={"count": len(texts), "items": texts[:_ITEMS_KEEP]},
        task_id=task_id,
        revertable=False,
        note=_CHECKLIST_NOTE,
        entity_label=title,
        ts=ts,
    )


# ── 任務討論區（不存留言全文，只存前 200 字摘要）──────────────────

_EXCERPT = 200
_COMMENT_NOTE = "留言由作者自行編輯或刪除；稽核只保存前 200 字摘要"


def _excerpt(body: Any) -> str:
    text = "" if body is None else str(body)
    return text if len(text) <= _EXCERPT else text[: _EXCERPT - 1] + "…"


def _author_name(conn: sqlite3.Connection, user_id: Any) -> str | None:
    if user_id is None:
        return None
    r = conn.execute("SELECT display_name FROM users WHERE id = ?", (user_id,)).fetchone()
    return r["display_name"] if r is not None else None


def comment_created(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    title = _task_title(conn, row["task_id"])
    verb = "回覆了留言" if row["parent_id"] is not None else "發表了留言"
    return record_audit(
        conn,
        actor=actor,
        entity_type="comment",
        entity_id=row["id"],
        entity_uid=row["uid"],
        action="create",
        summary=f"在{quote(title)}{verb}",
        after={"excerpt": _excerpt(row["body"])},
        task_id=row["task_id"],
        revertable=False,
        note=_COMMENT_NOTE,
        entity_label=title,
        ts=ts,
    )


def comment_edited(conn: sqlite3.Connection, actor: Any, before_row: Any, after_row: Any, ts: int) -> int | None:
    title = _task_title(conn, after_row["task_id"])
    return record_audit(
        conn,
        actor=actor,
        entity_type="comment",
        entity_id=after_row["id"],
        entity_uid=after_row["uid"],
        action="update",
        summary=f"編輯了在{quote(title)}的留言",
        before={"excerpt": _excerpt(before_row["body"])},
        after={"excerpt": _excerpt(after_row["body"])},
        task_id=after_row["task_id"],
        revertable=False,
        note=_COMMENT_NOTE,
        entity_label=title,
        ts=ts,
    )


def comment_deleted(conn: sqlite3.Connection, actor: Any, row: Any, ts: int) -> int | None:
    """刪除他人的留言（管理）可還原；刪除自己的留言不可還原（作者可重新發表）"""
    title = _task_title(conn, row["task_id"])
    actor_id = actor["id"] if actor is not None else None
    own = row["author_id"] == actor_id
    author = _author_name(conn, row["author_id"])
    summary = f"刪除了在{quote(title)}的留言" if own else f"刪除了{author or '成員'}在{quote(title)}的留言"
    before: dict[str, Any] = {"excerpt": _excerpt(row["body"])}
    if not own and author:
        before["authorName"] = author
    return record_audit(
        conn,
        actor=actor,
        entity_type="comment",
        entity_id=row["id"],
        entity_uid=row["uid"],
        action="delete",
        summary=summary,
        before=before,
        task_id=row["task_id"],
        revertable=not own,
        note=None if not own else "刪除自己的留言不提供還原，可重新發表",
        entity_label=title,
        ts=ts,
    )


def comment_resolved(conn: sqlite3.Connection, actor: Any, row: Any, resolved: bool, ts: int) -> int | None:
    title = _task_title(conn, row["task_id"])
    summary = (
        f"把{quote(title)}的一則討論標記為已解決" if resolved else f"重新開啟了{quote(title)}的一則討論"
    )
    return record_audit(
        conn,
        actor=actor,
        entity_type="comment",
        entity_id=row["id"],
        entity_uid=row["uid"],
        action="update",
        summary=summary,
        after={"excerpt": _excerpt(row["body"])},
        task_id=row["task_id"],
        revertable=False,
        note="可在討論區重新標記",
        entity_label=title,
        ts=ts,
    )
