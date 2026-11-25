"""狀態 migrate-and-delete、usage 與 projects.create 權限（docs/permissions.md）"""

from server.app import permissions

from .helpers import FakeClock, create_test_app, create_test_user, login_as


def setup():
    t = create_test_app(now=FakeClock().now)
    user = login_as(t, create_test_user(t.db, role="user"))
    mgr = login_as(t, create_test_user(t.db, role="manager"))
    return t, user, mgr


def _statuses(c):
    return {s["name"]: s["id"] for s in c.get("/api/statuses").json()}


def _task(c, status_id, title="t"):
    res = c.request("POST", "/api/tasks", {"title": title, "statusId": status_id})
    assert res.status_code == 201, res.text
    return res.json()


def test_migrate_and_delete_moves_tasks():
    t, user, mgr = setup()
    st = _statuses(mgr)
    a, b = _task(user, st["審查中"], "a"), _task(user, st["審查中"], "b")
    # 軟刪除的任務也要一併改移（否則外鍵 / 刪除檢查會卡住）
    user.request("DELETE", f"/api/tasks/{b['id']}")
    assert mgr.get("/api/statuses/usage").json()[str(st["審查中"])] == 2
    assert mgr.request("DELETE", f"/api/statuses/{st['審查中']}").status_code == 409
    before = t.db.scalar("SELECT count(*) FROM changes")
    res = mgr.request("POST", f"/api/statuses/{st['審查中']}/migrate-and-delete", {"targetStatusId": st["完成"]})
    assert res.status_code == 200 and res.json() == {"ok": True, "moved": 2}
    assert "審查中" not in _statuses(mgr)
    row = t.db.all("SELECT status_id, completed_at FROM tasks WHERE id = ?", (a["id"],))[0]
    assert row["status_id"] == st["完成"] and row["completed_at"] is not None
    # 2 筆任務 update + 1 筆狀態 delete
    assert t.db.scalar("SELECT count(*) FROM changes") == before + 3


def test_migrate_and_delete_errors():
    t, user, mgr = setup()
    st = _statuses(mgr)
    body = {"targetStatusId": st["完成"]}
    path = f"/api/statuses/{st['待辦']}/migrate-and-delete"
    assert user.request("POST", path, body).status_code == 403
    assert mgr.request("POST", "/api/statuses/9999/migrate-and-delete", body).status_code == 404
    assert mgr.request("POST", path, {"targetStatusId": 9999}).status_code == 404
    assert mgr.request("POST", path, {"targetStatusId": st["待辦"]}).status_code == 400
    assert mgr.request("POST", path, {}).status_code == 400
    assert "待辦" in _statuses(mgr)


def test_migrate_and_delete_keeps_last_status():
    t, _user, mgr = setup()
    st = _statuses(mgr)
    for name in ("進行中", "審查中", "完成"):
        assert mgr.request("DELETE", f"/api/statuses/{st[name]}").status_code == 200
    res = mgr.request("POST", f"/api/statuses/{st['待辦']}/migrate-and-delete", {"targetStatusId": st["待辦"]})
    assert res.status_code == 400
    # 只剩一個狀態時，即使目標存在（不同於自己）也不可能；以直接刪除確認至少保留一個
    assert mgr.request("DELETE", f"/api/statuses/{st['待辦']}").status_code == 409


def test_projects_create_goes_through_capability(monkeypatch):
    t, user, mgr = setup()
    assert user.request("POST", "/api/projects", {"name": "A"}).status_code == 201
    # root 在設定頁把 projects.create 調到 manager 以上後，user 立即被擋
    monkeypatch.setitem(permissions.CAPABILITIES, "projects.create", "manager")
    res = user.request("POST", "/api/projects", {"name": "B"})
    assert res.status_code == 403 and res.json()["error"]["message"] == "沒有權限執行此操作"
    assert mgr.request("POST", "/api/projects", {"name": "C"}).status_code == 201
    assert "projects.create" not in user.get("/api/auth/me").json()["capabilities"]
