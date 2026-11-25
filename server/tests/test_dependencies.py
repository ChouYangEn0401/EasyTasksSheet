"""任務依賴（阻擋關係）與延遲鏈：純函式推算、API、權限、變更流水、匯出匯入。"""

from __future__ import annotations

from server.app import data_transfer as dt
from server.app import permissions
from server.app.dependency_calc import (
    Edge,
    TaskInfo,
    components,
    compute_projections,
    critical_path,
    find_cycle,
    layer_depths,
    today_taipei,
)

from .helpers import FakeClock, TestApp, client, create_test_db, create_test_user, login_as

TODAY = "2026-01-05"


def T(i, start=None, due=None, done=False, deleted=False):
    return TaskInfo(i, start, due, done, deleted)


def proj(tasks, edges, today=TODAY):
    return compute_projections({t.id: t for t in tasks}, edges, today)


# ── 純函式：循環偵測 ───────────────────────────────────────


def test_find_cycle_direct_indirect_self():
    assert find_cycle([(1, 2)], 2, 1) == [2, 1, 2]
    chain = [(i, i + 1) for i in range(1, 12)]  # 1→2→…→12
    cyc = find_cycle(chain, 12, 1)
    assert cyc == [12, *range(1, 13)]
    assert find_cycle(chain, 1, 12) is None  # 捷徑不會成環
    assert find_cycle([], 3, 3) == [3, 3]
    assert find_cycle([(1, 2), (2, 3)], 3, 4) is None


# ── 純函式：延遲推算 ───────────────────────────────────────


def test_single_chain_propagates():
    # A 到期 01-10；B 01-08~01-09（1 天）；C 只有到期 01-12
    p = proj([T(1, due="2026-01-10"), T(2, "2026-01-08", "2026-01-09"), T(3, due="2026-01-12")], [Edge(1, 2), Edge(2, 3)])
    assert p[1].is_blocked is False and p[1].projected_end == "2026-01-10" and p[1].delay_days == 0
    assert p[1].blocks_count == 1
    assert p[2].is_blocked and p[2].projected_start == "2026-01-11" and p[2].projected_end == "2026-01-12"
    assert p[2].delay_days == 3
    assert p[3].projected_start == "2026-01-13" and p[3].projected_end == "2026-01-13" and p[3].delay_days == 1
    assert p[3].blocked_by_count == 1 and p[3].driver == 2


def test_multiple_blockers_take_max_and_lag():
    tasks = [T(1, due="2026-01-07"), T(2, due="2026-01-09"), T(3, "2026-01-06", "2026-01-08")]
    p = proj(tasks, [Edge(1, 3), Edge(2, 3)])
    assert p[3].blocked_by_count == 2 and p[3].driver == 2
    assert p[3].projected_start == "2026-01-10" and p[3].projected_end == "2026-01-12" and p[3].delay_days == 4
    # lag 2：前置 01-07 完成後再等 2 天 → 最早 01-10 開始（比 01-09+1 = 01-10 相同，取較小 id 為 driver）
    p = proj(tasks, [Edge(1, 3, lag=2), Edge(2, 3)])
    assert p[3].projected_start == "2026-01-10"
    p = proj(tasks, [Edge(1, 3, lag=5), Edge(2, 3)])
    assert p[3].projected_start == "2026-01-13" and p[3].driver == 1 and p[3].delay_days == 7


def test_done_and_deleted_blockers_do_not_block():
    p = proj([T(1, due="2026-01-30", done=True), T(2, due="2026-01-06")], [Edge(1, 2)])
    assert p[2].is_blocked is False and p[2].delay_days == 0 and p[1].blocks_count == 0
    p = proj([T(1, due="2026-01-30", deleted=True), T(2, due="2026-01-06")], [Edge(1, 2)])
    assert p[2].is_blocked is False and p[2].projected_end == "2026-01-06"
    # 被擋的任務自己已完成 → 不算被擋
    p = proj([T(1, due="2026-01-30"), T(2, due="2026-01-06", done=True)], [Edge(1, 2)])
    assert p[2].is_blocked is False and p[1].blocks_count == 0


def test_overdue_blocker_counts_from_today():
    p = proj([T(1, due="2026-01-01"), T(2, due="2026-01-03")], [Edge(1, 2)])
    assert p[1].projected_end == TODAY and p[1].delay_days == 4
    assert p[2].projected_end == "2026-01-06" and p[2].delay_days == 3


def test_blocker_without_dates_is_unknown_and_propagates():
    p = proj([T(1), T(2, due="2026-01-08"), T(3, due="2026-01-20")], [Edge(1, 2), Edge(2, 3)])
    assert p[2].is_blocked and p[2].unknown_blocker_date and p[2].delay_days is None and p[2].projected_end is None
    assert p[3].unknown_blocker_date and p[3].delay_days is None


def test_blocked_without_start_or_any_date():
    # 只有開始日的前置任務：以開始日當作單日任務
    p = proj([T(1, start="2026-01-09"), T(2)], [Edge(1, 2)])
    assert p[1].projected_end == "2026-01-09"
    assert p[2].projected_start == "2026-01-10" and p[2].projected_end == "2026-01-10" and p[2].delay_days is None
    # 自己的開始日比前置更晚 → 不受影響
    p = proj([T(1, due="2026-01-06"), T(2, "2026-01-20", "2026-01-22")], [Edge(1, 2)])
    assert p[2].projected_start == "2026-01-20" and p[2].delay_days == 0


def test_components_depth_critical_path():
    edges = [Edge(1, 2), Edge(1, 3), Edge(3, 4), Edge(2, 4), Edge(10, 11)]
    assert components(edges) == [[1, 2, 3, 4], [10, 11]]
    depth = layer_depths([1, 2, 3, 4], edges[:4])
    assert depth == {1: 0, 2: 1, 3: 1, 4: 2}
    tasks = [T(1, due="2026-01-06"), T(2, due="2026-01-20"), T(3, due="2026-01-07"), T(4, due="2026-01-08")]
    p = proj(tasks, edges[:4])
    assert critical_path([1, 2, 3, 4], p, depth) == [1, 2, 4]


def test_today_taipei():
    assert today_taipei(FakeClock().now()) == TODAY
    # UTC 2026-01-05 16:30 = 台北 01-06 00:30
    assert today_taipei(1767630600000) == "2026-01-06"


# ── API ───────────────────────────────────────────────────


def setup():
    clock = FakeClock()
    t = TestApp(now=clock.now)
    alice = create_test_user(t.db, display_name="Alice")
    a = login_as(t, alice)
    return t, clock, alice, a


def mk(a, title, **kw):
    res = a.request("POST", "/api/tasks", {"title": title, **kw})
    assert res.status_code == 201, res.text
    return res.json()


def link(a, blocked, blocker, **kw):
    return a.request(
        "POST", f"/api/tasks/{blocked['id']}/dependencies", {"direction": "blocked_by", "targetId": blocker["id"], **kw}
    )


def done_status(t) -> int:
    return t.db.scalar("SELECT id FROM statuses WHERE category = 'done'")


def test_create_list_idempotent_and_errors():
    t, _clock, _alice, a = setup()
    A = mk(a, "設計", dueDate="2026-01-10")
    B = mk(a, "實作", startDate="2026-01-08", dueDate="2026-01-09")
    res = link(a, B, A)
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["direction"] == "blocked_by" and body["task"]["title"] == "設計"
    assert body["self"]["isBlocked"] is True and body["self"]["delayDays"] == 3
    # 冪等：同一對再送一次回 200、不新增
    again = link(a, B, A)
    assert again.status_code == 200 and again.json()["id"] == body["id"]
    # 反方向（blocks）同一對也是同一筆
    same = a.request("POST", f"/api/tasks/{A['id']}/dependencies", {"direction": "blocks", "targetId": B["id"]})
    assert same.status_code == 200 and same.json()["direction"] == "blocks"
    assert t.db.scalar("SELECT count(*) FROM task_dependencies") == 1
    # 自己 400、不存在 404、格式錯 400
    assert link(a, A, A).status_code == 400
    assert a.request("POST", f"/api/tasks/{A['id']}/dependencies", {"direction": "blocked_by", "targetId": 999}).status_code == 404
    assert a.request("POST", "/api/tasks/999/dependencies", {"direction": "blocked_by", "targetId": A["id"]}).status_code == 404
    assert a.request("POST", f"/api/tasks/{A['id']}/dependencies", {"direction": "x", "targetId": B["id"]}).status_code == 400
    assert link(a, A, B, lagDays=-1).status_code == 400

    deps = a.get(f"/api/tasks/{B['id']}/dependencies").json()
    assert [d["task"]["id"] for d in deps["blockedBy"]] == [A["id"]] and deps["blocks"] == []
    assert deps["blockedBy"][0]["projection"]["projectedEnd"] == "2026-01-10"
    assert deps["self"]["projectedEnd"] == "2026-01-12"
    deps_a = a.get(f"/api/tasks/{A['id']}/dependencies").json()
    assert [d["task"]["id"] for d in deps_a["blocks"]] == [B["id"]]
    assert deps_a["blocks"][0]["projection"]["delayDays"] == 3


def test_cycle_rejected_with_titles():
    _t, _clock, _alice, a = setup()
    A, B, C = mk(a, "A 任務"), mk(a, "B 任務"), mk(a, "C 任務")
    assert link(a, B, A).status_code == 201  # A → B
    assert link(a, C, B).status_code == 201  # B → C
    res = link(a, A, C)  # C → A 會成環
    assert res.status_code == 409
    err = res.json()["error"]
    assert err["code"] == "DEPENDENCY_CYCLE"
    assert err["message"] == "無法建立：「C 任務」 → 「A 任務」 → 「B 任務」 → 「C 任務」 會形成循環"
    assert [c["id"] for c in err["details"]["cycle"]] == [C["id"], A["id"], B["id"], C["id"]]
    # 直接反向
    assert link(a, A, B).status_code == 409
    # 長鏈間接環
    tasks = [mk(a, f"L{i}") for i in range(8)]
    for x, y in zip(tasks, tasks[1:]):
        assert link(a, y, x).status_code == 201
    assert link(a, tasks[0], tasks[-1]).status_code == 409


def test_list_fields_aggregated_and_done_unblocks():
    t, _clock, _alice, a = setup()
    A = mk(a, "前置", dueDate="2026-01-10")
    B = mk(a, "後續", dueDate="2026-01-09")
    C = mk(a, "無關")
    link(a, B, A)
    rows = {r["id"]: r for r in a.get("/api/tasks").json()}
    assert rows[B["id"]]["isBlocked"] is True and rows[B["id"]]["blockedByCount"] == 1
    assert rows[B["id"]]["delayDays"] == 2 and rows[B["id"]]["projectedEnd"] == "2026-01-11"
    assert rows[A["id"]]["blocksCount"] == 1 and rows[A["id"]]["isBlocked"] is False
    assert rows[C["id"]]["isBlocked"] is False and rows[C["id"]]["delayDays"] is None
    assert rows[C["id"]]["blocksCount"] == 0 and rows[C["id"]]["projectedEnd"] is None
    # 既有欄位仍在
    assert {"title", "statusId", "custom", "sortOrder"} <= set(rows[C["id"]])
    # 前置完成 → 不再擋人（紀錄保留）
    a.request("PATCH", f"/api/tasks/{A['id']}", {"statusId": done_status(t)})
    rows = {r["id"]: r for r in a.get("/api/tasks").json()}
    assert rows[B["id"]]["isBlocked"] is False and rows[A["id"]]["blocksCount"] == 0
    assert t.db.scalar("SELECT count(*) FROM task_dependencies") == 1
    # 軟刪除的前置任務也不擋人，且不出現在詳情
    D = mk(a, "會被刪掉", dueDate="2026-02-01")
    link(a, B, D)
    assert {r["id"]: r for r in a.get("/api/tasks").json()}[B["id"]]["isBlocked"] is True
    a.request("DELETE", f"/api/tasks/{D['id']}")
    assert {r["id"]: r for r in a.get("/api/tasks").json()}[B["id"]]["isBlocked"] is False
    deps = a.get(f"/api/tasks/{B['id']}/dependencies").json()
    assert [d["task"]["id"] for d in deps["blockedBy"]] == [A["id"]]
    assert deps["blockedBy"][0]["task"]["isDone"] is True


def test_cross_project_allowed():
    _t, _clock, _alice, a = setup()
    p2 = a.request("POST", "/api/projects", {"name": "另一個專案"}).json()
    A = mk(a, "專案一的任務", dueDate="2026-01-10")
    B = mk(a, "專案二的任務", projectId=p2["id"], dueDate="2026-01-10")
    assert link(a, B, A).status_code == 201
    chains = a.get(f"/api/tasks/delay-chains?project={p2['id']}").json()["chains"]
    assert len(chains) == 1 and {n["id"] for n in chains[0]["nodes"]} == {A["id"], B["id"]}


def test_patch_and_delete_with_changes_on_both_ends():
    t, clock, alice, a = setup()
    A = mk(a, "A", dueDate="2026-01-10")
    B = mk(a, "B", dueDate="2026-01-12")
    clock.advance(60_000)
    before = t.db.scalar("SELECT max(id) FROM changes")
    dep = link(a, B, A).json()
    changes = t.db.all("SELECT entity_type, entity_id, action, actor_id FROM changes WHERE id > ?", (before,))
    assert sorted((c["entity_type"], c["entity_id"], c["action"]) for c in changes) == sorted(
        [("task", A["id"], "update"), ("task", B["id"], "update")]
    )
    assert all(c["actor_id"] == alice["id"] for c in changes)
    for x in (A, B):
        assert t.db.scalar("SELECT updated_at FROM tasks WHERE id = ?", (x["id"],)) == clock.now()

    res = a.request("PATCH", f"/api/tasks/{B['id']}/dependencies/{dep['id']}", {"lagDays": 4, "note": "等審查"})
    assert res.status_code == 200 and res.json()["lagDays"] == 4 and res.json()["note"] == "等審查"
    assert res.json()["self"]["projectedEnd"] == "2026-01-15" and res.json()["self"]["delayDays"] == 3
    # 從另一端也能操作；不屬於此任務的依賴 404
    C = mk(a, "C")
    assert a.request("PATCH", f"/api/tasks/{C['id']}/dependencies/{dep['id']}", {"lagDays": 1}).status_code == 404
    before = t.db.scalar("SELECT max(id) FROM changes")
    res = a.request("DELETE", f"/api/tasks/{A['id']}/dependencies/{dep['id']}")
    assert res.status_code == 200
    assert res.json()["removed"] == {"direction": "blocks", "targetId": B["id"], "lagDays": 4, "note": "等審查"}
    assert t.db.scalar("SELECT count(*) FROM changes WHERE id > ? AND entity_type = 'task'", (before,)) == 2
    assert a.request("DELETE", f"/api/tasks/{A['id']}/dependencies/{dep['id']}").status_code == 404


def test_delay_chains_structure_filter_sort():
    t, _clock, alice, a = setup()
    bob = create_test_user(t.db, display_name="Bob")
    # 鏈 1：A → B → C（有延後）；鏈 2：X → Y（準時）；Z 無依賴
    A = mk(a, "A", dueDate="2026-01-10")
    B = mk(a, "B", startDate="2026-01-08", dueDate="2026-01-09", assigneeId=bob["id"])
    C = mk(a, "C", dueDate="2026-01-12")
    X = mk(a, "X", dueDate="2026-01-06")
    Y = mk(a, "Y", dueDate="2026-01-30")
    Y2 = mk(a, "Y2", dueDate="2026-01-30")
    Y3 = mk(a, "Y3", dueDate="2026-01-30")
    mk(a, "Z")
    link(a, B, A)
    link(a, C, B)
    for y in (Y, Y2, Y3):
        link(a, y, X)
    res = a.get("/api/tasks/delay-chains")
    assert res.status_code == 200
    body = res.json()
    assert body["today"] == TODAY
    chains = body["chains"]
    # 最長延遲由大到小（鏈 1 雖然節點較少仍排前面）
    assert [c["summary"]["nodeCount"] for c in chains] == [3, 4]
    c1 = chains[0]
    s = c1["summary"]
    assert s["maxDelayDays"] == 3 and s["finalProjectedEnd"] == "2026-01-13"
    assert s["criticalPath"] == [A["id"], B["id"], C["id"]] and s["startNodes"] == [A["id"]]
    nodes = {n["id"]: n for n in c1["nodes"]}
    assert [nodes[i]["depth"] for i in (A["id"], B["id"], C["id"])] == [0, 1, 2]
    assert nodes[C["id"]]["blockerIds"] == [B["id"]] and nodes[C["id"]]["criticalDelay"] is True
    assert nodes[B["id"]]["assigneeId"] == bob["id"] and nodes[B["id"]]["isDone"] is False
    assert {(e["from"], e["to"]) for e in c1["edges"]} == {(A["id"], B["id"]), (B["id"], C["id"])}
    assert all(e["critical"] and e["active"] for e in c1["edges"])
    # 篩選：Bob 只負責 B，但整條鏈都回來
    f = a.get(f"/api/tasks/delay-chains?assignee={bob['id']}").json()["chains"]
    assert len(f) == 1 and len(f[0]["nodes"]) == 3
    assert a.get("/api/tasks/delay-chains?q=Y2").json()["chains"][0]["summary"]["nodeCount"] == 4
    assert a.get("/api/tasks/delay-chains?assignee=none,999").json()["chains"] != []
    assert a.get("/api/tasks/delay-chains?project=999").json()["chains"] == []
    assert a.get("/api/tasks/delay-chains?project=abc").status_code == 400
    # 已完成的前置任務：預設不顯示，includeDone 才顯示（淡色由前端處理）
    a.request("PATCH", f"/api/tasks/{A['id']}", {"statusId": done_status(t)})
    c1 = a.get("/api/tasks/delay-chains").json()["chains"]
    chain_bc = next(c for c in c1 if B["id"] in {n["id"] for n in c["nodes"]})
    assert {n["id"] for n in chain_bc["nodes"]} == {B["id"], C["id"]}
    assert chain_bc["summary"]["startNodes"] == [B["id"]]
    with_done = a.get("/api/tasks/delay-chains?includeDone=true").json()["chains"]
    chain_abc = next(c for c in with_done if B["id"] in {n["id"] for n in c["nodes"]})
    na = next(n for n in chain_abc["nodes"] if n["id"] == A["id"])
    assert na["isDone"] is True and na["depth"] == 0
    assert next(e for e in chain_abc["edges"] if e["from"] == A["id"])["active"] is False
    assert chain_abc["summary"]["doneCount"] == 1


def test_permissions_read_write():
    t, _clock, _alice, a = setup()
    A, B = mk(a, "A"), mk(a, "B")
    anon = client(t)
    assert anon.get("/api/tasks/delay-chains").status_code == 401
    assert anon.get(f"/api/tasks/{A['id']}/dependencies").status_code == 401
    assert anon.request("POST", f"/api/tasks/{A['id']}/dependencies", {"direction": "blocks", "targetId": B["id"]}).status_code == 401
    # 收回成員的 tasks.edit → 寫入 403、讀取仍可
    t.db.execute("INSERT INTO role_permissions (role, capability, allowed, updated_at) VALUES ('user', 'tasks.edit', 0, 1)")
    permissions.invalidate(t.db)
    try:
        assert link(a, B, A).status_code == 403
        assert a.get(f"/api/tasks/{A['id']}/dependencies").status_code == 200
        assert a.get("/api/tasks/delay-chains").status_code == 200
    finally:
        t.db.execute("DELETE FROM role_permissions")
        permissions.invalidate(t.db)
    assert link(a, B, A).status_code == 201


def test_cascade_on_hard_delete_and_constraints():
    t, _clock, _alice, a = setup()
    A, B = mk(a, "A"), mk(a, "B")
    link(a, B, A)
    uid = t.db.scalar("SELECT uid FROM task_dependencies")
    assert uid and len(uid) == 32
    import sqlite3

    import pytest

    with pytest.raises(sqlite3.IntegrityError):
        t.db.execute(
            "INSERT INTO task_dependencies (blocker_task_id, blocked_task_id, created_at, updated_at) VALUES (?, ?, 1, 1)",
            (A["id"], A["id"]),
        )
    with pytest.raises(sqlite3.IntegrityError):
        t.db.execute(
            "INSERT INTO task_dependencies (blocker_task_id, blocked_task_id, created_at, updated_at) VALUES (?, ?, 1, 1)",
            (A["id"], B["id"]),
        )
    t.db.execute("DELETE FROM tasks WHERE id = ?", (A["id"],))
    assert t.db.scalar("SELECT count(*) FROM task_dependencies") == 0


# ── 匯出匯入 ───────────────────────────────────────────────


def _admin_env(tmp_path, name, seed=True):
    clock = FakeClock()
    t = TestApp(now=clock.now, db=create_test_db(seed=seed))
    t.app.state.backup_dir = str(tmp_path / f"backups-{name}")
    admin = create_test_user(t.db, username=f"root-{name}", role="root")
    return t, login_as(t, admin)


def test_export_import_roundtrip_and_cycle_skip(tmp_path):
    ta, a = _admin_env(tmp_path, "a")
    A = mk(a, "A", dueDate="2026-01-10")
    B = mk(a, "B")
    C = mk(a, "C")
    link(a, B, A, lagDays=2, note="等設計")
    link(a, C, B)
    doc = a.get("/api/admin/data/export").json()
    assert len(doc[dt.DEP_KEY]) == 2
    first = doc[dt.DEP_KEY][0]
    assert first["lagDays"] == 2 and first["note"] == "等設計" and first["type"] == "finish_to_start"
    task_uid = {r["id"]: r["uid"] for r in ta.db.all("SELECT id, uid FROM tasks")}
    assert first["blockerTaskUid"] == task_uid[A["id"]] and first["blockedTaskUid"] == task_uid[B["id"]]

    tb, b = _admin_env(tmp_path, "b", seed=False)
    pv = b.request("POST", "/api/admin/data/import/preview", doc).json()
    cat = next(c for c in pv["categories"] if c["key"] == dt.DEP_KEY)
    assert cat["new"] == 2 and cat["total"] == 2
    res = b.request("POST", "/api/admin/data/import/apply", {"token": pv["token"], "missingUsers": "create"})
    assert res.status_code == 200, res.text
    stats = next(c for c in res.json()["categories"] if c["key"] == dt.DEP_KEY)
    assert stats["created"] == 2
    again = b.get("/api/admin/data/export").json()
    assert again[dt.DEP_KEY] == doc[dt.DEP_KEY]
    # 再匯入一次：冪等
    pv2 = b.request("POST", "/api/admin/data/import/preview", doc).json()
    assert next(c for c in pv2["categories"] if c["key"] == dt.DEP_KEY)["same"] == 2
    res2 = b.request("POST", "/api/admin/data/import/apply", {"token": pv2["token"]}).json()
    assert next(c for c in res2["categories"] if c["key"] == dt.DEP_KEY)["unchanged"] == 2
    assert tb.db.scalar("SELECT count(*) FROM task_dependencies") == 2

    # 匯入檔中 C → A（新 uid）會在 B 端成環 → 略過並記錄
    bad = dict(doc)
    bad[dt.DEP_KEY] = doc[dt.DEP_KEY] + [
        {
            "uid": "cyclecyclecycle1",
            "blockerTaskUid": task_uid[C["id"]],
            "blockedTaskUid": task_uid[A["id"]],
        }
    ]
    pv3 = b.request("POST", "/api/admin/data/import/preview", bad).json()
    res3 = b.request("POST", "/api/admin/data/import/apply", {"token": pv3["token"]}).json()
    assert next(c for c in res3["categories"] if c["key"] == dt.DEP_KEY)["skipped"] == 1
    assert any("循環" in m for m in res3["dependencyIssues"])
    assert tb.db.scalar("SELECT count(*) FROM task_dependencies") == 2

    # 取代模式：既有依賴先刪除（隨任務 cascade）再匯入
    pv4 = b.request("POST", "/api/admin/data/import/preview", doc).json()
    res4 = b.request(
        "POST",
        "/api/admin/data/import/apply",
        {"token": pv4["token"], "mode": "replace", "confirm": dt.REPLACE_CONFIRM, "missingUsers": "create"},
    ).json()
    stats4 = next(c for c in res4["categories"] if c["key"] == dt.DEP_KEY)
    assert stats4["deleted"] == 2 and stats4["created"] == 2


def test_old_export_without_dependencies_still_imports(tmp_path):
    _ta, a = _admin_env(tmp_path, "a")
    doc = a.get("/api/admin/data/export").json()
    doc.pop(dt.DEP_KEY)
    _tb, b = _admin_env(tmp_path, "b")
    pv = b.request("POST", "/api/admin/data/import/preview", doc)
    assert pv.status_code == 200, pv.text
    bad = {**doc, dt.DEP_KEY: [{"uid": "x"}]}
    assert b.request("POST", "/api/admin/data/import/preview", bad).status_code == 400
