"""任務待辦清單（/api/tasks/:id/checklist、聚合欄位、匯出匯入）。docs/design/task-list.md"""

from __future__ import annotations

from server.app import data_transfer as dt

from .helpers import FakeClock, client, create_test_app, create_test_user, login_as
from .test_data_transfer import Env, apply, export, ok, preview


def setup():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    alice = create_test_user(t.db, display_name="Alice")
    bob = create_test_user(t.db, display_name="Bob")
    a = login_as(t, alice)
    b = login_as(t, bob)
    return t, clock, alice, bob, a, b


def mk_task(api, title="任務") -> int:
    res = api.request("POST", "/api/tasks", {"title": title})
    assert res.status_code == 201
    return res.json()["id"]


def add(api, tid, *texts, status=201):
    res = api.request("POST", f"/api/tasks/{tid}/checklist", {"items": [{"text": x} for x in texts]})
    assert res.status_code == status, res.text
    return res.json()


def test_crud_and_order():
    t, clock, alice, bob, a, b = setup()
    tid = mk_task(a)
    assert a.get(f"/api/tasks/{tid}/checklist").json() == []

    one = a.request("POST", f"/api/tasks/{tid}/checklist", {"text": "  第一項  "})
    assert one.status_code == 201
    first = one.json()[0]
    assert first["text"] == "第一項" and first["isDone"] is False and first["sortOrder"] == 1
    assert first["taskId"] == tid and first["createdBy"] == alice["id"] and "uid" not in first
    assert first["doneAt"] is None and first["doneBy"] is None

    rows = add(b, tid, "第二項", "第三項")
    assert [r["sortOrder"] for r in rows] == [2, 3]
    assert [r["text"] for r in a.get(f"/api/tasks/{tid}/checklist").json()] == ["第一項", "第二項", "第三項"]

    # 單項建立可指定排序值（插入到兩項之間）
    mid = a.request("POST", f"/api/tasks/{tid}/checklist", {"text": "插入", "sortOrder": 1.5}).json()[0]
    assert mid["sortOrder"] == 1.5
    assert [r["text"] for r in a.get(f"/api/tasks/{tid}/checklist").json()] == ["第一項", "插入", "第二項", "第三項"]
    a.request("DELETE", f"/api/tasks/{tid}/checklist/{mid['id']}")

    # 改文字與排序（只送變動欄位）
    clock.advance(1000)
    res = b.request("PATCH", f"/api/tasks/{tid}/checklist/{first['id']}", {"text": "改過", "sortOrder": 2.5})
    assert res.status_code == 200
    got = res.json()
    assert got["text"] == "改過" and got["sortOrder"] == 2.5 and got["updatedBy"] == bob["id"]
    assert got["isDone"] is False
    assert [r["text"] for r in a.get(f"/api/tasks/{tid}/checklist").json()] == ["第二項", "改過", "第三項"]

    # 刪除
    assert a.request("DELETE", f"/api/tasks/{tid}/checklist/{first['id']}").json() == {"ok": True}
    assert len(a.get(f"/api/tasks/{tid}/checklist").json()) == 2
    assert a.request("DELETE", f"/api/tasks/{tid}/checklist/{first['id']}").status_code == 404
    # 項目不屬於該任務
    other = mk_task(a, "另一個")
    nid = a.get(f"/api/tasks/{tid}/checklist").json()[0]["id"]
    assert a.request("PATCH", f"/api/tasks/{other}/checklist/{nid}", {"text": "x"}).status_code == 404


def test_validation_and_limits():
    t, _clock, _alice, _bob, a, _b = setup()
    tid = mk_task(a)
    path = f"/api/tasks/{tid}/checklist"
    assert a.request("POST", path, {}).status_code == 400
    assert a.request("POST", path, {"text": "a", "items": [{"text": "b"}]}).status_code == 400
    assert a.request("POST", path, {"text": "   "}).status_code == 400
    assert a.request("POST", path, {"text": "x" * 501}).status_code == 400
    assert a.request("POST", path, {"text": "x" * 500}).status_code == 201
    assert a.request("POST", path, {"items": []}).status_code == 400
    assert a.request("POST", path, {"items": [{"text": "a"}] * 101}).status_code == 400
    assert a.request("POST", path, {"items": [{"text": "a"}, {"text": ""}]}).status_code == 400
    assert len(a.request("POST", path, {"items": [{"text": f"i{n}"} for n in range(100)]}).json()) == 100
    # 失敗的批次不會留下部分資料
    assert t.db.scalar("SELECT count(*) FROM task_checklist_items WHERE task_id = ?", (tid,)) == 101
    assert a.request("PATCH", f"{path}/1", {"text": ""}).status_code == 400
    assert a.request("PATCH", f"{path}/1", {"isDone": "yes"}).status_code == 400
    assert a.request("PATCH", f"{path}/abc", {"text": "x"}).status_code == 400
    assert a.request("POST", "/api/tasks/9999/checklist", {"text": "x"}).status_code == 404
    assert a.get("/api/tasks/9999/checklist").status_code == 404
    # 每任務總量上限 500
    for _ in range(3):
        a.request("POST", path, {"items": [{"text": f"j{n}"} for n in range(100)]})
    assert a.request("POST", path, {"items": [{"text": f"k{n}"} for n in range(100)]}).status_code == 400
    assert a.request("POST", path, {"items": [{"text": f"m{n}"} for n in range(99)]}).status_code == 201
    assert a.request("POST", path, {"text": "再一項"}).status_code == 400


def test_done_fields_and_batch_is_done():
    t, clock, alice, bob, a, b = setup()
    tid = mk_task(a)
    res = a.request("POST", f"/api/tasks/{tid}/checklist", {"items": [{"text": "已勾", "isDone": True}, {"text": "未勾"}]})
    done, todo = res.json()
    assert done["isDone"] is True and done["doneAt"] == clock.now() and done["doneBy"] == alice["id"]
    assert todo["doneAt"] is None

    clock.advance(5000)
    r = b.request("PATCH", f"/api/tasks/{tid}/checklist/{todo['id']}", {"isDone": True}).json()
    assert r["isDone"] is True and r["doneAt"] == clock.now() and r["doneBy"] == bob["id"]
    # 重複送相同狀態：done_at / done_by 不變
    clock.advance(5000)
    again = a.request("PATCH", f"/api/tasks/{tid}/checklist/{todo['id']}", {"isDone": True}).json()
    assert again["doneAt"] == r["doneAt"] and again["doneBy"] == bob["id"]
    # 取消勾選：清空
    r = a.request("PATCH", f"/api/tasks/{tid}/checklist/{todo['id']}", {"isDone": False}).json()
    assert r["isDone"] is False and r["doneAt"] is None and r["doneBy"] is None


def test_counts_on_task_responses_multi_tasks():
    t, _clock, _alice, _bob, a, _b = setup()
    t1, t2, t3 = mk_task(a, "一"), mk_task(a, "二"), mk_task(a, "三")
    items = add(a, t1, "a", "b", "c")
    add(a, t2, "x")
    a.request("PATCH", f"/api/tasks/{t1}/checklist/{items[0]['id']}", {"isDone": True})
    a.request("PATCH", f"/api/tasks/{t1}/checklist/{items[1]['id']}", {"isDone": True})

    by_id = {x["id"]: x for x in a.get("/api/tasks").json()}
    assert (by_id[t1]["checklistTotal"], by_id[t1]["checklistDone"]) == (3, 2)
    assert (by_id[t2]["checklistTotal"], by_id[t2]["checklistDone"]) == (1, 0)
    assert (by_id[t3]["checklistTotal"], by_id[t3]["checklistDone"]) == (0, 0)
    g = a.get(f"/api/tasks/{t1}").json()
    assert (g["checklistTotal"], g["checklistDone"]) == (3, 2)
    p = a.request("PATCH", f"/api/tasks/{t1}", {"title": "新標題"}).json()
    assert (p["checklistTotal"], p["checklistDone"]) == (3, 2)
    # 篩選查詢也帶聚合
    assert a.get("/api/tasks?q=二").json()[0]["checklistTotal"] == 1
    # 既有欄位不變
    assert {"id", "title", "sortOrder", "custom"} <= set(g)


def test_clear_done():
    t, _clock, _alice, _bob, a, _b = setup()
    tid = mk_task(a)
    items = add(a, tid, "a", "b", "c")
    for i in items[:2]:
        a.request("PATCH", f"/api/tasks/{tid}/checklist/{i['id']}", {"isDone": True})
    res = a.request("POST", f"/api/tasks/{tid}/checklist/clear-done")
    assert res.status_code == 200 and res.json() == {"removed": 2}
    assert [r["text"] for r in a.get(f"/api/tasks/{tid}/checklist").json()] == ["c"]
    before = t.db.scalar("SELECT count(*) FROM changes")
    assert a.request("POST", f"/api/tasks/{tid}/checklist/clear-done").json() == {"removed": 0}
    assert t.db.scalar("SELECT count(*) FROM changes") == before  # 沒有變動就不產生流水


def test_permissions():
    t, _clock, _alice, _bob, a, _b = setup()
    tid = mk_task(a)
    items = add(a, tid, "a")
    anon = client(t)
    assert anon.get(f"/api/tasks/{tid}/checklist").status_code == 401
    assert anon.request("POST", f"/api/tasks/{tid}/checklist", {"text": "x"}).status_code == 401

    root = create_test_user(t.db, role="root")
    r = login_as(t, root)
    assert r.request("PUT", "/api/admin/permissions", {"changes": [{"role": "user", "capability": "tasks.edit", "allowed": False}]}).status_code == 200
    # 讀取仍可，寫入 403
    assert a.get(f"/api/tasks/{tid}/checklist").status_code == 200
    path = f"/api/tasks/{tid}/checklist"
    assert a.request("POST", path, {"text": "x"}).status_code == 403
    assert a.request("PATCH", f"{path}/{items[0]['id']}", {"isDone": True}).status_code == 403
    assert a.request("DELETE", f"{path}/{items[0]['id']}").status_code == 403
    assert a.request("POST", f"{path}/clear-done").status_code == 403
    assert r.request("POST", path, {"text": "root 可"}).status_code == 201


def test_record_change_and_task_touch():
    t, clock, alice, bob, a, b = setup()
    tid = mk_task(a)

    def n() -> int:
        return t.db.scalar("SELECT count(*) FROM changes WHERE entity_type='task' AND entity_id=? AND action='update'", (tid,))

    base = n()
    clock.advance(10_000)
    items = add(b, tid, "a")
    assert n() == base + 1
    row = t.db.one("SELECT updated_at, updated_by FROM tasks WHERE id = ?", (tid,))
    assert row["updated_at"] == clock.now() and row["updated_by"] == bob["id"]
    a.request("PATCH", f"/api/tasks/{tid}/checklist/{items[0]['id']}", {"isDone": True})
    a.request("PATCH", f"/api/tasks/{tid}/checklist/{items[0]['id']}", {})  # 無變動
    assert n() == base + 2
    a.request("DELETE", f"/api/tasks/{tid}/checklist/{items[0]['id']}")
    assert n() == base + 3
    # 事件流水不使用清單項目 id 當 entity
    assert t.db.scalar("SELECT count(*) FROM changes WHERE entity_type NOT IN ('task','user','permission')") == 0


def test_soft_delete_keeps_items_and_hard_delete_cascades():
    t, _clock, _alice, _bob, a, _b = setup()
    tid = mk_task(a)
    add(a, tid, "a", "b")
    a.request("DELETE", f"/api/tasks/{tid}")
    assert t.db.scalar("SELECT count(*) FROM task_checklist_items WHERE task_id = ?", (tid,)) == 2
    assert a.get(f"/api/tasks/{tid}/checklist").status_code == 404
    assert a.request("POST", f"/api/tasks/{tid}/checklist", {"text": "x"}).status_code == 404
    # 實際刪除（例如匯入取代模式）：連動刪除
    with t.db.tx() as conn:
        conn.execute("DELETE FROM tasks WHERE id = ?", (tid,))
    assert t.db.scalar("SELECT count(*) FROM task_checklist_items") == 0


# ── 匯出匯入 ──


def test_export_import_roundtrip_and_idempotent(tmp_path):
    a = Env(tmp_path, name="a")
    task = ok(a.api.request("POST", "/api/tasks", {"title": "清單任務"}), 201)
    ok(
        a.api.request(
            "POST",
            f"/api/tasks/{task['id']}/checklist",
            {"items": [{"text": "一", "isDone": True}, {"text": "二"}, {"text": "三"}]},
        ),
        201,
    )
    doc = export(a)
    assert len(doc["taskChecklistItems"]) == 3
    first = doc["taskChecklistItems"][0]
    assert first["taskUid"] == doc["tasks"][0]["uid"] and first["isDone"] is True and first["doneByUsername"] == "admin-a"

    b = Env(tmp_path, seed=False, name="b")
    pv = preview(b, doc)
    cat = next(c for c in pv["categories"] if c["key"] == "taskChecklistItems")
    assert cat["new"] == 3 and cat["label"] == "待辦清單"
    apply(b, pv["token"], missingUsers="create")
    again = export(b)
    assert again["taskChecklistItems"] == doc["taskChecklistItems"]
    # 匯入產生的流水記在任務上（不使用項目 id）
    assert b.db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'task' AND action = 'update'") >= 3

    # 冪等：再匯入一次全部相同
    pv2 = preview(b, doc)
    cat2 = next(c for c in pv2["categories"] if c["key"] == "taskChecklistItems")
    assert cat2["new"] == 0 and cat2["conflict"] == 0 and cat2["same"] == 3
    apply(b, pv2["token"])
    assert b.db.scalar("SELECT count(*) FROM task_checklist_items") == 3

    # 修改匯入檔：較新者為準
    doc2 = {**doc, "taskChecklistItems": [dict(x) for x in doc["taskChecklistItems"]]}
    doc2["taskChecklistItems"][1]["text"] = "二（改）"
    doc2["taskChecklistItems"][1]["updatedAt"] += 60_000
    pv3 = preview(b, doc2)
    assert [c["category"] for c in pv3["conflicts"]] == ["taskChecklistItems"]
    apply(b, pv3["token"])
    assert b.db.scalar("SELECT text FROM task_checklist_items WHERE uid = ?", (doc2["taskChecklistItems"][1]["uid"],)) == "二（改）"
    assert dt.SPEC_BY_KEY["taskChecklistItems"].entity == "task"
