"""預設管理員 admin / password 的首次重設帳號＋密碼，以及 `python -m server.cli user-add`。"""

from __future__ import annotations

import re

import pytest

from server import cli
from server.app.db import create_db
from server.app.features.users import ensure_admin
from server.app.security import verify_password

from .helpers import TestApp, client, create_test_db, create_test_user, login, login_as

NEW_PW = "brand-new-pass-1"


def bootstrap(**settings):
    """空 DB → ensure_admin（預設 admin / password）→ 以 admin 登入"""
    db = create_test_db()
    ensure_admin(db, log=lambda _m: None)
    t = TestApp(db=db, settings=settings or None)
    admin = {"username": "admin", "password": "password"}
    return t, db, admin


def change(api, **body):
    return api.request("POST", "/api/auth/password", {"currentPassword": "password", "newPassword": NEW_PW, **body})


def test_default_admin_login_requires_username_change():
    t, _db, admin = bootstrap()
    res = login(t, "admin", "password")
    assert res.status_code == 200
    body = res.json()
    assert body["user"]["mustChangePassword"] is True
    assert body["mustChangeUsername"] is True
    api = login_as(t, admin)
    assert api.get("/api/auth/me").json()["mustChangeUsername"] is True


def test_default_admin_change_username_and_password():
    t, db, admin = bootstrap()
    a = login_as(t, admin)
    b = login_as(t, admin)
    res = change(a, username="  Boss.Lin ")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["user"]["username"] == "boss.lin"
    assert body["user"]["mustChangePassword"] is False
    assert body["mustChangeUsername"] is False
    assert body["user"]["role"] == "root"
    # 目前 session 保留、其他 session 撤銷
    assert a.get("/api/auth/me").json()["user"]["username"] == "boss.lin"
    assert b.get("/api/auth/me").status_code == 401
    # 舊帳號無法登入，新帳號可登入
    assert login(t, "admin", "password").status_code == 401
    assert login(t, "admin", NEW_PW).status_code == 401
    assert login(t, "boss.lin", "password").status_code == 401
    assert login(t, "boss.lin", NEW_PW).status_code == 200
    assert db.scalar("SELECT count(*) FROM users") == 1


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({}, "請設定新帳號"),
        ({"username": "  "}, "請設定新帳號"),
        ({"username": "admin"}, "新帳號不可為預設的 admin"),
        ({"username": "ADMIN"}, "新帳號不可為預設的 admin"),
        ({"username": "x"}, "帳號須為 3–32 個英文字母、數字或 . _ -，且以字母或數字開頭"),
        ({"username": "-bad"}, "帳號須為 3–32 個英文字母、數字或 . _ -，且以字母或數字開頭"),
    ],
)
def test_default_admin_invalid_username(body, message):
    t, db, admin = bootstrap()
    res = change(login_as(t, admin), **body)
    assert res.status_code == 400
    err = res.json()["error"]
    assert err["message"] == message and err["details"] == {"field": "username"}
    # 未變更任何資料
    row = db.one("SELECT * FROM users WHERE username = 'admin'")
    assert row["must_change_password"] == 1 and verify_password(row["password_hash"], "password")


def test_default_admin_duplicate_username_409():
    t, db, admin = bootstrap()
    create_test_user(db, username="taken")
    res = change(login_as(t, admin), username="taken")
    assert res.status_code == 409
    assert res.json()["error"]["details"] == {"field": "username"}
    assert db.one("SELECT must_change_password FROM users WHERE username = 'admin'")[0] == 1


def test_default_admin_weak_or_same_password():
    t, _db, admin = bootstrap()
    api = login_as(t, admin)
    short = change(api, username="boss", newPassword="short")
    assert short.status_code == 400 and short.json()["error"]["code"] == "VALIDATION_ERROR"
    same = change(api, username="boss", newPassword="password")
    assert same.status_code == 400
    assert same.json()["error"]["details"] == {"field": "newPassword"}
    wrong = api.request(
        "POST", "/api/auth/password", {"currentPassword": "nope", "newPassword": NEW_PW, "username": "boss"}
    )
    assert wrong.status_code == 400 and wrong.json()["error"]["message"] == "目前密碼不正確"
    assert login(t, "boss", NEW_PW).status_code == 401


def test_password_cannot_be_default_for_regular_user():
    t = TestApp()
    user = create_test_user(t.db, must_change_password=1)
    res = login_as(t, user).request(
        "POST", "/api/auth/password", {"currentPassword": user["password"], "newPassword": "password"}
    )
    assert res.status_code == 400 and res.json()["error"]["message"] == "不可使用預設密碼，請設定其他密碼"


def test_regular_user_cannot_change_username():
    t = TestApp()
    user = create_test_user(t.db, must_change_password=1)
    api = login_as(t, user)
    assert api.get("/api/auth/me").json()["mustChangeUsername"] is False
    res = api.request(
        "POST", "/api/auth/password", {"currentPassword": user["password"], "newPassword": NEW_PW, "username": "other"}
    )
    assert res.status_code == 400 and res.json()["error"]["details"] == {"field": "username"}
    ok = api.request("POST", "/api/auth/password", {"currentPassword": user["password"], "newPassword": NEW_PW})
    assert ok.status_code == 200 and ok.json()["user"]["username"] == user["username"]


def test_admin_username_without_must_change_is_normal():
    """名為 admin 但已完成首次重設（must_change_password=0）：一般改密碼，不可改帳號"""
    t = TestApp()
    user = create_test_user(t.db, username="admin", role="root")
    api = login_as(t, user)
    assert api.get("/api/auth/me").json()["mustChangeUsername"] is False
    res = api.request(
        "POST", "/api/auth/password", {"currentPassword": user["password"], "newPassword": NEW_PW, "username": "boss"}
    )
    assert res.status_code == 400


def test_bootstrap_username_follows_setting():
    """ADMIN_USERNAME 覆寫時，以該帳號為預設管理員"""
    db = create_test_db()
    ensure_admin(db, "boss", "env-password-1", log=lambda _m: None)
    t = TestApp(db=db, settings={"bootstrap_admin_username": "boss"})
    api = login_as(t, {"username": "boss", "password": "env-password-1"})
    assert api.get("/api/auth/me").json()["mustChangeUsername"] is True
    res = api.request(
        "POST", "/api/auth/password", {"currentPassword": "env-password-1", "newPassword": NEW_PW, "username": "boss"}
    )
    assert res.status_code == 400
    res = api.request(
        "POST", "/api/auth/password", {"currentPassword": "env-password-1", "newPassword": NEW_PW, "username": "chief"}
    )
    assert res.status_code == 200 and res.json()["user"]["username"] == "chief"


def test_me_without_login_401():
    t, _db, _admin = bootstrap()
    assert client(t).get("/api/auth/me").status_code == 401


# ── CLI user-add ──


@pytest.fixture
def cli_db(tmp_path):
    return str(tmp_path / "cli.db")


def _user(path: str, username: str):
    db = create_db(path)
    try:
        return db.one("SELECT * FROM users WHERE username = ?", (username,))
    finally:
        db.close()


def test_cli_user_add_with_password(cli_db, capsys):
    assert cli.main(["user-add", "Alice", "--name", "愛麗絲", "--password", "alice-pass-1", "--db", cli_db]) == 0
    out = capsys.readouterr().out
    assert "已建立成員（user）帳號 alice" in out and "首次登入後須立即變更密碼" in out
    assert "alice-pass-1" not in out
    row = _user(cli_db, "alice")
    assert row["role"] == "user" and row["display_name"] == "愛麗絲" and row["must_change_password"] == 1
    assert verify_password(row["password_hash"], "alice-pass-1")


def test_cli_user_add_random_password(cli_db, capsys):
    assert cli.main(["user-add", "bob", "--db", cli_db]) == 0
    out = capsys.readouterr().out
    password = re.search(r"隨機初始密碼：(\S+?)（", out).group(1)  # type: ignore[union-attr]
    row = _user(cli_db, "bob")
    assert row["role"] == "user" and row["must_change_password"] == 1 and row["display_name"] == "bob"
    assert verify_password(row["password_hash"], password)


def test_cli_user_add_admin_alias(cli_db, capsys):
    """--admin 為舊寫法：等同 --role root，並提示新寫法"""
    assert cli.main(["user-add", "carol", "--admin", "--password", "carol-pass-1", "--db", cli_db]) == 0
    cap = capsys.readouterr()
    assert "已建立超級管理員（root）帳號 carol" in cap.out
    assert "--role root" in cap.err
    assert _user(cli_db, "carol")["role"] == "root"
    # 與其他 --role 衝突時拒絕
    assert cli.main(["user-add", "carl", "--admin", "--role", "user", "--db", cli_db]) == 1
    assert "衝突" in capsys.readouterr().err
    assert _user(cli_db, "carl") is None


@pytest.mark.parametrize("role", ["root", "manager", "user"])
def test_cli_user_add_role(cli_db, capsys, role):
    assert cli.main(["user-add", f"r-{role}", "--role", role, "--password", "role-pass-1", "--db", cli_db]) == 0
    assert f"（{role}）帳號 r-{role}" in capsys.readouterr().out
    assert _user(cli_db, f"r-{role}")["role"] == role


def test_cli_user_add_invalid_role(cli_db, capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main(["user-add", "frank", "--role", "admin", "--db", cli_db])
    assert exc.value.code == 2
    assert "--role" in capsys.readouterr().err


def test_cli_user_add_errors(cli_db, capsys):
    assert cli.main(["user-add", "dave", "--password", "dave-pass-1", "--db", cli_db]) == 0
    capsys.readouterr()
    assert cli.main(["user-add", "dave", "--db", cli_db]) == 1
    assert "帳號 dave 已存在" in capsys.readouterr().err
    assert cli.main(["user-add", "erin", "--password", "short", "--db", cli_db]) == 1
    assert "密碼須為 8–256 個字元" in capsys.readouterr().err
    assert cli.main(["user-add", "x", "--db", cli_db]) == 1
    assert "帳號須為" in capsys.readouterr().err
    assert cli.main(["user-add", "--db", cli_db]) == 1
    assert _user(cli_db, "erin") is None


def test_cli_help(capsys):
    assert cli.main(["--help"]) == 0
    assert "user-add" in capsys.readouterr().out
    with pytest.raises(SystemExit) as exc:
        cli.main(["user-add", "--help"])
    assert exc.value.code == 0
    assert "--password" in capsys.readouterr().out
