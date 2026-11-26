"""前端靜態檔提供（server/app/app.py 的 _mount_spa）：沒有建置步驟的 ES modules 要靠這幾條才載得起來。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from server.app.app import _static_version, create_app

from .helpers import create_test_app


def _web(tmp_path, base_path=""):
    (tmp_path / "index.html").write_text(
        '<meta name="ts-base" content="{{BASE}}"><script type="module" src="{{STATIC}}/js/main.js"></script>',
        encoding="utf-8",
    )
    js = tmp_path / "static" / "js"
    js.mkdir(parents=True)
    (js / "main.js").write_text("export const a = 1;", encoding="utf-8")
    (tmp_path / "static" / "app.css").write_text("body{}", encoding="utf-8")
    t = create_test_app()
    app = create_app(t.db, static_dir=str(tmp_path), base_path=base_path, settings={"cookie_path": base_path or "/"})
    return tmp_path, TestClient(app)


def test_js_is_served_as_javascript_module_type(tmp_path):
    _, http = _web(tmp_path)
    res = http.get("/static/js/main.js")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/javascript")
    assert http.get("/static/app.css").headers["content-type"].startswith("text/css")


def test_index_template_is_rendered_with_base_and_versioned_static(tmp_path):
    root, http = _web(tmp_path, base_path="/easytasks")
    html = http.get("/easytasks/").text
    assert 'content="/easytasks"' in html
    ver = _static_version(root / "static")
    assert f'src="/easytasks/static/v/{ver}/js/main.js"' in html
    assert http.get("/easytasks/").headers["cache-control"] == "no-cache"


def test_versioned_path_is_immutable_and_unversioned_is_not(tmp_path):
    root, http = _web(tmp_path)
    ver = _static_version(root / "static")
    res = http.get(f"/static/v/{ver}/js/main.js")
    assert res.status_code == 200 and res.text == "export const a = 1;"
    assert "immutable" in res.headers["cache-control"]
    assert http.get("/static/js/main.js").headers["cache-control"] == "no-cache"


def test_version_changes_when_a_file_changes(tmp_path):
    root, http = _web(tmp_path)
    before = _static_version(root / "static")
    (root / "static" / "js" / "main.js").write_text("export const a = 2; // changed", encoding="utf-8")
    assert _static_version(root / "static") != before
    assert f"/static/v/{before}/" not in http.get("/").text


def test_missing_static_file_is_404_not_index(tmp_path):
    _, http = _web(tmp_path)
    res = http.get("/static/js/nope.js")
    assert res.status_code == 404
    assert res.json()["error"] == "NOT_FOUND"
    assert http.get("/static/v/abc/js/nope.js").status_code == 404
    # 非 static 的路徑仍回 index（SPA 路由）
    assert "ts-base" in http.get("/tasks/list").text


def test_path_traversal_is_blocked(tmp_path):
    root, http = _web(tmp_path)
    (root / "secret.txt").write_text("x", encoding="utf-8")
    assert http.get("/static/../secret.txt").status_code != 200 or "x" != http.get("/static/../secret.txt").text
    assert http.get("/static/%2e%2e/secret.txt").text != "x"
    assert http.get("/static/js/../../secret.txt").text != "x"


def test_health_reports_version(tmp_path):
    _, http = _web(tmp_path)
    body = http.get("/api/health").json()
    assert body["ok"] is True
    assert body["app"] == "EasyTasksSheet"
    assert body["version"].count(".") == 2
