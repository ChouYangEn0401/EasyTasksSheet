"""子路徑部署（BASE_PATH，例如 nginx 的 /easytasks/）。docs/DEPLOY-152.md"""

import pytest
from fastapi.testclient import TestClient

from server.app.app import create_app
from server.app.config import ConfigError, load_config, normalize_base_path

from .helpers import TEST_PASSWORD, create_test_app, create_test_user


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("", ""), ("/", ""), ("easytasks", "/easytasks"), ("/easytasks/", "/easytasks"), ("/a/b", "/a/b")],
)
def test_normalize_base_path(raw, expected):
    assert normalize_base_path(raw) == expected


@pytest.mark.parametrize("raw", ["/a b", "/../x", "/a?b", "/<x>"])
def test_invalid_base_path_rejected(raw):
    with pytest.raises(ConfigError):
        load_config({"BASE_PATH": raw})


def test_default_is_root():
    assert load_config({}).BASE_PATH == ""


def _app(tmp_path, base_path="/easytasks"):
    (tmp_path / "index.html").write_text('<div id="root"></div>', encoding="utf-8")
    (tmp_path / "static" / "js").mkdir(parents=True)
    (tmp_path / "static" / "js" / "app.js").write_text("console.log(1)", encoding="utf-8")
    t = create_test_app()
    app = create_app(t.db, settings={"cookie_path": base_path or "/"}, static_dir=str(tmp_path), base_path=base_path)
    return t, TestClient(app)


def test_prefix_stripped_or_not_both_work(tmp_path):
    """nginx 去掉前綴（proxy_pass 結尾斜線）或不去前綴（直接連後端）都要能用"""
    _, http = _app(tmp_path)
    for prefix in ("", "/easytasks"):
        assert http.get(f"{prefix}/api/health").json()["ok"] is True
        assert http.get(f"{prefix}/static/js/app.js").text == "console.log(1)"
        assert '<div id="root">' in http.get(f"{prefix}/tasks/list").text
        assert http.get(f"{prefix}/api/tasks").status_code == 401  # API 仍受登入保護
    assert http.get("/easytasks").status_code == 200
    # 只比對完整的路徑段：/easytasksX 不是前綴
    assert http.get("/easytasksX/api/health").headers["content-type"].startswith("text/html")


def test_session_cookie_path_is_base_path(tmp_path):
    t, http = _app(tmp_path)
    user = create_test_user(t.db)
    res = http.post(
        "/easytasks/api/auth/login",
        json={"username": user["username"], "password": TEST_PASSWORD},
        headers={"Origin": "http://testserver"},
    )
    assert res.status_code == 200
    assert "Path=/easytasks" in res.headers["set-cookie"]
    out = http.post("/easytasks/api/auth/logout", headers={"Origin": "http://testserver", "Content-Type": "application/json"})
    assert "Path=/easytasks" in out.headers["set-cookie"]


def test_without_base_path_cookie_is_root(tmp_path):
    t, http = _app(tmp_path, base_path="")
    user = create_test_user(t.db)
    res = http.post("/api/auth/login", json={"username": user["username"], "password": TEST_PASSWORD})
    assert "Path=/" in res.headers["set-cookie"] and "Path=/easytasks" not in res.headers["set-cookie"]
