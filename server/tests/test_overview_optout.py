"""帳號「列入總覽統計」（users.in_overview）：migration 回填、預設值、總覽 / 活動排除、成員管理 API、匯出匯入"""

from datetime import datetime

from server.app.changes import record_change
from server.app.db import create_db, run_migrations
from server.app.features.users import create_user

from .helpers import FakeClock, create_test_app, create_test_user, login_as

TODO, DOING, DONE = 1, 2, 4


def at(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


def test_migration_backfills_root_to_zero(tmp_path):
    from server.app.db import MIGRATIONS_DIR

    pre = tmp_path / "pre"
    pre.mkdir()
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if f.stem < "0019":
            (pre / f.name).write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
    db = create_db(str(tmp_path / "t.db"))
    run_migrations(db, pre)
    with db.tx() as conn:
        for name, role in (("r", "root"), ("m", "manager"), ("u", "user")):
            conn.execute(
                "INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) "
                "VALUES (?, ?, 'x', ?, 1, 1)",
                (name, name, role),
            )
    run_migrations(db)  # 套用 0019
    rows = {r["username"]: r["in_overview"] for r in db.all("SELECT username, in_overview FROM users")}
    assert rows == {"r": 0, "m": 1, "u": 1}


def test_create_user_defaults_by_role():
    t = create_test_app()
    root = create_user(t.db, username="rooty", password="pw-123456", role="root")
    user = create_user(t.db, username="usery", password="pw-123456", role="user")
    forced = create_user(t.db, username="forced", password="pw-123456", role="root", in_overview=True)
    assert (root["in_overview"], user["in_overview"], forced["in_overview"]) == (0, 1, 1)


def setup():
    clock = FakeClock(at("2026-01-07T10:00:00+08:00"))
    t = create_test_app(now=clock.now)
    root = create_test_user(t.db, role="root", in_overview=0)
    manager = create_test_user(t.db, role="manager")
    alice = create_test_user(t.db, display_name="Alice")
    bob = create_test_user(t.db, display_name="Bob")

    def add(title, status_id, assignee_id=None, completed_at=None):
        with t.db.tx() as conn:
            cur = conn.execute(
                "INSERT INTO tasks (project_id, title, status_id, assignee_id, updated_at, created_at, completed_at) "
                "VALUES (1, ?, ?, ?, ?, 1, ?)",
                (title, status_id, assignee_id, at("2026-01-07T09:00:00+08:00"), completed_at),
            )
            return cur.lastrowid

    def touch(task_id, actor_id):
        with t.db.tx() as conn:
            record_change(conn, "task", task_id, "update", actor_id, at("2026-01-07T09:30:00+08:00"))

    return t, root, manager, alice, bob, add, touch


def test_overview_excludes_opted_out_users():
    t, root, manager, alice, bob, add, _touch = setup()
    add("a", DOING, alice["id"])
    add("r-doing", DOING, root["id"])
    add("r-todo", TODO, root["id"])
    add("nobody", TODO, None)
    o = login_as(t, alice).get("/api/overview").json()
    ids = [m["user"]["id"] for m in o["members"]]
    assert root["id"] not in ids
    assert set(ids) == {manager["id"], alice["id"], bob["id"], }
    assert o["totals"]["activeMembers"] == 3
    assert o["totals"]["idleMembers"] == 2  # manager、bob 無進行中
    # 指派給排除者的任務不列入未指派，也不列入任何成員卡
    assert o["unassigned"]["openCount"] == 1
    assert sum(m["counts"]["todo"] + m["counts"]["doing"] for m in o["members"]) == 1
    # 任務本身仍在
    tasks = login_as(t, alice).get("/api/tasks").json()
    assert {x["title"] for x in tasks} >= {"r-doing", "r-todo"}
    # 狀態統計（任務層級）不受影響
    assert sum(s["count"] for s in o["totals"]["byStatus"]) == 4


def test_overview_all_excluded_gives_empty_members():
    t, root, manager, alice, bob, _add, _touch = setup()
    with t.db.tx() as conn:
        conn.execute("UPDATE users SET in_overview = 0")
    o = login_as(t, alice).get("/api/overview").json()
    assert o["members"] == [] and o["totals"]["activeMembers"] == 0 and o["totals"]["idleMembers"] == 0


def test_activity_excludes_members_and_team_totals():
    t, root, manager, alice, bob, add, touch = setup()
    done_at = at("2026-01-06T10:00:00+08:00")
    a = add("alice-done", DONE, alice["id"], done_at)
    r = add("root-done", DONE, root["id"], done_at)
    touch(a, alice["id"])
    touch(r, root["id"])
    touch(a, root["id"])  # 排除者處理別人的任務也不計
    o = login_as(t, alice).get("/api/overview/activity").json()
    assert root["id"] not in [m["userId"] for m in o["members"]]
    cur = o["teamWeeks"][-1]
    assert cur["completed"] == 1  # 只有 alice 的
    assert cur["touched"] == 1
    assert cur["involved"] == 1


def test_users_api_has_in_overview():
    t, root, _m, alice, _b, _a, _t = setup()
    users = {u["id"]: u for u in login_as(t, alice).get("/api/users").json()}
    assert users[root["id"]]["inOverview"] is False
    assert users[alice["id"]]["inOverview"] is True


def test_admin_create_defaults_and_set():
    t, root, manager, alice, _b, _a, _t = setup()
    api = login_as(t, root)
    r = api.request("POST", "/api/admin/users", {"username": "new-root", "displayName": "R", "role": "root"})
    assert r.status_code == 201 and r.json()["user"]["inOverview"] is False
    r = api.request("POST", "/api/admin/users", {"username": "new-user", "displayName": "U"})
    assert r.json()["user"]["inOverview"] is True
    r = api.request("POST", "/api/admin/users", {"username": "new-user2", "displayName": "U", "inOverview": False})
    assert r.json()["user"]["inOverview"] is False


def test_admin_patch_permissions_and_role_change():
    t, root, manager, alice, _b, _a, _t = setup()
    mgr = login_as(t, manager)
    r = mgr.request("PATCH", f"/api/admin/users/{alice['id']}", {"inOverview": False})
    assert r.status_code == 200 and r.json()["inOverview"] is False
    assert (
        t.db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'user' AND entity_id = ? AND action = 'update'", (alice["id"],))
        == 1
    )
    # manager 不可動 root 帳號
    assert mgr.request("PATCH", f"/api/admin/users/{root['id']}", {"inOverview": True}).status_code == 403
    # root 可以
    r = login_as(t, root).request("PATCH", f"/api/admin/users/{root['id']}", {"inOverview": True})
    assert r.status_code == 200 and r.json()["inOverview"] is True
    # 一般成員 403
    assert login_as(t, create_test_user(t.db)).request(
        "PATCH", f"/api/admin/users/{alice['id']}", {"inOverview": True}
    ).status_code == 403
    # 改為 root 時一併不列入；改回非 root 不自動變更
    api = login_as(t, root)
    r = api.request("PATCH", f"/api/admin/users/{manager['id']}", {"role": "root"})
    assert r.json()["inOverview"] is False
    r = api.request("PATCH", f"/api/admin/users/{manager['id']}", {"role": "user"})
    assert r.json()["inOverview"] is False
    # 同時指定則以明確值為準
    r = api.request("PATCH", f"/api/admin/users/{manager['id']}", {"role": "root", "inOverview": True})
    assert r.json()["inOverview"] is True


def test_export_roundtrip_includes_in_overview():
    from server.app import data_transfer as dt

    t, root, *_ = setup()
    doc = dt.export_document(t.db, 1)
    flags = {u["username"]: u["inOverview"] for u in doc["users"]}
    assert flags[root["username"]] is False
    assert flags[next(u for u in doc["users"] if u["role"] == "manager")["username"]] is True
    # 舊檔（缺此欄位）仍可驗證通過
    legacy = {k: v for k, v in doc["users"][0].items() if k != "inOverview"}
    dt.UserItem(**legacy)
