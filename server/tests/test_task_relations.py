"""任務關聯（related）與複製任務（server/app/features/task_relations.py）"""

from __future__ import annotations

from server.app import data_transfer as dt

from .helpers import MIN, FakeClock, TestApp, client, create_test_app, create_test_db, create_test_user, login_as


def setup():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    alice = create_test_user(t.db, display_name="Alice")
    a = login_as(t, alice)
    return t, clock, alice, a


def mk(a, title: str, **extra) -> dict:
    res = a.request("POST", "/api/tasks", {"title": title, **extra})
    assert res.status_code == 201, res.text
    return res.json()


def relate(a, x: int, y: int):
    return a.request("POST", f"/api/tasks/{x}/relations", {"targetId": y, "type": "related"})


def counts(a, **params) -> dict[int, int]:
    q = "&".join(f"{k}={v}" for k, v in params.items())
    return {t["id"]: t["relationCount"] for t in a.get(f"/api/tasks?{q}").json()}


# ── 關聯 ──


def test_create_relation_normalized_and_idempotent():
    t, clock, alice, a = setup()
    t1, t2 = mk(a, "甲"), mk(a, "乙")
    clock.advance(MIN)
    # 由較大 id 那端建立 → DB 仍以較小 id 在前
    res = relate(a, t2["id"], t1["id"])
    assert res.status_code == 201, res.text
    rel = res.json()
    assert rel["type"] == "related" and rel["createdBy"] == alice["id"] and rel["createdAt"] == clock.now()
    assert rel["task"] == {
        "id": t1["id"],
        "title": "甲",
        "statusId": t1["statusId"],
        "assigneeId": None,
        "projectId": t1["projectId"],
        "dueDate": None,
        "deleted": False,
    }
    row = t.db.one("SELECT * FROM task_relations")
    assert (row["task_a_id"], row["task_b_id"]) == (t1["id"], t2["id"])
    assert len(row["uid"]) == 32
    # 重複建立（任一方向）冪等：200 回傳既有
    again = relate(a, t1["id"], t2["id"])
    assert again.status_code == 200
    assert again.json()["id"] == rel["id"] and again.json()["task"]["id"] == t2["id"]
    assert t.db.scalar("SELECT count(*) FROM task_relations") == 1
    # 兩端都看得到（對稱）
    assert [r["task"]["id"] for r in a.get(f"/api/tasks/{t1['id']}/relations").json()] == [t2["id"]]
    assert [r["task"]["id"] for r in a.get(f"/api/tasks/{t2['id']}/relations").json()] == [t1["id"]]


def test_relation_errors():
    t, _clock, _alice, a = setup()
    t1 = mk(a, "甲")
    assert relate(a, t1["id"], t1["id"]).status_code == 400
    assert relate(a, t1["id"], 9999).status_code == 404
    assert relate(a, 9999, t1["id"]).status_code == 404
    assert a.request("POST", f"/api/tasks/{t1['id']}/relations", {"targetId": "x"}).status_code == 400
    assert a.request("POST", f"/api/tasks/{t1['id']}/relations", {"targetId": 2, "type": "blocks"}).status_code == 400
    assert a.get("/api/tasks/9999/relations").status_code == 404
    gone = mk(a, "刪掉")
    a.request("DELETE", f"/api/tasks/{gone['id']}")
    assert relate(a, t1["id"], gone["id"]).status_code == 404
    assert t.db.scalar("SELECT count(*) FROM task_relations") == 0


def test_delete_relation():
    t, _clock, _alice, a = setup()
    t1, t2, t3 = mk(a, "甲"), mk(a, "乙"), mk(a, "丙")
    rel = relate(a, t1["id"], t2["id"]).json()
    # 關聯不屬於該任務 → 404
    assert a.request("DELETE", f"/api/tasks/{t3['id']}/relations/{rel['id']}").status_code == 404
    # 從另一端刪除也可以
    assert a.request("DELETE", f"/api/tasks/{t2['id']}/relations/{rel['id']}").json() == {"ok": True}
    assert a.get(f"/api/tasks/{t1['id']}/relations").json() == []
    assert a.request("DELETE", f"/api/tasks/{t1['id']}/relations/{rel['id']}").status_code == 404
    # 刪除後可再建立
    assert relate(a, t1["id"], t2["id"]).status_code == 201


def test_soft_deleted_task_relation_shown_as_deleted_and_not_counted():
    t, _clock, _alice, a = setup()
    t1, t2, t3 = mk(a, "甲"), mk(a, "乙"), mk(a, "丙")
    relate(a, t1["id"], t2["id"])
    relate(a, t1["id"], t3["id"])
    a.request("DELETE", f"/api/tasks/{t3['id']}")
    rels = a.get(f"/api/tasks/{t1['id']}/relations").json()
    assert [(r["task"]["id"], r["task"]["deleted"]) for r in rels] == [(t2["id"], False), (t3["id"], True)]
    # 關聯保留，但計數不含已刪除的對方任務
    assert t.db.scalar("SELECT count(*) FROM task_relations") == 2
    assert counts(a)[t1["id"]] == 1
    # 已刪除任務本身的關聯清單 → 404
    assert a.get(f"/api/tasks/{t3['id']}/relations").status_code == 404


def test_relation_count_aggregated():
    _t, _clock, _alice, a = setup()
    ts = [mk(a, f"任務{i}") for i in range(5)]
    ids = [x["id"] for x in ts]
    relate(a, ids[0], ids[1])
    relate(a, ids[0], ids[2])
    relate(a, ids[3], ids[0])
    relate(a, ids[1], ids[2])
    c = counts(a)
    assert [c[i] for i in ids] == [3, 2, 2, 1, 0]
    # 既有欄位不受影響；篩選時計數仍以全部關聯計算
    one = a.get(f"/api/tasks?q=任務4").json()[0]
    assert one["title"] == "任務4" and one["relationCount"] == 0 and "custom" in one
    assert counts(a, q="任務0") == {ids[0]: 3}


def test_relation_changes_touch_both_ends():
    t, clock, alice, a = setup()
    t1, t2 = mk(a, "甲"), mk(a, "乙")
    bob = create_test_user(t.db, display_name="Bob")
    b = login_as(t, bob)
    clock.advance(MIN)
    before = t.db.scalar("SELECT max(id) FROM changes")
    rel = relate(b, t1["id"], t2["id"]).json()
    rows = t.db.all("SELECT entity_type, entity_id, action, actor_id FROM changes WHERE id > ?", (before,))
    assert sorted((r["entity_id"], r["action"], r["actor_id"]) for r in rows) == [
        (t1["id"], "update", bob["id"]),
        (t2["id"], "update", bob["id"]),
    ]
    assert {r["entity_type"] for r in rows} == {"task"}
    for x in (t1, t2):
        got = a.get(f"/api/tasks/{x['id']}").json()
        assert got["updatedAt"] == clock.now() and got["updatedBy"] == bob["id"]
    # 冪等重送不再產生變更
    mid = t.db.scalar("SELECT max(id) FROM changes")
    relate(b, t1["id"], t2["id"])
    assert t.db.scalar("SELECT max(id) FROM changes") == mid
    # 刪除也記兩端
    a.request("DELETE", f"/api/tasks/{t1['id']}/relations/{rel['id']}")
    rows = t.db.all("SELECT entity_id, action FROM changes WHERE id > ?", (mid,))
    assert sorted((r["entity_id"], r["action"]) for r in rows) == [(t1["id"], "update"), (t2["id"], "update")]


def test_relation_permissions():
    t, _clock, _alice, a = setup()
    t1, t2 = mk(a, "甲"), mk(a, "乙")
    anon = client(t)
    assert anon.get(f"/api/tasks/{t1['id']}/relations").status_code == 401
    assert relate(anon, t1["id"], t2["id"]).status_code == 401
    assert anon.request("POST", f"/api/tasks/{t1['id']}/duplicate", {}).status_code == 401
    # user 角色預設可（tasks.edit）；收回 tasks.edit 後 403、讀取仍可
    assert relate(a, t1["id"], t2["id"]).status_code == 201
    t.db.execute(
        "INSERT INTO role_permissions (role, capability, allowed, updated_at) VALUES ('user', 'tasks.edit', 0, 1)"
    )
    from server.app.permissions import invalidate

    invalidate(t.db)
    assert relate(a, t1["id"], t2["id"]).status_code == 403
    assert a.request("POST", f"/api/tasks/{t1['id']}/duplicate", {}).status_code == 403
    assert a.get(f"/api/tasks/{t1['id']}/relations").status_code == 200


# ── 複製 ──


def _custom_setup(a):
    text = a.request("POST", "/api/properties", {"name": "備註", "type": "text"}).json()
    num = a.request("POST", "/api/properties", {"name": "分數", "type": "number"}).json()
    return text, num


def test_duplicate_defaults():
    t, clock, alice, a = setup()
    member = create_test_user(t.db, display_name="Member")
    text, num = _custom_setup(a)
    done_status = t.db.scalar("SELECT id FROM statuses WHERE category = 'done'")
    src = mk(
        a,
        "ntu ranking new workflow",
        description="說明",
        assigneeId=member["id"],
        priority="high",
        startDate="2026-01-01",
        dueDate="2026-01-10",
        estimateHours=3.5,
        progress=60,
        statusId=done_status,
        custom={str(text["id"]): "哈囉", str(num["id"]): 7},
    )
    assert src["completedAt"] is not None
    # 附件與個人釘選不複製
    t.db.execute(
        "INSERT INTO attachments (entity_type, entity_id, original_name, stored_name, mime, size, sha256, created_at) "
        "VALUES ('task', ?, 'a.txt', 'x1', 'text/plain', 1, 'h', 1)",
        (src["id"],),
    )
    assert a.request("PUT", f"/api/personal/pins/{src['id']}").status_code == 201
    clock.advance(MIN)
    before = t.db.scalar("SELECT max(id) FROM changes")
    res = a.request("POST", f"/api/tasks/{src['id']}/duplicate", {})
    assert res.status_code == 201, res.text
    new = res.json()
    todo = t.db.scalar("SELECT id FROM statuses WHERE category = 'todo' ORDER BY sort_order LIMIT 1")
    assert new["id"] != src["id"]
    assert new["title"] == "ntu ranking new workflow（複製）"
    assert new["description"] == "說明"
    assert new["projectId"] == src["projectId"]
    assert new["statusId"] == todo
    assert new["assigneeId"] == member["id"]
    assert new["priority"] == "high"
    assert (new["startDate"], new["dueDate"]) == ("2026-01-01", "2026-01-10")
    assert new["estimateHours"] == 3.5
    assert new["progress"] == 0
    assert new["completedAt"] is None
    assert new["custom"] == {str(text["id"]): "哈囉", str(num["id"]): 7}
    assert new["createdBy"] == alice["id"] and new["createdAt"] == clock.now()
    assert new["relationCount"] == 1
    # 排在最後（同狀態的最後一筆）
    assert new["sortOrder"] == t.db.scalar("SELECT max(sort_order) FROM tasks")
    assert new["sortOrder"] > src["sortOrder"]
    # uid 由 trigger 產生且不同
    uids = {r[0] for r in t.db.all("SELECT uid FROM tasks WHERE id IN (?, ?)", (src["id"], new["id"]))}
    assert len(uids) == 2 and all(u and len(u) == 32 for u in uids)
    assert t.db.scalar("SELECT count(*) FROM attachments WHERE entity_type = 'task' AND entity_id = ?", (new["id"],)) == 0
    assert t.db.scalar("SELECT count(*) FROM personal_items WHERE task_id = ?", (new["id"],)) == 0
    # 預設與原任務建立相關連結；原任務的關聯本身不複製
    assert [r["task"]["id"] for r in a.get(f"/api/tasks/{src['id']}/relations").json()] == [new["id"]]
    rows = t.db.all("SELECT entity_id, action FROM changes WHERE id > ?", (before,))
    assert sorted((r["entity_id"], r["action"]) for r in rows) == [(src["id"], "update"), (new["id"], "create")]


def test_duplicate_does_not_copy_relations():
    _t, _clock, _alice, a = setup()
    src, other = mk(a, "原"), mk(a, "他")
    relate(a, src["id"], other["id"])
    new = a.request("POST", f"/api/tasks/{src['id']}/duplicate", {"relate": False}).json()
    assert a.get(f"/api/tasks/{new['id']}/relations").json() == []
    assert new["relationCount"] == 0
    assert counts(a)[src["id"]] == 1


def test_duplicate_copy_options():
    t, _clock, _alice, a = setup()
    member = create_test_user(t.db)
    text, _num = _custom_setup(a)
    src = mk(
        a,
        "原任務",
        description="說明",
        assigneeId=member["id"],
        priority="urgent",
        startDate="2026-01-01",
        dueDate="2026-01-10",
        estimateHours=2,
        custom={str(text["id"]): "x"},
    )
    off = {k: False for k in ("description", "customFields", "dates", "assignee", "estimate", "priority")}
    new = a.request(
        "POST", f"/api/tasks/{src['id']}/duplicate", {"title": "  新標題 ", "copy": off, "relate": False}
    ).json()
    assert new["title"] == "新標題"
    assert new["description"] == "" and new["custom"] == {}
    assert new["startDate"] is None and new["dueDate"] is None
    assert new["assigneeId"] is None and new["estimateHours"] is None and new["priority"] == "none"
    assert new["projectId"] == src["projectId"]
    assert a.get(f"/api/tasks/{src['id']}/relations").json() == []
    # 個別選項：只關掉日期，其餘預設 True
    partial = a.request("POST", f"/api/tasks/{src['id']}/duplicate", {"copy": {"dates": False}}).json()
    assert partial["dueDate"] is None and partial["description"] == "說明" and partial["priority"] == "urgent"
    assert partial["custom"] == {str(text["id"]): "x"} and partial["assigneeId"] == member["id"]


def test_duplicate_status_choice_and_validation():
    t, _clock, _alice, a = setup()
    src = mk(a, "原")
    doing = t.db.scalar("SELECT id FROM statuses WHERE category = 'doing' ORDER BY sort_order LIMIT 1")
    done = t.db.scalar("SELECT id FROM statuses WHERE category = 'done'")
    assert a.request("POST", f"/api/tasks/{src['id']}/duplicate", {"statusId": doing}).json()["statusId"] == doing
    as_done = a.request("POST", f"/api/tasks/{src['id']}/duplicate", {"statusId": done}).json()
    assert as_done["statusId"] == done and as_done["completedAt"] is not None
    assert a.request("POST", f"/api/tasks/{src['id']}/duplicate", {"statusId": 999}).status_code == 400
    assert a.request("POST", f"/api/tasks/{src['id']}/duplicate", {"title": ""}).status_code == 400
    assert a.request("POST", "/api/tasks/9999/duplicate", {}).status_code == 404
    # 第一個待辦類狀態依 sort_order：把「待辦」排到後面並新增另一個待辦類狀態
    m = login_as(t, create_test_user(t.db, role="manager"))
    st = m.request("POST", "/api/statuses", {"name": "收件匣", "category": "todo", "sortOrder": 0}).json()
    assert a.request("POST", f"/api/tasks/{src['id']}/duplicate", {}).json()["statusId"] == st["id"]


def test_duplicate_long_title_truncated():
    _t, _clock, _alice, a = setup()
    src = mk(a, "長" * 500)
    new = a.request("POST", f"/api/tasks/{src['id']}/duplicate", {}).json()
    assert len(new["title"]) == 500 and new["title"].endswith("（複製）")


# ── 匯出匯入 ──


class _Env:
    def __init__(self, tmp_path, name: str):
        self.clock = FakeClock()
        self.t = TestApp(now=self.clock.now, db=create_test_db())
        self.t.app.state.backup_dir = str(tmp_path / f"backups-{name}")
        self.db = self.t.db
        self.admin = create_test_user(self.db, username=f"admin-{name}", role="root")
        self.api = login_as(self.t, self.admin)

    def export(self) -> dict:
        res = self.api.get("/api/admin/data/export")
        assert res.status_code == 200, res.text
        return res.json()

    def preview(self, doc) -> dict:
        res = self.api.request("POST", "/api/admin/data/import/preview", doc)
        assert res.status_code == 200, res.text
        return res.json()

    def apply(self, token: str, **opts) -> dict:
        res = self.api.request("POST", "/api/admin/data/import/apply", {"token": token, **opts})
        assert res.status_code == 200, res.text
        return res.json()


def _cat(summary: dict, key: str = dt.RELATIONS_KEY) -> dict:
    return next(c for c in summary["categories"] if c["key"] == key)


def test_export_import_roundtrip_and_idempotent(tmp_path):
    a = _Env(tmp_path, "a")
    t1, t2, t3 = mk(a.api, "甲"), mk(a.api, "乙"), mk(a.api, "丙")
    relate(a.api, t2["id"], t1["id"])
    relate(a.api, t1["id"], t3["id"])
    doc = a.export()
    assert len(doc["taskRelations"]) == 2
    uid = {r["id"]: r["uid"] for r in a.db.all("SELECT id, uid FROM tasks")}
    first = doc["taskRelations"][0]
    assert (first["taskAUid"], first["taskBUid"], first["type"]) == (uid[t1["id"]], uid[t2["id"]], "related")
    assert first["createdByUsername"] == "admin-a"

    b = _Env(tmp_path, "b")
    pv = b.preview(doc)
    assert _cat(pv)["new"] == 2 and _cat(pv)["total"] == 2 and _cat(pv)["local"] == 0
    result = b.apply(pv["token"], missingUsers="create")
    assert _cat(result)["created"] == 2 and result["skippedRelations"] == []
    again = b.export()
    assert again["taskRelations"] == doc["taskRelations"]
    # 任務內容（含 updatedAt）不因套用關聯而改變
    assert [(x["uid"], x["updatedAt"]) for x in again["tasks"]] == [(x["uid"], x["updatedAt"]) for x in doc["tasks"]]
    # 再匯入一次：冪等
    pv2 = b.preview(doc)
    assert _cat(pv2)["new"] == 0 and _cat(pv2)["same"] == 2
    r2 = b.apply(pv2["token"])
    assert _cat(r2)["created"] == 0 and _cat(r2)["unchanged"] == 2
    assert b.db.scalar("SELECT count(*) FROM task_relations") == 2
    # 匯回來源（同 uid）也冪等
    pv3 = a.preview(doc)
    assert _cat(pv3)["same"] == 2


def test_import_relation_pair_dedup_and_skip_missing(tmp_path):
    a = _Env(tmp_path, "a")
    t1, t2 = mk(a.api, "甲"), mk(a.api, "乙")
    relate(a.api, t1["id"], t2["id"])
    doc = a.export()
    # 同一對但 uid 不同（反向）→ 不重複；對方任務不在匯入檔也不在本機 → 略過並記錄
    rel = doc["taskRelations"][0]
    doc["taskRelations"].append({**rel, "uid": "f" * 32, "taskAUid": rel["taskBUid"], "taskBUid": rel["taskAUid"]})
    doc["taskRelations"].append({**rel, "uid": "e" * 32, "taskBUid": "0" * 32})
    b = _Env(tmp_path, "b")
    pv = b.preview(doc)
    c = _cat(pv)
    assert (c["new"], c["same"], c["skip"], c["total"]) == (1, 1, 1, 3)
    result = b.apply(pv["token"], missingUsers="create")
    c = _cat(result)
    assert (c["created"], c["unchanged"], c["skipped"]) == (1, 1, 1)
    assert len(result["skippedRelations"]) == 1 and "0" * 32 in result["skippedRelations"][0]
    assert b.db.scalar("SELECT count(*) FROM task_relations") == 1


def test_import_old_file_without_relations_and_replace(tmp_path):
    a = _Env(tmp_path, "a")
    t1, t2 = mk(a.api, "甲"), mk(a.api, "乙")
    relate(a.api, t1["id"], t2["id"])
    doc = a.export()
    old = {k: v for k, v in doc.items() if k != "taskRelations"}
    pv = a.preview(old)
    assert _cat(pv)["total"] == 0
    # 取代模式：本機關聯先刪除再依匯入檔重建
    pv = a.preview(doc)
    result = a.apply(pv["token"], mode="replace", confirm=dt.REPLACE_CONFIRM)
    c = _cat(result)
    assert c["deleted"] == 1 and c["created"] == 1
    assert a.db.scalar("SELECT count(*) FROM task_relations") == 1
