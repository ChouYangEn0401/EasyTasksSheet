"""總覽（/api/overview 與 _overview_compute 純函式）"""

from datetime import datetime

from server.app.features._overview_compute import sort_members, week_of

from .helpers import FakeClock, client, create_test_app, create_test_user, login_as

# 種子狀態：1 待辦(todo)、2 進行中(doing)、3 審查中(doing)、4 完成(done)
TODO, DOING, REVIEW, DONE = 1, 2, 3, 4


def at(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def setup():
    """固定測試資料：假時鐘 2026-01-05（週一）09:00 +08:00"""
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    alice = create_test_user(t.db, display_name="Alice")
    bob = create_test_user(t.db, display_name="Bob")
    carol = create_test_user(t.db, display_name="Carol")
    dave = create_test_user(t.db, display_name="Dave")
    eve = create_test_user(t.db, display_name="Eve", is_active=0)
    seq = [0]

    def add(
        status_id,
        assignee_id=None,
        due_date=None,
        estimate_hours=None,
        updated_at=None,
        deleted_at=None,
        completed_at=None,
    ):
        seq[0] += 1
        updated = clock.now() if updated_at is None else updated_at
        # done 任務未指定完成時間時，以 updated_at 為完成時間
        completed = completed_at if completed_at is not None else (updated if status_id == DONE else None)
        with t.db.tx() as conn:
            cur = conn.execute(
                "INSERT INTO tasks (project_id, title, status_id, assignee_id, due_date, estimate_hours, "
                "updated_at, created_at, deleted_at, updated_by, completed_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    f"T{seq[0]}",
                    status_id,
                    assignee_id,
                    due_date,
                    estimate_hours,
                    updated,
                    at("2025-12-01T00:00:00+08:00"),
                    deleted_at,
                    alice["id"],
                    completed,
                ),
            )
            return {"id": cur.lastrowid, "title": f"T{seq[0]}"}

    # Alice：進行中 2（含審查中）、待辦 1（逾期）、完成 2（一筆本週、一筆上週）
    a1 = add(DOING, alice["id"], "2026-01-10", 3)
    a2 = add(REVIEW, alice["id"], updated_at=at("2026-01-05T08:30:00+08:00"))
    add(TODO, alice["id"], "2026-01-04", 2)
    add(DONE, alice["id"], estimate_hours=5, updated_at=at("2026-01-05T00:00:00+08:00"))
    add(DONE, alice["id"], updated_at=at("2026-01-04T23:59:59+08:00"))
    # Bob：只有待辦（目前無任務）
    add(TODO, bob["id"], estimate_hours=1.5)
    add(TODO, bob["id"], "2026-01-01", 2)
    # Carol：沒有任何任務（已刪除的不算）
    add(DOING, carol["id"], deleted_at=clock.now())
    # Dave：進行中且逾期、待辦逾期、已完成（到期已過但完成不算逾期；週日晚上更新仍屬本週）
    add(DOING, dave["id"], "2025-12-30", 4)
    add(TODO, dave["id"], "2026-01-02")
    add(DONE, dave["id"], "2025-12-01", updated_at=at("2026-01-11T23:00:00+08:00"))
    # Eve（停用）：不列入成員，但計入狀態總數
    add(DOING, eve["id"])
    # 未指派
    add(TODO, estimate_hours=2)
    add(DOING)
    add(DONE, updated_at=at("2026-01-12T00:00:00+08:00"))  # 下週一 00:00，不算本週
    # 上週完成、本週才被編輯其他欄位：依 completed_at，不算本週
    add(DONE, completed_at=at("2026-01-02T10:00:00+08:00"))
    # 本週完成但已軟刪除：不計
    add(DONE, completed_at=at("2026-01-05T08:00:00+08:00"), deleted_at=clock.now())

    api = login_as(t, alice)
    return api, alice, bob, carol, dave, a1, a2


def test_unauthenticated_401():
    t = create_test_app()
    assert client(t).get("/api/overview").status_code == 401


def test_overview_numbers():
    api, alice, bob, carol, dave, a1, a2 = setup()
    res = api.get("/api/overview")
    assert res.status_code == 200
    o = res.json()

    assert o["today"] == "2026-01-05"
    assert o["weekRange"] == {"start": "2026-01-05", "end": "2026-01-11"}
    assert [[s["name"], s["category"], s["count"]] for s in o["totals"]["byStatus"]] == [
        ["待辦", "todo", 5],
        ["進行中", "doing", 4],
        ["審查中", "doing", 1],
        ["完成", "done", 5],
    ]
    assert set(o["totals"]["byStatus"][0]) == {"statusId", "name", "category", "color", "count"}
    assert o["totals"]["overdue"] == 4
    assert o["totals"]["doneThisWeek"] == 2
    assert o["totals"]["idleMembers"] == 2
    assert o["totals"]["activeMembers"] == 4

    # 排序：無任務（待辦少 → 多）在前，其後進行中（逾期多 → 少）
    assert [m["user"]["displayName"] for m in o["members"]] == ["Carol", "Bob", "Dave", "Alice"]
    m = {x["user"]["id"]: x for x in o["members"]}
    assert set(m[alice["id"]]) == {
        "user",
        "doing",
        "counts",
        "overdue",
        "remainingHours",
        "unestimatedCount",
        "lastUpdatedAt",
        "idle",
    }
    assert set(m[alice["id"]]["user"]) == {"id", "username", "displayName"}

    ma = m[alice["id"]]
    assert ma["idle"] is False
    assert ma["counts"] == {"todo": 1, "doing": 2, "done": 2}
    assert ma["overdue"] == 1
    assert ma["remainingHours"] == 5
    assert ma["unestimatedCount"] == 1
    assert ma["lastUpdatedAt"] == at("2026-01-05T09:00:00+08:00")
    # 進行中任務依到期日排序，無到期日在後
    assert [d["id"] for d in ma["doing"]] == [a1["id"], a2["id"]]
    assert ma["doing"][0] == {
        "id": a1["id"],
        "title": a1["title"],
        "statusId": DOING,
        "dueDate": "2026-01-10",
        "updatedAt": at("2026-01-05T09:00:00+08:00"),
        "updatedBy": alice["id"],
    }

    mb = m[bob["id"]]
    assert mb["idle"] is True and mb["doing"] == []
    assert mb["counts"] == {"todo": 2, "doing": 0, "done": 0}
    assert mb["overdue"] == 1 and mb["remainingHours"] == 3.5 and mb["unestimatedCount"] == 0

    mc = m[carol["id"]]
    assert mc["idle"] is True and mc["doing"] == []
    assert mc["counts"] == {"todo": 0, "doing": 0, "done": 0}
    assert mc["overdue"] == 0 and mc["remainingHours"] == 0 and mc["lastUpdatedAt"] is None

    md = m[dave["id"]]
    assert md["idle"] is False
    assert md["counts"] == {"todo": 1, "doing": 1, "done": 1}
    assert md["overdue"] == 2 and md["remainingHours"] == 4 and md["unestimatedCount"] == 1

    assert o["unassigned"] == {"openCount": 2, "remainingHours": 2, "unestimatedCount": 1}
    # 整數工時輸出同 JS（5 而非 5.0）
    assert '"remainingHours":5,' in res.text


def test_week_of_taipei_across_utc_day():
    # UTC 1/4 16:30 = 台北 1/5（週一）00:30
    w = week_of(at("2026-01-04T16:30:00Z"), "Asia/Taipei")
    assert w["today"] == "2026-01-05" and w["start"] == "2026-01-05" and w["end"] == "2026-01-11"
    assert w["startMs"] == at("2026-01-05T00:00:00+08:00")
    assert w["endMs"] == at("2026-01-12T00:00:00+08:00")
    # 週日
    w = week_of(at("2026-11-29T20:00:00+08:00"), "Asia/Taipei")
    assert w["start"] == "2026-11-23" and w["end"] == "2026-11-29"


def test_sort_members_by_user_id_on_tie():
    """同條件不依名稱（Python 無 ICU），改依使用者 id；名稱定序由前端處理"""

    def mk(uid, name, idle, todo, overdue):
        return {
            "user": {"id": uid, "username": name, "displayName": name},
            "idle": idle,
            "counts": {"todo": todo, "doing": 0 if idle else 1, "done": 0},
            "overdue": overdue,
        }

    ordered = sort_members(
        [
            mk(4, "a", False, 0, 1),
            mk(3, "b", False, 0, 1),
            mk(5, "王", False, 0, 3),
            mk(2, "y", True, 1, 0),
            mk(1, "z", True, 1, 0),
            mk(6, "陳", True, 0, 0),
        ]
    )
    assert [x["user"]["id"] for x in ordered] == [6, 1, 2, 5, 3, 4]


def _week_count_app():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    alice = create_test_user(t.db, display_name="Alice")
    return t, clock, alice, login_as(t, alice)


def test_done_this_week_follows_completed_at_via_api():
    t, clock, alice, api = _week_count_app()
    # 上週日完成（台北 1/4 23:00）
    clock.set(at("2026-01-04T23:00:00+08:00"))
    old = api.request("POST", "/api/tasks", {"title": "上週完成", "statusId": DONE}).json()
    # 本週一 09:00：編輯上週完成任務的其他欄位 → 仍不算本週
    clock.set(at("2026-01-05T09:00:00+08:00"))
    api = login_as(t, alice)  # 時鐘跳過閒置逾時，重新登入
    api.request("PATCH", f"/api/tasks/{old['id']}", {"title": "改標題"})
    assert api.get("/api/overview").json()["totals"]["doneThisWeek"] == 0
    # 本週完成一筆
    task = api.request("POST", "/api/tasks", {"title": "本週"}).json()
    api.request("PATCH", f"/api/tasks/{task['id']}", {"statusId": DONE})
    assert api.get("/api/overview").json()["totals"]["doneThisWeek"] == 1
    # 改回非 done → 不計；軟刪除的 done 任務不計
    api.request("PATCH", f"/api/tasks/{task['id']}", {"statusId": DOING})
    assert api.get("/api/overview").json()["totals"]["doneThisWeek"] == 0
    gone = api.request("POST", "/api/tasks", {"title": "刪除", "statusId": DONE}).json()
    assert api.get("/api/overview").json()["totals"]["doneThisWeek"] == 1
    api.request("DELETE", f"/api/tasks/{gone['id']}")
    assert api.get("/api/overview").json()["totals"]["doneThisWeek"] == 0
