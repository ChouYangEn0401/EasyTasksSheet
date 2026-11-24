"""對應 src/server/features/personal/personal.test.ts（sortOrderForMove 為前端純函式，不在後端）"""

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
            (r["entity_type"], r["entity_id"], r["action"], r["actor_id"])
            for r in t.db.all("SELECT entity_type, entity_id, action, actor_id FROM changes ORDER BY id")
        ]

    return t, clock, alice, bob, a, b, change_rows


def test_unauthenticated_401():
    t, *_ = setup()
    assert client(t).get("/api/personal").status_code == 401
    assert client(t).get("/api/personal/pins").status_code == 401


def test_todos_crud():
    """新增排在最上方；勾選 / 改標題 / 備註 / 排序；重新讀取保留；寫入皆記錄變更"""
    _t, clock, alice, _bob, a, _b, change_rows = setup()
    first = a.request("POST", "/api/personal", {"title": " 訂購試劑 "}).json()
    assert set(first) == {"id", "userId", "title", "note", "isDone", "taskId", "sortOrder", "createdAt", "updatedAt"}
    assert first["userId"] == alice["id"] and first["title"] == "訂購試劑"
    assert first["note"] == "" and first["isDone"] is False and first["taskId"] is None
    clock.advance(1000)
    res = a.request("POST", "/api/personal", {"title": "回覆審稿意見", "note": "週五前"})
    assert res.status_code == 201
    second = res.json()
    assert second["sortOrder"] < first["sortOrder"]
    assert [i["title"] for i in a.get("/api/personal").json()] == ["回覆審稿意見", "訂購試劑"]

    # 空白標題無效
    assert a.request("POST", "/api/personal", {"title": "   "}).status_code == 400

    clock.advance(1000)
    patched = a.request(
        "PATCH",
        f"/api/personal/{first['id']}",
        {"isDone": True, "title": "訂購試劑 x2", "note": "找廠商", "sortOrder": second["sortOrder"] - 1},
    ).json()
    assert patched["isDone"] is True and patched["title"] == "訂購試劑 x2"
    assert patched["note"] == "找廠商" and patched["updatedAt"] == clock.now()
    assert [[i["title"], i["isDone"]] for i in a.get("/api/personal").json()] == [
        ["訂購試劑 x2", True],
        ["回覆審稿意見", False],
    ]
    assert a.request("PATCH", f"/api/personal/{first['id']}", {"title": ""}).status_code == 400
    empty = a.request("PATCH", f"/api/personal/{first['id']}", {})
    assert empty.status_code == 400 and empty.json()["error"]["code"] == "BAD_REQUEST"
    assert a.request("PATCH", "/api/personal/9999", {"isDone": True}).status_code == 404

    # 清除已完成
    assert a.request("DELETE", "/api/personal/done").json() == {"ok": True, "deleted": 1}
    assert a.request("DELETE", f"/api/personal/{second['id']}").status_code == 200
    assert a.get("/api/personal").json() == []

    assert change_rows() == [
        ("personal", first["id"], "create", alice["id"]),
        ("personal", second["id"], "create", alice["id"]),
        ("personal", first["id"], "update", alice["id"]),
        ("personal", first["id"], "delete", alice["id"]),
        ("personal", second["id"], "delete", alice["id"]),
    ]


def test_only_owner_can_write():
    """只有本人能改：他人改 / 刪回 403，指定他人寫入回 403；他人可唯讀檢視"""
    _t, _clock, alice, bob, a, b, change_rows = setup()
    item = a.request("POST", "/api/personal", {"title": "Alice 的待辦"}).json()
    before = len(change_rows())

    assert b.request("PATCH", f"/api/personal/{item['id']}", {"isDone": True}).status_code == 403
    assert b.request("DELETE", f"/api/personal/{item['id']}").status_code == 403
    assert b.request("POST", f"/api/personal?user={alice['id']}", {"title": "代寫"}).status_code == 403
    assert b.request("DELETE", f"/api/personal/done?user={alice['id']}").status_code == 403
    assert b.request("PUT", f"/api/personal/pins/1?user={alice['id']}").status_code == 403
    assert b.request("DELETE", f"/api/personal/pins/1?user={alice['id']}").status_code == 403
    assert b.request("DELETE", f"/api/personal/{item['id']}").json()["error"]["code"] == "FORBIDDEN"
    assert len(change_rows()) == before

    # 唯讀檢視
    assert [i["title"] for i in b.get(f"/api/personal?user={alice['id']}").json()] == ["Alice 的待辦"]
    assert b.get(f"/api/personal?user={bob['id']}").json() == []
    assert a.get(f"/api/personal/pins?user={bob['id']}").json() == []
    # 本人資料不受影響
    assert a.get("/api/personal").json()[0]["isDone"] is False


def test_view_missing_or_inactive_member():
    """檢視不存在或已停用的成員回 404；?user 格式錯誤回 400"""
    t, _clock, _alice, _bob, a, _b, _cr = setup()
    gone = create_test_user(t.db, is_active=0)
    assert a.get("/api/personal?user=9999").status_code == 404
    assert a.get(f"/api/personal/pins?user={gone['id']}").status_code == 404
    assert a.get("/api/personal?user=abc").status_code == 400


def test_pins():
    """標記冪等、依標記時間新→舊；取消標記；任務刪除後自動消失；不影響他人的標記"""
    _t, clock, alice, _bob, a, b, change_rows = setup()
    t1 = a.request("POST", "/api/tasks", {"title": "資料清理"}).json()
    t2 = a.request("POST", "/api/tasks", {"title": "撰寫週報"}).json()
    base = len(change_rows())

    put = a.request("PUT", f"/api/personal/pins/{t1['id']}")
    assert put.status_code == 201
    pin = put.json()
    assert pin["userId"] == alice["id"] and pin["taskId"] == t1["id"]
    assert a.request("PUT", f"/api/personal/pins/{t1['id']}").status_code == 200
    clock.advance(1000)
    a.request("PUT", f"/api/personal/pins/{t2['id']}")
    b.request("PUT", f"/api/personal/pins/{t1['id']}")

    pins = a.get("/api/personal/pins").json()
    assert [p["task"]["title"] for p in pins] == ["撰寫週報", "資料清理"]
    assert set(pins[0]) == {"pin", "task"}
    assert pins[0]["task"]["id"] == t2["id"]
    assert isinstance(pins[0]["task"]["statusId"], int) and isinstance(pins[0]["task"]["updatedAt"], int)
    assert pins[0]["task"]["custom"] == {}
    # 標記不出現在自由待辦
    assert a.get("/api/personal").json() == []
    # 標記列不能以待辦 API 修改
    assert a.request("PATCH", f"/api/personal/{pin['id']}", {"isDone": True}).status_code == 404

    assert a.request("PUT", "/api/personal/pins/9999").status_code == 404

    # 取消標記（冪等）
    assert a.request("DELETE", f"/api/personal/pins/{t2['id']}").status_code == 200
    assert a.request("DELETE", f"/api/personal/pins/{t2['id']}").status_code == 200
    assert [p["task"]["id"] for p in a.get("/api/personal/pins").json()] == [t1["id"]]

    # 任務軟刪除後，標記清單不再出現；也不能再標記
    b.request("DELETE", f"/api/tasks/{t1['id']}")
    assert a.get("/api/personal/pins").json() == []
    assert b.get("/api/personal/pins").json() == []
    assert a.request("PUT", f"/api/personal/pins/{t1['id']}").status_code == 404

    pin_changes = [r[2] for r in change_rows()[base:] if r[0] == "personal"]
    # a 標記 t1、t2，b 標記 t1，a 取消 t2（重複的 PUT / DELETE 不記錄）
    assert pin_changes == ["create", "create", "create", "delete"]
