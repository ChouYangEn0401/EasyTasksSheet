"""工程追蹤 v2：(A) 可自訂狀態、(B) 掃描本機專案、(C) 多台電腦回報的「不見不等於刪除」安全機制"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from server.app.db import MIGRATIONS_DIR, create_db, run_migrations, run_seed
from server.app.features.eng import build_overview, suspicious
from server.app.permissions import invalidate
from server.app import worktree_scan as ws

from .helpers import MIN, FakeClock, create_test_app, create_test_user, login_as

TOKEN = "report-secret-xyz"
ID_A = "aaaaaaaa-1111"
ID_B = "bbbbbbbb-2222"


def setup(role: str = "user", token: str | None = TOKEN, tmp: Path | None = None):
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    t.app.state.eng_report_token = token
    if tmp is not None:
        t.app.state.machine_home = str(tmp / "home")
    user = create_test_user(t.db, role=role)
    return t, clock, user, login_as(t, user)


def report(t, body, token=TOKEN):
    return t.http.post(
        "/api/eng/worktrees/report",
        content=json.dumps(body),
        headers={"content-type": "application/json", "x-report-token": token},
    )


def wt(path: str, branch: str | None = None, head: str = "abcdef1", **kw):
    return {"path": path, "branch": branch, "headSha": head, **kw}


def statuses(api, kind):
    return {s["key"]: s for s in api.get(f"/api/eng/statuses?kind={kind}").json()["statuses"]}


# ── (A) 自訂狀態 ──


def test_builtin_statuses_and_existing_values():
    _t, _c, _u, api = setup()
    issue = statuses(api, "issue")
    assert list(issue) == ["open", "doing", "blocked", "deferred", "closed", "wontfix"]
    assert issue["closed"]["category"] == "closed" and issue["wontfix"]["category"] == "closed"
    assert issue["blocked"]["label"] == "卡住" and all(s["isBuiltin"] for s in issue.values())
    tree = statuses(api, "worktree")
    assert list(tree) == ["active", "idle", "merged", "broken", "tech_debt", "legacy", "unknown", "lost", "cleaned"]
    assert tree["cleaned"]["category"] == "done" and tree["merged"]["category"] == "attention"
    assert {tree[k]["label"] for k in ("broken", "tech_debt", "legacy", "unknown")} == {"損毀", "技術債", "舊版保留", "未知"}
    assert api.get("/api/eng/statuses?kind=nope").status_code == 400
    both = api.get("/api/eng/statuses").json()
    assert both["categories"] == {"issue": ["open", "closed"], "worktree": ["active", "idle", "attention", "done"]}

    # 既有的狀態值照常可用；新狀態值也可用
    assert api.request("POST", "/api/eng/issues", {"title": "a"}).json()["status"] == "open"
    assert api.request("POST", "/api/eng/issues", {"title": "b", "status": "blocked"}).json()["status"] == "blocked"
    rec = api.request("POST", "/api/eng/worktree-records", {"machine": "PC", "path": "C:/w/a", "status": "tech_debt"})
    assert rec.status_code == 201 and rec.json()["status"] == "tech_debt"
    # 不存在的值 → 400
    assert api.request("POST", "/api/eng/issues", {"title": "x", "status": "weird"}).status_code == 400
    assert api.request("POST", "/api/eng/worktree-records", {"machine": "PC", "path": "C:/w/b", "status": "nope"}).status_code == 400


def test_status_crud_and_protection():
    t, _c, _u, api = setup()
    res = api.request("POST", "/api/eng/statuses", {"kind": "worktree", "label": "待驗證", "color": "teal", "category": "attention"})
    assert res.status_code == 201
    custom = res.json()
    assert custom["key"].startswith("c_") and custom["isBuiltin"] is False and custom["usage"] == 0
    # 同名 409、類別不符 400、顏色不在八色 400
    assert api.request("POST", "/api/eng/statuses", {"kind": "worktree", "label": "待驗證"}).status_code == 409
    assert api.request("POST", "/api/eng/statuses", {"kind": "issue", "label": "x", "category": "done"}).status_code == 400
    assert api.request("POST", "/api/eng/statuses", {"kind": "issue", "label": "x", "color": "pink"}).status_code == 400

    # 套用自訂狀態
    rec = api.request("POST", "/api/eng/worktree-records", {"machine": "PC", "path": "C:/w/a", "status": custom["key"]}).json()
    assert rec["status"] == custom["key"]
    # 使用中的自訂狀態不可刪除，只能封存
    res = api.request("DELETE", f"/api/eng/statuses/{custom['id']}")
    assert res.status_code == 409 and res.json()["error"]["details"] == {"usage": 1}
    res = api.request("PATCH", f"/api/eng/statuses/{custom['id']}", {"isArchived": True})
    assert res.status_code == 200 and res.json()["isArchived"] is True
    # 封存後：既有資料保留且可照常編輯其他欄位；但不可新設
    assert api.request("PATCH", f"/api/eng/worktree-records/{rec['id']}", {"note": "x", "status": custom["key"]}).status_code == 200
    assert api.request("POST", "/api/eng/worktree-records", {"machine": "PC", "path": "C:/w/b", "status": custom["key"]}).status_code == 400
    # 自訂狀態可改類別
    assert api.request("PATCH", f"/api/eng/statuses/{custom['id']}", {"category": "idle"}).json()["category"] == "idle"

    # 內建：可改名 / 改色 / 排序 / 封存，key 不變；不可改類別、不可刪除
    closed = statuses(api, "issue")["closed"]
    res = api.request("PATCH", f"/api/eng/statuses/{closed['id']}", {"label": "完成", "color": "teal", "sortOrder": 0.5, "key": "hack"})
    assert res.status_code == 200
    assert (res.json()["label"], res.json()["color"], res.json()["key"], res.json()["sortOrder"]) == ("完成", "teal", "closed", 0.5)
    assert api.request("PATCH", f"/api/eng/statuses/{closed['id']}", {"category": "open"}).status_code == 400
    assert api.request("DELETE", f"/api/eng/statuses/{closed['id']}").status_code == 400
    assert list(statuses(api, "issue"))[0] == "closed"  # 排序

    # 未使用的自訂狀態可刪除
    extra = api.request("POST", "/api/eng/statuses", {"kind": "issue", "label": "待回覆"}).json()
    assert extra["category"] == "open"
    assert api.request("DELETE", f"/api/eng/statuses/{extra['id']}").json() == {"ok": True}
    assert api.request("DELETE", f"/api/eng/statuses/{extra['id']}").status_code == 404

    # 至少保留一個未封存的狀態
    for s in statuses(api, "issue").values():
        if s["key"] != "wontfix":
            assert api.request("PATCH", f"/api/eng/statuses/{s['id']}", {"isArchived": True}).status_code == 200
    last = statuses(api, "issue")["wontfix"]
    assert api.request("PATCH", f"/api/eng/statuses/{last['id']}", {"isArchived": True}).status_code == 400
    # 預設值被封存時，新問題改用第一個可用狀態
    assert api.request("POST", "/api/eng/issues", {"title": "z"}).json()["status"] == "wontfix"

    kinds = [r["entity_type"] for r in t.db.all("SELECT entity_type FROM changes WHERE entity_type = 'repo'")]
    assert len(kinds) > 5


def test_status_manage_permission_can_be_revoked():
    t, _c, _u, api = setup()
    t.db.execute(
        "INSERT INTO role_permissions (role, capability, allowed, updated_at) VALUES ('user', 'eng.status.manage', 0, 1)"
    )
    invalidate(t.db)
    assert api.request("POST", "/api/eng/statuses", {"kind": "issue", "label": "x"}).status_code == 403
    assert api.get("/api/eng/statuses").status_code == 200  # 讀取不受影響
    assert "eng.status.manage" not in api.get("/api/auth/me").json()["capabilities"]


def test_issue_list_sorts_by_category_and_github_sync_respects_categories():
    from server.app.features.eng import github_changes

    _t, clock, _u, api = setup()
    a = api.request("POST", "/api/eng/issues", {"title": "不處理的", "status": "wontfix"}).json()
    clock.advance(MIN)
    b = api.request("POST", "/api/eng/issues", {"title": "卡住的", "status": "blocked"}).json()
    assert [i["id"] for i in api.get("/api/eng/issues").json()["issues"]] == [b["id"], a["id"]]
    row = {"status": "wontfix", "github_state": "open", "github_title": "t", "title": "t"}
    assert github_changes(row, {"state": "closed", "title": "t"}) == {}
    row = {"status": "wontfix", "github_state": "closed", "github_title": "t", "title": "t"}
    assert github_changes(row, {"state": "open", "title": "t"}) == {"status": "open"}


def test_migration_keeps_existing_values(tmp_path):
    """升級：0011 之前的資料（含舊狀態值與舊回報）不需改動；未知值補成自訂狀態；回報來源回填"""
    old = tmp_path / "old"
    old.mkdir()
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if f.stem < "0011":
            shutil.copy(f, old / f.name)
    db = create_db(str(tmp_path / "x.db"))
    run_migrations(db, old)
    run_seed(db)
    db.execute("INSERT INTO manual_issues (title, status, created_at, updated_at) VALUES ('a', 'doing', 1, 1)")
    db.execute("INSERT INTO manual_issues (title, status, created_at, updated_at) VALUES ('b', 'legacy-x', 1, 1)")
    db.execute("INSERT INTO worktree_records (machine, path, status, created_at, updated_at) VALUES ('PC', 'C:/a', 'merged', 1, 1)")
    db.execute(
        "INSERT INTO worktree_reports (machine, repo, path, reported_at) VALUES ('PC-01', 'r', 'C:/a', 5), ('pc-01', 'r', 'C:/b', 7)"
    )
    run_migrations(db)
    assert [r[0] for r in db.all("SELECT status FROM manual_issues ORDER BY id")] == ["doing", "legacy-x"]
    custom = db.one("SELECT * FROM eng_statuses WHERE kind = 'issue' AND key = 'legacy-x'")
    assert custom is not None and custom["is_builtin"] == 0 and custom["uid"]
    rec = db.one("SELECT * FROM worktree_records")
    assert (rec["status"], rec["source"], rec["deleted_at"], rec["machine_id"]) == ("merged", "manual", None, None)
    src = db.all("SELECT * FROM worktree_report_sources")
    assert len(src) == 1 and src[0]["machine_key"] == "name:pc-01" and src[0]["last_report_at"] == 7
    db.close()


# ── (C) 回報：machine_id、空回報 / 驟減保護、搬動、不自動刪除 ──


def overview(api):
    return api.get("/api/eng/worktrees").json()


def group_of(data, machine_id=None, name=None):
    for g in data["machines"]:
        if (machine_id and g["machineId"] == machine_id) or (name and g["machine"] == name):
            return g
    raise AssertionError(f"找不到電腦 {machine_id or name}")


def test_machine_id_is_the_key_not_the_name():
    t, clock, _u, api = setup()
    assert report(t, {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": [wt("C:/a/1", "f/1")]}).status_code == 200
    assert report(t, {"machine": "PC", "machineId": ID_B, "repo": "r", "worktrees": [wt("C:/b/1", "f/2")]}).status_code == 200
    data = overview(api)
    assert len(data["machines"]) == 2  # 同名不混淆
    assert [r["path"] for r in group_of(data, ID_A)["reports"]] == ["C:/a/1"]
    # 改名：同一個 id 仍是同一台
    clock.advance(MIN)
    report(t, {"machine": "PC-新名字", "machineId": ID_A, "repo": "r", "worktrees": [wt("C:/a/1", "f/1")]})
    data = overview(api)
    assert len(data["machines"]) == 2
    g = group_of(data, ID_A)
    assert g["machine"] == "PC-新名字" and len(g["reports"]) == 1
    # 無效的 id → 400
    assert report(t, {"machine": "PC", "machineId": "bad id!", "worktrees": []}).status_code == 400


def test_legacy_report_without_id_is_adopted_by_same_name():
    t, clock, _u, api = setup()
    report(t, {"machine": "Laptop", "repo": "r", "worktrees": [wt("/h/a", "f/a")]})
    assert group_of(overview(api), name="Laptop")["key"] == "name:laptop"
    clock.advance(MIN)
    report(t, {"machine": "laptop", "machineId": ID_A, "repo": "r", "worktrees": [wt("/h/a", "f/a"), wt("/h/b", "f/b")]})
    data = overview(api)
    assert len(data["machines"]) == 1
    g = data["machines"][0]
    assert g["key"] == f"id:{ID_A}" and sorted(r["path"] for r in g["reports"]) == ["/h/a", "/h/b"]
    assert t.db.scalar("SELECT count(*) FROM worktree_reports") == 2


def test_empty_report_is_held_and_old_data_kept():
    t, clock, _u, api = setup()
    rec = api.request("POST", "/api/eng/worktree-records", {"machine": "PC", "machineId": ID_A, "path": "C:/a/1", "branch": "f/1"}).json()
    report(t, {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": [wt("C:/a/1", "f/1"), wt("C:/a/2", "f/2")]})
    clock.advance(MIN)
    res = report(t, {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": []})
    assert res.status_code == 200
    body = res.json()
    assert body["held"] is True and body["reason"] == "empty" and body["previous"] == 2
    assert "已保留舊資料" in body["message"]
    g = group_of(overview(api), ID_A)
    pending = g["repos"][0]["pending"]
    assert pending == {"reason": "empty", "count": 0, "previous": 2, "at": clock.now()}
    # 舊資料仍在、沒有任何列被標為不見；紀錄沒有提示
    assert len(g["reports"]) == 2 and all(r["missingSince"] is None for r in g["reports"])
    assert g["records"][0]["id"] == rec["id"] and g["records"][0]["hint"] is None
    assert g["reportedAt"] == clock.now()  # 電腦仍在線（有回報）

    # 忽略：保留原快照
    sid = g["repos"][0]["sourceId"]
    assert api.request("POST", f"/api/eng/worktrees/pending/{sid}/discard").json() == {"ok": True}
    assert group_of(overview(api), ID_A)["repos"][0]["pending"] is None
    assert api.request("POST", f"/api/eng/worktrees/pending/{sid}/accept").status_code == 404

    # 再次空回報 → 確認採用：只標記「回報中找不到」，紀錄與快照列都保留
    report(t, {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": []})
    res = api.request("POST", f"/api/eng/worktrees/pending/{sid}/accept")
    assert res.status_code == 200 and res.json()["missing"] == 2
    g = group_of(overview(api), ID_A)
    assert len(g["reports"]) == 2 and all(r["missingSince"] is not None for r in g["reports"])
    assert g["records"][0]["hint"] == "vanished" and g["records"][0]["lastSeenAt"] is not None
    assert t.db.scalar("SELECT count(*) FROM worktree_records WHERE deleted_at IS NULL") == 1


def test_sudden_drop_is_held():
    assert suspicious(0, 0) is None
    assert suspicious(3, 0) == "empty"
    assert suspicious(10, 4) == "drop"
    assert suspicious(10, 5) is None  # 剛好一半不算
    assert suspicious(12, 7) is None  # 減少 5 但未超過一半
    assert suspicious(8, 4) is None  # 剛好一半且只減少 4
    assert suspicious(6, 1) == "drop"
    t, _clock, _u, api = setup()
    many = [wt(f"C:/w/{i}", f"f/{i}") for i in range(10)]
    report(t, {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": many})
    res = report(t, {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": many[:3]})
    assert res.json()["held"] is True and res.json()["reason"] == "drop"
    g = group_of(overview(api), ID_A)
    assert g["repos"][0]["pending"]["reason"] == "drop"
    assert sum(1 for r in g["reports"] if r["missingSince"] is None) == 10
    # 正常的下一次回報會直接採用並清除待確認
    res = report(t, {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": many[:8]})
    assert "held" not in res.json()
    g = group_of(overview(api), ID_A)
    assert g["repos"][0]["pending"] is None and sum(1 for r in g["reports"] if r["missingSince"]) == 2


def test_suspicious_edge_9_to_4():
    assert suspicious(9, 4) == "drop"


def test_moved_worktree_hint_and_update_path():
    t, _clock, _u, api = setup()
    rec = api.request(
        "POST", "/api/eng/worktree-records", {"machine": "PC", "machineId": ID_A, "path": "C:/old/wt", "branch": "feat/x"}
    ).json()
    report(t, {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": [wt("C:/old/wt", "feat/x", "1234567")]})
    report(t, {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": [wt("D:/new/wt", "feat/x", "1234567")]})
    g = group_of(overview(api), ID_A)
    r = g["records"][0]
    assert r["hint"] == "moved" and r["moveTo"]["path"] == "D:/new/wt"
    moved = next(x for x in g["reports"] if x["path"] == "D:/new/wt")
    assert moved["registered"] is False and moved["movedFrom"] == rec["id"]
    # 一鍵更新路徑
    assert api.request("PATCH", f"/api/eng/worktree-records/{rec['id']}", {"path": "D:/new/wt"}).status_code == 200
    g = group_of(overview(api), ID_A)
    assert g["records"][0]["hint"] is None
    assert next(x for x in g["reports"] if x["path"] == "D:/new/wt")["registered"] is True
    # HEAD 不同 → 不是搬動，而是不見 + 未登記
    report(t, {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": [wt("E:/other", "feat/x", "7654321")]})
    g = group_of(overview(api), ID_A)
    assert g["records"][0]["hint"] == "vanished"


def test_report_flows_never_delete_records_or_snapshots():
    """回報流程（一般、空清單、驟減、確認、忽略、改名、換 id）都不會刪除任何 worktree 紀錄或快照列"""
    t, clock, _u, api = setup()
    for i in range(6):
        api.request("POST", "/api/eng/worktree-records", {"machine": "PC", "machineId": ID_A, "path": f"C:/w/{i}", "branch": f"f/{i}"})
    api.request("POST", "/api/eng/worktree-records", {"machine": "PC", "path": "C:/manual", "status": "cleaned"})
    records_before = [dict(r) for r in t.db.all("SELECT * FROM worktree_records ORDER BY id")]
    many = [wt(f"C:/w/{i}", f"f/{i}") for i in range(6)]
    max_rows = 0
    steps = [
        {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": many},
        {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": []},
        {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": many[:1]},
        {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": many[:4]},
        {"machine": "PC-renamed", "machineId": ID_A, "repo": "r", "worktrees": many[2:3]},
        {"machine": "PC", "repo": "r", "worktrees": []},
        {"machine": "PC", "machineId": ID_B, "repo": "r", "worktrees": []},
        {"machine": "PC", "machineId": ID_A, "repo": "other", "worktrees": []},
    ]
    for body in steps:
        clock.advance(MIN)
        assert report(t, body).status_code == 200
        for s in t.db.all("SELECT id FROM worktree_report_sources WHERE pending_json IS NOT NULL"):
            api.request("POST", f"/api/eng/worktrees/pending/{s['id']}/accept")
        rows = t.db.scalar("SELECT count(*) FROM worktree_reports")
        assert rows >= max_rows  # 快照列只增不減
        max_rows = rows
        assert [dict(r) for r in t.db.all("SELECT * FROM worktree_records ORDER BY id")] == records_before
    deletes = t.db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'worktree_plan' AND action = 'delete'")
    assert deletes == 0


def test_stale_machine_flag():
    t, clock, user, api = setup()
    t.app.state.worktree_stale_days = 2
    report(t, {"machine": "PC", "machineId": ID_A, "repo": "r", "worktrees": [wt("C:/a", "f")]})
    assert group_of(overview(api), ID_A)["stale"] is False
    clock.advance(3 * 24 * 60 * MIN)
    data = overview(login_as(t, user))
    assert data["staleDays"] == 2 and group_of(data, ID_A)["stale"] is True
    assert len(group_of(data, ID_A)["reports"]) == 1  # 沒回報也不會讓資料消失


def test_build_overview_pure():
    assert build_overview([], [], []) == []


# ── 回收區（軟刪除 / 還原 / 清空） ──


def test_trash_restore_and_purge_permissions():
    t, clock, member, api = setup()
    manager = create_test_user(t.db, role="manager")
    rec = api.request("POST", "/api/eng/worktree-records", {"machine": "PC", "path": "C:/a"}).json()
    res = api.request("DELETE", f"/api/eng/worktree-records/{rec['id']}")
    assert res.json() == {"ok": True, "trashed": True}
    assert t.db.scalar("SELECT count(*) FROM worktree_records") == 1  # 只是移到回收區
    assert overview(api)["trashCount"] == 1 and overview(api)["machines"] == []
    assert api.request("DELETE", f"/api/eng/worktree-records/{rec['id']}").status_code == 404
    assert api.request("PATCH", f"/api/eng/worktree-records/{rec['id']}", {"note": "x"}).status_code == 404
    # 回收區中的不擋新增同路徑；但還原時會衝突
    dup = api.request("POST", "/api/eng/worktree-records", {"machine": "PC", "path": "C:/a"}).json()
    trash = api.get("/api/eng/worktree-records/trash").json()
    assert trash["retentionDays"] == 30 and [r["id"] for r in trash["records"]] == [rec["id"]]
    assert trash["records"][0]["deletedBy"] is not None and trash["records"][0]["expired"] is False
    assert api.request("POST", f"/api/eng/worktree-records/{rec['id']}/restore").status_code == 409
    api.request("DELETE", f"/api/eng/worktree-records/{dup['id']}")
    res = api.request("POST", f"/api/eng/worktree-records/{rec['id']}/restore")
    assert res.status_code == 200 and res.json()["deletedAt"] is None
    assert api.request("POST", f"/api/eng/worktree-records/{rec['id']}/restore").status_code == 404

    # 超過 30 天：標示已過期，但仍保留、仍可還原（不自動清除）
    api.request("DELETE", f"/api/eng/worktree-records/{rec['id']}")
    clock.advance(31 * 24 * 60 * MIN)
    api = login_as(t, member)
    mgr = login_as(t, manager)
    trash = api.get("/api/eng/worktree-records/trash").json()["records"]
    assert len(trash) == 2 and all(r["expired"] for r in trash)
    overview(api)  # 任何讀取都不會清除
    assert t.db.scalar("SELECT count(*) FROM worktree_records") == 2

    # 清空：成員不可；管理者需確認
    assert api.request("POST", "/api/eng/worktree-records/trash/purge", {"confirm": True}).status_code == 403
    assert mgr.request("POST", "/api/eng/worktree-records/trash/purge", {"confirm": False}).status_code == 400
    assert mgr.request("POST", "/api/eng/worktree-records/trash/purge", {}).status_code == 400
    res = mgr.request("POST", "/api/eng/worktree-records/trash/purge", {"confirm": True})
    assert res.json() == {"ok": True, "purged": 2}
    assert t.db.scalar("SELECT count(*) FROM worktree_records") == 0


# ── (B) 掃描本機專案 ──

GIT = shutil.which("git")
needs_git = pytest.mark.skipif(GIT is None, reason="需要 git")


def git(cwd: Path, *args: str) -> str:
    env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"}
    out = subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        check=True,
    )
    return out.stdout.decode()


@pytest.fixture()
def repo(tmp_path):
    """root/proj：main ＋ 4 個 worktree（feat-a 有提交且 dirty、feat-m 已合併、detached、gone 目錄已刪）"""
    root = tmp_path / "root"
    proj = root / "proj"
    proj.mkdir(parents=True)
    git(proj, "init", "-q")
    (proj / "a.txt").write_text("1")
    git(proj, "add", ".")
    git(proj, "commit", "-qm", "init")
    git(proj, "worktree", "add", "-q", "-b", "feat/a", str(root / "wt-a"))
    (root / "wt-a" / "b.txt").write_text("2")
    git(root / "wt-a", "add", ".")
    git(root / "wt-a", "commit", "-qm", "b")
    (root / "wt-a" / "dirty.txt").write_text("x")
    git(proj, "worktree", "add", "-q", "-b", "feat/m", str(root / "wt-m"))
    (root / "wt-m" / "m.txt").write_text("m")
    git(root / "wt-m", "add", ".")
    git(root / "wt-m", "commit", "-qm", "m")
    git(proj, "merge", "-q", "--no-ff", "-m", "merge m", "feat/m")
    git(proj, "worktree", "add", "-q", "--detach", str(root / "wt-detached"), "HEAD")
    git(proj, "worktree", "add", "-q", "-b", "feat/gone", str(root / "wt-gone"))
    shutil.rmtree(root / "wt-gone")
    (root / "plain").mkdir()
    return root


def scan_setup(tmp_path, root, role="manager"):
    t, clock, user, api = setup(role=role, tmp=tmp_path)
    t.app.state.worktree_scan_roots = str(root)
    return t, clock, user, api


@needs_git
def test_scan_repo_details(repo):
    result = ws.scan_repo(repo / "proj")
    assert result.repo == "proj" and result.base == "main"
    by = {Path(w.path).name: w for w in result.worktrees}
    assert set(by) == {"wt-a", "wt-m", "wt-detached", "wt-gone"}
    a = by["wt-a"]
    assert a.branch == "feat/a" and a.isDirty and a.ahead == 1 and a.behind == 2 and not a.isMerged and a.lastCommitAt
    assert by["wt-m"].isMerged and by["wt-m"].ahead == 0
    d = by["wt-detached"]
    assert d.branch is None and d.isDetached and d.headSha and not d.isMerged
    assert by["wt-gone"].isPrunable
    # 從任一 worktree 掃描結果相同
    assert {Path(w.path).name for w in ws.scan_repo(repo / "wt-a").worktrees} == set(by)


def test_git_runner_refuses_other_commands(tmp_path):
    g = ws.Git()
    for args in (("fetch",), ("worktree", "add", "x"), ("config", "core.x", "y"), ("-c", "x=y")):
        with pytest.raises(ws.ScanError):
            g.run(tmp_path, *args)
    assert "core.fsmonitor=false" in ws.SAFE_CONFIG and "core.hooksPath=" in ws.SAFE_CONFIG


@needs_git
def test_scan_preview_and_apply(tmp_path, repo):
    t, _clock, _u, api = scan_setup(tmp_path, repo)
    data = overview(api)
    assert data["scan"]["enabled"] is True and data["scan"]["roots"] == [os.path.realpath(repo)]
    # 預先手動登記一筆（已登記）＋ 一筆舊路徑（同分支同 HEAD → 可能搬動）
    scanned = {Path(w.path).name: w for w in ws.scan_repo(repo / "proj").worktrees}
    host = ws.local_machine(home=str(tmp_path / "home"))["machineName"]
    api.request("POST", "/api/eng/worktree-records", {"machine": host, "path": scanned["wt-a"].path, "branch": "feat/a"})
    api.request(
        "POST",
        "/api/eng/worktree-records",
        {"machine": host, "path": "C:/old/place", "branch": "feat/m", "headSha": scanned["wt-m"].headSha},
    )
    res = api.request("POST", "/api/eng/worktrees/scan", {"path": str(repo / "proj")})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["repo"] == "proj" and body["machine"] == host
    assert body["counts"] == {"new": 2, "existing": 1, "moved": 1}
    act = {Path(i["path"]).name: i for i in body["items"]}
    assert act["wt-a"]["action"] == "existing" and act["wt-m"]["action"] == "moved"
    assert act["wt-m"]["recordPath"] == "C:/old/place"
    # 預覽不寫入
    assert t.db.scalar("SELECT count(*) FROM worktree_records") == 2

    res = api.request(
        "POST",
        "/api/eng/worktrees/scan/apply",
        {"path": str(repo / "proj"), "paths": [act["wt-detached"]["path"], act["wt-m"]["path"]]},
    )
    assert res.json()["created"] == 1 and res.json()["moved"] == 1
    rows = {Path(r["path"]).name: r for r in t.db.all("SELECT * FROM worktree_records")}
    assert rows["wt-detached"]["source"] == "scan" and rows["wt-detached"]["repo"] == "proj"
    assert rows["wt-detached"]["owner_id"] == _u["id"]  # 掃描登記的負責人預設為呼叫者
    assert rows["wt-detached"]["head_sha"] == act["wt-detached"]["headSha"]
    assert "wt-m" in rows and "place" not in rows  # 搬動：更新路徑，而不是一筆遺失 + 一筆新增
    assert "wt-gone" not in rows  # 未勾選
    # 再掃一次：都已登記
    again = api.request("POST", "/api/eng/worktrees/scan", {"path": str(repo / "proj")}).json()
    assert again["counts"] == {"new": 1, "existing": 3, "moved": 0}


@needs_git
def test_scan_rejections(tmp_path, repo):
    t, _clock, _u, api = scan_setup(tmp_path, repo)

    def scan(path):
        return api.request("POST", "/api/eng/worktrees/scan", {"path": path})

    assert scan(str(repo / "plain")).json()["error"]["code"] == "SCAN_NOT_GIT"
    assert scan(str(repo / "nope")).json()["error"]["code"] == "SCAN_NOT_FOUND"
    assert scan(str(repo / ".." / "outside")).json()["error"]["code"] == "SCAN_OUTSIDE_ROOTS"
    assert scan(str(repo / "proj" / ".." / ".." )).json()["error"]["code"] == "SCAN_OUTSIDE_ROOTS"
    assert scan("relative/path").json()["error"]["code"] == "SCAN_BAD_PATH"
    assert scan(str(tmp_path)).status_code == 400
    # 符號連結逃逸（建立失敗的環境略過此段）
    outside = tmp_path / "outside-repo"
    outside.mkdir()
    link = repo / "link"
    try:
        os.symlink(outside, link, target_is_directory=True)
    except (OSError, NotImplementedError):
        link = None
    if link is not None:
        assert scan(str(link)).json()["error"]["code"] == "SCAN_OUTSIDE_ROOTS"

    # 未啟用
    t.app.state.worktree_scan_roots = None
    res = scan(str(repo / "proj"))
    assert res.status_code == 409 and res.json()["error"]["code"] == "SCAN_DISABLED"
    assert overview(api)["scan"]["enabled"] is False
    assert api.request("POST", "/api/eng/worktrees/scan/apply", {"path": str(repo / "proj"), "paths": []}).status_code == 409


@needs_git
def test_scan_requires_permission(tmp_path, repo):
    _t, _clock, _u, api = scan_setup(tmp_path, repo, role="user")
    assert api.request("POST", "/api/eng/worktrees/scan", {"path": str(repo / "proj")}).status_code == 403
    assert api.request("POST", "/api/eng/worktrees/scan/apply", {"path": str(repo / "proj"), "paths": []}).status_code == 403
    assert "roots" not in overview(api)["scan"]  # 無權限者看不到允許的資料夾


@needs_git
def test_cli_scan_worktrees(tmp_path, repo, monkeypatch, capsys):
    from server import cli

    monkeypatch.setenv("TASKS_SHEETS_HOME", str(tmp_path / "home"))
    db_path = str(tmp_path / "cli.db")
    assert cli.main(["scan-worktrees", str(repo / "proj"), "--db", db_path, "--machine", "DEV", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "新發現（未登記）：4" in out and "未寫入" in out
    # 未確認 → 不寫入
    assert cli.scan_worktrees_cmd([str(repo / "proj"), "--db", db_path], input_fn=lambda _p: "n") == 1
    assert cli.main(["scan-worktrees", str(repo / "proj"), "--db", db_path, "--machine", "DEV", "--repo", "my-proj", "--yes"]) == 0
    db = create_db(db_path)
    rows = db.all("SELECT * FROM worktree_records")
    assert len(rows) == 4 and {r["source"] for r in rows} == {"scan"} and {r["machine"] for r in rows} == {"DEV"}
    assert {r["repo"] for r in rows} == {"my-proj"}
    assert {r["status"] for r in rows} == {"active", "merged"}
    db.close()
    assert cli.main(["scan-worktrees", str(repo / "plain"), "--db", db_path]) == 1
    # machine.json 會在第一次執行時建立
    cfg = json.loads((tmp_path / "home" / "machine.json").read_text(encoding="utf-8"))
    assert ws.valid_machine_id(cfg["machineId"])
