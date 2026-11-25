"""資料匯出 / 匯入（/api/admin/data/*、server/app/data_transfer.py、CLI export / import）"""

from __future__ import annotations

import copy
import json
import re
import shutil

import pytest

from server import cli
from server.app import data_transfer as dt
from server.app.db import MIGRATIONS_DIR, create_db, run_migrations, run_seed

from .helpers import MIN, FakeClock, TestApp, client, create_test_db, create_test_user, login, login_as

UID_RE = re.compile(r"^[0-9a-f]{32}$")
UID_TABLES = [
    "projects",
    "statuses",
    "tasks",
    "property_defs",
    "feedback_items",
    "personal_items",
    "manual_issues",
    "worktree_records",
]


class Env:
    def __init__(self, tmp_path, seed: bool = True, name: str = "a"):
        self.clock = FakeClock()
        self.t = TestApp(now=self.clock.now, db=create_test_db(seed=seed))
        self.t.app.state.backup_dir = str(tmp_path / f"backups-{name}")
        self.db = self.t.db
        self.admin = create_test_user(self.db, username=f"admin-{name}", role="admin")
        self.member = create_test_user(self.db, username="alice", display_name="Alice")
        self.api = login_as(self.t, self.admin)


def ok(res, status: int = 200):
    assert res.status_code == status, res.text
    return res.json()


def populate(env: Env) -> dict:
    """以 API 建立涵蓋所有類別的資料（含自訂欄位、軟刪除任務、個人釘選、GitHub 連動）"""
    api, clock = env.api, env.clock
    member_id = env.member["id"]
    project = ok(api.request("POST", "/api/projects", {"name": "搬家專案", "color": "red"}), 201)
    person = ok(api.request("POST", "/api/properties", {"name": "窗口", "type": "person"}), 201)
    select = ok(
        api.request(
            "POST",
            "/api/properties",
            {"name": "等級", "type": "select", "projectId": project["id"], "options": [{"id": "a", "label": "A"}]},
        ),
        201,
    )
    clock.advance(MIN)
    task = ok(
        api.request(
            "POST",
            "/api/tasks",
            {
                "title": "寫報告",
                "projectId": project["id"],
                "assigneeId": member_id,
                "dueDate": "2026-02-01",
                "estimateHours": 2.5,
                "custom": {str(person["id"]): member_id, str(select["id"]): "a"},
            },
        ),
        201,
    )
    gone = ok(api.request("POST", "/api/tasks", {"title": "已刪除的任務"}), 201)
    ok(api.request("DELETE", f"/api/tasks/{gone['id']}"))
    ok(api.request("POST", "/api/feedback", {"kind": "problem", "title": "離心機異常", "assigneeId": member_id}), 201)
    ok(
        api.request(
            "POST",
            "/api/personal",
            {"title": "買咖啡", "status": "deferred", "dueDate": "2026-12-24", "detail": "下週再說\n預算 200"},
        ),
        201,
    )
    ok(api.request("POST", "/api/personal", {"title": "已完成的事", "status": "done"}), 201)
    ok(api.request("PUT", f"/api/personal/pins/{task['id']}"), 201)
    ok(api.request("POST", "/api/eng/issues", {"title": "登入很慢", "project": "web"}), 201)
    ok(api.request("POST", "/api/eng/worktree-records", {"machine": "pc-1", "path": "C:/w/feat"}), 201)
    env.db.execute(
        "INSERT INTO eng_github_links (project, github_repo, updated_by, updated_at) VALUES ('web', 'acme/web', ?, 1)",
        (env.admin["id"],),
    )
    return {"project": project, "task": task, "person": person, "select": select}


def export(env: Env) -> dict:
    res = env.api.get("/api/admin/data/export")
    assert res.status_code == 200, res.text
    return res.json()


def preview(env: Env, doc: dict) -> dict:
    return ok(env.api.request("POST", "/api/admin/data/import/preview", doc))


def apply(env: Env, token: str, **opts) -> dict:
    return ok(env.api.request("POST", "/api/admin/data/import/apply", {"token": token, **opts}))


def task_by_title(db, title: str):
    return db.one("SELECT * FROM tasks WHERE title = ?", (title,))


# ── uid ──


def test_uid_generated_for_every_create_path(tmp_path):
    env = Env(tmp_path)
    populate(env)
    for table in UID_TABLES:
        rows = env.db.all(f"SELECT uid FROM {table}")
        assert rows, table
        assert all(UID_RE.fullmatch(r["uid"] or "") for r in rows), table
    # 直接 SQL（任何未來的建立路徑）也會由 trigger 補上；明確給 uid 時保留
    env.db.execute("INSERT INTO statuses (name, color, category, created_at, updated_at) VALUES ('x', 'gray', 'todo', 1, 1)")
    env.db.execute(
        "INSERT INTO projects (uid, name, created_at, updated_at) VALUES ('given-uid-123', 'p', 1, 1)"
    )
    assert UID_RE.fullmatch(env.db.scalar("SELECT uid FROM statuses WHERE name = 'x'"))
    assert env.db.scalar("SELECT uid FROM projects WHERE name = 'p'") == "given-uid-123"
    for table in UID_TABLES:
        n = env.db.scalar(f"SELECT count(*) FROM {table}")
        assert env.db.scalar(f"SELECT count(DISTINCT uid) FROM {table}") == n
    # API 回應不暴露 uid
    assert "uid" not in env.api.get("/api/projects").json()[0]


def test_uid_unique_index():
    db = create_test_db()
    uid = db.scalar("SELECT uid FROM projects")
    with pytest.raises(Exception):
        db.execute("INSERT INTO projects (uid, name, created_at, updated_at) VALUES (?, 'dup', 1, 1)", (uid,))


def test_migration_backfills_existing_rows(tmp_path):
    old = tmp_path / "old"
    old.mkdir()
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if f.stem < "0005":
            shutil.copy(f, old / f.name)
    path = str(tmp_path / "old.db")
    db = create_db(path)
    run_migrations(db, old)
    run_seed(db)
    db.execute("INSERT INTO tasks (title, project_id, status_id, created_at, updated_at) VALUES ('舊任務', 1, 1, 1, 1)")
    db.execute("INSERT INTO manual_issues (title, created_at, updated_at) VALUES ('舊問題', 1, 1)")
    db.close()

    db2 = create_db(path)
    assert "0005_uid" in run_migrations(db2)
    for table in UID_TABLES:
        assert all(UID_RE.fullmatch(r[0] or "") for r in db2.all(f"SELECT uid FROM {table}")), table
    assert db2.scalar("SELECT count(DISTINCT uid) FROM statuses") == 4
    db2.close()


# ── 匯出 ──


def test_export_contents_without_secrets(tmp_path):
    env = Env(tmp_path)
    p = populate(env)
    res = env.api.get("/api/admin/data/export")
    assert res.status_code == 200
    assert res.headers["content-disposition"].startswith('attachment; filename="tasks-sheets-export-')
    text = res.text
    for secret in ("argon2", "password", "passwordHash", "password_hash", "sessions", "loginAttempts", "changes"):
        assert secret not in text
    doc = res.json()
    assert doc["format"] == "tasks-sheets-export" and doc["schemaVersion"] == dt.SCHEMA_VERSION
    assert doc["exportedAt"] == env.clock.now()
    assert {u["username"] for u in doc["users"]} == {"admin-a", "alice"}
    assert set(doc["users"][0]) == {"username", "displayName", "role", "isActive", "createdAt", "updatedAt"}
    task = next(x for x in doc["tasks"] if x["title"] == "寫報告")
    project_uid = env.db.scalar("SELECT uid FROM projects WHERE id = ?", (p["project"]["id"],))
    assert task["projectUid"] == project_uid
    assert task["assigneeUsername"] == "alice" and "assigneeId" not in task and "id" not in task
    person_uid = env.db.scalar("SELECT uid FROM property_defs WHERE id = ?", (p["person"]["id"],))
    assert task["custom"][person_uid] == "alice"
    deleted = next(x for x in doc["tasks"] if x["title"] == "已刪除的任務")
    assert deleted["deletedAt"] is not None
    assert doc["engGithubLinks"] == [
        {"project": "web", "githubRepo": "acme/web", "updatedByUsername": "admin-a", "updatedAt": 1}
    ]
    pin = next(x for x in doc["personalItems"] if x["taskUid"])
    assert pin["taskUid"] == task["uid"] and pin["username"] == "admin-a"


def test_backup_download(tmp_path):
    env = Env(tmp_path)
    res = env.api.get("/api/admin/data/backup")
    assert res.status_code == 200
    assert res.content.startswith(b"SQLite format 3\x00")
    assert re.search(r'filename="tasks-sheets-backup-\d{8}-\d{6}\.db"', res.headers["content-disposition"])
    path = tmp_path / "dl.db"
    path.write_bytes(res.content)
    copy_db = create_db(str(path))
    assert copy_db.scalar("SELECT count(*) FROM users") == 2
    copy_db.close()


# ── 權限與驗證 ──


def test_member_403_and_anonymous_401(tmp_path):
    env = Env(tmp_path)
    member = login_as(env.t, env.member)
    calls = [
        member.get("/api/admin/data/backup"),
        member.get("/api/admin/data/export"),
        member.request("POST", "/api/admin/data/import/preview", {}),
        member.request("POST", "/api/admin/data/import/apply", {"token": "x"}),
    ]
    assert [r.status_code for r in calls] == [403] * 4
    assert client(env.t).get("/api/admin/data/export").status_code == 401


def raw_post(env: Env, path: str, content: bytes):
    return env.t.http.post(
        path,
        content=content,
        headers={"cookie": env.api.cookie, "content-type": "application/json", "origin": "http://localhost"},
    )


def test_validation_and_size_limit(tmp_path):
    env = Env(tmp_path)
    doc = export(env)
    url = "/api/admin/data/import/preview"

    def err(body):
        res = env.api.request("POST", url, body)
        assert res.status_code == 400, res.text
        return res.json()["error"]

    assert raw_post(env, url, b"not json").json()["error"]["message"] == "檔案不是有效的 JSON"
    assert "不是 TasksSheets" in err({"hello": 1})["message"]
    assert "較新版本" in err({**doc, "schemaVersion": 99})["message"]
    assert err({**doc, "evil": True})["code"] == "IMPORT_INVALID"
    bad = copy.deepcopy(doc)
    bad["tasks"] = [{"uid": "x" * 32}]
    assert err(bad)["details"]
    bad = copy.deepcopy(doc)
    bad["statuses"][0]["color"] = "rainbow"
    assert err(bad)["code"] == "IMPORT_INVALID"
    # 參照不存在的 uid
    p = env.api.request("POST", "/api/tasks", {"title": "t"}).json()
    doc2 = export(env)
    doc2["projects"] = []
    assert "關聯" in err(doc2)["message"]
    # 結構過深
    deep = b'{"format": "tasks-sheets-export", "schemaVersion": 1, "exportedAt": 1, "users": ' + b"[" * 50000 + b"]" * 50000 + b"}"
    assert raw_post(env, url, deep).status_code == 400
    # 大小上限
    env.t.app.state.import_max_bytes = 1000
    res = raw_post(env, url, json.dumps(doc).encode() + b" " * 2000)
    assert res.status_code == 413 and res.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert p["title"] == "t"


def test_apply_requires_valid_token(tmp_path):
    env = Env(tmp_path)
    res = env.api.request("POST", "/api/admin/data/import/apply", {"token": "nope"})
    assert res.status_code == 400 and res.json()["error"]["code"] == "PREVIEW_EXPIRED"
    res = env.api.request("POST", "/api/admin/data/import/apply", {"token": "x", "strategy": "whatever"})
    assert res.status_code == 400 and res.json()["error"]["code"] == "VALIDATION_ERROR"
    # 其他管理員不可使用別人的 token
    tok = preview(env, export(env))["token"]
    other = login_as(env.t, create_test_user(env.db, role="admin"))
    res = other.request("POST", "/api/admin/data/import/apply", {"token": tok})
    assert res.status_code == 400


# ── 往返 ──


def test_roundtrip_into_empty_db(tmp_path):
    a = Env(tmp_path, name="a")
    populate(a)
    doc = export(a)

    b = Env(tmp_path, seed=False, name="b")
    pv = preview(b, doc)
    assert {c["key"]: c["new"] for c in pv["categories"]} == {s.key: len(doc[s.key]) for s in dt.SPECS}
    assert pv["conflicts"] == []
    assert [m["username"] for m in pv["missingUsers"]] == ["admin-a"]
    result = apply(b, pv["token"], missingUsers="create")
    assert result["backupFile"].endswith(".db")
    assert (tmp_path / "backups-b" / result["backupFile"]).is_file()
    assert [u["username"] for u in result["createdUsers"]] == ["admin-a"]

    again = export(b)
    for spec in dt.SPECS:
        assert again[spec.key] == doc[spec.key], spec.key
    # 再匯入一次：全部相同、不重複
    pv2 = preview(b, doc)
    assert all(c["new"] == 0 and c["conflict"] == 0 for c in pv2["categories"])
    # 匯入以 record_change 記錄
    assert b.db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'task' AND action = 'create'") == 2


def test_roundtrip_into_fresh_install_matches_defaults_by_name(tmp_path):
    a = Env(tmp_path, name="a")
    populate(a)
    doc = export(a)
    b = Env(tmp_path, name="b")  # 已 seed：預設狀態與預設專案（uid 不同）
    pv = preview(b, doc)
    statuses = next(c for c in pv["categories"] if c["key"] == "statuses")
    assert statuses["same"] == 4 and statuses["new"] == 0
    apply(b, pv["token"], missingUsers="skip")
    assert b.db.scalar("SELECT count(*) FROM statuses") == 4
    assert b.db.scalar("SELECT count(*) FROM projects") == 2
    t = task_by_title(b.db, "寫報告")
    assert t["assignee_id"] == b.member["id"]  # alice 兩邊都有
    # admin-a 不存在且選擇略過：admin-a 的個人清單略過、任務建立者清空
    assert t["created_by"] is None
    assert b.db.scalar("SELECT count(*) FROM personal_items") == 0
    custom = json.loads(t["custom"])
    person_id = b.db.scalar("SELECT id FROM property_defs WHERE name = '窗口'")
    assert custom[str(person_id)] == b.member["id"]


def test_import_legacy_personal_items_without_status_fields(tmp_path):
    """舊匯出檔的自由待辦沒有 status / dueDate / detail：由 isDone 推得 status，其餘取預設"""
    a = Env(tmp_path, name="a")
    populate(a)
    doc = export(a)
    for p in doc["personalItems"]:
        for k in ("status", "dueDate", "detail"):
            del p[k]
        p["isDone"] = p["title"] == "已完成的事"
    b = Env(tmp_path, seed=False, name="b")
    apply(b, preview(b, doc)["token"], missingUsers="create")
    rows = {r["title"]: r for r in b.db.all("SELECT * FROM personal_items WHERE task_id IS NULL")}
    assert (rows["買咖啡"]["status"], rows["買咖啡"]["is_done"], rows["買咖啡"]["detail"]) == ("todo", 0, "")
    assert rows["買咖啡"]["due_date"] is None
    assert (rows["已完成的事"]["status"], rows["已完成的事"]["is_done"]) == ("done", 1)


# ── 衝突 ──


def conflict_setup(tmp_path):
    env = Env(tmp_path)
    populate(env)
    env.clock.advance(MIN)
    doc = export(env)
    task = task_by_title(env.db, "寫報告")
    env.clock.advance(MIN)
    ok(env.api.request("PATCH", f"/api/tasks/{task['id']}", {"title": "本機改過", "progress": 50}))
    return env, doc, task


def test_preview_lists_conflict_with_diff(tmp_path):
    env, doc, task = conflict_setup(tmp_path)
    pv = preview(env, doc)
    tasks = next(c for c in pv["categories"] if c["key"] == "tasks")
    assert (tasks["new"], tasks["same"], tasks["conflict"]) == (0, 1, 1)
    [c] = pv["conflicts"]
    assert c["key"] == f"tasks:{task['uid']}"
    assert c["title"] == "寫報告" and c["categoryLabel"] == "任務"
    assert c["newer"] == "local"
    assert c["localUpdatedAt"] > c["importUpdatedAt"]
    assert {f["name"]: (f["local"], f["import"]) for f in c["fields"]} == {
        "title": ("本機改過", "寫報告"),
        "progress": (50, 0),
    }
    # 預覽不改資料
    assert task_by_title(env.db, "本機改過") is not None


@pytest.mark.parametrize(
    "strategy,expected",
    [("keep_newer", "本機改過"), ("keep_local", "本機改過"), ("use_import", "寫報告")],
)
def test_strategies(tmp_path, strategy, expected):
    env, doc, task = conflict_setup(tmp_path)
    result = apply(env, preview(env, doc)["token"], strategy=strategy)
    row = env.db.one("SELECT * FROM tasks WHERE id = ?", (task["id"],))
    assert row["title"] == expected
    tasks = next(c for c in result["categories"] if c["key"] == "tasks")
    assert tasks["updated"] == (1 if expected == "寫報告" else 0)


def test_keep_newer_takes_import_when_file_is_newer(tmp_path):
    env, doc, task = conflict_setup(tmp_path)
    item = next(x for x in doc["tasks"] if x["uid"] == task["uid"])
    item["title"] = "檔案較新"
    item["updatedAt"] = env.clock.now() + 10 * MIN
    pv = preview(env, doc)
    assert pv["conflicts"][0]["newer"] == "import"
    apply(env, pv["token"])
    row = env.db.one("SELECT * FROM tasks WHERE id = ?", (task["id"],))
    assert row["title"] == "檔案較新" and row["updated_at"] == item["updatedAt"]
    assert env.db.scalar("SELECT count(*) FROM changes WHERE entity_type='task' AND entity_id=? AND action='update'", (task["id"],)) == 2


def test_per_item_override(tmp_path):
    env, doc, task = conflict_setup(tmp_path)
    pv = preview(env, doc)
    key = pv["conflicts"][0]["key"]
    apply(env, pv["token"], strategy="keep_local", overrides={key: "use_import"})
    assert env.db.scalar("SELECT title FROM tasks WHERE id = ?", (task["id"],)) == "寫報告"


# ── 缺少成員 ──


def test_missing_member_create(tmp_path):
    env, doc, _task = conflict_setup(tmp_path)
    doc["users"].append({"username": "ghost", "displayName": "幽靈", "role": "admin", "isActive": True})
    t = next(x for x in doc["tasks"] if x["title"] == "已刪除的任務")
    t["assigneeUsername"] = "ghost"
    pv = preview(env, doc)
    assert pv["missingUsers"] == [{"username": "ghost", "displayName": "幽靈", "references": 1}]
    result = apply(env, pv["token"], missingUsers="create", strategy="use_import")
    [created] = result["createdUsers"]
    assert created["username"] == "ghost" and re.fullmatch(r"\S{4}-\S{4}-\S{4}", created["tempPassword"])
    ghost = env.db.one("SELECT * FROM users WHERE username = 'ghost'")
    assert (ghost["role"], ghost["is_active"], ghost["must_change_password"]) == ("member", 1, 1)
    assert created["tempPassword"] not in ghost["password_hash"]
    assert env.db.scalar("SELECT assignee_id FROM tasks WHERE title = '已刪除的任務'") == ghost["id"]
    lr = login(env.t, "ghost", created["tempPassword"])
    assert lr.status_code == 200 and lr.json()["user"]["mustChangePassword"] is True


def test_missing_member_skip(tmp_path):
    env, doc, _task = conflict_setup(tmp_path)
    t = next(x for x in doc["tasks"] if x["title"] == "已刪除的任務")
    t["assigneeUsername"] = "ghost"
    doc["personalItems"].append({**doc["personalItems"][0], "uid": "f" * 32, "username": "ghost", "taskUid": None})
    result = apply(env, preview(env, doc)["token"], missingUsers="skip", strategy="use_import")
    assert result["missingUsersSkipped"] == ["ghost"]
    assert env.db.one("SELECT 1 FROM users WHERE username = 'ghost'") is None
    assert env.db.scalar("SELECT assignee_id FROM tasks WHERE title = '已刪除的任務'") is None
    personal = next(c for c in result["categories"] if c["key"] == "personalItems")
    assert personal["skipped"] == 1


# ── transaction 與取代模式 ──


def test_apply_rolls_back_on_error(tmp_path, monkeypatch):
    a = Env(tmp_path, name="a")
    populate(a)
    doc = export(a)
    b = Env(tmp_path, seed=False, name="b")
    token = preview(b, doc)["token"]
    calls = {"n": 0}
    original = dt._Writer.insert

    def boom(self, spec, item):
        calls["n"] += 1
        if calls["n"] == 5:
            raise RuntimeError("人為錯誤")
        return original(self, spec, item)

    monkeypatch.setattr(dt._Writer, "insert", boom)
    before = {t: b.db.scalar(f"SELECT count(*) FROM {t}") for t in [*UID_TABLES, "users", "changes"]}
    res = b.api.request("POST", "/api/admin/data/import/apply", {"token": token, "missingUsers": "create"})
    assert res.status_code == 500
    after = {t: b.db.scalar(f"SELECT count(*) FROM {t}") for t in before}
    assert after == before
    assert calls["n"] == 5
    # 備份仍已產生（套用前）
    assert list((tmp_path / "backups-b").glob("*-pre-import-*.db"))


def test_replace_mode_requires_confirmation(tmp_path):
    a = Env(tmp_path, name="a")
    populate(a)
    doc = export(a)
    b = Env(tmp_path, name="b")
    ok(b.api.request("POST", "/api/tasks", {"title": "只在 B 的任務"}), 201)
    token = preview(b, doc)["token"]
    res = b.api.request("POST", "/api/admin/data/import/apply", {"token": token, "mode": "replace"})
    assert res.status_code == 400 and "確認字樣" in res.json()["error"]["message"]
    res = b.api.request(
        "POST", "/api/admin/data/import/apply", {"token": token, "mode": "replace", "confirm": "錯的"}
    )
    assert res.status_code == 400
    result = apply(b, token, mode="replace", confirm=dt.REPLACE_CONFIRM, missingUsers="create")
    assert task_by_title(b.db, "只在 B 的任務") is None
    tasks = next(c for c in result["categories"] if c["key"] == "tasks")
    assert tasks["deleted"] == 1 and tasks["created"] == 2
    assert b.db.scalar("SELECT count(*) FROM statuses") == 4
    # 成員保留，B 的管理員仍可登入
    assert b.db.one("SELECT 1 FROM users WHERE username = 'admin-b'") is not None
    for spec in dt.SPECS:
        assert export(b)[spec.key] == doc[spec.key], spec.key


def test_apply_with_inline_data(tmp_path):
    env, doc, task = conflict_setup(tmp_path)
    result = ok(
        env.api.request("POST", "/api/admin/data/import/apply", {"data": doc, "strategy": "use_import"})
    )
    assert result["backupFile"]
    assert env.db.scalar("SELECT title FROM tasks WHERE id = ?", (task["id"],)) == "寫報告"


# ── CLI ──


def test_cli_export_import(tmp_path, capsys):
    src = str(tmp_path / "src.db")
    dst = str(tmp_path / "dst.db")
    db = create_db(src)
    run_migrations(db)
    run_seed(db)
    db.execute("INSERT INTO tasks (title, project_id, status_id, created_at, updated_at) VALUES ('CLI 任務', 1, 1, 1, 1)")
    db.close()
    out = str(tmp_path / "export.json")
    assert cli.main(["export", out, "--db", src]) == 0
    assert "已匯出" in capsys.readouterr().out

    db = create_db(dst)
    run_migrations(db)
    db.close()
    assert cli.main(["import", out, "--db", dst, "--dry-run"]) == 0
    assert "未寫入" in capsys.readouterr().out
    db = create_db(dst)
    assert db.scalar("SELECT count(*) FROM tasks") == 0
    db.close()

    backups = tmp_path / "bk"
    assert cli.main(["import", out, "--db", dst, "--strategy", "keep_local", "--out", str(backups)]) == 0
    assert "完成" in capsys.readouterr().out
    assert list(backups.glob("dst-pre-import-*.db"))
    db = create_db(dst)
    assert db.scalar("SELECT title FROM tasks") == "CLI 任務"
    db.close()

    bad = tmp_path / "bad.json"
    bad.write_text('{"format": "tasks-sheets-export", "schemaVersion": 2, "exportedAt": 1}', encoding="utf-8")
    assert cli.main(["import", str(bad), "--db", dst]) == 1
    assert "較新版本" in capsys.readouterr().err
    assert cli.main(["import", out, "--db", dst, "--replace"]) == 1
