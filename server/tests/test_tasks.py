from .helpers import FakeClock, create_test_app, create_test_user, login_as


def setup():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    alice = create_test_user(t.db, display_name="Alice")
    bob = create_test_user(t.db, display_name="Bob")
    a = login_as(t, alice)
    b = login_as(t, bob)

    def change_count() -> int:
        return t.db.scalar("SELECT count(*) FROM changes")

    return t, clock, alice, bob, a, b, change_count


# ── users / statuses / projects ──


def test_users_statuses_projects():
    _t, _clock, alice, _bob, a, _b, _cc = setup()
    users = a.get("/api/users").json()
    assert alice["id"] in [u["id"] for u in users]
    assert "passwordHash" not in users[0]
    assert set(users[0]) == {
        "id",
        "username",
        "displayName",
        "role",
        "isActive",
        "mustChangePassword",
        "createdAt",
        "updatedAt",
    }

    statuses = a.get("/api/statuses").json()
    assert [(s["name"], s["color"]) for s in statuses] == [
        ("待辦", "gray"),
        ("進行中", "blue"),
        ("審查中", "purple"),
        ("完成", "green"),
    ]
    assert set(statuses[0]) == {"id", "name", "color", "category", "sortOrder", "createdAt", "updatedAt"}
    projects = a.get("/api/projects").json()
    assert len(projects) == 1
    assert projects[0]["name"] == "預設專案" and projects[0]["color"] == "blue"
    assert projects[0]["isArchived"] is False


def test_projects_create_update():
    _t, _clock, _alice, _bob, a, _b, change_count = setup()
    before = change_count()
    created = a.request("POST", "/api/projects", {"name": "新專案", "color": "teal"})
    assert created.status_code == 201
    p = created.json()
    assert p["name"] == "新專案" and p["color"] == "teal" and p["sortOrder"] == 2
    assert a.request("POST", "/api/projects", {"name": "x", "color": "#ff0000"}).status_code == 400
    patched = a.request("PATCH", f"/api/projects/{p['id']}", {"isArchived": True}).json()
    assert patched["name"] == "新專案" and patched["isArchived"] is True
    assert a.request("PATCH", "/api/projects/999", {"name": "y"}).status_code == 404
    assert change_count() == before + 2


# ── tasks ──


def test_create_with_title_only():
    _t, clock, alice, _bob, a, _b, _cc = setup()
    res = a.request("POST", "/api/tasks", {"title": "  只有標題  "})
    assert res.status_code == 201
    t = res.json()
    expected = {
        "title": "只有標題",
        "projectId": 1,
        "statusId": 1,
        "assigneeId": None,
        "priority": "none",
        "progress": 0,
        "custom": {},
        "createdBy": alice["id"],
        "updatedBy": alice["id"],
        "createdAt": clock.now(),
        "updatedAt": clock.now(),
        "deletedAt": None,
        "description": "",
        "startDate": None,
        "dueDate": None,
        "estimateHours": None,
    }
    assert {k: t[k] for k in expected} == expected
    assert set(t) == {*expected, "id", "sortOrder"}
    assert a.request("POST", "/api/tasks", {"title": ""}).status_code == 400
    assert a.request("POST", "/api/tasks", {"title": "x", "statusId": 999}).status_code == 400
    assert a.request("POST", "/api/tasks", {"title": "x", "projectId": None}).status_code == 400
    assert a.request("POST", "/api/tasks", {"title": "x", "progress": "5"}).status_code == 400


def test_create_with_all_fields():
    _t, _clock, _alice, bob, a, _b, _cc = setup()
    t = a.request(
        "POST",
        "/api/tasks",
        {
            "title": "完整",
            "statusId": 3,
            "assigneeId": bob["id"],
            "sortOrder": 7.5,
            "startDate": "2026-01-05",
            "dueDate": "2026-01-09",
            "estimateHours": 4,
            "priority": "high",
        },
    ).json()
    assert (t["statusId"], t["assigneeId"], t["sortOrder"], t["dueDate"], t["estimateHours"]) == (
        3,
        bob["id"],
        7.5,
        "2026-01-09",
        4,
    )


def test_member_can_update_others_task_partial_patch():
    _t, clock, alice, bob, a, b, change_count = setup()
    t = b.request("POST", "/api/tasks", {"title": "B 的任務", "description": "說明"}).json()
    clock.advance(5 * 60_000)
    before = change_count()
    res = a.request("PATCH", f"/api/tasks/{t['id']}", {"progress": 50, "assigneeId": alice["id"]})
    assert res.status_code == 200
    u = res.json()
    assert u["title"] == "B 的任務"
    assert u["description"] == "說明"
    assert u["progress"] == 50
    assert u["assigneeId"] == alice["id"]
    assert u["createdBy"] == bob["id"]
    assert u["updatedBy"] == alice["id"]
    assert u["updatedAt"] == clock.now()
    assert change_count() == before + 1
    assert a.request("PATCH", f"/api/tasks/{t['id']}", {"progress": 101}).status_code == 400
    # 可清除（null）的欄位
    cleared = a.request("PATCH", f"/api/tasks/{t['id']}", {"assigneeId": None, "dueDate": None}).json()
    assert cleared["assigneeId"] is None and cleared["progress"] == 50
    assert a.request("PATCH", f"/api/tasks/{t['id']}", {"title": None}).status_code == 400
    assert a.request("PATCH", "/api/tasks/abc", {"title": "x"}).status_code == 400


def test_soft_delete():
    t, _clock, _alice, _bob, a, _b, _cc = setup()
    task = a.request("POST", "/api/tasks", {"title": "要刪"}).json()
    assert a.request("DELETE", f"/api/tasks/{task['id']}").status_code == 200
    assert a.get("/api/tasks").json() == []
    assert a.get(f"/api/tasks/{task['id']}").status_code == 404
    assert a.request("PATCH", f"/api/tasks/{task['id']}", {"title": "x"}).status_code == 404
    assert a.request("DELETE", f"/api/tasks/{task['id']}").status_code == 404
    assert t.db.scalar("SELECT deleted_at FROM tasks WHERE id = ?", (task["id"],)) > 0
    assert [r["action"] for r in t.db.all("SELECT action FROM changes ORDER BY id")] == ["create", "delete"]


def test_list_filters():
    _t, _clock, alice, bob, a, _b, _cc = setup()
    p2 = a.request("POST", "/api/projects", {"name": "P2"}).json()

    def mk(body):
        return a.request("POST", "/api/tasks", body).json()

    t1 = mk({"title": "Alpha 報告", "assigneeId": alice["id"]})
    t2 = mk({"title": "beta 實驗", "assigneeId": bob["id"], "statusId": 2, "projectId": p2["id"]})
    t3 = mk({"title": "未指派 alpha", "statusId": 4})

    def ids(qs: str):
        return [t["id"] for t in a.get(f"/api/tasks{qs}").json()]

    assert ids("") == [t1["id"], t2["id"], t3["id"]]
    assert ids(f"?assignee={alice['id']},{bob['id']}") == [t1["id"], t2["id"]]
    assert ids("?assignee=none") == [t3["id"]]
    assert ids(f"?assignee=none,{bob['id']}") == [t2["id"], t3["id"]]
    assert ids("?status=2,4") == [t2["id"], t3["id"]]
    assert ids(f"?project={p2['id']}") == [t2["id"]]
    assert ids("?q=ALPHA") == [t1["id"], t3["id"]]
    assert ids("?q=alpha&assignee=none") == [t3["id"]]
    assert ids("?q=%20%20") == [t1["id"], t2["id"], t3["id"]]
    res = a.get("/api/tasks?status=abc")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"
    assert a.get("/api/tasks?assignee=nobody").status_code == 400


# ── 自訂 property ──


def test_custom_values_validated_and_merged():
    _t, _clock, _alice, bob, a, _b, change_count = setup()

    def mk(body):
        res = a.request("POST", "/api/properties", body)
        assert res.status_code == 201, res.text
        return res.json()

    num = mk({"name": "點數", "type": "number"})
    sel = mk(
        {
            "name": "類別",
            "type": "select",
            "options": [{"id": "a", "label": "A", "color": "red"}, {"id": "b", "label": "B"}],
        }
    )
    assert sel["options"] == [{"id": "a", "label": "A", "color": "red"}, {"id": "b", "label": "B"}]
    multi = mk({"name": "標籤", "type": "multi_select", "options": [{"id": "x", "label": "X"}]})
    date = mk({"name": "日期", "type": "date"})
    check = mk({"name": "完成", "type": "checkbox"})
    url = mk({"name": "連結", "type": "url"})
    person = mk({"name": "審查人", "type": "person"})
    text = mk({"name": "備註", "type": "text"})
    p2 = a.request("POST", "/api/projects", {"name": "P2"}).json()
    other = mk({"name": "P2 專屬", "type": "text", "projectId": p2["id"]})
    props = a.get("/api/properties").json()
    assert len(props) == 9
    assert set(props[0]) == {"id", "projectId", "name", "type", "options", "sortOrder", "createdAt", "updatedAt"}

    valid = {
        str(num["id"]): 3,
        str(sel["id"]): "a",
        str(multi["id"]): ["x"],
        str(date["id"]): "2026-02-01",
        str(check["id"]): True,
        str(url["id"]): "https://example.com",
        str(person["id"]): bob["id"],
        str(text["id"]): "文字",
    }
    created = a.request("POST", "/api/tasks", {"title": "t", "custom": valid})
    assert created.status_code == 201
    t = created.json()
    assert t["custom"] == valid

    invalid = [
        {str(num["id"]): "3"},
        {str(num["id"]): True},
        {str(sel["id"]): "zzz"},
        {str(multi["id"]): "x"},
        {str(multi["id"]): ["x", "x"]},
        {str(date["id"]): "2026/02/01"},
        {str(check["id"]): "yes"},
        {str(url["id"]): "not a url"},
        {str(person["id"]): 9999},
        {str(text["id"]): 5},
        {"9999": "unknown"},
        {str(other["id"]): "不屬於此專案"},
    ]
    for custom in invalid:
        res = a.request("PATCH", f"/api/tasks/{t['id']}", {"custom": custom})
        assert res.status_code == 400, custom

    before = change_count()
    patched = a.request("PATCH", f"/api/tasks/{t['id']}", {"custom": {str(num["id"]): 5, str(text["id"]): None}}).json()
    assert patched["custom"][str(num["id"])] == 5
    assert patched["custom"][str(sel["id"])] == "a"
    assert str(text["id"]) not in patched["custom"]
    assert change_count() == before + 1


def test_property_update_delete():
    _t, _clock, _alice, _bob, a, _b, change_count = setup()
    before = change_count()
    p = a.request("POST", "/api/properties", {"name": "點數", "type": "number"}).json()
    t = a.request("POST", "/api/tasks", {"title": "t", "custom": {str(p["id"]): 1}}).json()
    renamed = a.request("PATCH", f"/api/properties/{p['id']}", {"name": "故事點"}).json()
    assert renamed["name"] == "故事點" and renamed["type"] == "number"
    assert a.request("DELETE", f"/api/properties/{p['id']}").status_code == 200
    assert a.request("DELETE", f"/api/properties/{p['id']}").status_code == 404
    assert a.request("PATCH", f"/api/properties/{p['id']}", {"name": "x"}).status_code == 404
    assert a.get("/api/properties").json() == []
    assert a.get(f"/api/tasks/{t['id']}").json()["custom"] == {str(p["id"]): 1}
    dup = a.request(
        "POST",
        "/api/properties",
        {"name": "s", "type": "select", "options": [{"id": "a", "label": "A"}, {"id": "a", "label": "B"}]},
    )
    assert dup.status_code == 400
    assert change_count() == before + 4
