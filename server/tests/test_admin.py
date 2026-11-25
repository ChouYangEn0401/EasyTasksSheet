"""成員管理（移植 src/server/features/admin/admin.test.ts）"""

import re

from server.app.features.admin import generate_temp_password, is_last_active_root

from .helpers import MIN, FakeClock, client, create_test_app, create_test_user, login, login_as


def setup():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    admin = create_test_user(t.db, role="root")
    member = create_test_user(t.db)
    admin_api = login_as(t, admin)
    return t, t.db, clock, admin, member, admin_api


def change_count(db, user_id: int) -> int:
    return db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'user' AND entity_id = ?", (user_id,))


# ── 權限 ──


def test_member_gets_403_and_anonymous_401():
    t, _db, _clock, _admin, member, _api = setup()
    api = login_as(t, member)
    calls = [
        api.get("/api/admin/users"),
        api.request("POST", "/api/admin/users", {"username": "x-user", "displayName": "X"}),
        api.request("PATCH", f"/api/admin/users/{member['id']}", {"role": "root"}),
        api.request("POST", f"/api/admin/users/{member['id']}/reset-password"),
        api.request("POST", f"/api/admin/users/{member['id']}/unlock"),
        api.get("/api/admin/whatever"),
    ]
    assert [r.status_code for r in calls] == [403] * len(calls)
    assert client(t).get("/api/admin/users").status_code == 401


# ── 列出與新增 ──


def test_list_includes_disabled_without_password_hash():
    t, db, _clock, _admin, _member, api = setup()
    create_test_user(db, is_active=0)
    res = api.get("/api/admin/users")
    assert res.status_code == 200
    users = res.json()
    assert len(users) == 3
    assert any(not u["isActive"] for u in users)
    assert "argon2" not in res.text and "passwordHash" not in res.text
    assert all(u["lockedUntil"] is None for u in users)


def test_create_returns_temp_password_once():
    t, db, _clock, admin, _member, api = setup()
    res = api.request("POST", "/api/admin/users", {"username": "  New.User ", "displayName": "李大華", "role": "user"})
    assert res.status_code == 201
    body = res.json()
    assert body["user"]["username"] == "new.user"
    assert body["user"]["displayName"] == "李大華"
    assert body["user"]["mustChangePassword"] is True
    assert body["user"]["lockedUntil"] is None
    assert re.fullmatch(r"[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}", body["tempPassword"])

    row = db.one("SELECT password_hash FROM users WHERE id = ?", (body["user"]["id"],))
    assert body["tempPassword"] not in row["password_hash"]
    log = db.all("SELECT * FROM changes WHERE entity_id = ? AND entity_type = 'user'", (body["user"]["id"],))
    assert any(r["action"] == "create" and r["actor_id"] == admin["id"] for r in log)

    lr = login(t, "new.user", body["tempPassword"])
    assert lr.status_code == 200
    assert lr.json()["user"]["mustChangePassword"] is True
    assert body["tempPassword"] not in api.get("/api/admin/users").text


def test_create_default_role_user():
    _t, _db, _clock, _admin, _member, api = setup()
    res = api.request("POST", "/api/admin/users", {"username": "plain", "displayName": "P"})
    assert res.status_code == 201
    assert res.json()["user"]["role"] == "user"


def test_duplicate_username_409_and_bad_format_400():
    _t, _db, _clock, _admin, member, api = setup()
    dup = api.request("POST", "/api/admin/users", {"username": member["username"].upper(), "displayName": "Dup"})
    assert dup.status_code == 409
    err = dup.json()["error"]
    assert err["message"] == "此帳號已被使用"
    assert err["details"] == {"field": "username"}
    for username in ["ab", "有中文", "-start", "a b c"]:
        bad = api.request("POST", "/api/admin/users", {"username": username, "displayName": "X"})
        assert bad.status_code == 400, username
    no_name = api.request("POST", "/api/admin/users", {"username": "okname", "displayName": " "})
    assert no_name.status_code == 400


def test_temp_password_unique_length_14():
    s = {generate_temp_password() for _ in range(50)}
    assert len(s) == 50
    assert all(len(p) == 14 for p in s)
    assert not any(c in p for p in s for c in "0O1lI")


# ── 編輯、停用 / 啟用 ──


def test_update_display_name_and_role():
    _t, db, clock, _admin, member, api = setup()
    before = change_count(db, member["id"])
    clock.advance(5 * MIN)
    res = api.request("PATCH", f"/api/admin/users/{member['id']}", {"displayName": "新名字", "role": "root"})
    assert res.status_code == 200
    body = res.json()
    assert body["displayName"] == "新名字" and body["role"] == "root"
    assert body["updatedAt"] == clock.now()
    assert change_count(db, member["id"]) == before + 1


def test_update_rejects_username_or_unknown_and_404():
    _t, _db, _clock, _admin, member, api = setup()
    assert api.request("PATCH", f"/api/admin/users/{member['id']}", {"username": "hacked"}).status_code == 400
    assert api.request("PATCH", "/api/admin/users/9999", {"displayName": "x"}).status_code == 404
    assert api.request("PATCH", f"/api/admin/users/{member['id']}", {"displayName": None}).status_code == 400


def test_noop_patch_does_not_record_change():
    _t, db, _clock, _admin, member, api = setup()
    before = change_count(db, member["id"])
    res = api.request("PATCH", f"/api/admin/users/{member['id']}", {"role": "user"})
    assert res.status_code == 200
    assert change_count(db, member["id"]) == before


def test_disable_revokes_sessions_and_reenable():
    t, db, _clock, _admin, member, api = setup()
    m1 = login_as(t, member)
    m2 = login_as(t, member)
    assert m1.get("/api/auth/me").status_code == 200

    res = api.request("PATCH", f"/api/admin/users/{member['id']}", {"isActive": False})
    assert res.status_code == 200
    assert res.json()["isActive"] is False
    assert db.scalar("SELECT count(*) FROM sessions WHERE user_id = ?", (member["id"],)) == 0
    assert m1.get("/api/auth/me").status_code == 401
    assert m2.get("/api/tasks").status_code == 401
    assert login(t, member["username"]).status_code == 401

    on = api.request("PATCH", f"/api/admin/users/{member['id']}", {"isActive": True})
    assert on.json()["isActive"] is True
    assert login(t, member["username"]).status_code == 200


def test_last_root_protection():
    _t, db, _clock, admin, _member, api = setup()
    create_test_user(db, role="root", is_active=0)  # 停用中的 root 不算數
    for patch in ({"isActive": False}, {"role": "user"}):
        res = api.request("PATCH", f"/api/admin/users/{admin['id']}", patch)
        assert res.status_code == 409
        assert res.json()["error"]["message"] == "至少需保留一位超級管理員"
    row = db.one("SELECT role, is_active FROM users WHERE id = ?", (admin["id"],))
    assert row["role"] == "root" and row["is_active"] == 1

    create_test_user(db, role="root")
    demote = api.request("PATCH", f"/api/admin/users/{admin['id']}", {"role": "user"})
    assert demote.status_code == 200
    assert api.get("/api/admin/users").status_code == 403


def test_disable_self_logs_out():
    _t, db, _clock, admin, _member, api = setup()
    create_test_user(db, role="root")
    res = api.request("PATCH", f"/api/admin/users/{admin['id']}", {"isActive": False})
    assert res.status_code == 200
    assert api.get("/api/auth/me").status_code == 401


# ── 重設密碼與解除鎖定 ──


def test_reset_password():
    t, db, _clock, _admin, member, api = setup()
    m = login_as(t, member)
    before = change_count(db, member["id"])
    res = api.request("POST", f"/api/admin/users/{member['id']}/reset-password")
    assert res.status_code == 200
    body = res.json()
    assert body["user"]["mustChangePassword"] is True
    assert m.get("/api/auth/me").status_code == 401
    assert login(t, member["username"]).status_code == 401
    assert login(t, member["username"], body["tempPassword"]).status_code == 200
    assert change_count(db, member["id"]) == before + 1


def test_reset_own_password_keeps_session():
    _t, _db, _clock, admin, _member, api = setup()
    assert api.request("POST", f"/api/admin/users/{admin['id']}/reset-password").status_code == 200
    me = api.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["mustChangePassword"] is True


def test_reset_disabled_user_409():
    _t, db, _clock, _admin, _member, api = setup()
    off = create_test_user(db, is_active=0)
    assert api.request("POST", f"/api/admin/users/{off['id']}/reset-password").status_code == 409


def test_locked_until_and_unlock():
    t, db, clock, _admin, member, api = setup()
    for _ in range(5):
        login(t, member["username"], "wrong-password")
        clock.advance(MIN)
    assert login(t, member["username"]).status_code == 429

    users = api.get("/api/admin/users").json()
    locked = next(u for u in users if u["id"] == member["id"])
    assert locked["lockedUntil"] > clock.now()

    before = change_count(db, member["id"])
    res = api.request("POST", f"/api/admin/users/{member['id']}/unlock")
    assert res.status_code == 200
    assert res.json()["lockedUntil"] is None
    assert change_count(db, member["id"]) == before + 1
    assert login(t, member["username"]).status_code == 200


def test_is_last_active_root():
    def a(id, role, active=True):
        return {"id": id, "role": role, "isActive": active}

    assert is_last_active_root(a(1, "root"), [a(1, "root"), a(2, "user")])
    assert is_last_active_root(a(1, "root"), [a(1, "root"), a(2, "root", False)])
    assert not is_last_active_root(a(1, "root"), [a(1, "root"), a(2, "root")])
    assert not is_last_active_root(a(2, "user"), [a(1, "root"), a(2, "user")])
    assert not is_last_active_root(a(1, "root", False), [a(1, "root", False)])
