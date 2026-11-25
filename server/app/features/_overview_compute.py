"""總覽彙總（純函式，方便以固定資料測試）。

定義（docs/design/gantt-overview.md §B4）：
- 目前無任務：category doing 的任務數為 0
- 逾期：到期日早於今天且 category ≠ done
- 未完成預估：category ≠ done 的 estimate_hours 合計
- 本週完成：category done 且 completed_at 落在本週（週一 00:00 至下週一 00:00，以 tz 計）
- 不列入總覽統計的帳號（users.in_overview = 0）：不出現在成員卡片與「目前無任務」統計、近三週不計入成員與團隊合計；
  任務本身不受影響（指派給他們的任務不列入任何成員卡，也不計入「未指派」）
- 成員排序：只依數值條件與使用者 id 穩定排序；名稱定序交給前端（Intl.Collator，Python 端無 ICU）
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Any, Iterable

from ..timeutil import get_zone, local_midnight_ms


def week_of(now: int, time_zone: str) -> dict[str, Any]:
    """本週（週一至週日）範圍與起訖時刻（ms）"""
    zone = get_zone(time_zone)
    today = datetime.fromtimestamp(now / 1000, tz=zone).date()
    start = today - timedelta(days=today.weekday())  # 週一 = 0
    end = start + timedelta(days=6)
    nxt = start + timedelta(days=7)
    return {
        "today": today.isoformat(),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "startMs": local_midnight_ms(start, zone),
        "endMs": local_midnight_ms(nxt, zone),
    }


def sort_members(members: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """成員排序：無任務在前（待辦少 → 多）；進行中（逾期多 → 少）；同條件依使用者 id。

    不以名稱排序：Python 端無 ICU，中文定序與瀏覽器不同；前端會在同條件成員間以
    Intl.Collator('zh-Hant') 依顯示名稱重排（src/web/features/overview/sortMembers.ts）。
    """

    def key(m: dict[str, Any]) -> tuple:
        if m["idle"]:
            return (0, m["counts"]["todo"], m["user"]["id"])
        return (1, -m["overdue"], m["user"]["id"])

    return sorted(members, key=key)


def _round2(n: float) -> int | float:
    # 同 JS Math.round(n * 100) / 100（四捨五入，非銀行家捨入）；整數輸出為 int（JSON 同 JS 的 5 而非 5.0）
    r = math.floor(n * 100 + 0.5) / 100
    return int(r) if r == int(r) else r


#: 詳情清單每人每週最多回傳的任務數
ACTIVITY_ITEMS_LIMIT = 20


def activity_weeks(now: int, time_zone: str, weeks: int) -> list[dict[str, Any]]:
    """最近 N 週（含本週，週一至週日，以 tz 計），由舊到新；最後一週為進行中的本週"""
    zone = get_zone(time_zone)
    cur = week_of(now, time_zone)
    start0 = date.fromisoformat(cur["start"])
    out = []
    for back in range(weeks - 1, -1, -1):
        s = start0 - timedelta(days=7 * back)
        out.append(
            {
                "start": s.isoformat(),
                "end": (s + timedelta(days=6)).isoformat(),
                "startMs": local_midnight_ms(s, zone),
                "endMs": local_midnight_ms(s + timedelta(days=7), zone),
                "current": back == 0,
            }
        )
    return out


def compute_activity(
    statuses: list[dict[str, Any]],
    users: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
    changes: list[dict[str, Any]],
    now: int,
    time_zone: str,
    weeks: int = 3,
    retention_days: float = 30,
) -> dict[str, Any]:
    """近 N 週大家大概做了多少事（docs/design/gantt-overview.md §B5）。

    tasks（未刪除）：id/title/statusId/assigneeId/estimateHours/completedAt
    changes（entity_type = task，action 為 create / update）：entityId/actorId/createdAt

    - completed：completed_at 落在該週、目前仍為 done 的任務，歸給目前的負責人
    - touched：該成員在該週新增或更新過的不同任務數（依 changes 表；已刪除任務不計）
    - involved：completed ∪ touched 的不同任務數（迷你直條的高度依據）
    - completedHours / hoursKnown：完成任務中有填 estimate_hours 者的合計與件數
    - changes 只保留 retention_days 天；週起點早於保留界線時 touchedPartial = true
    """
    week_list = activity_weeks(now, time_zone, weeks)
    cutoff = now - int(retention_days * 86_400_000)
    status_by_id = {s["id"]: s for s in statuses}
    task_by_id = {t["id"]: t for t in tasks}
    # 不列入總覽統計的帳號（in_overview = 0）：其完成 / 處理不計入成員，也不計入團隊合計
    excluded = {u["id"] for u in users if not u.get("inOverview", True)}

    def week_index(ms: int | None) -> int | None:
        if ms is None:
            return None
        for i, w in enumerate(week_list):
            if w["startMs"] <= ms < w["endMs"]:
                return i
        return None

    # (key, week) -> {task_id: {"completedAt": ms | None, "touchedAt": ms | None}}；key 為 user id 或 "team"
    buckets: dict[tuple[Any, int], dict[int, dict[str, int | None]]] = {}

    def mark(key: Any, wi: int, tid: int, field: str, ms: int) -> None:
        entry = buckets.setdefault((key, wi), {}).setdefault(tid, {"completedAt": None, "touchedAt": None})
        prev = entry[field]
        if prev is None or ms > prev:
            entry[field] = ms

    for t in tasks:
        s = status_by_id.get(t["statusId"])
        if not s or s["category"] != "done":
            continue
        wi = week_index(t.get("completedAt"))
        if wi is None:
            continue
        if t["assigneeId"] in excluded:
            continue
        mark("team", wi, t["id"], "completedAt", t["completedAt"])
        if t["assigneeId"] is not None:
            mark(t["assigneeId"], wi, t["id"], "completedAt", t["completedAt"])

    for c in changes:
        if c["entityId"] not in task_by_id or c["actorId"] is None or c["actorId"] in excluded:
            continue
        wi = week_index(c["createdAt"])
        if wi is None:
            continue
        mark("team", wi, c["entityId"], "touchedAt", c["createdAt"])
        mark(c["actorId"], wi, c["entityId"], "touchedAt", c["createdAt"])

    def stats(key: Any, wi: int, with_items: bool) -> dict[str, Any]:
        entries = buckets.get((key, wi), {})
        completed = [tid for tid, e in entries.items() if e["completedAt"] is not None]
        hours = 0.0
        known = 0
        for tid in completed:
            h = task_by_id[tid]["estimateHours"]
            if h is not None:
                hours += h
                known += 1
        out: dict[str, Any] = {
            "completed": len(completed),
            "touched": sum(1 for e in entries.values() if e["touchedAt"] is not None),
            "involved": len(entries),
            "completedHours": _round2(hours),
            "hoursKnown": known,
        }
        if with_items:
            items = []
            for tid, e in entries.items():
                t = task_by_id[tid]
                items.append(
                    {
                        "id": tid,
                        "title": t["title"],
                        "statusId": t["statusId"],
                        "estimateHours": t["estimateHours"],
                        "completed": e["completedAt"] is not None,
                        "touched": e["touchedAt"] is not None,
                        # 完成的任務以完成時刻為準，其餘以該週最後一次處理的時刻
                        "at": e["completedAt"] if e["completedAt"] is not None else e["touchedAt"],
                    }
                )
            # 完成在前，再依時間新 → 舊、id
            items.sort(key=lambda x: (0 if x["completed"] else 1, -x["at"], x["id"]))
            out["items"] = items[:ACTIVITY_ITEMS_LIMIT]
            out["itemsTotal"] = len(items)
        return out

    return {
        "weeks": [
            {
                "start": w["start"],
                "end": w["end"],
                "current": w["current"],
                "touchedPartial": w["startMs"] < cutoff,
            }
            for w in week_list
        ],
        "teamWeeks": [stats("team", i, False) for i in range(len(week_list))],
        "members": [
            {"userId": u["id"], "weeks": [stats(u["id"], i, True) for i in range(len(week_list))]}
            for u in sorted(users, key=lambda u: u["id"])
            if u["isActive"] and u["id"] not in excluded
        ],
    }


def compute_overview(
    statuses: list[dict[str, Any]],
    users: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
    now: int,
    time_zone: str,
) -> dict[str, Any]:
    """statuses：id/name/color/category/sortOrder；users：id/username/displayName/isActive；
    tasks（未刪除）：id/title/statusId/assigneeId/dueDate/estimateHours/updatedAt/updatedBy/completedAt"""
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
        completed_at = t.get("completedAt")
        if category_of(t) == "done" and completed_at is not None and week["startMs"] <= completed_at < week["endMs"]:
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
        if not u["isActive"] or not u.get("inOverview", True):
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
