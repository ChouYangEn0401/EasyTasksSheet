"""總覽彙總（純函式，方便以固定資料測試；對應 src/server/features/overview/compute.ts）。

定義（docs/design/gantt-overview.md §B4）：
- 目前無任務：category doing 的任務數為 0
- 逾期：到期日早於今天且 category ≠ done
- 未完成預估：category ≠ done 的 estimate_hours 合計
- 本週完成（近似）：category done 且 updated_at 落在本週（週一 00:00 至下週一 00:00，以 tz 計）
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any, Iterable

#: 沒有 IANA 時區資料庫（Windows 未裝 tzdata）時的固定位移備援（皆無日光節約時間）
_FIXED_OFFSETS = {
    "Asia/Taipei": 8,
    "Asia/Shanghai": 8,
    "Asia/Hong_Kong": 8,
    "Asia/Singapore": 8,
    "Asia/Tokyo": 9,
    "UTC": 0,
    "Etc/UTC": 0,
}


def get_zone(name: str) -> tzinfo:
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name)
    except Exception:
        hours = _FIXED_OFFSETS.get(name)
        if hours is None:
            raise
        return timezone(timedelta(hours=hours), name)


def date_in_zone(ms: int, time_zone: str) -> str:
    """某時區下的日期字串 YYYY-MM-DD"""
    return datetime.fromtimestamp(ms / 1000, tz=get_zone(time_zone)).date().isoformat()


def week_of(now: int, time_zone: str) -> dict[str, Any]:
    """本週（週一至週日）範圍與起訖時刻（ms）"""
    zone = get_zone(time_zone)
    today = datetime.fromtimestamp(now / 1000, tz=zone).date()
    start = today - timedelta(days=today.weekday())  # 週一 = 0
    end = start + timedelta(days=6)
    nxt = start + timedelta(days=7)

    def local_midnight(d: date) -> int:
        return int(datetime(d.year, d.month, d.day, tzinfo=zone).timestamp() * 1000)

    return {
        "today": today.isoformat(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "startMs": local_midnight(start),
        "endMs": local_midnight(nxt),
    }


def _name_key(m: dict[str, Any]) -> tuple[str, str]:
    # 近似 localeCompare(..., 'zh-Hant')：不分大小寫，再以原字串定序
    name = m["user"]["displayName"]
    return (name.casefold(), name)


def sort_members(members: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """成員排序：無任務在前（待辦少 → 多，再依名稱）；進行中（逾期多 → 少，再依名稱）"""

    def key(m: dict[str, Any]) -> tuple:
        if m["idle"]:
            return (0, m["counts"]["todo"], _name_key(m))
        return (1, -m["overdue"], _name_key(m))

    return sorted(members, key=key)


def _round2(n: float) -> int | float:
    # 同 JS Math.round(n * 100) / 100（四捨五入，非銀行家捨入）；整數輸出為 int（JSON 同 JS 的 5 而非 5.0）
    r = math.floor(n * 100 + 0.5) / 100
    return int(r) if r == int(r) else r


def compute_overview(
    statuses: list[dict[str, Any]],
    users: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
    now: int,
    time_zone: str,
) -> dict[str, Any]:
    """statuses：id/name/color/category/sortOrder；users：id/username/displayName/isActive；
    tasks（未刪除）：id/title/statusId/assigneeId/dueDate/estimateHours/updatedAt/updatedBy"""
    week = week_of(now, time_zone)
    today = week["today"]
    status_by_id = {s["id"]: s for s in statuses}

    def category_of(t: dict[str, Any]) -> str:
        s = status_by_id.get(t["statusId"])
        return s["category"] if s else "todo"

    def is_overdue(t: dict[str, Any]) -> bool:
        return bool(t["dueDate"]) and t["dueDate"] < today and category_of(t) != "done"

    status_count: dict[int, int] = {}
    overdue = 0
    done_this_week = 0
    by_assignee: dict[int | None, list[dict[str, Any]]] = {}
    for t in tasks:
        status_count[t["statusId"]] = status_count.get(t["statusId"], 0) + 1
        if is_overdue(t):
            overdue += 1
        if category_of(t) == "done" and week["startMs"] <= t["updatedAt"] < week["endMs"]:
            done_this_week += 1
        by_assignee.setdefault(t["assigneeId"], []).append(t)

    def summarize(items: list[dict[str, Any]]) -> dict[str, Any]:
        counts = {"todo": 0, "doing": 0, "done": 0}
        remaining = 0.0
        unestimated = 0
        member_overdue = 0
        last_updated: int | None = None
        doing: list[dict[str, Any]] = []
        for t in items:
            cat = category_of(t)
            counts[cat] = counts.get(cat, 0) + 1
            if cat != "done":
                if t["estimateHours"] is None:
                    unestimated += 1
                else:
                    remaining += t["estimateHours"]
            if is_overdue(t):
                member_overdue += 1
            if last_updated is None or t["updatedAt"] > last_updated:
                last_updated = t["updatedAt"]
            if cat == "doing":
                doing.append(
                    {
                        "id": t["id"],
                        "title": t["title"],
                        "statusId": t["statusId"],
                        "dueDate": t["dueDate"],
                        "updatedAt": t["updatedAt"],
                        "updatedBy": t["updatedBy"],
                    }
                )
        # 到期日（無到期日排後）→ 最近更新 → id
        doing.sort(key=lambda d: (d["dueDate"] is None and 1 or 0, d["dueDate"] or "", -d["updatedAt"], d["id"]))
        return {
            "counts": counts,
            "remainingHours": _round2(remaining),
            "unestimatedCount": unestimated,
            "overdue": member_overdue,
            "lastUpdatedAt": last_updated,
            "doing": doing,
        }

    members = []
    for u in users:
        if not u["isActive"]:
            continue
        s = summarize(by_assignee.get(u["id"], []))
        members.append(
            {
                "user": {"id": u["id"], "username": u["username"], "displayName": u["displayName"]},
                **s,
                "idle": s["counts"]["doing"] == 0,
            }
        )

    un = summarize(by_assignee.get(None, []))
    ordered = sort_members(members)

    return {
        "today": today,
        "weekRange": {"start": week["start"], "end": week["end"]},
        "totals": {
            "byStatus": [
                {
                    "statusId": s["id"],
                    "name": s["name"],
                    "category": s["category"],
                    "color": s["color"],
                    "count": status_count.get(s["id"], 0),
                }
                for s in sorted(statuses, key=lambda s: (s["sortOrder"], s["id"]))
            ],
            "overdue": overdue,
            "doneThisWeek": done_this_week,
            "idleMembers": sum(1 for m in ordered if m["idle"]),
            "activeMembers": len(ordered),
        },
        "members": ordered,
        "unassigned": {
            "openCount": un["counts"]["todo"] + un["counts"]["doing"],
            "remainingHours": un["remainingHours"],
            "unestimatedCount": un["unestimatedCount"],
        },
    }
