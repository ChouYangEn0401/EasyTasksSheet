"""個人設定 /api/profile：資料、改顯示名稱、改帳號（需密碼）、限制與只能改自己。"""

from .helpers import MIN, FakeClock, client, create_test_app, create_test_user, login, login_as


def setup(**settings):
    clock = FakeClock()
    t = create_test_app(now=clock.now, settings=settings)
    user = create_test_user(t.db)
    return t, t.db, clock, user


def patch(api, body):
    return api.request("PATCH", "/api/profile", body)


def test_requires_login():
    t, *_ = setup()
    assert client(t).get("/api/profile").status_code == 401
    assert client(t).request("PATCH", "/api/profile", {"displayName": "x"}).status_code == 401


def test_get_profile():
    t, _db, clock, user = setup()
    api = login_as(t, user)
    body = api.get("/api/profile").json()
    assert body == {
        "id": user["id"],
        "username": user["username"],
        "displayName": user["display_name"],
        "role": "user",
        "createdAt": 1,
        "lastLoginAt": clock.now(),
    }
    assert "password" not in str(body).lower()


def test_update_display_name_without_password():
    t, db, _clock, user = setup()
    api = login_as(t, user)
    res = patch(api, {"displayName": "  新名字  "})
    assert res.status_code == 200
    assert res.json()["displayName"] == "新名字"
    assert db.one("SELECT display_name FROM users WHERE id = ?", (user["id"],))["display_name"] == "新名字"
    assert db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'user' AND action = 'update'") == 1
    assert patch(api, {"displayName": "   "}).status_code == 400
    assert patch(api, {"displayName": "x" * 101}).status_code == 400


def test_noop_patch_writes_nothing():
    t, db, _clock, user = setup()
    api = login_as(t, user)
    assert patch(api, {}).status_code == 200
    assert patch(api, {"username": user["username"].upper()}).status_code == 200
    assert db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'user'") == 0


def test_change_username_requires_current_password():
    t, db, _clock, user = setup()
    api = login_as(t, user)
    missing = patch(api, {"username": "brand-new"})
    assert missing.status_code == 400
    assert missing.json()["error"]["details"]["field"] == "currentPassword"
    wrong = patch(api, {"username": "brand-new", "currentPassword": "wrong-password"})
    assert wrong.status_code == 400
    assert wrong.json()["error"]["details"]["field"] == "currentPassword"
    assert db.one("SELECT username FROM users WHERE id = ?", (user["id"],))["username"] == user["username"]


def test_change_username_success_keeps_session_and_updates_login():
    t, db, _clock, user = setup()
    api = login_as(t, user)
    other = login_as(t, user)
    res = patch(api, {"username": "  New.Name-1 ", "currentPassword": user["password"], "displayName": "改名"})
    assert res.status_code == 200
    body = res.json()
    assert body["username"] == "new.name-1" and body["displayName"] == "改名"
    # 現有 session 保持有效（包含其他裝置）
    assert api.get("/api/auth/me").json()["user"]["username"] == "new.name-1"
    assert other.get("/api/auth/me").status_code == 200
    assert login(t, user["username"]).status_code == 401
    assert login(t, "new.name-1").status_code == 200
    assert db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'user' AND action = 'update'") == 1


def test_username_validation_and_conflict():
    t, db, _clock, user = setup()
    taken = create_test_user(db, username="taken-name")
    api = login_as(t, user)
    bad = patch(api, {"username": "A!", "currentPassword": user["password"]})
    assert bad.status_code == 400 and bad.json()["error"]["details"]["field"] == "username"
    dup = patch(api, {"username": "TAKEN-name", "currentPassword": user["password"]})
    assert dup.status_code == 409
    assert dup.json()["error"]["details"]["field"] == "username"
    assert db.one("SELECT username FROM users WHERE id = ?", (taken["id"],))["username"] == "taken-name"
    assert db.one("SELECT username FROM users WHERE id = ?", (user["id"],))["username"] == user["username"]


def test_bootstrap_admin_username_rejected():
    t, _db, _clock, user = setup(bootstrap_admin_username="admin")
    api = login_as(t, user)
    res = patch(api, {"username": "admin", "currentPassword": user["password"]})
    assert res.status_code == 400 and res.json()["error"]["details"]["field"] == "username"


def test_role_and_other_fields_rejected():
    t, db, _clock, user = setup()
    api = login_as(t, user)
    for body in ({"role": "admin"}, {"displayName": "ok", "role": "admin"}, {"isActive": False}, {"id": 999}):
        res = patch(api, body)
        assert res.status_code == 400, body
    assert db.one("SELECT role, display_name FROM users WHERE id = ?", (user["id"],))["role"] == "user"
    assert db.one("SELECT display_name FROM users WHERE id = ?", (user["id"],))["display_name"] == user["display_name"]


def test_only_edits_own_profile():
    t, db, _clock, user = setup()
    victim = create_test_user(db)
    api = login_as(t, user)
    # id 不是可用欄位；且無 /api/profile/<id> 之類路由
    assert patch(api, {"id": victim["id"], "displayName": "hack"}).status_code == 400
    assert api.request("PATCH", f"/api/profile/{victim['id']}", {"displayName": "hack"}).status_code in (404, 405)
    assert patch(api, {"displayName": "mine"}).status_code == 200
    assert db.one("SELECT display_name FROM users WHERE id = ?", (victim["id"],))["display_name"] == victim["display_name"]
    assert api.get("/api/profile").json()["id"] == user["id"]


def test_wrong_current_password_counts_towards_login_lockout():
    t, _db, clock, user = setup()
    api = login_as(t, user)
    for _ in range(5):
        res = patch(api, {"username": "brand-new", "currentPassword": "wrong-password"})
        assert res.status_code == 400
        clock.advance(MIN)
    # 已鎖定：即使密碼正確也回 429，登入同樣被鎖
    locked = patch(api, {"username": "brand-new", "currentPassword": user["password"]})
    assert locked.status_code == 429
    assert int(locked.headers["retry-after"]) > 0
    assert login(t, user["username"]).status_code == 429
    clock.advance(15 * MIN)
    assert patch(api, {"username": "brand-new", "currentPassword": user["password"]}).status_code == 200


def test_change_password_wrong_current_counts_towards_lockout():
    t, _db, clock, user = setup()
    api = login_as(t, user)
    for _ in range(5):
        res = api.request("POST", "/api/auth/password", {"currentPassword": "nope-nope", "newPassword": "new-password-1"})
        assert res.status_code == 400
        clock.advance(MIN)
    ok = api.request("POST", "/api/auth/password", {"currentPassword": user["password"], "newPassword": "new-password-1"})
    assert ok.status_code == 429
    assert login(t, user["username"]).status_code == 429


def test_change_password_via_settings_flow_revokes_other_sessions():
    t, _db, _clock, user = setup()
    a = login_as(t, user)
    b = login_as(t, user)
    res = a.request("POST", "/api/auth/password", {"currentPassword": user["password"], "newPassword": "new-password-1"})
    assert res.status_code == 200
    assert a.get("/api/profile").status_code == 200
    assert b.get("/api/profile").status_code == 401
    # 一般使用者不可借此端點改帳號
    bad = a.request(
        "POST", "/api/auth/password", {"currentPassword": "new-password-1", "newPassword": "newer-password-1", "username": "x-user"}
    )
    assert bad.status_code == 400
