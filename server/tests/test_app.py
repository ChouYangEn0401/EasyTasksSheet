import pytest

from .helpers import client, create_test_app, create_test_user, login_as

# 各功能路由：此處只驗證「未登入一律 401」（功能細節由各自的測試檔負責）
FEATURE_PATHS = [
    ("GET", "/api/overview"),
    ("GET", "/api/feedback"),
    ("GET", "/api/personal"),
    ("GET", "/api/changes?since=0"),
    ("GET", "/api/events"),
]

CORE_LIST_PATHS = ["/api/users", "/api/projects", "/api/statuses", "/api/tasks", "/api/properties"]

# 已實作的功能路由：只驗證未登入 401
IMPLEMENTED_FEATURE_PATHS = [("GET", "/api/eng/issues"), ("GET", "/api/eng/worktrees"), ("GET", "/api/admin/users")]

PROTECTED_PATHS = [
    ("GET", "/api/auth/me"),
    ("POST", "/api/auth/heartbeat"),
    ("POST", "/api/auth/password"),
    ("GET", "/api/users"),
    ("GET", "/api/projects"),
    ("POST", "/api/projects"),
    ("GET", "/api/statuses"),
    ("GET", "/api/tasks"),
    ("PATCH", "/api/tasks/1"),
    ("DELETE", "/api/tasks/1"),
    ("GET", "/api/properties"),
    ("GET", "/api/nope"),
    *FEATURE_PATHS,
    *IMPLEMENTED_FEATURE_PATHS,
]


def logged_in():
    t = create_test_app()
    user = create_test_user(t.db)
    return login_as(t, user)


def test_health_without_login():
    t = create_test_app(now=lambda: 123)
    res = t.http.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"ok": True, "time": 123}


@pytest.mark.parametrize("method,path", PROTECTED_PATHS)
def test_protected_paths_require_login(method, path):
    t = create_test_app()
    res = client(t).request(method, path, None if method in ("GET", "DELETE") else {})
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "UNAUTHORIZED"


@pytest.mark.parametrize("path", CORE_LIST_PATHS)
def test_core_list_paths_mounted(path):
    api = logged_in()
    assert api.get(path).status_code == 200


def test_public_report_path_skips_session():
    t = create_test_app()
    res = client(t).request("POST", "/api/eng/worktrees/report", {})
    # 不需 session；未設定 WORKTREE_REPORT_TOKEN 時一律 403
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "FORBIDDEN"


def test_unknown_api_returns_json_404():
    api = logged_in()
    res = api.get("/api/nope")
    assert res.status_code == 404
    assert res.json() == {"error": {"code": "NOT_FOUND", "message": "找不到 API"}}
    # 已知路徑但方法不支援，同樣回 JSON 404
    res = api.request("PUT", "/api/tasks", {})
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "NOT_FOUND"


def test_spa_fallback(tmp_path):
    from fastapi.testclient import TestClient

    from server.app.app import create_app

    (tmp_path / "index.html").write_text('<div id="root"></div>', encoding="utf-8")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    t = create_test_app()
    http = TestClient(create_app(t.db, static_dir=str(tmp_path)))
    assert '<div id="root">' in http.get("/some/spa/route").text
    assert http.get("/").status_code == 200
    assert http.get("/assets/app.js").text == "console.log(1)"
    assert '<div id="root">' in http.get("/../pyproject.toml").text
    res = http.get("/api/unknown")
    assert res.status_code == 401  # 未登入的 /api/* 不會被 SPA 接走
    assert res.json()["error"]["code"] == "UNAUTHORIZED"
