"""個人頁「匯報報告」：某成員在日期區間內的完成事項（docs/design/personal.md「匯報報告」）。

口徑：
- 日界線以 config.TZ（預設 Asia/Taipei）計；區間含頭尾日（from 當日 00:00 至 to 隔日 00:00）
- 完成任務：指派給該成員、completed_at 落在區間、目前仍為 done 類別、未軟刪除
- 完成待辦：該成員自由待辦（非標記列）status = done 且 done_at 落在區間（done_at 缺漏以 updated_at 推得）
- 預估工時：只加總有填 estimate_hours 的任務；沒人填就不回傳 estimatedHours
- 每種資料各一次批次查詢，專案名稱以 JOIN 取得
"""

from __future__ import annotations

import re
import sqlite3
from datetime import date, timedelta
from typing import Any

from .errors import bad_request
from .timeutil import date_in_zone, get_zone, local_midnight_ms

MAX_DAYS = 366
INCLUDE_KEYS = ("doing", "deferred", "cancelled", "created")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_range(raw_from: str | None, raw_to: str | None) -> tuple[date, date]:
    def one(raw: str | None, label: str) -> date:
        if raw is None or not _DATE_RE.match(raw):
            raise bad_request(f"{label}須為 YYYY-MM-DD 日期")
        try:
            return date.fromisoformat(raw)
        except ValueError:
            raise bad_request(f"{label}不是有效的日期") from None

    start, end = one(raw_from, "起始日"), one(raw_to, "結束日")
    if end < start:
        raise bad_request("結束日不可早於起始日")
    if (end - start).days + 1 > MAX_DAYS:
        raise bad_request(f"日期區間最長 {MAX_DAYS} 天")
    return start, end


def parse_include(raw: str | None) -> set[str]:
    out: set[str] = set()
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        if part not in INCLUDE_KEYS:
            raise bad_request(f"include 不支援「{part}」")
        out.add(part)
    return out


_TASK_SELECT = (
    "SELECT t.id, t.title, t.project_id, p.name AS project_name, p.color AS project_color, s.name AS status_name, "
    "t.completed_at, t.created_at, t.start_date, t.due_date, t.estimate_hours, t.priority "
    "FROM tasks t JOIN projects p ON p.id = t.project_id JOIN statuses s ON s.id = t.status_id "
)
_TODO_SELECT = "SELECT id, title, note, detail, status, due_date, done_at, updated_at FROM personal_items "


def _task_item(r: sqlite3.Row, tz: str) -> dict[str, Any]:
    return {
        "id": r["id"],
        "title": r["title"],
        "projectId": r["project_id"],
        "projectName": r["project_name"],
        "projectColor": r["project_color"],
        "statusName": r["status_name"],
        "completedDate": date_in_zone(r["completed_at"], tz) if r["completed_at"] is not None else None,
        "startDate": r["start_date"],
        "dueDate": r["due_date"],
        "estimateHours": r["estimate_hours"],
        "priority": r["priority"],
    }


def _todo_item(r: sqlite3.Row, tz: str) -> dict[str, Any]:
    done_ms = r["done_at"] if r["done_at"] is not None else r["updated_at"]
    return {
        "id": r["id"],
        "title": r["title"],
        "note": r["note"],
        "detail": (r["detail"] or "").strip()[:200],
        "status": r["status"],
        "doneDate": date_in_zone(done_ms, tz) if r["status"] == "done" else None,
        "dueDate": r["due_date"],
    }


def build_report(
    conn: sqlite3.Connection,
    user_id: int,
    start: date,
    end: date,
    include: set[str],
    tz: str,
) -> dict[str, Any]:
    zone = get_zone(tz)
    start_ms = local_midnight_ms(start, zone)
    end_ms = local_midnight_ms(end + timedelta(days=1), zone)  # 不含

    user = conn.execute("SELECT id, display_name FROM users WHERE id = ?", (user_id,)).fetchone()

    done_rows = conn.execute(
        _TASK_SELECT + "WHERE t.assignee_id = ? AND t.deleted_at IS NULL AND s.category = 'done' "
        "AND t.completed_at >= ? AND t.completed_at < ? ORDER BY t.completed_at, t.id",
        (user_id, start_ms, end_ms),
    ).fetchall()
    completed_tasks = [_task_item(r, tz) for r in done_rows]

    todo_rows = conn.execute(
        _TODO_SELECT + "WHERE user_id = ? AND task_id IS NULL AND status = 'done' "
        "AND coalesce(done_at, updated_at) >= ? AND coalesce(done_at, updated_at) < ? "
        "ORDER BY coalesce(done_at, updated_at), id",
        (user_id, start_ms, end_ms),
    ).fetchall()
    completed_todos = [_todo_item(r, tz) for r in todo_rows]

    # 依專案分組件數（完成任務；待辦無專案不列入）
    by_project: dict[int, dict[str, Any]] = {}
    for t in completed_tasks:
        g = by_project.setdefault(
            t["projectId"],
            {"projectId": t["projectId"], "projectName": t["projectName"], "projectColor": t["projectColor"], "count": 0},
        )
        g["count"] += 1

    summary: dict[str, Any] = {
        "completedTaskCount": len(completed_tasks),
        "completedTodoCount": len(completed_todos),
        "byProject": sorted(by_project.values(), key=lambda g: (-g["count"], g["projectId"])),
    }
    hours = [t["estimateHours"] for t in completed_tasks if t["estimateHours"] is not None]
    if hours:  # 沒人填就不回傳
        summary["estimatedHours"] = round(sum(hours), 2)
        summary["hoursKnown"] = len(hours)

    result: dict[str, Any] = {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "timeZone": tz,
        "user": {"id": user["id"], "displayName": user["display_name"]} if user else None,
        "summary": summary,
        "completedTasks": completed_tasks,
        "completedTodos": completed_todos,
    }

    if "doing" in include:
        rows = conn.execute(
            _TASK_SELECT + "WHERE t.assignee_id = ? AND t.deleted_at IS NULL AND s.category = 'doing' "
            "AND t.created_at < ? ORDER BY t.project_id, t.sort_order, t.id",
            (user_id, end_ms),
        ).fetchall()
        result["inProgress"] = [_task_item(r, tz) for r in rows]
    statuses = [s for s in ("deferred", "cancelled") if s in include]
    if statuses:
        marks = ",".join("?" * len(statuses))
        rows = conn.execute(
            _TODO_SELECT + f"WHERE user_id = ? AND task_id IS NULL AND status IN ({marks}) ORDER BY sort_order, id",
            (user_id, *statuses),
        ).fetchall()
        result["deferredTodos"] = [_todo_item(r, tz) for r in rows]
    if "created" in include:
        rows = conn.execute(
            _TASK_SELECT + "WHERE t.created_by = ? AND t.deleted_at IS NULL AND t.created_at >= ? AND t.created_at < ? "
            "ORDER BY t.created_at, t.id",
            (user_id, start_ms, end_ms),
        ).fetchall()
        result["createdTasks"] = [{**_task_item(r, tz), "createdDate": date_in_zone(r["created_at"], tz)} for r in rows]
    return result
