"""後端審查修正（R1 / R3）的回歸測試：數值驗證、留言歷史隱私、還原的還原、匯入討論串結構、日界時區、
依賴匯入效能、成員建立稽核、API 路徑授權、inOverview 稽核與匯入。"""

from __future__ import annotations

import dataclasses
import json
import random
import time

import pytest

from server.app import config as app_config
from server.app import data_transfer as dt
from server.app.dependency_calc import IncrementalDag, find_cycle, today_local

from .helpers import FakeClock, create_test_app, create_test_db, create_test_user, login_as
from .test_data_transfer import Env, apply, export, ok, preview

BIG = 2**64


def _env():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    member = create_test_user(t.db, display_name="小明")
    other = create_test_user(t.db, display_name="小華")
    manager = create_test_user(t.db, role="manager", display_name="小管")
    return t, clock, login_as(t, member), login_as(t, other), login_as(t, manager)


def raw(api, method: str, path: str, text: str):
    """送出未經 json.dumps 的 JSON 文字（測 1e400、NaN 等）"""
    h = {"content-type": "application/json", "origin": "http://localhost", "cookie": api.cookie}
    http = api.app.http
    http.cookies.clear()
    return http.request(method, path, headers=h, content=text)


# ── M1：sortOrder / estimateHours 拒絕 NaN / Infinity / 1e400 ──


BAD_NUMBERS = ("Infinity", "-Infinity", "NaN", "1e400")


def test_checklist_sort_order_rejects_non_finite():
    t, _c, a, _o, _m = _env()
    task = ok(a.request("POST", "/api/tasks", {"title": "清單"}), 201)
    tid = task["id"]
    item = ok(a.request("POST", f"/api/tasks/{tid}/checklist", {"text": "一"}), 201)
    item_id = (item.get("items") or [item])[0]["id"] if isinstance(item, dict) else item[0]["id"]
    before = t.db.scalar("SELECT count(*) FROM task_checklist_items")
    for bad in BAD_NUMBERS:
        res = raw(a, "POST", f"/api/tasks/{tid}/checklist", f'{{"text": "x", "sortOrder": {bad}}}')
        assert res.status_code == 400, (bad, res.text)
        res = raw(a, "PATCH", f"/api/tasks/{tid}/checklist/{item_id}", f'{{"sortOrder": {bad}}}')
        assert res.status_code == 400, (bad, res.text)
    assert t.db.scalar("SELECT count(*) FROM task_checklist_items") == before
    assert all(abs(v) < 1e300 for (v,) in t.db.conn.execute("SELECT sort_order FROM task_checklist_items"))
    assert a.get(f"/api/tasks/{tid}/checklist").status_code == 200


def test_schema_floats_reject_non_finite():
    t, _c, a, _o, m = _env()
    task = ok(a.request("POST", "/api/tasks", {"title": "數值"}), 201)
    status_id = t.db.scalar("SELECT id FROM statuses LIMIT 1")
    project_id = t.db.scalar("SELECT id FROM projects LIMIT 1")
    prop = ok(m.request("POST", "/api/properties", {"name": "欄", "type": "text"}), 201)
    before = t.db.scalar("SELECT max(updated_at) FROM tasks")
    for bad in BAD_NUMBERS:
        assert raw(a, "POST", "/api/tasks", f'{{"title": "x", "sortOrder": {bad}}}').status_code == 400
        assert raw(a, "POST", "/api/tasks", f'{{"title": "x", "estimateHours": {bad}}}').status_code == 400
        assert raw(a, "PATCH", f"/api/tasks/{task['id']}", f'{{"sortOrder": {bad}}}').status_code == 400
        assert raw(a, "PATCH", f"/api/tasks/{task['id']}", f'{{"estimateHours": {bad}}}').status_code == 400
        assert raw(m, "PATCH", f"/api/projects/{project_id}", f'{{"sortOrder": {bad}}}').status_code == 400
        assert raw(m, "PATCH", f"/api/statuses/{status_id}", f'{{"sortOrder": {bad}}}').status_code == 400
        assert raw(m, "POST", "/api/statuses", f'{{"name": "s", "sortOrder": {bad}}}').status_code == 400
        assert raw(m, "PATCH", f"/api/properties/{prop['id']}", f'{{"sortOrder": {bad}}}').status_code == 400
    assert t.db.scalar("SELECT count(*) FROM tasks") == 1
    assert t.db.scalar("SELECT max(updated_at) FROM tasks") == before
    assert a.get("/api/tasks").status_code == 200 and m.get("/api/statuses").status_code == 200


# ── m3：超大整數 / 不嚴格的 id ──


def test_huge_integers_rejected_not_500():
    t, _c, a, _o, _m = _env()
    task = ok(a.request("POST", "/api/tasks", {"title": "大數"}), 201)
    tid = task["id"]
    root = ok(a.request("POST", f"/api/tasks/{tid}/comments", {"body": "根"}), 201)
    cases = [
        ("POST", f"/api/tasks/{tid}/relations", {"targetId": BIG}),
        ("POST", f"/api/tasks/{tid}/duplicate", {"statusId": BIG}),
        ("POST", f"/api/tasks/{tid}/comments", {"body": "x", "parentId": BIG}),
        ("POST", f"/api/tasks/{tid}/comments", {"body": "x", "parentId": root["id"], "replyToId": BIG}),
        ("POST", f"/api/tasks/{tid}/dependencies", {"targetId": BIG, "direction": "blocks"}),
        ("POST", "/api/tasks", {"title": "x", "assigneeId": BIG}),
        ("PATCH", f"/api/tasks/{tid}", {"projectId": BIG}),
    ]
    for method, path, body in cases:
        res = a.request(method, path, body)
        assert res.status_code == 400, (path, body, res.status_code, res.text)
    assert a.get(f"/api/tasks/{tid}/comments?before=99999999999999999999999_1").status_code == 400


@pytest.mark.parametrize("bad", ["1e30", "+1", "1.0", " 1", "1 ", "%201", "0", "-1", "99999999999999999999", "0x1"])
def test_parse_id_strict(bad):
    t, _c, a, _o, _m = _env()
    ok(a.request("POST", "/api/tasks", {"title": "一號"}), 201)
    res = a.get(f"/api/tasks/{bad}")
    assert res.status_code in (400, 404), (bad, res.status_code)
    assert a.get("/api/tasks/1").status_code == 200


# ── M2：任務歷史不洩漏留言內容 ──


def test_task_history_hides_comment_content():
    t, _c, a, other, m = _env()
    task = ok(a.request("POST", "/api/tasks", {"title": "討論"}), 201)
    tid = task["id"]
    secret = "這是誤貼的密碼 hunter2-SECRET"
    c = ok(a.request("POST", f"/api/tasks/{tid}/comments", {"body": secret}), 201)
    ok(a.request("PATCH", f"/api/tasks/{tid}/comments/{c['id']}", {"body": "改過 EDITED-SECRET"}))
    ok(a.request("DELETE", f"/api/tasks/{tid}/comments/{c['id']}"))
    hist = other.get(f"/api/tasks/{tid}/history")
    assert hist.status_code == 200
    body = hist.text
    assert "hunter2" not in body and "EDITED-SECRET" not in body
    items = [i for i in hist.json()["items"] if i["entityType"] == "comment"]
    assert len(items) == 3 and all(i["changes"] == [] for i in items)
    assert {i["summary"] for i in items} >= {"在『討論』發表了留言", "刪除了在『討論』的留言"}
    # 管理者在全站稽核頁可看完整內容
    full = m.get(f"/api/admin/audit?taskId={tid}&entityType=comment")
    assert full.status_code == 200 and "hunter2" in full.text and "EDITED-SECRET" in full.text
    aid = next(i["id"] for i in full.json()["items"] if i["action"] == "delete")
    assert "hunter2" not in other.get(f"/api/admin/audit/{aid}").text  # 一般成員 403


# ── m4：還原的還原 ──


def _last(t):
    return t.db.one("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1")


def _revert(api, aid: int):
    res = api.request("POST", f"/api/admin/audit/{aid}/revert", {})
    assert res.status_code == 200, res.text
    return res.json()["revertId"]


def test_revert_of_restore_comment():
    t, _c, a, _o, m = _env()
    tid = ok(a.request("POST", "/api/tasks", {"title": "留言任務"}), 201)["id"]
    c = ok(a.request("POST", f"/api/tasks/{tid}/comments", {"body": "會被管理刪除"}), 201)
    ok(m.request("DELETE", f"/api/tasks/{tid}/comments/{c['id']}"))
    deleted = _last(t)
    restore_id = _revert(m, deleted["id"])
    restore = t.db.one("SELECT * FROM audit_log WHERE id = ?", (restore_id,))
    assert restore["action"] == "restore" and restore["revertable"] == 1
    assert m.get(f"/api/admin/audit/{restore_id}").json()["revertPreview"]["kind"] == "delete_comment"
    again = _revert(m, restore_id)
    assert t.db.scalar("SELECT deleted_at FROM task_comments WHERE id = ?", (c["id"],)) is not None
    # 再還原一次（delete → undelete）
    _revert(m, again)
    assert t.db.scalar("SELECT deleted_at FROM task_comments WHERE id = ?", (c["id"],)) is None


@pytest.mark.parametrize("kind", ["relation", "dependency"])
def test_revert_of_restore_link(kind):
    t, _c, a, _o, m = _env()
    x = ok(a.request("POST", "/api/tasks", {"title": "甲"}), 201)["id"]
    y = ok(a.request("POST", "/api/tasks", {"title": "乙"}), 201)["id"]
    if kind == "relation":
        link = ok(a.request("POST", f"/api/tasks/{x}/relations", {"targetId": y}), 201)
        ok(a.request("DELETE", f"/api/tasks/{x}/relations/{link['id']}"))
        table = "task_relations"
    else:
        link = ok(a.request("POST", f"/api/tasks/{y}/dependencies", {"targetId": x, "direction": "blocked_by"}), 201)
        ok(a.request("DELETE", f"/api/tasks/{y}/dependencies/{link['id']}"))
        table = "task_dependencies"
    removed = _last(t)
    restore_id = _revert(m, removed["id"])
    assert t.db.scalar(f"SELECT count(*) FROM {table}") == 1
    again = _revert(m, restore_id)
    assert t.db.scalar(f"SELECT count(*) FROM {table}") == 0
    _revert(m, again)
    assert t.db.scalar(f"SELECT count(*) FROM {table}") == 1


@pytest.mark.parametrize("kind", ["status", "property"])
def test_revert_of_restore_status_property(kind):
    t, _c, _a, _o, m = _env()
    if kind == "status":
        row = ok(m.request("POST", "/api/statuses", {"name": "暫停"}), 201)
        ok(m.request("DELETE", f"/api/statuses/{row['id']}"))
        table = "statuses"
    else:
        row = ok(m.request("POST", "/api/properties", {"name": "版本", "type": "text"}), 201)
        ok(m.request("DELETE", f"/api/properties/{row['id']}"))
        table = "property_defs"
    deleted = _last(t)
    restore_id = _revert(m, deleted["id"])
    exists = lambda: t.db.scalar(f"SELECT count(*) FROM {table} WHERE id = ?", (row["id"],))  # noqa: E731
    assert exists() == 1
    again = _revert(m, restore_id)
    assert exists() == 0
    _revert(m, again)
    assert exists() == 1


# ── m5：匯入留言的討論串結構 ──


def test_import_comments_thread_structure(tmp_path):
    src = Env(tmp_path, name="a")
    api = src.api
    t1 = ok(api.request("POST", "/api/tasks", {"title": "任務一"}), 201)
    t2 = ok(api.request("POST", "/api/tasks", {"title": "任務二"}), 201)
    root1 = ok(api.request("POST", f"/api/tasks/{t1['id']}/comments", {"body": "根一"}), 201)
    ok(api.request("POST", f"/api/tasks/{t1['id']}/comments", {"body": "回覆", "parentId": root1["id"]}), 201)
    ok(api.request("POST", f"/api/tasks/{t2['id']}/comments", {"body": "根二"}), 201)
    doc = export(src)
    by_body = {c["body"]: c for c in doc["taskComments"]}
    r1, rep, r2 = by_body["根一"], by_body["回覆"], by_body["根二"]

    def extra(uid: str, **kw):
        return {**rep, "uid": uid, "body": f"違規 {uid}", **kw}

    doc["taskComments"] += [
        extra("badtask01", taskUid=r2["taskUid"], parentUid=r1["uid"], replyToUid=None),
        extra("thirdlvl01", parentUid=rep["uid"], replyToUid=None),
        extra("badreply01", parentUid=r1["uid"], replyToUid=r2["uid"]),
        extra("rootreply1", parentUid=None, replyToUid=r1["uid"]),
    ]
    dst = Env(tmp_path, name="b")
    result = apply(dst, preview(dst, doc)["token"], missingUsers="create")
    stats = result["taskComments"]
    assert stats["created"] == 3 and stats["skipped"] == 4
    reasons = " ".join(stats["skippedReasons"])
    assert "另一個任務" in reasons and "兩層" in reasons and "同一個討論串" in reasons and "根訊息" in reasons
    assert dst.db.scalar("SELECT count(*) FROM task_comments WHERE body LIKE '違規%'") == 0

    # 更新既有留言：不得改變其所屬任務與討論串
    before = dst.db.one("SELECT task_id, parent_id FROM task_comments WHERE uid = ?", (rep["uid"],))
    doc2 = export(src)
    moved = next(c for c in doc2["taskComments"] if c["uid"] == rep["uid"])
    moved.update(taskUid=r2["taskUid"], parentUid=None, replyToUid=None, body="被改過", updatedAt=moved["updatedAt"] + 10**6)
    result = apply(dst, preview(dst, doc2)["token"], strategy="use_import")
    after = dst.db.one("SELECT task_id, parent_id, body FROM task_comments WHERE uid = ?", (rep["uid"],))
    assert (after["task_id"], after["parent_id"]) == (before["task_id"], before["parent_id"])
    assert after["body"] == "被改過"


# ── m6：「今天」依 config.TZ ──


def test_today_local_uses_config_tz(monkeypatch):
    now = FakeClock().now() - 2 * 3_600_000  # 2026-01-05 07:00 +08:00 = 2026-01-04 23:00 UTC
    assert today_local(now) == "2026-01-05"
    monkeypatch.setattr(app_config, "config", dataclasses.replace(app_config.config, TZ="UTC"))
    assert today_local(now) == "2026-01-04"
    assert today_local(now, "Asia/Taipei") == "2026-01-05"


# ── m7(c)：匯入新建帳號沿用 inOverview ──


def test_import_new_users_follow_in_overview(tmp_path):
    src = Env(tmp_path, name="a")
    create_test_user(src.db, username="carol", in_overview=0)
    create_test_user(src.db, username="dave", in_overview=0)
    src.db.execute("UPDATE users SET in_overview = 0 WHERE username = 'alice'")
    doc = export(src)
    for u in doc["users"]:
        if u["username"] == "dave":
            del u["inOverview"]  # 缺漏 → 依角色預設（匯入建立的成員為 user → 列入）
    dst = Env(tmp_path, name="b")
    apply(dst, preview(dst, doc)["token"], missingUsers="create")
    ov = {r["username"]: r["in_overview"] for r in dst.db.all("SELECT username, in_overview FROM users")}
    assert ov["carol"] == 0 and ov["dave"] == 1
    assert ov["alice"] == 1  # 既有帳號不覆寫


def test_import_accepts_schema_version_1(tmp_path):
    src = Env(tmp_path, name="a")
    ok(src.api.request("POST", "/api/tasks", {"title": "舊版檔"}), 201)
    doc = export(src)
    assert doc["schemaVersion"] == dt.SCHEMA_VERSION == 2
    doc["schemaVersion"] = 1
    for k in ("taskChecklistItems", "taskRelations", "taskDependencies", "taskComments"):
        doc.pop(k, None)
    for x in doc["tasks"]:
        for k in ("descriptionLocked", "lockedByUsername", "lockedAt"):
            del x[k]
    for u in doc["users"]:
        del u["inOverview"]
    for p in doc["personalItems"]:
        p.pop("doneAt", None)
    dst = Env(tmp_path, name="b")
    apply(dst, preview(dst, doc)["token"], missingUsers="create")
    assert dst.db.scalar("SELECT count(*) FROM tasks WHERE title = '舊版檔'") == 1
    bad = dict(doc, schemaVersion=3)
    res = dst.api.request("POST", "/api/admin/data/import/preview", bad)
    assert res.status_code == 400 and "較新版本" in res.text


# ── m8：依賴匯入效能（增量循環檢查）──


def _apply_deps(db, edges: list[tuple[int, int]]):
    uid = {r["id"]: r["uid"] for r in db.all("SELECT id, uid FROM tasks")}
    items = [
        {
            "uid": f"dep{i:08d}",
            "blockerTaskUid": uid[a],
            "blockedTaskUid": uid[b],
            "type": "finish_to_start",
            "lagDays": 0,
            "note": "",
            "createdByUsername": None,
            "createdAt": None,
            "updatedAt": None,
        }
        for i, (a, b) in enumerate(edges)
    ]
    doc = {dt.DEP_KEY: items}
    stats = dt._dependency_stats()
    with db.tx() as conn:
        w = dt._Writer(conn, {"propertyDefs": []}, None, 1)
        issues = dt._apply_dependencies(w, doc, dt.ApplyOptions(), stats)
    return stats, issues


def _db_with_tasks(n: int):
    db = create_test_db()
    pid, sid = db.scalar("SELECT id FROM projects LIMIT 1"), db.scalar("SELECT id FROM statuses LIMIT 1")
    with db.tx() as conn:
        conn.executemany(
            "INSERT INTO tasks (project_id, status_id, title, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
            [(pid, sid, f"T{i}") for i in range(n)],
        )
    return db, [r[0] for r in db.conn.execute("SELECT id FROM tasks ORDER BY id")]


def test_dependency_import_5000_fast():
    db, ids = _db_with_tasks(5001)
    # 逆向的長鏈（逐筆 DFS 的最差情況）＋一條閉合環的邊＋重複對
    edges = [(ids[i + 1], ids[i]) for i in range(5000)]
    edges.append((ids[0], ids[5000]))
    start = time.perf_counter()
    stats, issues = _apply_deps(db, edges)
    elapsed = time.perf_counter() - start
    assert elapsed < 3, elapsed
    assert stats["created"] == 5000 and stats["skipped"] == 1
    assert len(issues) == 1 and "循環" in issues[0]
    assert db.scalar("SELECT count(*) FROM task_dependencies") == 5000


def test_incremental_dag_matches_naive_find_cycle():
    rnd = random.Random(7)
    for _ in range(30):
        n = rnd.randint(3, 25)
        edges = [(rnd.randint(1, n), rnd.randint(1, n)) for _ in range(rnd.randint(5, 80))]
        order = list(range(1, n + 1))
        rnd.shuffle(order)
        dag = IncrementalDag(order)
        accepted: list[tuple[int, int]] = []
        for a, b in edges:
            expected = find_cycle(accepted, a, b)
            got = dag.add(a, b)
            assert (got is None) == (expected is None)
            if got is None:
                accepted.append((a, b))
            else:
                # 回傳的環確實由已接受的邊＋新邊組成
                assert got[0] == got[-1] == a and got[1] == b
                pairs = set(accepted) | {(a, b)}
                assert all((got[i], got[i + 1]) in pairs for i in range(len(got) - 1))


def test_dependency_import_same_result_as_before():
    db, ids = _db_with_tasks(12)
    rnd = random.Random(3)
    edges = [(rnd.choice(ids), rnd.choice(ids)) for _ in range(60)]
    stats, issues = _apply_deps(db, edges)
    # 對照：逐筆以 find_cycle 檢查（原本的行為）
    accepted: list[tuple[int, int]] = []
    seen_pairs: set[tuple[int, int]] = set()
    created = skipped = unchanged = 0
    for a, b in edges:
        if a == b:
            skipped += 1
        elif (a, b) in seen_pairs:
            unchanged += 1
        elif find_cycle(accepted, a, b) is not None:
            skipped += 1
        else:
            accepted.append((a, b))
            seen_pairs.add((a, b))
            created += 1
    assert (stats["created"], stats["skipped"], stats["unchanged"]) == (created, skipped, unchanged)
    got = {(r[0], r[1]) for r in db.conn.execute("SELECT blocker_task_id, blocked_task_id FROM task_dependencies")}
    assert got == set(accepted)
    assert sum("循環" in i for i in issues) == skipped - sum(a == b for a, b in edges)


# ── n2：建立成員與稽核同一 transaction ──


def test_member_create_audit_in_same_transaction(monkeypatch):
    t, _c, _a, _o, m = _env()
    from server.app import audit_events

    def boom(*_a, **_k):
        raise RuntimeError("audit boom")

    monkeypatch.setattr(audit_events, "user_created", boom)
    res = m.request("POST", "/api/admin/users", {"username": "atomic", "displayName": "原子"})
    assert res.status_code == 500
    assert t.db.scalar("SELECT count(*) FROM users WHERE username = 'atomic'") == 0


# ── n3：中介層以路由器相同的 path 判斷授權 ──


@pytest.mark.parametrize(
    "path",
    [
        "/api/admin/users/",
        "/api/admin%2Fusers",
        "/api/admin/users%3F",
        "/api/admin/users%3Fx=1",
        "/api/tasks/../admin/users",
        "/api/x/../admin/users",
        "/API/admin/users",
        "/api/Admin/users",
        "/api/admin/./users",
        "/api//admin/users",
    ],
)
def test_admin_path_variants_not_bypassable(path):
    t, _c, a, _o, _m = _env()
    for method in ("GET", "POST"):
        res = a.request(method, path, {"username": "evil", "displayName": "x"} if method == "POST" else None)
        assert res.status_code in (401, 403, 404, 405), (method, path, res.status_code)
    assert t.db.scalar("SELECT count(*) FROM users WHERE username = 'evil'") == 0
    # 未登入：不得 2xx
    a.app.http.cookies.clear()
    res = a.app.http.request("GET", path)
    assert res.status_code in (401, 403, 404, 405)


# ── n4：inOverview 變更納入稽核 ──


def test_in_overview_change_audited_and_revertable():
    t, _c, _a, _o, m = _env()
    uid = t.db.scalar("SELECT id FROM users WHERE display_name = '小明'")
    ok(m.request("PATCH", f"/api/admin/users/{uid}", {"inOverview": False}))
    row = _last(t)
    assert row["entity_type"] == "user" and row["summary"] == "把成員『小明』設為不列入總覽統計"
    assert json.loads(row["before_json"]) == {"inOverview": True}
    detail = m.get(f"/api/admin/audit/{row['id']}").json()
    assert detail["changes"][0]["label"] == "列入總覽統計" and detail["changes"][0]["afterText"] == "不列入"
    _revert(m, row["id"])
    assert t.db.scalar("SELECT in_overview FROM users WHERE id = ?", (uid,)) == 1
