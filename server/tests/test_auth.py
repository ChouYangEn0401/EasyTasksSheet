import re

from server.app.db import Database
from server.app.features.users import ensure_admin
from server.app.security import verify_password

from .helpers import MIN, FakeClock, client, create_test_app, create_test_db, create_test_user, login, login_as


def setup(**settings):
    clock = FakeClock()
    t = create_test_app(now=clock.now, settings=settings)
    user = create_test_user(t.db)
    return t, t.db, clock, user


def set_cookie_of(res) -> str:
    return res.headers.get("set-cookie", "")


# ── 登入 / 登出 ──


def test_login_cookie_flags_and_no_plaintext():
    t, db, _clock, user = setup()
    res = login(t, user["username"])
    assert res.status_code == 200
    body = res.json()
    assert body["user"]["id"] == user["id"] and body["user"]["username"] == user["username"]
    assert "passwordHash" not in body["user"]
    cookie = set_cookie_of(res)
    assert re.search("HttpOnly", cookie, re.I)
    assert re.search("SameSite=Lax", cookie, re.I)
    assert not re.search("Secure", cookie, re.I)

    row = db.one("SELECT password_hash FROM users WHERE id = ?", (user["id"],))
    assert user["password"] not in row["password_hash"]
    assert row["password_hash"].startswith("$argon2id$")
    token = cookie.split(";")[0].split("=", 1)[1]
    dump = str([dict(r) for r in db.all("SELECT * FROM sessions")])
    assert token not in dump


def test_cookie_secure_in_production():
    t, _db, _clock, user = setup(cookie_secure=True)
    assert "Secure" in set_cookie_of(login(t, user["username"]))


def test_wrong_password_missing_user_and_inactive_same_401():
    t, db, _clock, _user = setup()
    u = create_test_user(db)
    inactive = create_test_user(db, is_active=0)
    wrong = login(t, u["username"], "wrong-password")
    missing = login(t, "nobody", "wrong-password")
    disabled = login(t, inactive["username"])
    assert [wrong.status_code, missing.status_code, disabled.status_code] == [401, 401, 401]
    assert len({r.json()["error"]["message"] for r in (wrong, missing, disabled)}) == 1


def test_logout_invalidates_session():
    t, _db, _clock, user = setup()
    api = login_as(t, user)
    assert api.get("/api/auth/me").status_code == 200
    res = api.request("POST", "/api/auth/logout")
    assert res.status_code == 200
    assert res.json() == {"ok": True}
    assert api.get("/api/auth/me").status_code == 401


def test_login_requires_json_body():
    t, _db, _clock, _user = setup()
    res = client(t).request("POST", "/api/auth/login", None)
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "BAD_REQUEST"
    res = client(t).request("POST", "/api/auth/login", {"username": "", "password": "x"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "VALIDATION_ERROR"


# ── 登入失敗限制 ──


def test_user_lockout_after_5_failures():
    t, _db, clock, user = setup()
    for _ in range(5):
        assert login(t, user["username"], "bad-password").status_code == 401
        clock.advance(MIN)
    locked = login(t, user["username"])
    assert locked.status_code == 429
    assert int(locked.headers["retry-after"]) > 0
    # 鎖定自最後一次失敗（1 分鐘前）起算 15 分鐘
    assert locked.json()["error"]["details"]["retryAfterSeconds"] == 14 * 60

    # 不存在的帳號同樣會被鎖，不洩漏帳號是否存在
    for _ in range(5):
        login(t, "ghost", "bad-password")
    assert login(t, "ghost", "bad-password").status_code == 429

    clock.advance(14 * MIN - 1)
    assert login(t, user["username"]).status_code == 429
    clock.advance(1)
    assert login(t, user["username"]).status_code == 200


def test_spread_failures_do_not_lock_and_success_resets():
    t, _db, clock, user = setup()
    for _ in range(4):
        login(t, user["username"], "bad-password")
    assert login(t, user["username"]).status_code == 200
    for _ in range(4):
        login(t, user["username"], "bad-password")
    assert login(t, user["username"]).status_code == 200

    for _ in range(6):
        assert login(t, user["username"], "bad-password").status_code == 401
        clock.advance(4 * MIN)


def test_ip_limit_ignores_forwarded_header_by_default():
    """未設 TRUSTED_PROXY：X-Forwarded-For 被忽略，同一 socket IP 的連續失敗仍觸發限制"""
    t, _db, clock, user = setup()
    for i in range(20):
        spoof = {"x-forwarded-for": f"10.0.{i}.1"}
        assert login(t, f"someone{i % 5}x{i}", "bad-password", spoof).status_code == 401
    assert login(t, user["username"]).status_code == 429
    assert login(t, user["username"], headers={"x-forwarded-for": "10.9.9.9"}).status_code == 429
    clock.advance(15 * MIN)
    assert login(t, user["username"]).status_code == 200


def test_ip_limit_20_failures_with_trusted_proxy():
    t, _db, clock, user = setup(trusted_proxy=True)
    ip = {"x-forwarded-for": "10.0.0.9"}
    for i in range(20):
        assert login(t, f"someone{i % 5}x{i}", "bad-password", ip).status_code == 401
    assert login(t, user["username"], headers=ip).status_code == 429
    assert login(t, user["username"], headers={"x-forwarded-for": "10.0.0.10"}).status_code == 200
    clock.advance(15 * MIN)
    assert login(t, user["username"], headers=ip).status_code == 200


def test_trusted_proxy_spoofed_prefix_cannot_bypass():
    """代理把真實對端 IP 附加到鏈尾；用戶端自填的前綴不影響判斷"""
    t, _db, _clock, user = setup(trusted_proxy=True)
    for i in range(20):
        spoof = {"x-forwarded-for": f"1.2.3.{i}, 10.0.0.9"}
        assert login(t, f"someone{i % 5}x{i}", "bad-password", spoof).status_code == 401
    assert login(t, user["username"], headers={"x-forwarded-for": "10.0.0.9"}).status_code == 429
    assert login(t, user["username"], headers={"x-forwarded-for": "8.8.8.8, 10.0.0.9"}).status_code == 429
    assert login(t, user["username"], headers={"x-forwarded-for": "10.0.0.10"}).status_code == 200


# ── session 期限 ──


def test_absolute_expiry_9h_even_with_heartbeat():
    t, _db, clock, user = setup()
    api = login_as(t, user)
    for _ in range(17):
        clock.advance(30 * MIN)
        assert api.request("POST", "/api/auth/heartbeat").status_code == 200
    clock.advance(30 * MIN - 1)
    assert api.get("/api/auth/me").status_code == 200
    clock.advance(1)
    assert api.get("/api/auth/me").status_code == 401


def test_get_polling_does_not_refresh_idle():
    t, _db, clock, user = setup()
    api = login_as(t, user)
    for _ in range(59):
        clock.advance(MIN)
        assert api.get("/api/tasks").status_code == 200
    clock.advance(MIN)
    res = api.get("/api/tasks")
    assert res.status_code == 401
    assert res.json()["error"]["message"] == "登入已逾時，請重新登入"


def test_heartbeat_and_writes_refresh_idle():
    t, _db, clock, user = setup()
    api = login_as(t, user)
    clock.advance(50 * MIN)
    hb = api.request("POST", "/api/auth/heartbeat")
    assert hb.status_code == 200
    assert hb.json()["lastActiveAt"] == clock.now()
    clock.advance(50 * MIN)
    assert api.request("POST", "/api/tasks", {"title": "寫入"}).status_code == 201
    clock.advance(59 * MIN)
    assert api.get("/api/auth/me").status_code == 200
    clock.advance(MIN)
    assert api.get("/api/auth/me").status_code == 401


def test_idle_timeout_configurable():
    t, _db, clock, user = setup(idle_timeout_ms=10 * MIN)
    api = login_as(t, user)
    me = api.get("/api/auth/me").json()
    assert me["session"]["idleTimeoutMs"] == 10 * MIN
    assert me["session"]["expiresAt"] == clock.now() + 9 * 60 * MIN
    clock.advance(10 * MIN)
    assert api.get("/api/auth/me").status_code == 401


# ── 改密碼 ──


def test_change_password():
    t, db, _clock, user = setup()
    db.execute("UPDATE users SET must_change_password = 1 WHERE id = ?", (user["id"],))
    a = login_as(t, user)
    b = login_as(t, user)
    assert a.get("/api/auth/me").json()["user"]["mustChangePassword"] is True

    bad = a.request("POST", "/api/auth/password", {"currentPassword": "nope", "newPassword": "new-password-1"})
    assert bad.status_code == 400
    short = a.request("POST", "/api/auth/password", {"currentPassword": user["password"], "newPassword": "short"})
    assert short.status_code == 400
    ok = a.request("POST", "/api/auth/password", {"currentPassword": user["password"], "newPassword": "new-password-1"})
    assert ok.status_code == 200
    assert ok.json()["user"]["mustChangePassword"] is False

    assert a.get("/api/auth/me").status_code == 200
    assert b.get("/api/auth/me").status_code == 401
    assert login(t, user["username"]).status_code == 401
    assert login(t, user["username"], "new-password-1").status_code == 200
    assert db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'user'") == 1


# ── CSRF ──


def test_csrf_cross_origin_or_non_json_403():
    t, _db, _clock, user = setup()
    api = login_as(t, user)
    assert api.request("POST", "/api/tasks", {"title": "x"}, {"origin": "http://evil.example"}).status_code == 403
    assert api.request("POST", "/api/tasks", {"title": "x"}, {"content-type": "text/plain"}).status_code == 403
    login_form = client(t).request(
        "POST",
        "/api/auth/login",
        {"username": user["username"], "password": user["password"]},
        {"origin": "http://evil.example"},
    )
    assert login_form.status_code == 403
    assert login_form.json()["error"]["code"] == "FORBIDDEN"
    # DELETE 不要求 Content-Type，但仍檢查 Origin
    assert api.request("DELETE", "/api/tasks/1", headers={"origin": "http://evil.example"}).status_code == 403


def test_app_origin_only():
    t, _db, _clock, user = setup(app_origin="https://tasks.lab")
    try:
        login_as(t, user)  # 測試 client 送 http://localhost
        raised = False
    except AssertionError:
        raised = True
    assert raised
    assert login(t, user["username"], headers={"origin": "https://tasks.lab"}).status_code == 200


# ── 預設管理員 ──


def test_ensure_admin_default_admin_password():
    db: Database = create_test_db()
    logs: list[str] = []
    admin = ensure_admin(db, log=logs.append)
    assert admin is not None
    assert admin["username"] == "admin" and admin["role"] == "root" and admin["must_change_password"] == 1
    assert verify_password(admin["password_hash"], "password")
    assert logs == ["[auth] 已建立預設管理員 admin / password，首次登入須重設帳號與密碼"]
    # 已有帳號時不再建立
    assert ensure_admin(db, log=logs.append) is None
    assert len(logs) == 1


def test_ensure_admin_from_env_does_not_log_password():
    db = create_test_db()
    logs: list[str] = []
    admin = ensure_admin(db, "boss", "env-password-1", log=logs.append)
    assert admin is not None and admin["username"] == "boss" and admin["must_change_password"] == 1
    assert verify_password(admin["password_hash"], "env-password-1")
    assert len(logs) == 1
    assert "env-password-1" not in ",".join(logs)


def test_config_admin_defaults_and_override():
    from server.app.config import load_config
    from server.app.settings import auth_settings_from

    c = load_config({"ADMIN_USERNAME": "", "ADMIN_PASSWORD": ""})
    assert (c.ADMIN_USERNAME, c.ADMIN_PASSWORD) == ("admin", "password")
    assert auth_settings_from(c).bootstrap_admin_username == "admin"
    c = load_config({"ADMIN_USERNAME": "boss", "ADMIN_PASSWORD": "env-password-1"})
    assert (c.ADMIN_USERNAME, c.ADMIN_PASSWORD) == ("boss", "env-password-1")
    assert auth_settings_from(c).bootstrap_admin_username == "boss"


def test_verify_existing_node_argon2_hash():
    """@node-rs/argon2 預設參數（m=19456,t=2,p=1）產生的雜湊可驗證"""
    from argon2 import PasswordHasher

    h = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1).hash("hello-world")
    assert h.startswith("$argon2id$v=19$m=19456,t=2,p=1$")
    assert verify_password(h, "hello-world")
    assert not verify_password(h, "nope")
    assert not verify_password("not-a-hash", "nope")
