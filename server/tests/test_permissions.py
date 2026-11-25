"""三層角色權限（server/app/permissions.py、docs/permissions.md）：
權限矩陣（每個 capability × root / manager / user）、成員管理的角色規則、狀態管理、role migration。"""

import itertools
import shutil
import sqlite3

import pytest

from server.app.db import MIGRATIONS_DIR, create_db, run_migrations, run_seed
from server.app.permissions import CAPABILITIES, ROLES, can, capabilities_of, role_can

from .helpers import FakeClock, create_test_app, create_test_user, login, login_as

ROLE_ORDER = {"user": 1, "manager": 2, "root": 3}
_seq = itertools.count(1)


def _uniq(prefix: str) -> str:
    return f"{prefix}-{next(_seq)}"


# 每個 capability 一個探測請求：(method, path, body)。允許時不得為 401 / 403 / 5xx，拒絕時必為 403。
PROBES = {
    "tasks.edit": lambda: ("POST", "/api/tasks", {"title": "權限測試任務"}),
    "feedback.edit": lambda: ("POST", "/api/feedback", {"kind": "bug", "title": "權限測試回饋"}),
    "personal.edit": lambda: ("POST", "/api/personal", {"title": "權限測試待辦"}),
    "eng.edit": lambda: ("POST", "/api/eng/issues", {"title": "權限測試問題"}),
    "projects.create": lambda: ("POST", "/api/projects", {"name": _uniq("專案")}),
    "properties.edit": lambda: ("POST", "/api/properties", {"name": _uniq("欄位"), "type": "text"}),
    "profile.edit": lambda: ("POST", "/api/auth/password", {"currentPassword": "wrong-pass", "newPassword": "x" * 12}),
    "members.manage": lambda: ("GET", "/api/admin/users", None),
    "statuses.manage": lambda: ("POST", "/api/statuses", {"name": _uniq("狀態")}),
    "projects.manage": lambda: ("PATCH", "/api/projects/1", {"name": _uniq("改名")}),
    "github.manage": lambda: ("PUT", "/api/eng/github-links", {"links": []}),
    "data.export_json": lambda: ("GET", "/api/admin/data/export", None),
    "data.import_merge": lambda: ("POST", "/api/admin/data/import/preview", {"format": "nope"}),
    "data.backup_db": lambda: ("GET", "/api/admin/data/backup", None),
    "data.import_replace": lambda: ("POST", "/api/admin/data/import/apply", {"mode": "replace", "token": "nope"}),
    "roles.assign_root": lambda: (
        "POST",
        "/api/admin/users",
        {"username": _uniq("new-root"), "displayName": "R", "role": "root"},
    ),
}


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    t.app.state.github_token = "gh-test-token"
    t.app.state.backup_dir = str(tmp_path_factory.mktemp("backups"))
    apis = {role: login_as(t, create_test_user(t.db, role=role)) for role in ROLES}
    return t, apis


def test_every_capability_has_a_probe():
    assert set(PROBES) == set(CAPABILITIES)


@pytest.mark.parametrize("capability", list(CAPABILITIES))
@pytest.mark.parametrize("role", ["user", "manager", "root"])
def test_matrix(env, capability, role):
    _t, apis = env
    allowed = ROLE_ORDER[role] >= ROLE_ORDER[CAPABILITIES[capability]]
    assert role_can(role, capability) is allowed
    method, path, body = PROBES[capability]()
    res = apis[role].request(method, path, body)
    if allowed:
        assert res.status_code not in (401, 403) and res.status_code < 500, (res.status_code, res.text)
    else:
        assert res.status_code == 403, (res.status_code, res.text)
        assert res.json()["error"] == {"code": "FORBIDDEN", "message": "沒有權限執行此操作"}


def test_matrix_shape():
    """user ⊂ manager ⊂ root；最低角色分布符合 docs/permissions.md"""
    by_role = {r: set(capabilities_of({"role": r})) for r in ROLES}
    assert by_role["user"] < by_role["manager"] < by_role["root"]
    assert by_role["root"] == set(CAPABILITIES)
    assert by_role["manager"] - by_role["user"] == {
        "members.manage",
        "statuses.manage",
        "projects.manage",
        "github.manage",
        "data.export_json",
        "data.import_merge",
    }
    assert by_role["root"] - by_role["manager"] == {"data.backup_db", "data.import_replace", "roles.assign_root"}
    assert capabilities_of(None) == [] and capabilities_of({"role": "admin"}) == []
    assert not can(None, "tasks.edit")
    with pytest.raises(KeyError):
        can({"role": "root"}, "no.such")


def test_frontend_capabilities_in_sync():
    """src/shared/permissions.ts 的 CAPABILITIES 與後端一致（名稱與最低角色）"""
    import re
    from pathlib import Path

    ts = (Path(__file__).resolve().parents[2] / "src" / "shared" / "permissions.ts").read_text(encoding="utf-8")
    pairs = dict(re.findall(r"'([a-z_]+\.[a-z_]+)': '(root|manager|user)'", ts))
    assert pairs == CAPABILITIES


def test_me_and_login_include_capabilities(env):
    t, apis = env
    for role in ROLES:
        me = apis[role].get("/api/auth/me").json()
        assert me["user"]["role"] == role
        assert me["capabilities"] == capabilities_of({"role": role})
    u = create_test_user(t.db, role="manager")
    body = login(t, u["username"]).json()
    assert "members.manage" in body["capabilities"] and "data.backup_db" not in body["capabilities"]


# ── 成員管理：manager 只能在 user ↔ manager 間調整，root 帳號只有 root 能動 ──


def member_env():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    root = create_test_user(t.db, role="root")
    manager = create_test_user(t.db, role="manager")
    user = create_test_user(t.db, role="user")
    return t, root, manager, user, login_as(t, root), login_as(t, manager)


def test_manager_member_rules():
    t, root, manager, user, _r, m = member_env()
    # 新增：user / manager 可，root 不可
    assert m.request("POST", "/api/admin/users", {"username": "m-new1", "displayName": "A"}).json()["user"]["role"] == "user"
    made = m.request("POST", "/api/admin/users", {"username": "m-new2", "displayName": "B", "role": "manager"})
    assert made.status_code == 201 and made.json()["user"]["role"] == "manager"
    assert m.request("POST", "/api/admin/users", {"username": "m-new3", "displayName": "C", "role": "root"}).status_code == 403
    assert t.db.one("SELECT id FROM users WHERE username = 'm-new3'") is None

    # user ↔ manager
    up = m.request("PATCH", f"/api/admin/users/{user['id']}", {"role": "manager"})
    assert up.status_code == 200 and up.json()["role"] == "manager"
    down = m.request("PATCH", f"/api/admin/users/{user['id']}", {"role": "user"})
    assert down.status_code == 200 and down.json()["role"] == "user"
    # 不能設為 root
    assert m.request("PATCH", f"/api/admin/users/{user['id']}", {"role": "root"}).status_code == 403
    # 不能動 root 帳號（編輯、停用、重設密碼、解鎖）
    rid = root["id"]
    for method, path, body in [
        ("PATCH", f"/api/admin/users/{rid}", {"displayName": "改名"}),
        ("PATCH", f"/api/admin/users/{rid}", {"isActive": False}),
        ("PATCH", f"/api/admin/users/{rid}", {"role": "user"}),
        ("POST", f"/api/admin/users/{rid}/reset-password", None),
        ("POST", f"/api/admin/users/{rid}/unlock", None),
    ]:
        assert m.request(method, path, body).status_code == 403, (method, path, body)
    row = t.db.one("SELECT display_name, role, is_active FROM users WHERE id = ?", (rid,))
    assert (row["role"], row["is_active"]) == ("root", 1) and row["display_name"] != "改名"
    # 可管理其他 manager（含重設密碼）
    assert m.request("POST", f"/api/admin/users/{made.json()['user']['id']}/reset-password").status_code == 200
    # 列表可看到 root
    assert any(u["role"] == "root" for u in m.get("/api/admin/users").json())


def test_root_assigns_and_revokes_root():
    t, root, manager, _user, r, _m = member_env()
    up = r.request("PATCH", f"/api/admin/users/{manager['id']}", {"role": "root"})
    assert up.status_code == 200 and up.json()["role"] == "root"
    # 現在有兩位 root：可撤銷自己的 root
    down = r.request("PATCH", f"/api/admin/users/{root['id']}", {"role": "manager"})
    assert down.status_code == 200
    # 降為 manager 後即失去 roles.assign_root
    assert r.request("PATCH", f"/api/admin/users/{manager['id']}", {"role": "user"}).status_code == 403
    assert r.get("/api/auth/me").json()["capabilities"] == capabilities_of({"role": "manager"})


def test_last_root_protected():
    t, root, _manager, _user, r, _m = member_env()
    create_test_user(t.db, role="root", is_active=0)  # 停用中的 root 不算數
    for patch in ({"isActive": False}, {"role": "manager"}, {"role": "user"}):
        res = r.request("PATCH", f"/api/admin/users/{root['id']}", patch)
        assert res.status_code == 409
        assert res.json()["error"]["message"] == "至少需保留一位超級管理員"
    # manager 不算 root：有其他啟用中的 manager 也不行
    assert t.db.one("SELECT role FROM users WHERE id = ?", (root["id"],))["role"] == "root"


def test_manager_can_demote_self():
    t, _root, manager, _user, _r, m = member_env()
    res = m.request("PATCH", f"/api/admin/users/{manager['id']}", {"role": "user"})
    assert res.status_code == 200
    assert m.get("/api/admin/users").status_code == 403


# ── 狀態管理（/api/statuses） ──


def test_statuses_crud():
    t, _root, _manager, user, _r, m = member_env()
    before = t.db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'status'")
    created = m.request("POST", "/api/statuses", {"name": " 阻塞 "})
    assert created.status_code == 201
    s = created.json()
    assert (s["name"], s["color"], s["category"], s["sortOrder"]) == ("阻塞", "gray", "todo", 5)
    assert m.request("POST", "/api/statuses", {"name": "x", "color": "#fff"}).status_code == 400
    assert m.request("POST", "/api/statuses", {"name": "x", "category": "nope"}).status_code == 400
    assert m.request("POST", "/api/statuses", {"name": " "}).status_code == 400

    patched = m.request("PATCH", f"/api/statuses/{s['id']}", {"name": "卡住", "color": "red", "sortOrder": 0.5})
    assert patched.status_code == 200
    assert (patched.json()["name"], patched.json()["color"]) == ("卡住", "red")
    assert m.get("/api/statuses").json()[0]["id"] == s["id"]  # 排序生效
    assert m.request("PATCH", "/api/statuses/999", {"name": "y"}).status_code == 404

    # 使用中（含已刪除的任務）→ 409
    u = login_as(t, user)
    task = u.request("POST", "/api/tasks", {"title": "用到新狀態", "statusId": s["id"]}).json()
    assert u.request("DELETE", f"/api/tasks/{task['id']}").status_code in (200, 204)
    res = m.request("DELETE", f"/api/statuses/{s['id']}")
    assert res.status_code == 409
    assert "仍有 1 筆任務使用此狀態" in res.json()["error"]["message"]
    # 改為其他狀態後可刪
    t.db.execute("UPDATE tasks SET status_id = 1 WHERE id = ?", (task["id"],))
    assert m.request("DELETE", f"/api/statuses/{s['id']}").status_code == 200
    assert s["id"] not in [x["id"] for x in m.get("/api/statuses").json()]
    assert m.request("DELETE", f"/api/statuses/{s['id']}").status_code == 404
    after = t.db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'status'")
    assert after == before + 3  # create / update / delete

    # user 不可寫入
    assert u.request("POST", "/api/statuses", {"name": "x"}).status_code == 403
    assert u.request("PATCH", "/api/statuses/1", {"name": "x"}).status_code == 403
    assert u.request("DELETE", "/api/statuses/1").status_code == 403


def test_cannot_delete_last_status():
    t, _root, _manager, _user, _r, m = member_env()
    ids = [s["id"] for s in m.get("/api/statuses").json()]
    t.db.execute("DELETE FROM tasks")
    for sid in ids[:-1]:
        assert m.request("DELETE", f"/api/statuses/{sid}").status_code == 200
    res = m.request("DELETE", f"/api/statuses/{ids[-1]}")
    assert res.status_code == 409 and res.json()["error"]["message"] == "至少需保留一個狀態"


# ── migration 0006_roles ──


def test_role_migration(tmp_path):
    old = tmp_path / "old"
    old.mkdir()
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if f.stem < "0006":
            shutil.copy(f, old / f.name)
    path = str(tmp_path / "old.db")
    db = create_db(path)
    run_migrations(db, old)
    run_seed(db)
    for name, role in [("old-admin", "admin"), ("old-member", "member"), ("old-default", None)]:
        if role is None:
            db.execute(
                "INSERT INTO users (username, display_name, password_hash, created_at, updated_at) VALUES (?, ?, 'x', 1, 1)",
                (name, name),
            )
        else:
            db.execute(
                "INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) "
                "VALUES (?, ?, 'x', ?, 1, 1)",
                (name, name, role),
            )
    db.close()

    db2 = create_db(path)
    assert "0006_roles" in run_migrations(db2)
    roles = {r["username"]: r["role"] for r in db2.all("SELECT username, role FROM users")}
    assert roles == {"old-admin": "root", "old-member": "user", "old-default": "user"}

    # 之後以舊值或欄位預設寫入，會轉為新值；不合法的值拒絕
    db2.execute(
        "INSERT INTO users (username, display_name, password_hash, created_at, updated_at) VALUES ('d2', 'd2', 'x', 1, 1)"
    )
    db2.execute(
        "INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) "
        "VALUES ('a2', 'a2', 'x', 'admin', 1, 1)"
    )
    assert db2.scalar("SELECT role FROM users WHERE username = 'd2'") == "user"
    assert db2.scalar("SELECT role FROM users WHERE username = 'a2'") == "root"
    with pytest.raises(sqlite3.IntegrityError):
        db2.execute(
            "INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) "
            "VALUES ('bad', 'bad', 'x', 'superuser', 1, 1)"
        )
    with pytest.raises(sqlite3.IntegrityError):
        db2.execute("UPDATE users SET role = 'member' WHERE username = 'd2'")
    assert run_migrations(db2) == []
    db2.close()


def test_role_migration_on_empty_db():
    db = create_db(":memory:")
    assert "0006_roles" in run_migrations(db)
    assert db.scalar("SELECT count(*) FROM users") == 0
    db.close()
