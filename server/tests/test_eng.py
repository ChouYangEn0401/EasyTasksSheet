"""工程追蹤簡化版：手動問題、worktree 紀錄、各電腦回報與比對提示"""

from server.app.features.eng import build_overview, path_key

from .helpers import MIN, FakeClock, client, create_test_app, create_test_user, login_as

TOKEN = "report-secret-123"


def setup(token: str | None = None):
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    t.app.state.eng_report_token = token
    member = create_test_user(t.db)
    other = create_test_user(t.db)
    api = login_as(t, member)
    return t, t.db, clock, member, other, api


def changes(db, entity_type):
    return [dict(r) for r in db.all("SELECT * FROM changes WHERE entity_type = ? ORDER BY id", (entity_type,))]


def report(t, body, headers=None):
    h = {"content-type": "application/json"}
    h.update(headers or {})
    import json

    return t.http.post("/api/eng/worktrees/report", content=json.dumps(body), headers=h)


# ── 問題 ──


def test_issue_crud_by_any_member():
    t, db, clock, member, other, api = setup()
    res = api.request(
        "POST",
        "/api/eng/issues",
        {"title": "  登入頁跑版 ", "project": "tasks-sheets", "assigneeId": other["id"], "url": "https://x.test/1"},
    )
    assert res.status_code == 201
    issue = res.json()
    assert issue["title"] == "登入頁跑版"
    assert issue["status"] == "open"
    assert issue["description"] == ""
    assert issue["assigneeId"] == other["id"]
    assert issue["updatedBy"] == member["id"] and issue["updatedAt"] == clock.now()

    # 另一位成員可結案
    clock.advance(5 * MIN)
    other_api = login_as(t, other)
    res = other_api.request("PATCH", f"/api/eng/issues/{issue['id']}", {"status": "closed", "url": None})
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "closed" and body["url"] is None
    assert body["updatedBy"] == other["id"] and body["updatedAt"] == clock.now()
    assert body["title"] == "登入頁跑版"

    # 列表：未結案在前
    api.request("POST", "/api/eng/issues", {"title": "第二個"})
    listed = api.get("/api/eng/issues").json()
    assert [i["title"] for i in listed] == ["第二個", "登入頁跑版"]

    assert api.request("DELETE", f"/api/eng/issues/{issue['id']}").json() == {"ok": True}
    assert api.request("DELETE", f"/api/eng/issues/{issue['id']}").status_code == 404
    assert [c["action"] for c in changes(db, "repo")] == ["create", "update", "create", "delete"]


def test_issue_validation():
    _t, _db, _clock, _member, _other, api = setup()
    assert api.request("POST", "/api/eng/issues", {"title": " "}).status_code == 400
    assert api.request("POST", "/api/eng/issues", {"title": "x", "status": "weird"}).status_code == 400
    assert api.request("POST", "/api/eng/issues", {"title": "x", "url": "javascript:alert(1)"}).status_code == 400
    assert api.request("POST", "/api/eng/issues", {"title": "x", "assigneeId": 9999}).status_code == 400
    ok = api.request("POST", "/api/eng/issues", {"title": "x", "url": "  "})
    assert ok.status_code == 201 and ok.json()["url"] is None
    assert api.request("PATCH", "/api/eng/issues/9999", {"title": "y"}).status_code == 404
    assert api.request("PATCH", f"/api/eng/issues/{ok.json()['id']}", {"title": None}).status_code == 400


# ── Worktree 紀錄 ──


def test_record_crud_and_duplicate_path():
    _t, db, clock, member, _other, api = setup()
    res = api.request(
        "POST",
        "/api/eng/worktree-records",
        {"machine": "PC-01", "path": "C:\\work\\repo-feat", "branch": "feat/x", "ownerId": member["id"], "purpose": "新功能"},
    )
    assert res.status_code == 201
    rec = res.json()
    assert rec["status"] == "active" and rec["note"] == ""

    # 同電腦（不分大小寫）同路徑（斜線 / 大小寫正規化）→ 409
    dup = api.request("POST", "/api/eng/worktree-records", {"machine": "pc-01", "path": "c:/work/repo-feat/"})
    assert dup.status_code == 409
    assert dup.json()["error"]["details"] == {"field": "path"}
    # 不同電腦可以
    assert api.request("POST", "/api/eng/worktree-records", {"machine": "PC-02", "path": "C:\\work\\repo-feat"}).status_code == 201

    clock.advance(MIN)
    upd = api.request("PATCH", f"/api/eng/worktree-records/{rec['id']}", {"status": "merged", "note": "待清理"})
    assert upd.status_code == 200
    assert upd.json()["status"] == "merged" and upd.json()["updatedAt"] == clock.now()
    assert api.request("PATCH", f"/api/eng/worktree-records/{rec['id']}", {"status": "nope"}).status_code == 400
    assert api.request("POST", "/api/eng/worktree-records", {"machine": "", "path": "x"}).status_code == 400

    assert api.request("DELETE", f"/api/eng/worktree-records/{rec['id']}").status_code == 200
    assert api.request("PATCH", f"/api/eng/worktree-records/{rec['id']}", {"note": "x"}).status_code == 404
    assert [c["action"] for c in changes(db, "worktree_plan")] == ["create", "create", "update", "delete"]


# ── 回報 ──

WT = {
    "path": "C:/work/repo-feat",
    "branch": "feat/x",
    "headSha": "abcdef1",
    "isDirty": True,
    "ahead": 2,
    "behind": 0,
    "lastCommitAt": 1,
    "isPrunable": False,
    "isMerged": False,
}


def test_report_disabled_without_token():
    t, _db, _clock, _member, _other, _api = setup(token=None)
    res = report(t, {"machine": "PC-01", "worktrees": []}, {"x-report-token": "anything"})
    assert res.status_code == 403
    assert "WORKTREE_REPORT_TOKEN" in res.json()["error"]["message"]


def test_report_token_checks():
    t, db, _clock, _member, _other, _api = setup(token=TOKEN)
    body = {"machine": "PC-01", "worktrees": [WT]}
    assert report(t, body).status_code == 403
    assert report(t, body, {"x-report-token": "wrong"}).status_code == 403
    assert report(t, body, {"authorization": "Bearer wrong"}).status_code == 403
    # 非 JSON 一律 403（CSRF 檢查）
    res = t.http.post("/api/eng/worktrees/report", content="x", headers={"x-report-token": TOKEN, "content-type": "text/plain"})
    assert res.status_code == 403
    assert report(t, body, {"authorization": f"Bearer {TOKEN}"}).status_code == 200
    ok = report(t, body, {"x-report-token": TOKEN})
    assert ok.status_code == 200
    assert ok.json() == {"ok": True, "machine": "PC-01", "repo": "", "count": 1}
    # 同電腦同 repo 整批取代
    assert db.scalar("SELECT count(*) FROM worktree_reports") == 1
    bad = report(t, {"machine": "PC-01", "worktrees": [{**WT, "headSha": "not-a-sha"}]}, {"x-report-token": TOKEN})
    assert bad.status_code == 400
    assert report(t, {"worktrees": []}, {"x-report-token": TOKEN}).status_code == 400
    # 舊版腳本的 reporter 欄位視為電腦名稱
    legacy = report(t, {"reporter": "PC-09", "repo": "r", "worktrees": []}, {"x-report-token": TOKEN})
    assert legacy.status_code == 200 and legacy.json()["machine"] == "PC-09"
    rows = changes(db, "repo")
    assert rows[-1]["actor_id"] is None


def test_overview_groups_by_machine_with_hints():
    t, _db, clock, _member, _other, api = setup(token=TOKEN)
    api.request("POST", "/api/eng/worktree-records", {"machine": "PC-01", "path": "c:\\work\\repo-feat", "branch": "feat/x"})
    api.request("POST", "/api/eng/worktree-records", {"machine": "PC-01", "path": "C:/work/gone", "branch": "feat/gone"})
    api.request(
        "POST", "/api/eng/worktree-records", {"machine": "PC-01", "path": "C:/work/old", "branch": "old", "status": "cleaned"}
    )
    api.request("POST", "/api/eng/worktree-records", {"machine": "LAPTOP", "path": "/home/a/wt", "branch": "feat/l"})

    # 尚未回報：沒有提示
    data = api.get("/api/eng/worktrees").json()
    assert data["reportEnabled"] is True
    assert [g["machine"] for g in data["machines"]] == ["LAPTOP", "PC-01"]
    assert all(r["hint"] is None for g in data["machines"] for r in g["records"])

    clock.advance(MIN)
    extra = {**WT, "path": "C:/work/spike", "branch": "tmp/spike"}
    assert report(t, {"machine": "pc-01", "repo": "tasks", "worktrees": [WT, extra]}, {"x-report-token": TOKEN}).status_code == 200
    data = api.get("/api/eng/worktrees").json()
    pc = next(g for g in data["machines"] if g["machine"] == "PC-01")
    assert pc["reportedAt"] == clock.now()
    hints = {r["branch"]: r["hint"] for r in pc["records"]}
    assert hints == {"feat/x": None, "feat/gone": "missing", "old": None}
    reg = {r["branch"]: r["registered"] for r in pc["reports"]}
    assert reg == {"feat/x": True, "tmp/spike": False}
    assert pc["reports"][0]["isDirty"] is True
    laptop = next(g for g in data["machines"] if g["machine"] == "LAPTOP")
    assert laptop["reportedAt"] is None and laptop["records"][0]["hint"] is None


def test_requires_login_except_report():
    t, _db, _clock, _member, _other, _api = setup(token=TOKEN)
    anon = client(t)
    assert anon.get("/api/eng/issues").status_code == 401
    assert anon.get("/api/eng/worktrees").status_code == 401
    assert anon.request("POST", "/api/eng/issues", {"title": "x"}).status_code == 401


def test_path_key_and_build_overview_pure():
    assert path_key("C:\\Work\\Repo\\") == path_key("c:/work/repo")
    assert path_key("/home/A/wt/") == "/home/A/wt"
    assert path_key("/home/A/wt") != path_key("/home/a/wt")
    assert build_overview([], []) == []
