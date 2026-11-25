"""權限設定（/api/admin/permissions、role_permissions 覆寫、有效矩陣）。docs/permissions.md"""

import pytest

from server.app.permissions import (
    CAPABILITIES,
    CONFIGURABLE_ROLES,
    PROTECTED_CAPABILITIES,
    ROLES,
    can,
    capabilities_of,
    invalidate,
    role_can,
)

from .helpers import FakeClock, create_test_app, create_test_user, login_as
from .test_permissions import PROBES

URL = "/api/admin/permissions"


@pytest.fixture
def env(tmp_path):
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    t.app.state.github_token = "gh-test-token"
    t.app.state.backup_dir = str(tmp_path / "backups")
    users = {role: create_test_user(t.db, role=role) for role in ROLES}
    apis = {role: login_as(t, users[role]) for role in ROLES}
    return t, users, apis


def put(api, *changes):
    return api.request("PUT", URL, {"changes": [{"role": r, "capability": c, "allowed": a} for r, c, a in changes]})


def caps(api):
    return set(api.get("/api/auth/me").json()["capabilities"])


def probe(api, capability):
    method, path, body = PROBES[capability](api)
    return api.request(method, path, body)


def assert_probe(api, capability, allowed):
    res = probe(api, capability)
    if allowed:
        assert res.status_code not in (401, 403) and res.status_code < 500, (capability, res.status_code, res.text)
    else:
        assert res.status_code == 403, (capability, res.status_code, res.text)
        assert res.json()["error"]["code"] == "FORBIDDEN"


def test_get_matrix_defaults(env):
    _t, _users, apis = env
    res = apis["root"].get(URL)
    assert res.status_code == 200
    body = res.json()
    assert [r["role"] for r in body["roles"]] == list(ROLES)
    assert [r["configurable"] for r in body["roles"]] == [False, True, True]
    assert [c["key"] for c in body["capabilities"]] == list(CAPABILITIES)
    groups = {g["key"] for g in body["groups"]}
    for c in body["capabilities"]:
        assert c["label"] and c["group"] in groups
        assert c["protected"] is (c["key"] in PROTECTED_CAPABILITIES)
        assert c["defaults"] == {r: role_can(r, c["key"]) for r in ROLES}
        assert c["effective"] == c["defaults"]
        assert c["overridden"] == {"manager": False, "user": False}
    assert body["lastUpdated"] is None
    # 預設行為不變：me 與預設矩陣一致
    for role in ROLES:
        assert caps(apis[role]) == set(capabilities_of({"role": role}))


def test_override_grant_and_revoke(env):
    t, users, apis = env
    assert_probe(apis["user"], "statuses.manage", False)
    res = put(apis["root"], ("user", "statuses.manage", True), ("manager", "projects.manage", False))
    assert res.status_code == 200, res.text
    row = next(c for c in res.json()["capabilities"] if c["key"] == "statuses.manage")
    assert row["effective"]["user"] is True and row["overridden"]["user"] is True
    assert res.json()["lastUpdated"]["userId"] == users["root"]["id"]
    # 下一個請求即生效（快取已失效）
    assert "statuses.manage" in caps(apis["user"])
    assert_probe(apis["user"], "statuses.manage", True)
    assert "projects.manage" not in caps(apis["manager"])
    assert_probe(apis["manager"], "projects.manage", False)
    assert t.db.scalar("SELECT count(*) FROM role_permissions") == 2
    # 改回預設值 → 刪除覆寫列
    assert put(apis["root"], ("user", "statuses.manage", False)).status_code == 200
    assert t.db.scalar("SELECT count(*) FROM role_permissions") == 1
    assert_probe(apis["user"], "statuses.manage", False)
    # 每次寫入都有一筆 permission 變更流水（SSE 據此通知前端）
    rows = t.db.all("SELECT entity_id, action, actor_id FROM changes WHERE entity_type = 'permission'")
    assert [tuple(r) for r in rows] == [(0, "update", users["root"]["id"])] * 2


def test_revoke_user_level_capability(env):
    """一般協作權限（原本登入即可）收回後，寫入 403、讀取不受影響"""
    _t, _users, apis = env
    assert put(apis["root"], ("user", "tasks.edit", False)).status_code == 200
    assert_probe(apis["user"], "tasks.edit", False)
    assert apis["user"].get("/api/tasks").status_code == 200
    assert_probe(apis["manager"], "tasks.edit", True)


def test_profile_edit_revoked_but_forced_change_allowed(env):
    t, _users, apis = env
    assert put(apis["root"], ("user", "profile.edit", False)).status_code == 200
    assert_probe(apis["user"], "profile.edit", False)
    forced = create_test_user(t.db, role="user", must_change_password=1)
    res = login_as(t, forced).request(
        "POST", "/api/auth/password", {"currentPassword": forced["password"], "newPassword": "new-password-123"}
    )
    assert res.status_code == 200, res.text


def test_protected_cannot_be_granted(env):
    t, _users, apis = env
    for cap in PROTECTED_CAPABILITIES:
        for role in CONFIGURABLE_ROLES:
            res = put(apis["root"], (role, cap, True))
            assert res.status_code == 400, (cap, role)
            assert "僅限超級管理員" in res.json()["error"]["message"]
            # 設為 false（= 預設）不算授予，可接受且不寫入
            assert put(apis["root"], (role, cap, False)).status_code == 200
    # 同一批次有一筆不合法 → 全部不寫入
    res = put(apis["root"], ("user", "statuses.manage", True), ("manager", "data.backup_db", True))
    assert res.status_code == 400
    assert t.db.scalar("SELECT count(*) FROM role_permissions") == 0
    # 直接寫入 DB 的受保護覆寫也會被忽略
    t.db.execute(
        "INSERT INTO role_permissions (role, capability, allowed, updated_at) VALUES ('manager', 'data.backup_db', 1, 1)"
    )
    invalidate(t.db)
    assert not can({"role": "manager"}, "data.backup_db", t.db)
    assert_probe(apis["manager"], "data.backup_db", False)


def test_root_cannot_be_overridden(env):
    t, _users, apis = env
    res = put(apis["root"], ("root", "tasks.edit", False))
    assert res.status_code == 400 and "超級管理員永遠擁有全部權限" in res.json()["error"]["message"]
    for bad in [("admin", "tasks.edit", True), ("user", "no.such", True)]:
        assert put(apis["root"], bad).status_code == 400
    assert apis["root"].request("PUT", URL, {"changes": [{"role": "user"}]}).status_code == 400
    assert apis["root"].request("PUT", URL, {"nope": 1}).status_code == 400
    # DB 層也拒絕 root 列
    with pytest.raises(Exception):
        t.db.execute(
            "INSERT INTO role_permissions (role, capability, allowed, updated_at) VALUES ('root', 'tasks.edit', 0, 1)"
        )
    assert caps(apis["root"]) == set(CAPABILITIES)


def test_reset(env):
    t, _users, apis = env
    assert put(apis["root"], ("user", "statuses.manage", True), ("manager", "members.manage", False)).status_code == 200
    res = apis["root"].request("POST", f"{URL}/reset", {"role": "user"})
    assert res.status_code == 200
    assert "statuses.manage" not in caps(apis["user"])
    assert "members.manage" not in caps(apis["manager"])
    assert apis["root"].request("POST", f"{URL}/reset", {"role": "root"}).status_code == 400
    res = apis["root"].request("POST", f"{URL}/reset")
    assert res.status_code == 200
    assert all(c["effective"] == c["defaults"] for c in res.json()["capabilities"])
    assert t.db.scalar("SELECT count(*) FROM role_permissions") == 0
    assert "members.manage" in caps(apis["manager"])


def test_non_root_forbidden(env):
    _t, _users, apis = env
    for role in CONFIGURABLE_ROLES:
        api = apis[role]
        assert api.get(URL).status_code == 403
        assert put(api, ("user", "statuses.manage", True)).status_code == 403
        assert api.request("POST", f"{URL}/reset").status_code == 403
    # 授予 manager 成員管理也不影響此頁（permissions.configure 受保護）
    assert put(apis["root"], ("manager", "members.manage", True)).status_code == 200
    assert apis["manager"].get(URL).status_code == 403


def test_cache_invalidation(env):
    """有效矩陣在記憶體快取：直接改 DB 不會生效，透過 API 寫入（或 invalidate）後下一個請求即生效"""
    t, _users, apis = env
    assert "statuses.manage" not in caps(apis["user"])  # 建立快取
    t.db.execute(
        "INSERT INTO role_permissions (role, capability, allowed, updated_at) VALUES ('user', 'statuses.manage', 1, 1)"
    )
    assert "statuses.manage" not in caps(apis["user"])  # 仍是快取
    invalidate(t.db)
    assert "statuses.manage" in caps(apis["user"])
    assert put(apis["root"], ("user", "statuses.manage", False)).status_code == 200
    assert "statuses.manage" not in caps(apis["user"])


@pytest.mark.parametrize("capability", [c for c in CAPABILITIES if c not in PROTECTED_CAPABILITIES])
@pytest.mark.parametrize("role", list(CONFIGURABLE_ROLES))
def test_every_capability_flips(env, capability, role):
    """每個可調整的 capability × 角色：翻轉預設後，me 與端點實際行為皆一致；重設後恢復"""
    _t, _users, apis = env
    default = role_can(role, capability)
    assert put(apis["root"], (role, capability, not default)).status_code == 200
    assert (capability in caps(apis[role])) is (not default)
    assert_probe(apis[role], capability, not default)
    # 其他角色不受影響
    other = next(r for r in CONFIGURABLE_ROLES if r != role)
    assert (capability in caps(apis[other])) is role_can(other, capability)
    assert_probe(apis["root"], capability, True)
    assert apis["root"].request("POST", f"{URL}/reset").status_code == 200
    assert (capability in caps(apis[role])) is default
    assert_probe(apis[role], capability, default)
