"""GET /api/overview/activity：近三週大家大概做了多少事（docs/design/gantt-overview.md §B5）"""

from datetime import datetime

from server.app.changes import record_change
from server.app.features._overview_compute import ACTIVITY_ITEMS_LIMIT, activity_weeks, compute_activity

from .helpers import FakeClock, client, create_test_app, create_test_user, login_as

# 種子狀態：1 待辦(todo)、2 進行中(doing)、3 審查中(doing)、4 完成(done)
TODO, DOING, REVIEW, DONE = 1, 2, 3, 4
DAY = 86_400_000


def at(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def setup(now_iso: str = "2026-01-07T10:00:00+08:00"):
    """假時鐘預設 2026-01-07（週三）：本週 1/5–1/11、上週 12/29–1/4、前週 12/22–12/28"""
    clock = FakeClock(at(now_iso))
    t = create_test_app(now=clock.now)
    alice = create_test_user(t.db, display_name="Alice")
    bob = create_test_user(t.db, display_name="Bob")
    eve = create_test_user(t.db, display_name="Eve", is_active=0)

    def add(title, status_id, assignee_id=None, estimate_hours=None, completed_at=None, deleted_at=None):
        with t.db.tx() as conn:
            cur = conn.execute(
                "INSERT INTO tasks (project_id, title, status_id, assignee_id, estimate_hours, updated_at, created_at, "
                "deleted_at, completed_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
                (title, status_id, assignee_id, estimate_hours, 1, 1, deleted_at, completed_at),
            )
            return cur.lastrowid

    def touch(task_id, actor_id, iso, action="update"):
        with t.db.tx() as conn:
            record_change(conn, "task", task_id, action, actor_id, at(iso))

    return t, clock, alice, bob, eve, add, touch


def get(t, user):
    res = login_as(t, user).get("/api/overview/activity")
    assert res.status_code == 200, res.text
    return res.json()


def member(o, user):
    return next(m for m in o["members"] if m["userId"] == user["id"])


def test_unauthenticated_401():
    t = create_test_app()
    assert client(t).get("/api/overview/activity").status_code == 401


def test_week_boundaries_in_taipei():
    t, clock, alice, bob, eve, add, touch = setup()
    # 本週一 00:00（台北）= UTC 1/4 16:00 → 本週；前一秒 → 上週
    add("本週一凌晨", DONE, alice["id"], completed_at=at("2026-01-04T16:00:00Z"))
    add("上週日深夜", DONE, alice["id"], completed_at=at("2026-01-04T15:59:59Z"))
    # 前週一 00:00 → 前週；更早 → 不計
    add("前週一", DONE, alice["id"], completed_at=at("2025-12-22T00:00:00+08:00"))
    add("更早", DONE, alice["id"], completed_at=at("2025-12-21T23:59:59+08:00"))
    o = get(t, alice)

    assert o["weeks"] == [
        {"start": "2025-12-22", "end": "2025-12-28", "current": False, "touchedPartial": False},
        {"start": "2025-12-29", "end": "2026-01-04", "current": False, "touchedPartial": False},
        {"start": "2026-01-05", "end": "2026-01-11", "current": True, "touchedPartial": False},
    ]
    assert [w["completed"] for w in member(o, alice)["weeks"]] == [1, 1, 1]
    assert [w["completed"] for w in o["teamWeeks"]] == [1, 1, 1]
    titles = [[i["title"] for i in w["items"]] for w in member(o, alice)["weeks"]]
    assert titles == [["前週一"], ["上週日深夜"], ["本週一凌晨"]]


def test_counts_hours_items_and_exclusions():
    t, clock, alice, bob, eve, add, touch = setup()
    # Alice 本週：完成 2（一筆有估時 3.5h、一筆沒填），另處理 1 筆進行中的任務
    a1 = add("完成有估時", DONE, alice["id"], 3.5, completed_at=at("2026-01-06T10:00:00+08:00"))
    a2 = add("完成沒估時", DONE, alice["id"], completed_at=at("2026-01-06T11:00:00+08:00"))
    a3 = add("進行中", DOING, alice["id"], 8)
    touch(a1, alice["id"], "2026-01-06T09:00:00+08:00", "create")
    touch(a1, alice["id"], "2026-01-06T10:00:00+08:00")
    touch(a3, alice["id"], "2026-01-06T12:00:00+08:00")
    touch(a3, alice["id"], "2026-01-07T09:00:00+08:00")  # 同一任務多次只算一件
    # Alice 也處理了 Bob 的任務（處理歸給動手的人，完成歸給負責人）
    b1 = add("Bob 的任務", DONE, bob["id"], 2, completed_at=at("2026-01-07T08:00:00+08:00"))
    touch(b1, alice["id"], "2026-01-06T15:00:00+08:00")
    # 不計：軟刪除任務、delete 動作、無操作者、已改回非 done 的任務（completed_at 已清空）
    gone = add("已刪除", DONE, alice["id"], 5, completed_at=at("2026-01-06T10:00:00+08:00"), deleted_at=1)
    touch(gone, alice["id"], "2026-01-06T10:00:00+08:00")
    touch(a2, alice["id"], "2026-01-06T13:00:00+08:00", "delete")
    touch(a2, None, "2026-01-06T13:00:00+08:00")
    add("改回進行中", DOING, alice["id"], 1)
    # 停用成員：不列為成員，但其處理的任務仍計入全隊
    e1 = add("Eve 處理", TODO)
    touch(e1, eve["id"], "2026-01-06T10:00:00+08:00")

    o = get(t, alice)
    ids = [m["userId"] for m in o["members"]]
    assert alice["id"] in ids and bob["id"] in ids and eve["id"] not in ids

    wa = member(o, alice)["weeks"][2]
    assert {k: wa[k] for k in ("completed", "touched", "involved", "completedHours", "hoursKnown", "itemsTotal")} == {
        "completed": 2,
        "touched": 3,  # a1、a3、b1
        "involved": 4,  # a1、a2、a3、b1
        "completedHours": 3.5,
        "hoursKnown": 1,
        "itemsTotal": 4,
    }
    # 完成在前（新 → 舊），其後為處理過的任務（新 → 舊）
    assert [i["id"] for i in wa["items"]] == [a2, a1, a3, b1]
    assert wa["items"][1] == {
        "id": a1,
        "title": "完成有估時",
        "statusId": DONE,
        "estimateHours": 3.5,
        "completed": True,
        "touched": True,
        "at": at("2026-01-06T10:00:00+08:00"),
    }
    assert wa["items"][2]["at"] == at("2026-01-07T09:00:00+08:00")

    wb = member(o, bob)["weeks"][2]
    assert (wb["completed"], wb["touched"], wb["completedHours"], wb["hoursKnown"]) == (1, 0, 2, 1)

    team = o["teamWeeks"][2]
    assert team == {"completed": 3, "touched": 4, "involved": 5, "completedHours": 5.5, "hoursKnown": 2}
    assert "items" not in team
    # 之前兩週沒有紀錄
    assert [w["involved"] for w in member(o, alice)["weeks"][:2]] == [0, 0]
    assert member(o, alice)["weeks"][0]["items"] == []


def test_no_estimates_means_zero_hours_known():
    t, clock, alice, bob, eve, add, touch = setup()
    add("沒估時", DONE, alice["id"], completed_at=at("2026-01-06T10:00:00+08:00"))
    w = member(get(t, alice), alice)["weeks"][2]
    assert (w["completed"], w["completedHours"], w["hoursKnown"]) == (1, 0, 0)


def test_items_limit():
    t, clock, alice, bob, eve, add, touch = setup()
    for i in range(ACTIVITY_ITEMS_LIMIT + 5):
        add(f"T{i}", DONE, alice["id"], completed_at=at("2026-01-06T10:00:00+08:00") + i)
    w = member(get(t, alice), alice)["weeks"][2]
    assert w["completed"] == ACTIVITY_ITEMS_LIMIT + 5
    assert w["itemsTotal"] == ACTIVITY_ITEMS_LIMIT + 5
    assert len(w["items"]) == ACTIVITY_ITEMS_LIMIT


def test_weeks_param_and_pruned_changes():
    """changes 只保留 30 天：處理件數只能回溯到保留界線；完成件數依 tasks.completed_at 不受影響"""
    t, clock, alice, bob, eve, add, touch = setup("2026-01-11T22:00:00+08:00")  # 週日
    task = add("很久以前", DONE, alice["id"], completed_at=at("2025-12-15T10:00:00+08:00"))
    touch(task, alice["id"], "2025-12-15T10:00:00+08:00")
    api = login_as(t, alice)
    o = api.get("/api/overview/activity?weeks=4").json()
    assert [w["start"] for w in o["weeks"]] == ["2025-12-15", "2025-12-22", "2025-12-29", "2026-01-05"]
    # 第 4 週起點（12/15）在保留界線（12/12 22:00）之後，資料完整
    assert [w["touchedPartial"] for w in o["weeks"]] == [False, False, False, False]
    assert member(o, alice)["weeks"][0]["touched"] == 1
    # 清掉超過保留期限的變更後，處理件數歸零、完成件數仍在
    with t.db.tx() as conn:
        conn.execute("DELETE FROM changes WHERE created_at < ?", (at("2025-12-20T00:00:00+08:00"),))
    w0 = member(api.get("/api/overview/activity?weeks=4").json(), alice)["weeks"][0]
    assert (w0["completed"], w0["touched"]) == (1, 0)
    # weeks 範圍限制 1–4；非數字回到預設 3
    assert len(api.get("/api/overview/activity?weeks=9").json()["weeks"]) == 4
    assert len(api.get("/api/overview/activity?weeks=0").json()["weeks"]) == 1
    assert len(api.get("/api/overview/activity?weeks=abc").json()["weeks"]) == 3


def test_touched_partial_flag_pure():
    now = at("2026-01-11T22:00:00+08:00")
    o = compute_activity(statuses=[], users=[], tasks=[], changes=[], now=now, time_zone="Asia/Taipei",
                         weeks=4, retention_days=20)
    # 保留 20 天 → 界線 12/22 22:00；12/15 與 12/22 00:00 起的兩週不完整
    assert [w["touchedPartial"] for w in o["weeks"]] == [True, True, False, False]
    assert o["members"] == [] and len(o["teamWeeks"]) == 4


def test_activity_weeks_across_utc_day():
    # UTC 1/4 16:30 = 台北 1/5（週一）00:30 → 本週從 1/5 起
    ws = activity_weeks(at("2026-01-04T16:30:00Z"), "Asia/Taipei", 3)
    assert [w["start"] for w in ws] == ["2025-12-22", "2025-12-29", "2026-01-05"]
    assert ws[-1]["startMs"] == at("2026-01-05T00:00:00+08:00")
    assert ws[0]["endMs"] == ws[1]["startMs"] and ws[1]["endMs"] == ws[2]["startMs"]
    assert ws[-1]["endMs"] - ws[0]["startMs"] == 21 * DAY


def test_activity_via_real_api_flow():
    """透過 API 新增 / 完成任務時，changes 與 completed_at 會被正確記錄並反映在本週"""
    t, clock, alice, bob, eve, add, touch = setup()
    api = login_as(t, alice)
    task = api.request("POST", "/api/tasks", {"title": "新任務", "assigneeId": bob["id"], "estimateHours": 2}).json()
    api.request("PATCH", f"/api/tasks/{task['id']}", {"statusId": DONE})
    o = api.get("/api/overview/activity").json()
    wa = member(o, alice)["weeks"][2]
    wb = member(o, bob)["weeks"][2]
    assert (wa["completed"], wa["touched"]) == (0, 1)
    assert (wb["completed"], wb["touched"], wb["completedHours"]) == (1, 0, 2)
