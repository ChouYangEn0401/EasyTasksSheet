"""工程追蹤的選配 GitHub 連動：網址解析、同步規則、匯入去重、在 GitHub 建立、無 token（GitHub 呼叫一律以假用戶端取代）"""

import urllib.error

import pytest

from server.app.github import GitHubClient, GitHubError, normalize_repo, parse_issue_url

from .helpers import MIN, FakeClock, create_test_app, create_test_user, login_as

GH_URL = "https://github.com/Acme/Widgets/issues/12"


class FakeGitHub:
    """記憶體中的 GitHub：issues[(repo, number)] = {title, body, state}"""

    def __init__(self):
        self.issues: dict[tuple[str, int], dict] = {}
        self.fail: dict[tuple[str, int], GitHubError] = {}
        self.calls: list[tuple] = []

    def add(self, repo, number, title, state="open", body="", pull=False):
        self.issues[(repo, number)] = {"title": title, "state": state, "body": body, "pull": pull}

    def _out(self, repo, number):
        i = self.issues[(repo, number)]
        return {
            "number": number,
            "title": i["title"],
            "body": i["body"],
            "state": i["state"],
            "html_url": f"https://github.com/{repo}/issues/{number}",
            "is_pull": i["pull"],
        }

    def get_issue(self, repo, number):
        self.calls.append(("get", repo, number))
        if (repo, number) in self.fail:
            raise self.fail[(repo, number)]
        if (repo, number) not in self.issues:
            raise GitHubError("找不到此 GitHub issue / repo（或 token 沒有權限）", 404)
        return self._out(repo, number)

    def list_open_issues(self, repo):
        self.calls.append(("list", repo))
        return [self._out(r, n) for (r, n), i in self.issues.items() if r == repo and i["state"] == "open"]

    def create_issue(self, repo, title, body):
        self.calls.append(("create", repo, title, body))
        number = max([n for (r, n) in self.issues if r == repo] or [0]) + 1
        self.add(repo, number, title, body=body)
        return self._out(repo, number)


def setup(token: str | None = "gh-secret-token"):
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    t.app.state.github_token = token
    gh = FakeGitHub()
    t.app.state.github_client = gh
    member = create_test_user(t.db)
    api = login_as(t, member)
    return t, t.db, clock, gh, member, api


def issues(api):
    return {i["id"]: i for i in api.get("/api/eng/issues").json()["issues"]}


# ── 網址解析 ──


def test_parse_issue_url():
    assert parse_issue_url(GH_URL) == ("acme/widgets", 12)
    assert parse_issue_url("https://github.com/a-b/c.d_e/issues/3/") == ("a-b/c.d_e", 3)
    assert parse_issue_url("https://github.com/a/b/issues/3#issuecomment-1") == ("a/b", 3)
    assert parse_issue_url("https://www.github.com/a/b/issues/3?x=1") == ("a/b", 3)
    assert parse_issue_url("https://github.com/a/b/pull/3") is None
    assert parse_issue_url("https://github.com/a/b/issues") is None
    assert parse_issue_url("https://example.com/a/b/issues/3") is None
    assert parse_issue_url("https://github.com/a/b/issues/0") is None
    assert parse_issue_url(None) is None
    assert normalize_repo("Acme/Widgets") == "acme/widgets"
    assert normalize_repo("https://github.com/Acme/Widgets.git") == "acme/widgets"
    assert normalize_repo("acme") is None
    assert normalize_repo("a/b/c") is None


def test_url_parsed_on_create_and_update_without_token():
    _t, db, _clock, _gh, _member, api = setup(token=None)
    created = api.request("POST", "/api/eng/issues", {"title": "x", "url": GH_URL}).json()
    assert created["githubRepo"] == "acme/widgets" and created["githubNumber"] == 12
    assert created["githubState"] is None and created["syncedAt"] is None

    # 已同步過的資訊：連結不變時保留，改成其他網址時清空
    db.execute("UPDATE manual_issues SET github_state = 'open', github_synced_at = 1 WHERE id = ?", (created["id"],))
    same = api.request("PATCH", f"/api/eng/issues/{created['id']}", {"url": GH_URL + "/", "title": "y"}).json()
    assert same["githubState"] == "open" and same["syncedAt"] == 1
    other = api.request("PATCH", f"/api/eng/issues/{created['id']}", {"url": "https://github.com/acme/widgets/issues/13"})
    assert other.json()["githubNumber"] == 13 and other.json()["githubState"] is None
    plain = api.request("PATCH", f"/api/eng/issues/{created['id']}", {"url": "https://example.com/1"}).json()
    assert plain["githubRepo"] is None and plain["githubNumber"] is None
    pr = api.request("POST", "/api/eng/issues", {"title": "pr", "url": "https://github.com/a/b/pull/1"}).json()
    assert pr["githubNumber"] is None


# ── 無 token ──


def test_disabled_without_token():
    _t, _db, _clock, gh, _member, api = setup(token=None)
    listed = api.get("/api/eng/issues").json()
    assert listed["githubEnabled"] is False
    iid = api.request("POST", "/api/eng/issues", {"title": "x", "url": GH_URL}).json()["id"]
    for method, path, body in [
        ("POST", "/api/eng/issues/sync", {}),
        ("POST", "/api/eng/issues/import", {"project": "p"}),
        ("POST", f"/api/eng/issues/{iid}/publish", {}),
        ("PUT", "/api/eng/github-links", {"links": []}),
    ]:
        res = api.request(method, path, body)
        assert res.status_code == 503, path
        assert "GITHUB_TOKEN" in res.json()["error"]["message"]
    assert gh.calls == []


def test_token_never_returned():
    t, _db, _clock, _gh, _member, api = setup()
    api.request("POST", "/api/eng/issues", {"title": "x", "url": GH_URL})
    res = api.get("/api/eng/issues")
    assert res.json()["githubEnabled"] is True
    assert "gh-secret-token" not in res.text
    assert t.app.state.github_token not in api.request("POST", "/api/eng/issues/sync", {}).text


# ── 同步規則 ──


def test_sync_state_change_rules():
    _t, db, clock, gh, member, api = setup()
    gh.add("acme/widgets", 12, "GitHub 標題")
    iid = api.request("POST", "/api/eng/issues", {"title": "本地標題", "url": GH_URL, "status": "doing"}).json()["id"]
    api.request("POST", "/api/eng/issues", {"title": "純手記"})

    # 第一次同步：GitHub 開啟中 → 本地狀態與標題不動，只記錄 state / syncedAt
    clock.advance(MIN)
    res = api.request("POST", "/api/eng/issues/sync", {}).json()
    assert res == {"checked": 1, "updated": [], "failed": [], "syncedAt": clock.now()}
    i = issues(api)[iid]
    assert i["status"] == "doing" and i["title"] == "本地標題"
    assert i["githubState"] == "open" and i["syncedAt"] == clock.now()

    # GitHub 無變動：本地手動改的狀態不被覆蓋
    api.request("PATCH", f"/api/eng/issues/{iid}", {"status": "closed"})
    clock.advance(MIN)
    assert api.request("POST", "/api/eng/issues/sync", {}).json()["updated"] == []
    assert issues(api)[iid]["status"] == "closed"
    api.request("PATCH", f"/api/eng/issues/{iid}", {"status": "doing"})

    # GitHub 關閉 → 已結案；標題變動 → 覆蓋
    gh.add("acme/widgets", 12, "GitHub 新標題", state="closed")
    clock.advance(MIN)
    assert api.request("POST", "/api/eng/issues/sync", {"id": iid}).json()["updated"] == [iid]
    i = issues(api)[iid]
    assert i["status"] == "closed" and i["title"] == "GitHub 新標題" and i["githubState"] == "closed"
    assert i["syncedAt"] == clock.now()

    # GitHub 重開 → 未處理
    gh.add("acme/widgets", 12, "GitHub 新標題", state="open")
    api.request("POST", "/api/eng/issues/sync", {})
    assert issues(api)[iid]["status"] == "open"

    rows = db.all("SELECT action, actor_id FROM changes WHERE entity_type = 'repo' AND entity_id = ?", (iid,))
    assert all(r["actor_id"] == member["id"] for r in rows)


def test_sync_first_time_closed_and_failures():
    _t, _db, _clock, gh, _member, api = setup()
    gh.add("acme/widgets", 12, "已關閉", state="closed")
    a = api.request("POST", "/api/eng/issues", {"title": "a", "url": GH_URL}).json()["id"]
    b = api.request("POST", "/api/eng/issues", {"title": "b", "url": "https://github.com/acme/widgets/issues/99"}).json()["id"]
    c = api.request("POST", "/api/eng/issues", {"title": "c", "url": "https://github.com/acme/widgets/issues/5"}).json()["id"]
    gh.add("acme/widgets", 5, "c")
    gh.fail[("acme/widgets", 5)] = GitHubError("無法連線 GitHub（逾時或網路錯誤）")
    res = api.request("POST", "/api/eng/issues/sync", {}).json()
    assert res["checked"] == 3 and res["updated"] == [a]
    assert sorted(f["id"] for f in res["failed"]) == [b, c]
    listed = issues(api)
    assert listed[a]["status"] == "closed"
    assert listed[b]["syncedAt"] is None and listed[c]["syncedAt"] is None

    plain = api.request("POST", "/api/eng/issues", {"title": "plain"}).json()["id"]
    assert api.request("POST", "/api/eng/issues/sync", {"id": plain}).status_code == 400
    assert api.request("POST", "/api/eng/issues/sync", {"id": 9999}).status_code == 404


# ── 專案連動 / 匯入 ──


def test_links_and_import_dedup():
    _t, db, _clock, gh, _member, api = setup()
    assert api.request("PUT", "/api/eng/github-links", {"links": [{"project": "w", "githubRepo": "bad"}]}).status_code == 400
    dup = [{"project": "W", "githubRepo": "a/b"}, {"project": "w", "githubRepo": "a/c"}]
    assert api.request("PUT", "/api/eng/github-links", {"links": dup}).status_code == 400
    saved = api.request(
        "PUT", "/api/eng/github-links", {"links": [{"project": "Widgets", "githubRepo": "https://github.com/Acme/Widgets"}]}
    )
    assert saved.json() == {"links": [{"project": "Widgets", "githubRepo": "acme/widgets"}]}
    assert api.get("/api/eng/issues").json()["links"] == [{"project": "Widgets", "githubRepo": "acme/widgets"}]

    gh.add("acme/widgets", 1, "第一", body="說明一")
    gh.add("acme/widgets", 2, "第二")
    gh.add("acme/widgets", 3, "已關閉", state="closed")
    gh.add("acme/widgets", 4, "PR", pull=True)
    gh.add("other/repo", 1, "別的 repo")
    # 已用網址手記過 #2 → 不重複建立
    api.request("POST", "/api/eng/issues", {"title": "手記的 #2", "url": "https://github.com/acme/widgets/issues/2"})

    assert api.request("POST", "/api/eng/issues/import", {"project": "沒連動"}).status_code == 400
    res = api.request("POST", "/api/eng/issues/import", {"project": "widgets"})
    assert res.status_code == 200
    assert res.json()["created"] == 1 and res.json()["repo"] == "acme/widgets"
    again = api.request("POST", "/api/eng/issues/import", {"project": "Widgets"}).json()
    assert again["created"] == 0
    rows = db.all("SELECT * FROM manual_issues WHERE github_repo = 'acme/widgets' ORDER BY github_number")
    assert [(r["github_number"], r["title"]) for r in rows] == [(1, "第一"), (2, "手記的 #2")]
    first = rows[0]
    assert first["description"] == "說明一" and first["project"] == "widgets" and first["status"] == "open"
    assert first["url"] == "https://github.com/acme/widgets/issues/1" and first["github_state"] == "open"
    assert db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'repo' AND action = 'create'") == 2

    # GitHub 錯誤 → 502，不影響資料
    gh.list_open_issues = lambda repo: (_ for _ in ()).throw(GitHubError("GitHub token 無效或已過期", 401))
    bad = api.request("POST", "/api/eng/issues/import", {"project": "Widgets"})
    assert bad.status_code == 502 and bad.json()["error"]["message"] == "GitHub token 無效或已過期"


# ── 在 GitHub 建立 ──


def test_publish():
    _t, db, clock, gh, member, api = setup()
    api.request("PUT", "/api/eng/github-links", {"links": [{"project": "Widgets", "githubRepo": "acme/widgets"}]})
    gh.add("acme/widgets", 7, "既有")
    iid = api.request("POST", "/api/eng/issues", {"title": "要回報的 bug", "description": "步驟…", "project": "widgets"}).json()["id"]
    clock.advance(MIN)
    res = api.request("POST", f"/api/eng/issues/{iid}/publish", {})
    assert res.status_code == 200
    body = res.json()
    assert body["githubRepo"] == "acme/widgets" and body["githubNumber"] == 8
    assert body["url"] == "https://github.com/acme/widgets/issues/8"
    assert body["githubState"] == "open" and body["syncedAt"] == clock.now() and body["updatedBy"] == member["id"]
    assert gh.calls[-1] == ("create", "acme/widgets", "要回報的 bug", "步驟…")
    # 已連結 → 400；未連動專案 / 無專案 → 400；不存在 → 404
    assert api.request("POST", f"/api/eng/issues/{iid}/publish", {}).status_code == 400
    other = api.request("POST", "/api/eng/issues", {"title": "x", "project": "沒連動"}).json()["id"]
    assert api.request("POST", f"/api/eng/issues/{other}/publish", {}).status_code == 400
    none = api.request("POST", "/api/eng/issues", {"title": "x"}).json()["id"]
    assert api.request("POST", f"/api/eng/issues/{none}/publish", {}).status_code == 400
    assert api.request("POST", "/api/eng/issues/9999/publish", {}).status_code == 404
    assert db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'repo' AND entity_id = ? AND action = 'update'", (iid,)) == 1


# ── 真實用戶端的錯誤轉換（不連網：替換 urlopen） ──


def test_client_maps_errors(monkeypatch):
    import server.app.github as mod

    def raise_http(req, timeout):
        assert req.headers["Authorization"] == "Bearer tok"
        assert timeout == mod.TIMEOUT_SECONDS
        raise urllib.error.HTTPError(req.full_url, 401, "x", {}, None)  # type: ignore[arg-type]

    monkeypatch.setattr(mod.urllib.request, "urlopen", raise_http)
    with pytest.raises(GitHubError, match="token 無效"):
        GitHubClient("tok").get_issue("a/b", 1)

    def raise_timeout(req, timeout):
        raise TimeoutError()

    monkeypatch.setattr(mod.urllib.request, "urlopen", raise_timeout)
    with pytest.raises(GitHubError, match="無法連線"):
        GitHubClient("tok").get_issue("a/b", 1)
