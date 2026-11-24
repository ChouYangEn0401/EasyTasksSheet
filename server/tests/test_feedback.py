"""對應 src/server/features/feedback/feedback.test.ts"""

from server.app.features.feedback import derive_feedback_status

from .helpers import FakeClock, client, create_test_app, create_test_user, login_as


def setup():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    alice = create_test_user(t.db, display_name="Alice")
    bob = create_test_user(t.db, display_name="Bob")
    a = login_as(t, alice)
    b = login_as(t, bob)

    def change_rows():
        return [
            dict(r)
            for r in t.db.all("SELECT entity_type, entity_id, action, actor_id, created_at FROM changes ORDER BY id")
        ]

    return t, clock, alice, bob, a, b, change_rows


def test_derive_feedback_status():
    """排入即 scheduled、清空即 open、resolved 優先"""
    assert derive_feedback_status(False, None) == "open"
    assert derive_feedback_status(False, "2026-11-24") == "scheduled"
    assert derive_feedback_status(True, "2026-11-24") == "resolved"
    assert derive_feedback_status(True, None) == "resolved"


def test_unauthenticated_401():
    t, *_ = setup()
    assert client(t).get("/api/feedback").status_code == 401


def test_create_needs_only_kind_and_title():
    """只需 kind + title 即可建立；reporter 為自己、狀態為 open；驗證錯誤回 400"""
    _t, clock, alice, _bob, a, _b, change_rows = setup()
    res = a.request("POST", "/api/feedback", {"kind": "problem", "title": "  離心機溫度異常 "})
    assert res.status_code == 201
    item = res.json()
    assert item == {
        "id": item["id"],
        "projectId": None,
        "kind": "problem",
        "title": "離心機溫度異常",
        "body": "",
        "status": "open",
        "scheduledDate": None,
        "reporterId": alice["id"],
        "assigneeId": None,
        "updatedBy": alice["id"],
        "createdAt": clock.now(),
        "updatedAt": clock.now(),
    }
    rows = change_rows()
    assert len(rows) == 1
    assert rows[0]["entity_type"] == "feedback" and rows[0]["entity_id"] == item["id"]
    assert rows[0]["action"] == "create" and rows[0]["actor_id"] == alice["id"]

    assert a.request("POST", "/api/feedback", {"kind": "problem", "title": "  "}).status_code == 400
    assert a.request("POST", "/api/feedback", {"kind": "bug", "title": "x"}).status_code == 400
    assert a.request("POST", "/api/feedback", {"title": "x"}).status_code == 400
    assert a.request("POST", "/api/feedback", {"kind": "feedback", "title": "x", "assigneeId": 999}).status_code == 400
    assert (
        a.request("POST", "/api/feedback", {"kind": "feedback", "title": "x", "scheduledDate": "2026-02-30"}).status_code
        == 400
    )
    bad = a.request("POST", "/api/feedback", {"kind": "bug", "title": "x"}).json()
    assert bad["error"]["code"] == "VALIDATION_ERROR"
    # 建立時帶排程日即為已排程
    sched = a.request("POST", "/api/feedback", {"kind": "feedback", "title": "週報", "scheduledDate": "2026-11-26"}).json()
    assert sched["status"] == "scheduled"


def test_schedule_reschedule_unschedule():
    """排程 / 改期 / 取消排程由 scheduledDate 推導狀態；每次寫入記錄變更與 updatedAt / updatedBy"""
    _t, clock, alice, bob, a, b, change_rows = setup()
    item = a.request("POST", "/api/feedback", {"kind": "problem", "title": "t"}).json()

    clock.advance(60_000)
    scheduled = b.request("PATCH", f"/api/feedback/{item['id']}", {"scheduledDate": "2026-11-26"}).json()
    assert scheduled["status"] == "scheduled"
    assert scheduled["scheduledDate"] == "2026-11-26"
    assert scheduled["reporterId"] == alice["id"]
    assert scheduled["updatedBy"] == bob["id"]
    assert scheduled["updatedAt"] == clock.now()
    assert scheduled["createdAt"] == item["createdAt"]

    moved = a.request("PATCH", f"/api/feedback/{item['id']}", {"scheduledDate": "2026-12-01"}).json()
    assert moved["status"] == "scheduled" and moved["scheduledDate"] == "2026-12-01"
    assert moved["updatedBy"] == alice["id"]

    # 只改其他欄位不影響狀態
    edited = a.request(
        "PATCH", f"/api/feedback/{item['id']}", {"title": "新標題", "body": "內容", "assigneeId": bob["id"]}
    ).json()
    assert edited["title"] == "新標題" and edited["body"] == "內容"
    assert edited["assigneeId"] == bob["id"] and edited["status"] == "scheduled"

    cleared = a.request("PATCH", f"/api/feedback/{item['id']}", {"scheduledDate": None}).json()
    assert cleared["status"] == "open" and cleared["scheduledDate"] is None

    assert [r["action"] for r in change_rows()] == ["create", "update", "update", "update", "update"]

    # 不可直接寫 status
    ignored = a.request("PATCH", f"/api/feedback/{item['id']}", {"status": "resolved"}).json()
    assert ignored["status"] == "open"
    assert a.request("PATCH", f"/api/feedback/{item['id']}", {"scheduledDate": "11/26"}).status_code == 400
    assert a.request("PATCH", "/api/feedback/999", {"title": "x"}).status_code == 404


def test_resolve_keeps_schedule_and_reopen():
    """標記已解決保留排程日；重新開啟依排程日回到 scheduled / open"""
    _t, _clock, _alice, _bob, a, _b, _cr = setup()
    item = a.request("POST", "/api/feedback", {"kind": "problem", "title": "t", "scheduledDate": "2026-11-26"}).json()
    resolved = a.request("PATCH", f"/api/feedback/{item['id']}", {"resolved": True}).json()
    assert resolved["status"] == "resolved" and resolved["scheduledDate"] == "2026-11-26"

    # 已解決時改排程日仍維持已解決
    moved = a.request("PATCH", f"/api/feedback/{item['id']}", {"scheduledDate": "2026-11-27"}).json()
    assert moved["status"] == "resolved" and moved["scheduledDate"] == "2026-11-27"

    reopened = a.request("PATCH", f"/api/feedback/{item['id']}", {"resolved": False}).json()
    assert reopened["status"] == "scheduled" and reopened["scheduledDate"] == "2026-11-27"

    a.request("PATCH", f"/api/feedback/{item['id']}", {"resolved": True, "scheduledDate": None})
    reopened_open = a.request("PATCH", f"/api/feedback/{item['id']}", {"resolved": False}).json()
    assert reopened_open["status"] == "open"


def test_list_order_and_filters():
    """列表依建立時間新→舊；可依 kind / status / 排程區間篩選"""
    _t, clock, _alice, _bob, a, _b, _cr = setup()

    def mk(body):
        clock.advance(1000)
        return a.request("POST", "/api/feedback", body).json()

    p1 = mk({"kind": "problem", "title": "p1"})
    f1 = mk({"kind": "feedback", "title": "f1", "scheduledDate": "2026-11-10"})
    p2 = mk({"kind": "problem", "title": "p2", "scheduledDate": "2026-12-05"})
    a.request("PATCH", f"/api/feedback/{p2['id']}", {"resolved": True})

    def ids(qs):
        return [x["id"] for x in a.get(f"/api/feedback{qs}").json()]

    assert ids("") == [p2["id"], f1["id"], p1["id"]]
    assert ids("?kind=problem") == [p2["id"], p1["id"]]
    assert ids("?status=open,scheduled") == [f1["id"], p1["id"]]
    assert ids("?kind=problem&status=resolved") == [p2["id"]]
    assert ids("?from=2026-11-01&to=2026-11-30") == [f1["id"]]
    assert a.get("/api/feedback?status=done").status_code == 400
    assert a.get("/api/feedback?kind=bug").status_code == 400
    assert a.get("/api/feedback?from=11/01").status_code == 400


def test_get_and_delete_single():
    """GET / DELETE 單筆；刪除後 404 並記錄變更"""
    _t, _clock, _alice, bob, a, b, change_rows = setup()
    item = a.request("POST", "/api/feedback", {"kind": "feedback", "title": "要刪"}).json()
    got = b.get(f"/api/feedback/{item['id']}").json()
    assert got["id"] == item["id"] and got["title"] == "要刪"
    res = b.request("DELETE", f"/api/feedback/{item['id']}")
    assert res.status_code == 200 and res.json() == {"ok": True}
    assert a.get(f"/api/feedback/{item['id']}").status_code == 404
    assert a.request("DELETE", f"/api/feedback/{item['id']}").status_code == 404
    assert a.get("/api/feedback").json() == []
    last = change_rows()[-1]
    assert last["entity_id"] == item["id"] and last["action"] == "delete" and last["actor_id"] == bob["id"]
    assert a.get("/api/feedback/abc").status_code == 400
