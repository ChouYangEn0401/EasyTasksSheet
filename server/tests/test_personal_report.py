"""匯報報告：GET /api/personal/report 與 done_at 維護、migration 回填"""

import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from server.app.db import MIGRATIONS_DIR, create_db, run_migrations

from .helpers import FakeClock, client, create_test_app, create_test_user, login_as

TODO, DOING, REVIEW, DONE = 1, 2, 3, 4
TPE = timezone(timedelta(hours=8))


def at(iso: str) -> int:
    return int(datetime.fromisoformat(iso).replace(tzinfo=TPE).timestamp() * 1000)


def setup():
    clock = FakeClock()  # 2026-01-05 09:00 +08:00
    t = create_test_app(now=clock.now)
    alice = create_test_user(t.db, display_name="Alice")
    bob = create_test_user(t.db, display_name="Bob")
    eve = create_test_user(t.db, display_name="Eve", is_active=0)
    a = login_as(t, alice)
    seq = [0]

    def add(assignee, status=DONE, completed=None, hours=None, deleted=None, created=None, created_by=None):
        seq[0] += 1
        with t.db.tx() as conn:
            cur = conn.execute(
                "INSERT INTO tasks (project_id, title, status_id, assignee_id, estimate_hours, created_at, updated_at, "
                "created_by, completed_at, deleted_at) VALUES (1, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
                (f"T{seq[0]}", status, assignee, hours, created or at("2025-12-01T00:00:00"), created_by, completed, deleted),
            )
            return cur.lastrowid

    def todo(user, title, status, done_at=None, updated=1):
        with t.db.tx() as conn:
            cur = conn.execute(
                "INSERT INTO personal_items (user_id, title, status, is_done, done_at, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, 1, ?)",
                (user, title, status, int(status == "done"), done_at, updated),
            )
            return cur.lastrowid

    return t, clock, alice, bob, eve, a, add, todo


def report(a, **q):
    qs = "&".join(f"{k}={v}" for k, v in q.items())
    return a.get(f"/api/personal/report?{qs}")


def titles(items):
    return [i["title"] for i in items]


def test_auth_and_validation():
    t, _c, _al, _b, _e, a, *_ = setup()
    assert client(t).get("/api/personal/report?from=2026-01-01&to=2026-01-07").status_code == 401
    for q in (
        {},
        {"from": "2026-01-01"},
        {"from": "2026/01/01", "to": "2026-01-07"},
        {"from": "2026-02-30", "to": "2026-03-01"},
        {"from": "2026-01-08", "to": "2026-01-07"},
        {"from": "2026-01-01", "to": "2026-01-07", "include": "bogus"},
    ):
        assert report(a, **q).status_code == 400, q


def test_range_limit():
    _t, _c, _al, _b, _e, a, _add, _todo = setup()
    assert report(a, **{"from": "2025-01-01", "to": "2026-01-01"}).status_code == 200  # 366 天
    assert report(a, **{"from": "2025-01-01", "to": "2026-01-02"}).status_code == 400  # 367 天


def test_inclusive_boundaries_and_taipei_midnight():
    _t, _c, alice, _b, _e, a, add, _todo = setup()
    add(alice["id"], completed=at("2026-01-05T00:00:00"))  # 起始日 00:00 含（UTC 為前一日 16:00）
    add(alice["id"], completed=at("2026-01-07T23:59:59"))  # 結束日最後一秒含
    add(alice["id"], completed=at("2026-01-04T23:59:59"))  # 前一日不含
    add(alice["id"], completed=at("2026-01-08T00:00:00"))  # 後一日 00:00 不含
    data = report(a, **{"from": "2026-01-05", "to": "2026-01-07"}).json()
    assert titles(data["completedTasks"]) == ["T1", "T2"]
    assert [x["completedDate"] for x in data["completedTasks"]] == ["2026-01-05", "2026-01-07"]
    assert data["summary"]["completedTaskCount"] == 2
    one = report(a, **{"from": "2026-01-05", "to": "2026-01-05"}).json()
    assert titles(one["completedTasks"]) == ["T1"]


def test_excluded_tasks():
    _t, _c, alice, bob, _e, a, add, _todo = setup()
    ts = at("2026-01-06T10:00:00")
    add(alice["id"], completed=ts)
    add(alice["id"], status=DOING, completed=ts)  # 完成後又改回未完成
    add(alice["id"], completed=ts, deleted=ts)  # 軟刪除
    add(bob["id"], completed=ts)  # 他人
    add(None, completed=ts)  # 未指派
    data = report(a, **{"from": "2026-01-05", "to": "2026-01-11"}).json()
    assert titles(data["completedTasks"]) == ["T1"]


def test_todos_done_at():
    _t, _c, alice, bob, _e, a, _add, todo = setup()
    todo(alice["id"], "完成一", "done", done_at=at("2026-01-06T09:00:00"))
    todo(alice["id"], "區間外", "done", done_at=at("2026-01-20T09:00:00"))
    todo(alice["id"], "未完成", "todo")
    todo(alice["id"], "缺漏推得", "done", done_at=None, updated=at("2026-01-07T12:00:00"))
    todo(bob["id"], "他人", "done", done_at=at("2026-01-06T09:00:00"))
    data = report(a, **{"from": "2026-01-05", "to": "2026-01-11"}).json()
    assert titles(data["completedTodos"]) == ["完成一", "缺漏推得"]
    assert data["completedTodos"][0]["doneDate"] == "2026-01-06"
    assert data["summary"]["completedTodoCount"] == 2


def test_done_at_maintained_by_patch():
    _t, clock, _al, _b, _e, a, _add, _todo = setup()
    item = a.request("POST", "/api/personal", {"title": "x"}).json()
    assert item["doneAt"] is None
    clock.advance(1000)
    done = a.request("PATCH", f"/api/personal/{item['id']}", {"isDone": True}).json()
    assert done["doneAt"] == clock.now()
    clock.advance(1000)
    again = a.request("PATCH", f"/api/personal/{item['id']}", {"title": "y"}).json()
    assert again["doneAt"] == done["doneAt"]  # 其他情況不變
    back = a.request("PATCH", f"/api/personal/{item['id']}", {"status": "doing"}).json()
    assert back["doneAt"] is None
    created = a.request("POST", "/api/personal", {"title": "z", "status": "done"}).json()
    assert created["doneAt"] == clock.now()
    # 完成後又改回的不算入報告
    data = report(a, **{"from": "2026-01-05", "to": "2026-01-05"}).json()
    assert titles(data["completedTodos"]) == ["z"]


def test_estimate_hours():
    _t, _c, alice, _b, _e, a, add, _todo = setup()
    ts = at("2026-01-06T10:00:00")
    add(alice["id"], completed=ts)
    q = {"from": "2026-01-05", "to": "2026-01-11"}
    s = report(a, **q).json()["summary"]
    assert "estimatedHours" not in s and "hoursKnown" not in s
    add(alice["id"], completed=ts, hours=2.5)
    add(alice["id"], completed=ts, hours=1)
    s = report(a, **q).json()["summary"]
    assert s["estimatedHours"] == 3.5 and s["hoursKnown"] == 2 and s["completedTaskCount"] == 3
    assert s["byProject"][0]["count"] == 3 and s["byProject"][0]["projectName"]


def test_include_options():
    _t, _c, alice, bob, _e, a, add, todo = setup()
    add(alice["id"], status=DOING)
    add(alice["id"], status=TODO)  # 待辦類別不算進行中
    add(bob["id"], status=DOING)
    add(alice["id"], created=at("2026-01-06T10:00:00"), created_by=alice["id"], completed=at("2026-01-06T10:00:00"))
    add(alice["id"], created=at("2026-02-06T10:00:00"), created_by=alice["id"])
    todo(alice["id"], "延", "deferred")
    todo(alice["id"], "取消", "cancelled")
    q = {"from": "2026-01-05", "to": "2026-01-11"}
    base = report(a, **q).json()
    assert not {"inProgress", "deferredTodos", "createdTasks"} & set(base)
    full = report(a, **q, include="doing,deferred,cancelled,created").json()
    assert titles(full["inProgress"]) == ["T1"]
    assert sorted(titles(full["deferredTodos"])) == ["取消", "延"]
    assert titles(full["createdTasks"]) == ["T4"] and full["createdTasks"][0]["createdDate"] == "2026-01-06"
    only_def = report(a, **q, include="deferred").json()
    assert titles(only_def["deferredTodos"]) == ["延"] and "inProgress" not in only_def


def test_view_others_and_inactive():
    _t, _c, _al, bob, eve, a, add, _todo = setup()
    add(bob["id"], completed=at("2026-01-06T10:00:00"))
    q = {"from": "2026-01-05", "to": "2026-01-11"}
    data = report(a, **q, user=bob["id"]).json()
    assert titles(data["completedTasks"]) == ["T1"] and data["user"]["displayName"] == "Bob"
    assert report(a, **q).json()["completedTasks"] == []
    assert report(a, **q, user=eve["id"]).status_code == 404
    assert report(a, **q, user=9999).status_code == 404
    assert report(a, **q, user="abc").status_code == 400


def test_migration_backfills_done_at(tmp_path):
    """0020 之前的 DB 有 done 的自由待辦：升級後 done_at = updated_at；非 done 為 NULL"""
    old = tmp_path / "migrations"
    old.mkdir()
    for f in Path(MIGRATIONS_DIR).glob("*.sql"):
        if not f.name.startswith("0020_"):
            shutil.copy(f, old / f.name)
    db = create_db(":memory:")
    run_migrations(db, old)
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO users (username, display_name, password_hash, created_at, updated_at) VALUES ('u','U','x',1,1)"
        )
        for title, status, upd in (("d", "done", 555), ("t", "todo", 777)):
            conn.execute(
                "INSERT INTO personal_items (user_id, title, status, is_done, created_at, updated_at) "
                "VALUES (1, ?, ?, ?, 1, ?)",
                (title, status, int(status == "done"), upd),
            )
    applied = run_migrations(db)
    assert any(n.startswith("0020_") for n in applied)
    assert db.scalar("SELECT done_at FROM personal_items WHERE title = 'd'") == 555
    assert db.scalar("SELECT done_at FROM personal_items WHERE title = 't'") is None
