"""多台電腦同步（server/app/sync_push.py、features/sync_push.py、server/sync_client.py；docs/sync.md）。

以兩個檔案型資料庫模擬：A = 本機（直接寫 SQL 控制 updated_at）、B = 中央（TestApp + 假時鐘）。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from server import sync_client
from server.app import sync_push as sp
from server.app.db import Database, create_db, run_migrations, run_seed

from .helpers import MIN, FakeClock, TestApp, create_test_user, login_as

T0 = FakeClock().now()


# ── 工具 ────────────────────────────────────────────────────


def file_db(path: Path) -> Database:
    db = create_db(str(path))
    run_migrations(db)
    run_seed(db)
    return db


@pytest.fixture
def env(tmp_path):
    clock = FakeClock()
    local = file_db(tmp_path / "local" / "app.db")
    central = TestApp(now=clock.now, db=file_db(tmp_path / "central" / "app.db"))
    central.app.state.backup_dir = str(tmp_path / "backups")
    root = create_test_user(central.db, role="root")
    manager = create_test_user(central.db, role="manager")
    member = create_test_user(central.db, role="user")
    apis = {"root": login_as(central, root), "manager": login_as(central, manager), "user": login_as(central, member)}
    yield {"local": local, "central": central, "clock": clock, "apis": apis, "tmp": tmp_path, "manager": manager}
    local.close()
    central.db.close()


def make_source(e, name="小明的筆電", **extra) -> tuple[int, str]:
    res = e["apis"]["manager"].request("POST", "/api/admin/sync/sources", {"name": name, **extra})
    assert res.status_code == 201, res.text
    body = res.json()
    return body["source"]["id"], body["token"]


def push_raw(e, token: str | None, doc, headers=None):
    h = {"content-type": "application/json"}
    if token is not None:
        h["authorization"] = f"Bearer {token}"
    h.update(headers or {})
    content = doc if isinstance(doc, (bytes, str)) else json.dumps(doc)
    return e["central"].http.post("/api/sync/push", content=content, headers=h)


def push(e, token: str, since=None, batch_size=500, machine="A") -> list[dict]:
    items, users = sp.export_changes(e["local"], since)
    docs = sp.build_batches(
        items,
        users,
        machine_name=machine,
        exported_at=e["clock"].now(),
        since=since,
        push_id="p1",
        batch_size=batch_size,
        in_overview=sp.export_user_flags(e["local"]),
    )
    out = []
    for d in docs:
        res = push_raw(e, token, d)
        assert res.status_code == 200, res.text
        out.append(res.json())
    return out


def ids(db: Database) -> tuple[int, int]:
    return db.scalar("SELECT id FROM projects ORDER BY id LIMIT 1"), db.scalar("SELECT id FROM statuses ORDER BY id LIMIT 1")


def add_task(db: Database, title: str, at: int, **cols) -> str:
    pid, sid = ids(db)
    values = {"project_id": pid, "status_id": sid, "title": title, "created_at": at, "updated_at": at, **cols}
    with db.tx() as conn:
        cur = conn.execute(
            f"INSERT INTO tasks ({', '.join(values)}) VALUES ({', '.join('?' * len(values))})", tuple(values.values())
        )
        return conn.execute("SELECT uid FROM tasks WHERE id = ?", (cur.lastrowid,)).fetchone()[0]


def set_task(db: Database, uid: str, at: int, **cols) -> None:
    cols["updated_at"] = at
    db.execute(f"UPDATE tasks SET {', '.join(f'{k} = ?' for k in cols)} WHERE uid = ?", (*cols.values(), uid))


def task(db: Database, uid: str):
    return db.one("SELECT * FROM tasks WHERE uid = ?", (uid,))


def totals(results: list[dict]) -> dict[str, int]:
    out = {k: 0 for k in sp.TOTAL_KEYS}
    for r in results:
        for k in out:
            out[k] += r["totals"][k]
    return out


def changes_count(db: Database) -> int:
    return db.scalar("SELECT count(*) FROM changes")


# ── 金鑰驗證 ─────────────────────────────────────────────────


def test_token_auth(env):
    e = env
    sid, token = make_source(e)
    doc = sp.build_batches([], {}, machine_name="A", exported_at=T0, since=None, push_id="x")[0]
    for tok in (None, "", "tss_wrong", token + "x"):
        res = push_raw(e, tok, doc)
        assert res.status_code == 403
        assert res.json()["error"]["message"] == "同步金鑰無效或來源已停用"
    assert push_raw(e, None, doc, {"x-sync-token": token}).status_code == 200
    assert push_raw(e, token, doc).status_code == 200
    # DB 只存雜湊
    row = e["central"].db.one("SELECT * FROM sync_sources WHERE id = ?", (sid,))
    assert row["token_hash"] == sp.hash_token(token) and token not in json.dumps(dict(row))
    # 停用 → 403；重新啟用 → 可用
    api = e["apis"]["manager"]
    assert api.request("PATCH", f"/api/admin/sync/sources/{sid}", {"isActive": False}).status_code == 200
    assert push_raw(e, token, doc).status_code == 403
    api.request("PATCH", f"/api/admin/sync/sources/{sid}", {"isActive": True})
    assert push_raw(e, token, doc).status_code == 200
    # 重新產生 → 舊金鑰失效
    new = api.request("POST", f"/api/admin/sync/sources/{sid}/token").json()["token"]
    assert push_raw(e, token, doc).status_code == 403
    assert push_raw(e, new, doc).status_code == 200
    # 刪除 → 失效
    assert api.request("DELETE", f"/api/admin/sync/sources/{sid}").status_code == 200
    assert push_raw(e, new, doc).status_code == 403
    # 列表不含金鑰
    listing = api.get("/api/admin/sync/sources").text
    assert new not in listing


def test_auth_failures_rate_limited(env):
    e = env
    doc = sp.build_batches([], {}, machine_name="A", exported_at=T0, since=None, push_id="x")[0]
    codes = [push_raw(e, "tss_bad", doc).status_code for _ in range(21)]
    assert codes[:20] == [403] * 20 and codes[20] == 429


def test_size_limit_and_invalid(env):
    e = env
    _sid, token = make_source(e)
    e["central"].app.state.import_max_bytes = 2_000
    big = sp.build_batches([], {}, machine_name="A" * 150, exported_at=T0, since=None, push_id="x")[0]
    big["users"] = [{"username": f"u{i}", "displayName": "x" * 50} for i in range(50)]
    assert push_raw(e, token, big).status_code == 413
    assert push_raw(e, token, b"not json").status_code == 400
    assert push_raw(e, token, {"format": "nope"}).status_code == 400


# ── 套用規則 ────────────────────────────────────────────────


def test_new_update_same_idempotent(env):
    e = env
    _sid, token = make_source(e)
    a = add_task(e["local"], "本機任務一", T0 - 60 * MIN)
    b = add_task(e["local"], "本機任務二", T0 - 60 * MIN)
    r1 = totals(push(e, token))
    # 預設狀態 / 專案以名稱對應中央既有資料（相同），兩筆任務新增
    assert r1["created"] == 2 and r1["conflict"] == 0
    cdb = e["central"].db
    assert task(cdb, a)["title"] == "本機任務一"
    assert cdb.scalar("SELECT count(*) FROM sync_uid_aliases") >= 2
    # 中央任務的專案 / 狀態對應到中央自己的預設資料
    assert task(cdb, a)["project_id"] == ids(cdb)[0]

    # 同批重送：沒有任何變更（含變更流水）
    before = changes_count(cdb)
    r2 = totals(push(e, token))
    assert r2["created"] == 0 and r2["updated"] == 0 and r2["unchanged"] > 0
    assert changes_count(cdb) == before

    # 本機修改（比中央新很多）→ 更新
    set_task(e["local"], b, T0, title="本機任務二（改）")
    r3 = totals(push(e, token))
    assert r3["updated"] == 1
    assert task(cdb, b)["title"] == "本機任務二（改）"
    assert changes_count(cdb) == before + 1
    # last_push 紀錄
    src = e["apis"]["manager"].get("/api/admin/sync/sources").json()["sources"][0]
    assert src["lastPushAt"] == e["clock"].now() and src["lastPushSummary"]["sourceName"] == "小明的筆電"


def test_incremental_since_only_sends_new(env):
    e = env
    old = add_task(e["local"], "舊", T0 - 600 * MIN)
    new = add_task(e["local"], "新", T0)
    items, _ = sp.export_changes(e["local"], T0 - 5 * MIN)
    uids = [i["uid"] for k, i in items if k == "tasks"]
    assert new in uids and old not in uids
    full, _ = sp.export_changes(e["local"], None)
    assert old in [i["uid"] for k, i in full if k == "tasks"]


def test_time_rule_auto_newer_and_conflict(env):
    e = env
    _sid, token = make_source(e)
    a = add_task(e["local"], "A", T0 - 120 * MIN)
    b = add_task(e["local"], "B", T0 - 120 * MIN)
    push(e, token)
    cdb = e["central"].db
    # 中央改 a（T0），本機改 a 在 T0-30 分 → 中央較新且差 > 10 分 → 保留中央
    set_task(cdb, a, T0, title="A 中央")
    set_task(e["local"], a, T0 - 30 * MIN, title="A 本機")
    # 中央改 b（T0），本機改 b（T0+3 分）→ 差 3 分 → 衝突
    set_task(cdb, b, T0, title="B 中央", description="中央說明")
    set_task(e["local"], b, T0 + 3 * MIN, title="B 本機")
    r = totals(push(e, token))
    assert r["older"] == 1 and r["conflict"] == 1
    assert task(cdb, a)["title"] == "A 中央"
    assert task(cdb, b)["title"] == "B 中央"  # 衝突不套用
    rows = cdb.all("SELECT * FROM sync_conflicts")
    assert len(rows) == 1 and rows[0]["status"] == "pending"
    assert set(json.loads(rows[0]["diff_fields"])) == {"title", "description"}
    # 同一份內容重送 → 不重複建立
    totals(push(e, token))
    assert cdb.scalar("SELECT count(*) FROM sync_conflicts") == 1
    # 本機又改了新版本（仍在門檻內）→ 更新同一筆衝突紀錄
    set_task(e["local"], b, T0 + 4 * MIN, title="B 本機 v2")
    push(e, token)
    rows = cdb.all("SELECT * FROM sync_conflicts")
    assert len(rows) == 1 and json.loads(rows[0]["incoming_json"])["title"] == "B 本機 v2"
    # 本機很久之後再改 → 自動採用，衝突由系統關閉
    set_task(e["local"], b, T0 + 60 * MIN, title="B 本機 最終")
    push(e, token)
    assert task(cdb, b)["title"] == "B 本機 最終"
    row = cdb.one("SELECT * FROM sync_conflicts")
    assert row["status"] == "resolved" and row["resolution"] == "use_incoming" and row["resolved_by"] is None


def test_threshold_configurable(env):
    e = env
    e["central"].app.state.sync_auto_resolve_minutes = 1
    _sid, token = make_source(e)
    a = add_task(e["local"], "A", T0 - 120 * MIN)
    push(e, token)
    set_task(e["central"].db, a, T0, title="中央")
    set_task(e["local"], a, T0 + 3 * MIN, title="本機")
    r = totals(push(e, token))
    assert r["updated"] == 1 and r["conflict"] == 0


def _make_conflict(e, token):
    a = add_task(e["local"], "原標題", T0 - 120 * MIN, description="原說明", priority="low")
    push(e, token)
    cdb = e["central"].db
    set_task(cdb, a, T0, title="中央標題", description="中央說明")
    set_task(e["local"], a, T0 + 2 * MIN, title="本機標題", description="本機說明", priority="high")
    push(e, token)
    cid = cdb.scalar("SELECT id FROM sync_conflicts WHERE entity_uid = ? AND status = 'pending'", (a,))
    assert cid
    return a, cid


def test_resolve_three_ways(env):
    e = env
    api = e["apis"]["manager"]
    _sid, token = make_source(e)
    cdb = e["central"].db

    a, cid = _make_conflict(e, token)
    detail = api.get(f"/api/admin/sync/conflicts/{cid}").json()
    assert {f["name"] for f in detail["fields"]} == {"title", "description", "priority"}
    assert detail["diffMinutes"] == 2.0 and detail["sourceName"] == "小明的筆電"
    before = changes_count(cdb)
    res = api.request("POST", f"/api/admin/sync/conflicts/{cid}/resolve", {"resolution": "keep_local"})
    assert res.status_code == 200 and res.json()["status"] == "resolved"
    assert task(cdb, a)["title"] == "中央標題" and changes_count(cdb) == before
    # 已解決不可重複
    again = api.request("POST", f"/api/admin/sync/conflicts/{cid}/resolve", {"resolution": "use_incoming"})
    assert again.status_code == 409
    # 同一份內容再推送不會再產生衝突
    push(e, token)
    assert cdb.scalar("SELECT count(*) FROM sync_conflicts WHERE status = 'pending'") == 0

    # use_incoming
    b = add_task(e["local"], "第二筆", T0 - 120 * MIN)
    push(e, token)
    set_task(cdb, b, T0, title="第二筆中央")
    set_task(e["local"], b, T0 + 1 * MIN, title="第二筆本機")
    push(e, token)
    cid2 = cdb.scalar("SELECT id FROM sync_conflicts WHERE entity_uid = ? AND status = 'pending'", (b,))
    assert api.request("POST", f"/api/admin/sync/conflicts/{cid2}/resolve", {"resolution": "use_incoming"}).status_code == 200
    assert task(cdb, b)["title"] == "第二筆本機"
    assert changes_count(cdb) > before

    # merged：標題用上傳、說明保留中央
    c = add_task(e["local"], "第三筆", T0 - 120 * MIN, description="d0")
    push(e, token)
    set_task(cdb, c, T0, title="第三筆中央", description="d中央")
    set_task(e["local"], c, T0 + 1 * MIN, title="第三筆本機", description="d本機")
    push(e, token)
    cid3 = cdb.scalar("SELECT id FROM sync_conflicts WHERE entity_uid = ? AND status = 'pending'", (c,))
    res = api.request(
        "POST",
        f"/api/admin/sync/conflicts/{cid3}/resolve",
        {"resolution": "merged", "choices": {"title": "incoming", "description": "local"}},
    )
    assert res.status_code == 200, res.text
    t = task(cdb, c)
    assert t["title"] == "第三筆本機" and t["description"] == "d中央"
    assert t["updated_by"] == e["manager"]["id"]
    assert res.json()["resolvedByName"] == e["manager"]["display_name"]
    bad = api.request("POST", f"/api/admin/sync/conflicts/{cid3}/resolve", {"resolution": "merged", "choices": {"x": "y"}})
    assert bad.status_code == 400
    # 已解決清單（紀錄）
    resolved = api.get("/api/admin/sync/conflicts?status=resolved").json()
    assert resolved["counts"]["resolved"] == 3 and resolved["conflicts"][0]["resolution"] == "merged"


def test_resolve_bulk(env):
    e = env
    api = e["apis"]["manager"]
    _sid, token = make_source(e)
    cdb = e["central"].db
    uids = [add_task(e["local"], f"批次 {i}", T0 - 120 * MIN) for i in range(3)]
    push(e, token)
    for u in uids:
        set_task(cdb, u, T0, title=f"中央 {u[:4]}")
        set_task(e["local"], u, T0 + MIN, title=f"本機 {u[:4]}")
    push(e, token)
    pending = api.get("/api/admin/sync/conflicts").json()
    assert pending["counts"]["pending"] == 3
    cids = [c["id"] for c in pending["conflicts"]]
    res = api.request("POST", "/api/admin/sync/conflicts/resolve-bulk", {"ids": cids[:2] + [9999], "resolution": "use_incoming"})
    assert res.status_code == 200 and res.json() == {"resolved": cids[:2], "skipped": [9999]}
    assert sum(task(cdb, u)["title"].startswith("本機") for u in uids) == 2
    assert api.get("/api/admin/sync/conflicts").json()["counts"]["pending"] == 1


def test_never_deletes_and_soft_delete(env):
    e = env
    _sid, token = make_source(e)
    a = add_task(e["local"], "會被本機硬刪", T0 - 120 * MIN)
    b = add_task(e["local"], "會被本機軟刪", T0 - 120 * MIN)
    push(e, token)
    cdb = e["central"].db
    # 本機硬刪 a（資料不見）、軟刪 b（明確刪除）
    e["local"].execute("DELETE FROM tasks WHERE uid = ?", (a,))
    set_task(e["local"], b, T0, deleted_at=T0)
    push(e, token, since=None)  # 全量也一樣：缺少的資料不刪除
    assert task(cdb, a) is not None and task(cdb, a)["deleted_at"] is None
    assert task(cdb, b)["deleted_at"] == T0
    # 中央自己的資料（本機沒有）不受影響
    own = add_task(cdb, "中央自有", T0)
    push(e, token)
    assert task(cdb, own) is not None


def test_missing_members(env):
    e = env
    ldb = e["local"]
    with ldb.tx() as conn:
        conn.execute(
            "INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at) "
            "VALUES ('bob', '小鮑', 'x', 'user', 1, 1)"
        )
    bob = ldb.scalar("SELECT id FROM users WHERE username = 'bob'")
    a = add_task(ldb, "指派給 bob", T0 - 60 * MIN, assignee_id=bob)
    with ldb.tx() as conn:
        conn.execute(
            "INSERT INTO personal_items (user_id, title, created_at, updated_at) VALUES (?, 'bob 的清單', ?, ?)",
            (bob, T0, T0),
        )
    _sid, token = make_source(e)
    res = push(e, token)
    cdb = e["central"].db
    assert task(cdb, a)["assignee_id"] is None  # 略過指派
    assert res[0]["missingUsers"] == ["bob"]
    assert cdb.scalar("SELECT count(*) FROM users WHERE username = 'bob'") == 0
    assert totals(res)["skipped"] == 1  # 個人清單需擁有者 → 略過
    # 冪等：再推送一次為「相同」
    assert totals(push(e, token))["updated"] == 0

    # 開啟「自動建立缺少的成員」的來源
    _sid2, token2 = make_source(e, name="自動建立", autoCreateUsers=True)
    set_task(ldb, a, T0, title="指派給 bob（改）")
    res = push(e, token2)
    u = cdb.one("SELECT * FROM users WHERE username = 'bob'")
    assert u is not None and u["role"] == "user" and u["must_change_password"] == 1 and u["display_name"] == "小鮑"
    assert task(cdb, a)["assignee_id"] == u["id"]
    assert res[0]["createdUsers"] == ["bob"]


def test_transaction_rollback(env, monkeypatch):
    e = env
    _sid, token = make_source(e)
    for i in range(3):
        add_task(e["local"], f"R{i}", T0)
    cdb = e["central"].db
    before = cdb.scalar("SELECT count(*) FROM tasks"), changes_count(cdb)
    orig = sp._Applier.process
    calls = {"n": 0}

    def boom(self, spec, item, keys):
        if spec.key == "tasks":
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("boom")
        return orig(self, spec, item, keys)

    monkeypatch.setattr(sp._Applier, "process", boom)
    items, users = sp.export_changes(e["local"], None)
    doc = sp.build_batches(items, users, machine_name="A", exported_at=T0, since=None, push_id="r")[0]
    assert push_raw(e, token, doc).status_code == 500
    assert (cdb.scalar("SELECT count(*) FROM tasks"), changes_count(cdb)) == before
    assert cdb.scalar("SELECT last_push_at FROM sync_sources") is None


def test_backup_once_per_day_per_source(env):
    e = env
    _sid, token = make_source(e)
    add_task(e["local"], "x", T0)
    bdir = Path(e["central"].app.state.backup_dir)
    push(e, token)
    files = list(bdir.glob("*pre-sync-*.db"))
    assert len(files) == 1
    push(e, token)
    assert len(list(bdir.glob("*pre-sync-*.db"))) == 1
    e["clock"].advance(24 * 60 * MIN)
    push(e, token)
    assert len(list(bdir.glob("*pre-sync-*.db"))) == 2


def test_batches_and_dependencies(env):
    e = env
    _sid, token = make_source(e)
    ldb = e["local"]
    with ldb.tx() as conn:
        conn.execute("INSERT INTO projects (name, color, sort_order, created_at, updated_at) VALUES ('本機專案', 'red', 5, ?, ?)", (T0, T0))
    pid = ldb.scalar("SELECT id FROM projects WHERE name = '本機專案'")
    for i in range(7):
        add_task(ldb, f"T{i}", T0, project_id=pid)
    res = push(e, token, batch_size=3)
    assert len(res) >= 3
    cdb = e["central"].db
    cpid = cdb.scalar("SELECT id FROM projects WHERE name = '本機專案'")
    assert cdb.scalar("SELECT count(*) FROM tasks WHERE project_id = ?", (cpid,)) == 7
    summary = e["apis"]["manager"].get("/api/admin/sync/sources").json()["sources"][0]["lastPushSummary"]
    assert summary["batches"] == len(res) and summary["totals"]["created"] == 8


def test_permissions_user_denied(env):
    e = env
    user = e["apis"]["user"]
    for method, path, body in [
        ("GET", "/api/admin/sync/sources", None),
        ("POST", "/api/admin/sync/sources", {"name": "x"}),
        ("GET", "/api/admin/sync/conflicts", None),
        ("POST", "/api/admin/sync/conflicts/resolve-bulk", {"ids": [1], "resolution": "keep_local"}),
    ]:
        assert user.request(method, path, body).status_code == 403
    assert e["apis"]["root"].get("/api/admin/sync/sources").status_code == 200
    me = user.get("/api/auth/me").json()
    assert "sync.manage" not in me["capabilities"]


def test_cli_sync_push_watermark(env, monkeypatch, capsys):
    """CLI：水位只在成功後前進；--dry-run 不上傳；失敗時水位不動"""
    e = env
    _sid, token = make_source(e)
    ldb_path = Path(e["local"].path)
    add_task(e["local"], "CLI 任務", T0)
    sent: list[dict] = []

    def fake_post(server, tok, doc, timeout=120):
        sent.append(doc)
        res = push_raw(e, tok, doc)
        if res.status_code != 200:
            raise sync_client.PushFailed(res.json()["error"]["message"])
        return res.json()

    monkeypatch.setattr(sync_client, "post_batch", fake_post)
    base = ["--server", "https://central.example", "--token", token, "--db", str(ldb_path)]
    assert sync_client.sync_push_cmd([*base, "--dry-run"]) == 0
    assert sent == []
    assert sync_client.sync_push_cmd(base) == 0
    state = json.loads((ldb_path.parent / ".sync-state.json").read_text(encoding="utf-8"))
    wm = state["https://central.example"]["watermark"]
    assert task(e["central"].db, task(e["local"], e["local"].scalar("SELECT uid FROM tasks"))["uid"])
    # 下一次增量：since = 水位
    sent.clear()
    assert sync_client.sync_push_cmd(base) == 0
    assert sent[0]["source"]["since"] == wm and sent[0]["incremental"] is True
    # 失敗：水位不前進
    bad = ["--server", "https://central.example", "--token", "tss_wrong", "--db", str(ldb_path)]
    state_before = (ldb_path.parent / ".sync-state.json").read_text(encoding="utf-8")
    assert sync_client.sync_push_cmd(bad) == 1
    assert (ldb_path.parent / ".sync-state.json").read_text(encoding="utf-8") == state_before
    # 只允許 https（localhost 例外）
    assert sync_client.sync_push_cmd(["--server", "http://example.com", "--token", token, "--db", str(ldb_path)]) == 1
    out = capsys.readouterr()
    assert "只允許 https" in out.err


# ── 待辦清單同步（taskChecklistItems 在 SPECS 內）────────────────


def add_item(db: Database, task_uid: str, text: str, at: int, **cols) -> str:
    tid = task(db, task_uid)["id"]
    values = {"task_id": tid, "text": text, "sort_order": 1, "created_at": at, "updated_at": at, **cols}
    with db.tx() as conn:
        cur = conn.execute(
            f"INSERT INTO task_checklist_items ({', '.join(values)}) VALUES ({', '.join('?' * len(values))})",
            tuple(values.values()),
        )
        return conn.execute("SELECT uid FROM task_checklist_items WHERE id = ?", (cur.lastrowid,)).fetchone()[0]


def item(db: Database, uid: str):
    return db.one("SELECT * FROM task_checklist_items WHERE uid = ?", (uid,))


def test_checklist_items_synced_idempotent_and_conflict(env):
    e = env
    _sid, token = make_source(e)
    a = add_task(e["local"], "有清單的任務", T0 - 120 * MIN)
    i1 = add_item(e["local"], a, "買材料", T0 - 120 * MIN)
    i2 = add_item(e["local"], a, "組裝", T0 - 120 * MIN, is_done=1, done_at=T0 - 100 * MIN)
    res = push(e, token)
    cat = next(c for c in res[0]["categories"] if c["key"] == "taskChecklistItems")
    assert cat["created"] == 2
    cdb = e["central"].db
    assert item(cdb, i1)["task_id"] == task(cdb, a)["id"] and item(cdb, i2)["is_done"] == 1
    # 冪等：重送不變
    before = changes_count(cdb)
    cat = next(c for c in push(e, token)[0]["categories"] if c["key"] == "taskChecklistItems")
    assert cat["created"] == 0 and cat["updated"] == 0 and cat["unchanged"] == 2
    assert changes_count(cdb) == before
    # 兩邊在門檻內各自修改 → 待確認衝突，不套用
    cdb.execute("UPDATE task_checklist_items SET text = '買材料（中央）', updated_at = ? WHERE uid = ?", (T0, i1))
    e["local"].execute("UPDATE task_checklist_items SET text = '買材料（本機）', updated_at = ? WHERE uid = ?", (T0 + MIN, i1))
    cat = next(c for c in push(e, token)[0]["categories"] if c["key"] == "taskChecklistItems")
    assert cat["conflict"] == 1 and item(cdb, i1)["text"] == "買材料（中央）"
    row = cdb.one("SELECT * FROM sync_conflicts WHERE category = 'taskChecklistItems'")
    assert row["entity_uid"] == i1 and row["status"] == "pending"


def test_blank_checklist_item_skip_reason(env):
    e = env
    _sid, token = make_source(e)
    a = add_task(e["local"], "任務", T0 - 60 * MIN)
    add_item(e["local"], a, "x", T0 - 60 * MIN)
    items, users = sp.export_changes(e["local"], None)
    doc = sp.build_batches(items, users, machine_name="A", exported_at=T0, since=None, push_id="b")[0]
    doc["taskChecklistItems"][0]["text"] = "   "
    res = push_raw(e, token, doc)
    assert res.status_code == 200, res.text
    body = res.json()
    assert any("空白的待辦項目" in r for r in body["skipped"])
    assert not any("個人清單" in r for r in body["skipped"])


# ── 描述鎖定不受同步改寫 ──────────────────────────────────────


def test_sync_cannot_change_description_lock(env):
    e = env
    _sid, token = make_source(e)
    cdb = e["central"].db
    mgr = e["manager"]["id"]
    a = add_task(e["local"], "會被鎖定", T0 - 120 * MIN, description="原描述")
    b = add_task(e["local"], "本機想鎖", T0 - 120 * MIN)
    # 本機自行鎖定的新任務：中央建立時不帶鎖
    c = add_task(e["local"], "本機新建已鎖", T0 - 120 * MIN, description_locked=1, locked_at=T0 - 120 * MIN)
    push(e, token)
    assert task(cdb, c)["description_locked"] == 0 and task(cdb, c)["locked_at"] is None

    # 中央鎖定 a；本機很久之後改了 a 的描述與標題 → 標題更新、描述與鎖定保留中央
    set_task(cdb, a, T0, description="PM 定稿", description_locked=1, locked_by=mgr, locked_at=T0)
    set_task(e["local"], a, T0 + 60 * MIN, title="會被鎖定（改名）", description="本機亂改", description_locked=0)
    # 本機想替 b 加鎖 → 中央不變
    set_task(e["local"], b, T0 + 60 * MIN, description_locked=1, locked_at=T0)
    res = push(e, token)
    ta, tb = task(cdb, a), task(cdb, b)
    assert ta["title"] == "會被鎖定（改名）" and ta["description"] == "PM 定稿"
    assert (ta["description_locked"], ta["locked_by"], ta["locked_at"]) == (1, mgr, T0)
    assert tb["description_locked"] == 0 and tb["locked_at"] is None
    assert res[0]["descriptionLockSkipped"] == 1
    src = e["apis"]["manager"].get("/api/admin/sync/sources").json()["sources"][0]
    assert src["lastPushSummary"]["descriptionLockSkipped"] == 1

    # 只有描述不同（中央已鎖定）→ 視為相同，不產生衝突
    set_task(e["local"], a, T0 + 61 * MIN, description="又改一次")
    r = totals(push(e, token))
    assert r["conflict"] == 0 and task(cdb, a)["description"] == "PM 定稿"


def test_sync_auto_created_user_follows_in_overview(env):
    e = env
    ldb = e["local"]
    with ldb.tx() as conn:
        conn.execute(
            "INSERT INTO users (username, display_name, password_hash, role, created_at, updated_at, in_overview) "
            "VALUES ('quiet', '安靜', 'x', 'user', 1, 1, 0)"
        )
    q = ldb.scalar("SELECT id FROM users WHERE username = 'quiet'")
    add_task(ldb, "給 quiet", T0 - 60 * MIN, assignee_id=q)
    _sid, token = make_source(e, name="自動", autoCreateUsers=True)
    push(e, token)
    assert e["central"].db.scalar("SELECT in_overview FROM users WHERE username = 'quiet'") == 0
