"""稽核紀錄與還原（server/app/audit.py、audit_events.py、features/audit_log.py；docs/design/audit-log.md）"""

import json

import pytest

from server.app import audit
from server.app.audit import (
    MAX_FIELD_CHARS,
    diff_fields,
    load_fields,
    maybe_prune,
    prune_audit,
    record_audit,
    same_value,
)

from .helpers import TEST_PASSWORD, FakeClock, create_test_app, create_test_user, login_as

DAY = 86_400_000


@pytest.fixture()
def env():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    root = create_test_user(t.db, role="root", display_name="根管理")
    manager = create_test_user(t.db, role="manager", display_name="小管")
    member = create_test_user(t.db, role="user", display_name="小明")
    other = create_test_user(t.db, role="user", display_name="小華")
    return {
        "t": t,
        "clock": clock,
        "root": login_as(t, root),
        "manager": login_as(t, manager),
        "member": login_as(t, member),
        "other": login_as(t, other),
        "users": {"root": root, "manager": manager, "member": member, "other": other},
    }


def rows(t, where: str = "1=1", params=()):
    return t.db.all(f"SELECT * FROM audit_log WHERE {where} ORDER BY id", params)


def last(t):
    return t.db.one("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1")


def fields(row):
    return load_fields(row["before_json"])[0], load_fields(row["after_json"])[0]


def new_task(api, **body):
    res = api.request("POST", "/api/tasks", {"title": "設計稿", **body})
    assert res.status_code == 201, res.text
    return res.json()


# ── 純函式 ───────────────────────────────────────────────


def test_diff_fields_only_changed():
    b, a = diff_fields({"x": 1, "y": "a", "z": [1, 2]}, {"x": 1.0, "y": "b", "z": [1, 2], "w": None})
    assert b == {"y": "a"} and a == {"y": "b"}
    b, a = diff_fields({"x": 1}, {"x": 2, "y": 3}, ["x"])
    assert b == {"x": 1} and a == {"x": 2}
    assert diff_fields(None, {"k": 1}) == ({"k": None}, {"k": 1})
    assert same_value({"a": 1, "b": 2}, {"b": 2, "a": 1})
    assert not same_value(True, 1) and not same_value(None, "")


def test_large_text_truncated_and_not_revertable():
    t = create_test_app()
    big = "字" * (MAX_FIELD_CHARS + 50)
    with t.db.tx() as conn:
        aid = record_audit(
            conn, actor=None, entity_type="task", entity_id=1, action="update", summary="s",
            before={"description": big}, after={"description": "短"}, revertable=True,
        )
    row = t.db.one("SELECT * FROM audit_log WHERE id = ?", (aid,))
    before, truncated = load_fields(row["before_json"])
    assert truncated == {"description"} and len(before["description"]) == MAX_FIELD_CHARS
    assert row["revertable"] == 0 and "過長" in row["note"]
    # 20000 字以內完整保存
    ok = "字" * MAX_FIELD_CHARS
    with t.db.tx() as conn:
        aid = record_audit(conn, actor=None, entity_type="task", entity_id=1, action="update", summary="s",
                           before={"description": ok}, after={"description": ""}, revertable=True)
    row = t.db.one("SELECT * FROM audit_log WHERE id = ?", (aid,))
    assert load_fields(row["before_json"]) == ({"description": ok}, set()) and row["revertable"] == 1


def test_audit_rolls_back_with_main_operation():
    t = create_test_app()
    with pytest.raises(RuntimeError):
        with t.db.tx() as conn:
            record_audit(conn, actor=None, entity_type="task", entity_id=1, action="update", summary="會回滾")
            raise RuntimeError("main op failed")
    assert t.db.scalar("SELECT count(*) FROM audit_log") == 0


def test_audit_failure_does_not_break_main_operation(env, monkeypatch):
    t, member = env["t"], env["member"]
    task = new_task(member)

    def boom(*_a, **_k):
        raise RuntimeError("disk full")

    monkeypatch.setattr(audit, "_insert", boom)
    res = member.request("PATCH", f"/api/tasks/{task['id']}", {"title": "仍然成功"})
    assert res.status_code == 200 and res.json()["title"] == "仍然成功"
    assert t.db.scalar("SELECT count(*) FROM audit_log WHERE action = 'update'") == 0
    # 主操作的 changes 照常寫入
    assert t.db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'task' AND action = 'update'") == 1


def _insert_aged(conn, now, age_days, summary):
    conn.execute(
        "INSERT INTO audit_log (ts, entity_type, entity_id, action, summary) VALUES (?, 'task', 1, 'update', ?)",
        (now - age_days * DAY, summary),
    )


def test_retention_prune(env):
    t, clock = env["t"], env["clock"]
    now = clock.now()
    with t.db.tx() as conn:
        for age in (400, 366, 10):
            _insert_aged(conn, now, age, str(age))
        assert prune_audit(conn, now - 365 * DAY) == 2
    assert [r["summary"] for r in rows(t)] == ["10"]
    # 每日至多一次：同一天內第二次不修剪
    with t.db.tx() as conn:
        _insert_aged(conn, now, 500, "old")
        audit._last_prune.pop(id(conn), None)
        assert maybe_prune(conn, now, days=365) == 1
        _insert_aged(conn, now, 500, "old2")
        assert maybe_prune(conn, now + 1000, days=365) == 0
        assert maybe_prune(conn, now + DAY + 1, days=365) == 1
    # 寫入稽核時自動檢查（距上次已超過一天）
    with t.db.tx() as conn:
        _insert_aged(conn, now, 500, "old3")
        record_audit(conn, actor=None, entity_type="task", entity_id=1, action="update", summary="new",
                     ts=now + 3 * DAY)
    assert "old3" not in [r["summary"] for r in rows(t)]
    # 啟動時修剪
    with t.db.tx() as conn:
        _insert_aged(conn, now, 500, "old4")
    assert audit.prune_on_startup(t.db, now=now, days=365) == 1


def test_retention_config(monkeypatch):
    from server.app.config import ConfigError, load_config

    assert load_config({}).AUDIT_RETENTION_DAYS == 365
    assert load_config({"AUDIT_RETENTION_DAYS": "30"}).AUDIT_RETENTION_DAYS == 30
    with pytest.raises(ConfigError):
        load_config({"AUDIT_RETENTION_DAYS": "0"})


# ── 任務 ─────────────────────────────────────────────────


def test_task_create_update_delete_recorded(env):
    t, member, u = env["t"], env["member"], env["users"]["member"]
    task = new_task(member, description="第一版")
    r = last(t)
    assert (r["entity_type"], r["action"], r["task_id"], r["source"]) == ("task", "create", task["id"], "web")
    assert r["summary"] == "建立任務『設計稿』"
    assert (r["actor_id"], r["actor_name"], r["actor_username"]) == (u["id"], "小明", u["username"])
    assert fields(r)[1]["description"] == "第一版" and r["revertable"] == 1

    member.request("PATCH", f"/api/tasks/{task['id']}", {"statusId": 2, "title": "設計稿"})
    r = last(t)
    b, a = fields(r)
    assert b == {"statusId": 1} and a == {"statusId": 2}  # 只含有變動的欄位
    assert r["summary"] == "把『設計稿』的狀態從『待辦』改為『進行中』"

    member.request("PATCH", f"/api/tasks/{task['id']}", {"description": "第二版"})
    assert last(t)["summary"] == "修改了『設計稿』的描述"
    member.request("PATCH", f"/api/tasks/{task['id']}", {"title": "設計稿 v2"})
    assert last(t)["summary"] == "把任務標題從『設計稿』改為『設計稿 v2』"
    member.request("PATCH", f"/api/tasks/{task['id']}", {"dueDate": "2026-02-01", "priority": "high"})
    assert last(t)["summary"] == "修改了『設計稿 v2』的優先度、到期日"
    member.request("PATCH", f"/api/tasks/{task['id']}", {"assigneeId": u["id"]})
    assert last(t)["summary"] == "把『設計稿 v2』的負責人從『未指派』改為『小明』"

    n = t.db.scalar("SELECT count(*) FROM audit_log")
    member.request("PATCH", f"/api/tasks/{task['id']}", {"title": "設計稿 v2"})  # 沒有實際變動
    assert t.db.scalar("SELECT count(*) FROM audit_log") == n

    member.request("DELETE", f"/api/tasks/{task['id']}")
    r = last(t)
    assert (r["action"], r["summary"]) == ("delete", "刪除任務『設計稿 v2』")


def test_task_custom_fields_per_key(env):
    t, member = env["t"], env["member"]
    prop = member.request("POST", "/api/properties", {
        "name": "版本", "type": "select", "options": [{"id": "a", "label": "Alpha"}, {"id": "b", "label": "Beta"}],
    }).json()
    pts = member.request("POST", "/api/properties", {"name": "點數", "type": "number"}).json()
    task = new_task(member)
    member.request("PATCH", f"/api/tasks/{task['id']}", {"custom": {str(prop["id"]): "a", str(pts["id"]): 3}})
    member.request("PATCH", f"/api/tasks/{task['id']}", {"custom": {str(prop["id"]): "b"}})
    r = last(t)
    b, a = fields(r)
    key = f"custom.{prop['id']}"
    assert b == {key: "a"} and a == {key: "b"}
    assert r["summary"] == "把『設計稿』的版本從『Alpha』改為『Beta』"


def test_reorder_merged(env):
    t, member, clock = env["t"], env["member"], env["clock"]
    task = new_task(member)
    for i, s in enumerate((10.5, 11.5, 12.5)):
        clock.advance(1000)
        member.request("PATCH", f"/api/tasks/{task['id']}", {"sortOrder": s})
    reorders = rows(t, "action = 'reorder'")
    assert len(reorders) == 1
    b, a = fields(reorders[0])
    assert b == {"sortOrder": 1.0} and a == {"sortOrder": 12.5}
    assert reorders[0]["summary"] == "調整了『設計稿』的順序"
    # 順序隨狀態一起變（看板拖曳）只記狀態
    member.request("PATCH", f"/api/tasks/{task['id']}", {"statusId": 2, "sortOrder": 99})
    assert fields(last(t)) == ({"statusId": 1}, {"statusId": 2})


# ── 還原：任務 ────────────────────────────────────────────


def test_revert_task_update_success_and_record_change(env):
    t, member, manager = env["t"], env["member"], env["manager"]
    task = new_task(member, description="原本的描述")
    member.request("PATCH", f"/api/tasks/{task['id']}", {"description": "被改壞了"})
    aid = last(t)["id"]
    before_changes = t.db.scalar("SELECT max(id) FROM changes")

    detail = manager.get(f"/api/admin/audit/{aid}").json()
    assert detail["changes"][0]["field"] == "description" and detail["changes"][0]["long"] is True
    preview = detail["revertPreview"]
    assert preview["blocked"] is None and preview["hasConflict"] is False
    assert preview["fields"][0]["currentText"] == "被改壞了"

    res = manager.request("POST", f"/api/admin/audit/{aid}/revert", {})
    assert res.status_code == 200, res.text
    assert member.get(f"/api/tasks/{task['id']}").json()["description"] == "原本的描述"
    orig = t.db.one("SELECT * FROM audit_log WHERE id = ?", (aid,))
    assert orig["reverted_at"] is not None and orig["reverted_by"] == env["users"]["manager"]["id"]
    rv = last(t)
    assert (rv["source"], rv["revert_of"], rv["action"], rv["task_id"]) == ("revert", aid, "update", task["id"])
    assert rv["summary"] == "還原：修改了『設計稿』的描述"
    assert fields(rv) == ({"description": "被改壞了"}, {"description": "原本的描述"})
    # 走既有 record_change，畫面即時更新
    ch = t.db.all("SELECT entity_type, entity_id, action FROM changes WHERE id > ?", (before_changes,))
    assert [tuple(c) for c in ch] == [("task", task["id"], "update")]

    # 列表：原筆顯示已還原與還原紀錄
    items = manager.get("/api/admin/audit").json()["items"]
    item = next(i for i in items if i["id"] == aid)
    assert item["revertedByName"] == "小管" and item["revertEntryId"] == rv["id"]

    # 重複還原拒絕
    again = manager.request("POST", f"/api/admin/audit/{aid}/revert", {})
    assert again.status_code == 409 and again.json()["error"]["code"] == "ALREADY_REVERTED"


def test_revert_conflict_and_force(env):
    t, member, other, manager = env["t"], env["member"], env["other"], env["manager"]
    task = new_task(member, description="A")
    member.request("PATCH", f"/api/tasks/{task['id']}", {"description": "B"})
    first = last(t)["id"]
    other.request("PATCH", f"/api/tasks/{task['id']}", {"description": "C"})

    res = manager.request("POST", f"/api/admin/audit/{first}/revert", {})
    assert res.status_code == 409
    err = res.json()["error"]
    assert err["code"] == "REVERT_CONFLICT"
    c = err["details"]["conflicts"][0]
    assert (c["field"], c["current"], c["after"], c["before"]) == ("description", "C", "B", "A")
    assert member.get(f"/api/tasks/{task['id']}").json()["description"] == "C"
    assert t.db.one("SELECT reverted_at FROM audit_log WHERE id = ?", (first,))["reverted_at"] is None

    res = manager.request("POST", f"/api/admin/audit/{first}/revert", {"force": True})
    assert res.status_code == 200
    assert member.get(f"/api/tasks/{task['id']}").json()["description"] == "A"


def test_revert_status_change_updates_completed_at(env):
    member, manager, t = env["member"], env["manager"], env["t"]
    task = new_task(member)
    member.request("PATCH", f"/api/tasks/{task['id']}", {"statusId": 4})
    assert member.get(f"/api/tasks/{task['id']}").json()["completedAt"] is not None
    assert manager.request("POST", f"/api/admin/audit/{last(t)['id']}/revert", {}).status_code == 200
    got = member.get(f"/api/tasks/{task['id']}").json()
    assert got["statusId"] == 1 and got["completedAt"] is None


def test_revert_create_deletes_and_delete_restores(env):
    t, member, manager = env["t"], env["member"], env["manager"]
    task = new_task(member)
    created = last(t)["id"]
    assert manager.request("POST", f"/api/admin/audit/{created}/revert", {}).status_code == 200
    assert member.get(f"/api/tasks/{task['id']}").status_code == 404
    undo_create = last(t)
    assert undo_create["action"] == "delete" and undo_create["revertable"] == 1

    # 還原「還原」：任務回來
    assert manager.request("POST", f"/api/admin/audit/{undo_create['id']}/revert", {}).status_code == 200
    assert member.get(f"/api/tasks/{task['id']}").status_code == 200
    assert last(t)["action"] == "restore"

    task2 = new_task(member, title="要刪的")
    member.request("DELETE", f"/api/tasks/{task2['id']}")
    deleted = last(t)["id"]
    assert manager.request("POST", f"/api/admin/audit/{deleted}/revert", {}).status_code == 200
    assert member.get(f"/api/tasks/{task2['id']}").json()["title"] == "要刪的"
    ch = t.db.one("SELECT entity_type, action FROM changes ORDER BY id DESC LIMIT 1")
    assert tuple(ch) == ("task", "create")


def test_revert_update_of_deleted_task_blocked(env):
    t, member, manager = env["t"], env["member"], env["manager"]
    task = new_task(member)
    member.request("PATCH", f"/api/tasks/{task['id']}", {"title": "改過"})
    upd = last(t)["id"]
    member.request("DELETE", f"/api/tasks/{task['id']}")
    res = manager.request("POST", f"/api/admin/audit/{upd}/revert", {})
    assert res.status_code == 409 and res.json()["error"]["code"] == "NOT_REVERTABLE"
    assert "已刪除" in res.json()["error"]["message"]
    assert manager.get(f"/api/admin/audit/{upd}").json()["revertPreview"]["blocked"]


# ── 還原：專案 / 狀態 / 自訂欄位 / 成員 / 權限 ─────────────────


def test_project_audit_and_revert(env):
    t, root = env["t"], env["root"]
    p = root.request("POST", "/api/projects", {"name": "官網"}).json()
    created = last(t)
    assert created["summary"] == "建立專案『官網』" and created["revertable"] == 0 and "封存" in created["note"]
    assert root.request("POST", f"/api/admin/audit/{created['id']}/revert", {}).status_code == 409

    root.request("PATCH", f"/api/projects/{p['id']}", {"name": "官網改版"})
    assert last(t)["summary"] == "把專案『官網』改名為『官網改版』"
    root.request("PATCH", f"/api/projects/{p['id']}", {"isArchived": True})
    archived = last(t)
    assert archived["summary"] == "封存了專案『官網改版』"
    assert root.request("POST", f"/api/admin/audit/{archived['id']}/revert", {}).status_code == 200
    assert next(x for x in root.get("/api/projects").json() if x["id"] == p["id"])["isArchived"] is False


def test_status_audit_and_revert(env):
    t, manager, member = env["t"], env["manager"], env["member"]
    s = manager.request("POST", "/api/statuses", {"name": "暫停", "color": "orange"}).json()
    created = last(t)
    assert created["summary"] == "新增狀態『暫停』"

    manager.request("PATCH", f"/api/statuses/{s['id']}", {"name": "擱置"})
    renamed = last(t)
    assert renamed["summary"] == "把狀態『暫停』改名為『擱置』"
    assert manager.request("POST", f"/api/admin/audit/{renamed['id']}/revert", {}).status_code == 200
    assert next(x for x in manager.get("/api/statuses").json() if x["id"] == s["id"])["name"] == "暫停"

    # 已有任務使用 → 建立不可還原（以原因說明）
    task = new_task(member, statusId=s["id"])
    res = manager.request("POST", f"/api/admin/audit/{created['id']}/revert", {})
    assert res.status_code == 409 and "已有 1 筆任務使用此狀態" in res.json()["error"]["message"]

    member.request("PATCH", f"/api/tasks/{task['id']}", {"statusId": 1})
    t.db.execute("DELETE FROM tasks WHERE id = ?", (task["id"],))
    assert manager.request("POST", f"/api/admin/audit/{created['id']}/revert", {}).status_code == 200
    assert all(x["id"] != s["id"] for x in manager.get("/api/statuses").json())

    # 刪除 → 還原（同編號重建）
    s2 = manager.request("POST", "/api/statuses", {"name": "封存中", "category": "done"}).json()
    manager.request("DELETE", f"/api/statuses/{s2['id']}")
    deleted = last(t)
    assert deleted["summary"] == "刪除狀態『封存中』" and deleted["revertable"] == 1
    assert manager.request("POST", f"/api/admin/audit/{deleted['id']}/revert", {}).status_code == 200
    back = next(x for x in manager.get("/api/statuses").json() if x["id"] == s2["id"])
    assert back["name"] == "封存中" and back["category"] == "done"


def test_status_migrate_delete_not_revertable(env):
    t, manager, member = env["t"], env["manager"], env["member"]
    s = manager.request("POST", "/api/statuses", {"name": "暫停"}).json()
    task = new_task(member, statusId=s["id"])
    manager.request("POST", f"/api/statuses/{s['id']}/migrate-and-delete", {"targetStatusId": 1})
    summary = last(t)
    assert summary["summary"] == "刪除狀態『暫停』，並把 1 筆任務改為『待辦』" and summary["revertable"] == 0
    hist = member.get(f"/api/tasks/{task['id']}/history").json()["items"]
    assert "一併改移" in hist[0]["summary"] and hist[0]["revertable"] is False


def test_property_audit_and_revert(env):
    t, member, manager = env["t"], env["member"], env["manager"]
    p = member.request("POST", "/api/properties", {"name": "版本", "type": "text"}).json()
    member.request("PATCH", f"/api/properties/{p['id']}", {"name": "版號"})
    assert last(t)["summary"] == "把自訂欄位『版本』改名為『版號』"
    member.request("DELETE", f"/api/properties/{p['id']}")
    deleted = last(t)
    assert deleted["summary"] == "刪除自訂欄位『版號』"
    assert manager.request("POST", f"/api/admin/audit/{deleted['id']}/revert", {}).status_code == 200
    assert [x["name"] for x in member.get("/api/properties").json()] == ["版號"]


def test_member_audit_and_revert(env):
    t, manager, root = env["t"], env["manager"], env["root"]
    res = manager.request("POST", "/api/admin/users", {"username": "newbie", "displayName": "新人"})
    temp = res.json()["tempPassword"]
    created = last(t)
    assert created["summary"] == "新增成員『新人』（帳號 newbie，成員）" and created["revertable"] == 0
    uid = res.json()["user"]["id"]

    manager.request("PATCH", f"/api/admin/users/{uid}", {"isActive": False})
    disabled = last(t)
    assert disabled["summary"] == "停用了成員『新人』" and fields(disabled) == ({"isActive": True}, {"isActive": False})
    assert manager.request("POST", f"/api/admin/audit/{disabled['id']}/revert", {}).status_code == 200
    assert t.db.scalar("SELECT is_active FROM users WHERE id = ?", (uid,)) == 1

    manager.request("PATCH", f"/api/admin/users/{uid}", {"role": "manager"})
    assert last(t)["summary"] == "把『新人』的角色從『成員』改為『管理者』"

    reset = manager.request("POST", f"/api/admin/users/{uid}/reset-password")
    temp2 = reset.json()["tempPassword"]
    pw = last(t)
    assert pw["summary"] == "重設了『新人』的密碼" and pw["revertable"] == 0
    manager.request("POST", f"/api/admin/users/{uid}/unlock")
    assert last(t)["summary"] == "解除了『新人』的登入鎖定"

    # 不洩漏密碼：任何稽核欄位都不含臨時密碼或雜湊
    dump = json.dumps([dict(r) for r in rows(t)], ensure_ascii=False)
    hash_ = t.db.scalar("SELECT password_hash FROM users WHERE id = ?", (uid,))
    for secret in (temp, temp2, hash_, TEST_PASSWORD):
        assert secret not in dump
    listing = root.get("/api/admin/audit?entityType=user").text
    assert temp2 not in listing and "password_hash" not in listing and "passwordHash" not in listing


def test_member_revert_respects_last_root(env):
    t, root = env["t"], env["root"]
    other_root = create_test_user(t.db, role="root", display_name="另一位")
    root.request("PATCH", f"/api/admin/users/{other_root['id']}", {"role": "manager"})
    demote = last(t)
    # 還原為 root：manager 沒有 roles.assign_root → 403
    res = env["manager"].request("POST", f"/api/admin/audit/{demote['id']}/revert", {})
    assert res.status_code == 403
    assert root.request("POST", f"/api/admin/audit/{demote['id']}/revert", {}).status_code == 200


def test_profile_change_recorded_not_revertable(env):
    t, member = env["t"], env["member"]
    member.request("PATCH", "/api/profile", {"displayName": "阿明"})
    r = last(t)
    assert r["summary"] == "在個人設定把顯示名稱從『小明』改為『阿明』"
    assert r["actor_name"] == "阿明" and r["revertable"] == 0
    member.request("PATCH", "/api/profile", {"username": "ming", "currentPassword": TEST_PASSWORD})
    r = last(t)
    assert "帳號從" in r["summary"] and TEST_PASSWORD not in (r["before_json"] + r["after_json"])


def test_permissions_audit_and_revert_root_only(env):
    t, root, manager = env["t"], env["root"], env["manager"]
    root.request("PUT", "/api/admin/permissions", {"changes": [{"role": "user", "capability": "tasks.edit", "allowed": False}]})
    r = last(t)
    assert fields(r) == ({"user:tasks.edit": True}, {"user:tasks.edit": False})
    assert r["summary"] == "調整權限設定：成員・編輯任務改為不允許"
    # manager 有 audit.revert 但沒有 permissions.configure
    assert manager.request("POST", f"/api/admin/audit/{r['id']}/revert", {}).status_code == 403
    assert root.request("POST", f"/api/admin/audit/{r['id']}/revert", {}).status_code == 200
    assert env["member"].request("POST", "/api/tasks", {"title": "可以了"}).status_code == 201

    root.request("PUT", "/api/admin/permissions", {"changes": [{"role": "manager", "capability": "audit.view", "allowed": False}]})
    root.request("POST", "/api/admin/permissions/reset", {})
    reset = last(t)
    assert reset["summary"] == "把所有角色的權限還原為預設（1 項變更）"
    assert root.request("POST", f"/api/admin/audit/{reset['id']}/revert", {}).status_code == 200
    assert manager.get("/api/admin/audit").status_code == 403


# ── 匯入 / 同步摘要 ─────────────────────────────────────────


def test_import_summary_not_revertable(env, tmp_path):
    t, root = env["t"], env["root"]
    t.app.state.backup_dir = str(tmp_path)
    new_task(env["member"], title="匯出的任務")
    doc = root.get("/api/admin/data/export").json()
    doc["tasks"][0]["title"] = "匯入後的標題"
    doc["tasks"][0]["updatedAt"] = env["clock"].now() + 1000
    res = root.request("POST", "/api/admin/data/import/apply", {"data": doc, "strategy": "use_import"})
    assert res.status_code == 200, res.text
    r = last(t)
    assert (r["entity_type"], r["source"], r["revertable"]) == ("import", "import", 0)
    assert r["summary"].startswith("套用資料匯入（合併）：") and "更新 1 筆" in r["summary"]
    assert root.request("POST", f"/api/admin/audit/{r['id']}/revert", {}).status_code == 409


def test_sync_summary_recorded(env):
    from server.app.audit_events import sync_applied

    t = env["t"]
    with t.db.tx() as conn:
        assert sync_applied(conn, {"id": 3, "name": "辦公室"}, "PC-1", {"created": 0, "updated": 0}, 1) is None
        aid = sync_applied(conn, {"id": 3, "name": "辦公室"}, "PC-1", {"created": 2, "updated": 1, "conflict": 1}, 1)
    r = t.db.one("SELECT * FROM audit_log WHERE id = ?", (aid,))
    assert r["summary"] == "同步來源『辦公室』（PC-1）上傳：新增 2 筆、更新 1 筆、1 筆待確認"
    assert (r["source"], r["actor_id"], r["actor_name"], r["revertable"]) == ("sync", None, "同步：辦公室", 0)


def test_personal_items_not_recorded(env):
    t, member = env["t"], env["member"]
    assert member.request("POST", "/api/personal", {"title": "私人待辦"}).status_code in (200, 201)
    assert t.db.scalar("SELECT count(*) FROM audit_log") == 0


# ── API 與權限 ─────────────────────────────────────────────


def test_permission_matrix(env):
    t, member, manager = env["t"], env["member"], env["manager"]
    task = new_task(member)
    aid = last(t)["id"]
    assert manager.get("/api/admin/audit").status_code == 200
    assert member.get("/api/admin/audit").status_code == 403
    assert member.get(f"/api/admin/audit/{aid}").status_code == 403
    assert member.request("POST", f"/api/admin/audit/{aid}/revert", {}).status_code == 403
    hist = member.get(f"/api/tasks/{task['id']}/history")
    assert hist.status_code == 200 and hist.json()["items"][0]["summary"] == "建立任務『設計稿』"
    from .helpers import client

    anon = client(t)
    assert anon.get("/api/admin/audit").status_code == 401
    assert anon.get(f"/api/tasks/{task['id']}/history").status_code == 401
    # 不提供修改 / 刪除稽核的 API
    assert manager.request("PUT", f"/api/admin/audit/{aid}", {}).status_code in (404, 405)
    assert manager.request("DELETE", f"/api/admin/audit/{aid}").status_code in (404, 405)
    assert t.db.scalar("SELECT count(*) FROM audit_log WHERE id = ?", (aid,)) == 1


def test_list_filters_and_cursor(env):
    t, member, other, manager, clock = env["t"], env["member"], env["other"], env["manager"], env["clock"]
    a = new_task(member, title="甲")
    clock.advance(1000)
    new_task(other, title="乙")
    clock.advance(1000)
    member.request("PATCH", f"/api/tasks/{a['id']}", {"title": "甲改"})
    uid = env["users"]["member"]["id"]

    got = manager.get(f"/api/admin/audit?actor={uid}").json()["items"]
    assert [i["summary"] for i in got] == ["把任務標題從『甲』改為『甲改』", "建立任務『甲』"]
    assert [i["summary"] for i in manager.get("/api/admin/audit?action=create").json()["items"]] == [
        "建立任務『乙』",
        "建立任務『甲』",
    ]
    assert len(manager.get(f"/api/admin/audit?taskId={a['id']}").json()["items"]) == 2
    assert [i["entityLabel"] for i in manager.get("/api/admin/audit?q=乙").json()["items"]] == ["乙"]
    start = clock.now() - 2000
    assert len(manager.get(f"/api/admin/audit?from={start + 1}&to={clock.now()}").json()["items"]) == 1
    assert len(manager.get("/api/admin/audit?revertable=true").json()["items"]) == 3

    page1 = manager.get("/api/admin/audit?limit=2").json()
    assert len(page1["items"]) == 2 and page1["nextBefore"] == page1["items"][-1]["id"]
    page2 = manager.get(f"/api/admin/audit?limit=2&before={page1['nextBefore']}").json()
    assert len(page2["items"]) == 1 and page2["nextBefore"] is None

    assert manager.get("/api/admin/audit?limit=0").status_code == 400
    assert manager.get("/api/admin/audit?entityType=nope").status_code == 400
    assert manager.get("/api/admin/audit?revertable=yes").status_code == 400
    assert manager.get("/api/admin/audit/999999").status_code == 404
    assert manager.request("POST", "/api/admin/audit/999999/revert", {}).status_code == 404


def test_task_history_paging_and_changes(env):
    t, member = env["t"], env["member"]
    task = new_task(member, description="一")
    for d in ("二", "三", "四"):
        member.request("PATCH", f"/api/tasks/{task['id']}", {"description": d})
    page = member.get(f"/api/tasks/{task['id']}/history?limit=2").json()
    assert len(page["items"]) == 2
    ch = page["items"][0]["changes"][0]
    assert (ch["label"], ch["beforeText"], ch["afterText"], ch["long"]) == ("描述", "三", "四", True)
    rest = member.get(f"/api/tasks/{task['id']}/history?before={page['nextBefore']}").json()
    assert len(rest["items"]) == 2 and rest["nextBefore"] is None
    assert member.get("/api/tasks/999999/history").json() == {"items": [], "nextBefore": None}


# ── 整合：相關任務 / 依賴 / 待辦清單 / 復原刪除 ──────────────────


def test_relation_audit_and_revert(env):
    t, member, manager = env["t"], env["member"], env["manager"]
    a, b = new_task(member, title="甲"), new_task(member, title="乙")
    rel = member.request("POST", f"/api/tasks/{a['id']}/relations", {"targetId": b["id"], "type": "related"}).json()
    created = last(t)
    assert (created["entity_type"], created["action"], created["task_id"]) == ("relation", "create", a["id"])
    assert created["summary"] == "把『甲』與『乙』設為相關任務" and created["revertable"] == 1
    # 重複建立（已存在）不記錄
    member.request("POST", f"/api/tasks/{b['id']}/relations", {"targetId": a["id"], "type": "related"})
    assert last(t)["id"] == created["id"]

    member.request("DELETE", f"/api/tasks/{a['id']}/relations/{rel['id']}")
    removed = last(t)
    assert removed["action"] == "delete" and removed["summary"] == "移除了『甲』與『乙』的相關連結"
    detail = manager.get(f"/api/admin/audit/{removed['id']}").json()
    assert detail["revertPreview"]["kind"] == "recreate_link"
    assert {c["afterText"] for c in detail["changes"]} == {None}
    assert {c["beforeText"] for c in detail["changes"]} >= {"甲", "乙"}

    assert manager.request("POST", f"/api/admin/audit/{removed['id']}/revert", {}).status_code == 200
    rels = member.get(f"/api/tasks/{a['id']}/relations").json()
    assert [r["id"] for r in rels] == [rel["id"]]
    # 還原「建立」= 移除
    assert manager.request("POST", f"/api/admin/audit/{created['id']}/revert", {}).status_code == 200
    assert member.get(f"/api/tasks/{a['id']}/relations").json() == []
    ch = t.db.one("SELECT entity_type, action FROM changes ORDER BY id DESC LIMIT 1")
    assert tuple(ch) == ("task", "update")


def test_dependency_audit_and_revert_with_cycle_guard(env):
    t, member, manager = env["t"], env["member"], env["manager"]
    a, b = new_task(member, title="前置"), new_task(member, title="後續")
    dep = member.request(
        "POST", f"/api/tasks/{b['id']}/dependencies", {"targetId": a["id"], "direction": "blocked_by"}
    ).json()
    created = last(t)
    assert created["entity_type"] == "dependency" and created["summary"] == "設定『後續』等待『前置』完成"
    member.request("DELETE", f"/api/tasks/{b['id']}/dependencies/{dep['id']}")
    removed = last(t)
    assert removed["summary"] == "移除了『後續』對『前置』的依賴"
    # 反向建立後，還原原本的依賴會形成循環 → 不可還原
    member.request("POST", f"/api/tasks/{a['id']}/dependencies", {"targetId": b["id"], "direction": "blocked_by"})
    res = manager.request("POST", f"/api/admin/audit/{removed['id']}/revert", {})
    assert res.status_code == 409 and "循環" in res.json()["error"]["message"]


def test_checklist_audit_merged_and_batches(env):
    t, member, clock = env["t"], env["member"], env["clock"]
    task = new_task(member, title="清單任務")
    tid = task["id"]
    items = member.request(
        "POST", f"/api/tasks/{tid}/checklist", {"items": [{"text": "一"}, {"text": "二"}, {"text": "三"}]}
    ).json()
    batch = last(t)
    assert (batch["entity_type"], batch["action"]) == ("checklist", "create")
    assert batch["summary"] == "在『清單任務』一次新增了 3 項待辦" and batch["revertable"] == 0
    # 單項新增不記錄
    member.request("POST", f"/api/tasks/{tid}/checklist", {"text": "四"})
    assert last(t)["id"] == batch["id"]
    for it in items:
        clock.advance(1000)
        member.request("PATCH", f"/api/tasks/{tid}/checklist/{it['id']}", {"isDone": True})
    toggles = rows(t, "entity_type = 'checklist' AND action = 'update'")
    assert len(toggles) == 1 and toggles[0]["summary"] == "完成了『清單任務』的待辦項目 3 項"
    member.request("POST", f"/api/tasks/{tid}/checklist/clear-done")
    cleared = last(t)
    assert cleared["summary"] == "清除了『清單任務』已完成的待辦 3 項"
    assert fields(cleared)[0]["items"] == ["一", "二", "三"]
    # 出現在任務活動歷史
    hist = member.get(f"/api/tasks/{tid}/history")
    if hist.status_code == 200:
        assert any(i["entityType"] == "checklist" for i in hist.json()["items"])


def test_task_restore_endpoint_recorded(env):
    t, member = env["t"], env["member"]
    task = new_task(member, title="被刪又復原")
    member.request("DELETE", f"/api/tasks/{task['id']}")
    assert member.request("POST", f"/api/tasks/{task['id']}/restore").status_code == 200
    r = last(t)
    assert (r["action"], r["summary"], r["revertable"]) == ("restore", "還原了已刪除的任務『被刪又復原』", 1)
