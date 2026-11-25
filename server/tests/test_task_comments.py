"""任務討論區（/api/tasks/:id/comments*）與描述鎖定（tasks.description_locked）。docs/design/task-discussion.md"""

from __future__ import annotations

from server.app.features.task_comments import RATE_LIMIT

from .helpers import MIN, FakeClock, client, create_test_app, create_test_user, login_as
from .test_data_transfer import Env, apply, export, ok, preview


def setup():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    alice = create_test_user(t.db, username="alice", display_name="Alice")
    bob = create_test_user(t.db, username="bob", display_name="Bob")
    boss = create_test_user(t.db, username="boss", display_name="Boss", role="manager")
    a, b, m = login_as(t, alice), login_as(t, bob), login_as(t, boss)
    task = ok(m.request("POST", "/api/tasks", {"title": "討論任務"}), 201)
    return t, clock, (alice, bob, boss), (a, b, m), task


def post(api, task_id: int, body: str, **extra):
    return api.request("POST", f"/api/tasks/{task_id}/comments", {"body": body, **extra})


def threads(api, task_id: int, qs: str = ""):
    return ok(api.get(f"/api/tasks/{task_id}/comments{qs}"))


def changes(t, entity: str = "task_comment") -> list[tuple[int, str]]:
    return [
        (r["entity_id"], r["action"])
        for r in t.db.all("SELECT entity_id, action FROM changes WHERE entity_type = ? ORDER BY id", (entity,))
    ]


# ── CRUD 與兩層結構 ──


def test_create_reply_and_list_threads():
    t, clock, (alice, bob, _boss), (a, b, _m), task = setup()
    tid = task["id"]
    root = ok(post(a, tid, "  這個要怎麼測？  "), 201)
    assert root["body"] == "這個要怎麼測？" and root["parentId"] is None and root["authorId"] == alice["id"]
    assert root["editedAt"] is None and root["deletedAt"] is None and root["mentions"] == []
    clock.advance(MIN)
    reply = ok(post(b, tid, "先跑 pipeline", parentId=root["id"]), 201)
    clock.advance(MIN)
    reply2 = ok(post(a, tid, "好", parentId=root["id"], replyToId=reply["id"]), 201)
    assert reply2["replyToId"] == reply["id"] and reply2["parentId"] == root["id"]
    clock.advance(MIN)
    other = ok(post(b, tid, "另一個話題"), 201)

    res = threads(a, tid)
    assert [th["id"] for th in res["threads"]] == [other["id"], root["id"]]
    th = res["threads"][1]
    assert [r["id"] for r in th["replies"]] == [reply["id"], reply2["id"]]
    assert th["replyCount"] == 2 and th["lastActivityAt"] == reply2["createdAt"]
    assert res["hasMore"] is False and res["nextBefore"] is None
    # 記錄變更流水（entity task_comment）
    assert changes(t) == [(root["id"], "create"), (reply["id"], "create"), (reply2["id"], "create"), (other["id"], "create")]


def test_two_level_validation():
    _t, _clock, _u, (a, _b, m), task = setup()
    tid = task["id"]
    root = ok(post(a, tid, "根"), 201)
    reply = ok(post(a, tid, "回覆", parentId=root["id"]), 201)
    # 回覆的 parent 必須是根訊息
    res = post(a, tid, "第三層", parentId=reply["id"])
    assert res.status_code == 400 and "兩層" in res.json()["error"]["message"]
    # replyToId 需同串且需有 parentId
    assert post(a, tid, "x", replyToId=reply["id"]).status_code == 400
    other_root = ok(post(a, tid, "另一串"), 201)
    assert post(a, tid, "x", parentId=other_root["id"], replyToId=reply["id"]).status_code == 400
    # 其他任務的討論串
    task2 = ok(m.request("POST", "/api/tasks", {"title": "別的任務"}), 201)
    assert post(a, task2["id"], "x", parentId=root["id"]).status_code == 400
    # 內容長度
    assert post(a, tid, "   ").status_code == 400
    assert post(a, tid, "字" * 4001).status_code == 400
    assert post(a, tid, "字" * 4000).status_code == 201
    # 不存在的任務 / 已刪除的任務
    assert post(a, 99999, "x").status_code == 404
    ok(m.request("DELETE", f"/api/tasks/{task2['id']}"))
    assert post(a, task2["id"], "x").status_code == 404
    assert a.get(f"/api/tasks/{task2['id']}/comments").status_code == 404


def test_thread_pagination_cursor_and_reply_paging():
    _t, clock, _u, (a, b, _m), task = setup()
    tid = task["id"]
    roots = []
    for i in range(25):
        clock.advance(1000)
        roots.append(ok(post(a if i % 2 else b, tid, f"討論 {i}"), 201))
    page1 = threads(a, tid)
    assert len(page1["threads"]) == 20 and page1["hasMore"] is True
    assert page1["threads"][0]["id"] == roots[-1]["id"]
    page2 = threads(a, tid, f"?before={page1['nextBefore']}")
    assert [th["id"] for th in page2["threads"]] == [r["id"] for r in reversed(roots[:5])]
    assert page2["hasMore"] is False
    assert len(threads(a, tid, "?limit=3")["threads"]) == 3
    assert a.get(f"/api/tasks/{tid}/comments?before=oops").status_code == 400

    # 回覆讓舊討論串的活動時間更新 → 排到最前
    clock.advance(1000)
    ok(post(a, tid, "補一句", parentId=roots[0]["id"]), 201)
    assert threads(a, tid)["threads"][0]["id"] == roots[0]["id"]

    # 每串最多附 10 則最新回覆 + replyCount；其餘以 /replies 載入
    for i in range(14):
        clock.advance(1000)
        ok(post(b, tid, f"回覆 {i}", parentId=roots[0]["id"]), 201)
    th = threads(a, tid)["threads"][0]
    assert th["replyCount"] == 15 and len(th["replies"]) == 10
    assert th["replies"][-1]["body"] == "回覆 13"
    older = ok(a.get(f"/api/tasks/{tid}/comments/{roots[0]['id']}/replies?before={th['replies'][0]['id']}"))
    assert [r["body"] for r in older["replies"]] == ["補一句", "回覆 0", "回覆 1", "回覆 2", "回覆 3"]
    assert older["hasMore"] is False
    some = ok(a.get(f"/api/tasks/{tid}/comments/{roots[0]['id']}/replies?before={th['replies'][0]['id']}&limit=2"))
    assert [r["body"] for r in some["replies"]] == ["回覆 2", "回覆 3"] and some["hasMore"] is True
    # 只能對根訊息載入回覆
    reply_id = th["replies"][0]["id"]
    assert a.get(f"/api/tasks/{tid}/comments/{reply_id}/replies").status_code == 400


def test_edit_only_by_author_keeps_edited_at():
    t, clock, _u, (a, b, m), task = setup()
    tid = task["id"]
    c = ok(post(a, tid, "原本"), 201)
    clock.advance(MIN)
    edited = ok(a.request("PATCH", f"/api/tasks/{tid}/comments/{c['id']}", {"body": "改過 @bob"}))
    assert edited["body"] == "改過 @bob" and edited["editedAt"] == clock.now() and edited["createdAt"] == c["createdAt"]
    assert edited["mentions"] == [t.db.scalar("SELECT id FROM users WHERE username = 'bob'")]
    # 他人（含管理者）不可編輯
    for other in (b, m):
        res = other.request("PATCH", f"/api/tasks/{tid}/comments/{c['id']}", {"body": "竄改"})
        assert res.status_code == 403
    assert ("update" in [act for _i, act in changes(t)])


def test_soft_delete_keeps_thread_and_permissions():
    t, _clock, (alice, bob, boss), (a, b, m), task = setup()
    tid = task["id"]
    root = ok(post(a, tid, "根訊息"), 201)
    reply = ok(post(b, tid, "回覆", parentId=root["id"]), 201)
    # 他人（一般成員）不能刪除
    assert b.request("DELETE", f"/api/tasks/{tid}/comments/{root['id']}").status_code == 403
    # 作者可刪除自己的
    gone = ok(a.request("DELETE", f"/api/tasks/{tid}/comments/{root['id']}"))
    assert gone["deletedAt"] is not None and gone["deletedBy"] == alice["id"] and gone["body"] == ""
    # 根訊息刪除但仍有回覆：討論串保留，顯示「已刪除」
    th = threads(a, tid)["threads"]
    assert len(th) == 1 and th[0]["deletedAt"] is not None and th[0]["body"] == ""
    assert th[0]["replies"][0]["body"] == "回覆"
    # 已刪除的訊息不可編輯
    assert a.request("PATCH", f"/api/tasks/{tid}/comments/{root['id']}", {"body": "x"}).status_code == 409
    # 管理者可刪除他人的訊息
    ok(m.request("DELETE", f"/api/tasks/{tid}/comments/{reply['id']}"))
    assert t.db.scalar("SELECT deleted_by FROM task_comments WHERE id = ?", (reply["id"],)) == boss["id"]
    # 整串都刪除 → 不再列出；資料仍在（軟刪除）
    assert threads(a, tid)["threads"] == []
    assert t.db.scalar("SELECT count(*) FROM task_comments WHERE task_id = ?", (tid,)) == 2
    # 重複刪除不再記錄
    n = len(changes(t))
    ok(m.request("DELETE", f"/api/tasks/{tid}/comments/{reply['id']}"))
    assert len(changes(t)) == n
    assert bob["id"]


def test_resolve_permissions():
    _t, _clock, (alice, bob, _boss), (a, b, m), task = setup()
    tid = task["id"]
    root = ok(post(a, tid, "問題"), 201)
    reply = ok(post(b, tid, "回覆", parentId=root["id"]), 201)
    # 非作者、非負責人、非管理者 → 403
    assert b.request("POST", f"/api/tasks/{tid}/comments/{root['id']}/resolve").status_code == 403
    # 作者可標記
    r = ok(a.request("POST", f"/api/tasks/{tid}/comments/{root['id']}/resolve"))
    assert r["threadResolvedAt"] is not None and r["threadResolvedBy"] == alice["id"]
    ok(a.request("POST", f"/api/tasks/{tid}/comments/{root['id']}/unresolve"))
    # 任務負責人可標記
    ok(m.request("PATCH", f"/api/tasks/{tid}", {"assigneeId": bob["id"]}))
    r = ok(b.request("POST", f"/api/tasks/{tid}/comments/{root['id']}/resolve"))
    assert r["threadResolvedBy"] == bob["id"]
    # 管理者可重新開啟
    r = ok(m.request("POST", f"/api/tasks/{tid}/comments/{root['id']}/unresolve"))
    assert r["threadResolvedAt"] is None and r["threadResolvedBy"] is None
    # 只有根訊息可標記
    assert a.request("POST", f"/api/tasks/{tid}/comments/{reply['id']}/resolve").status_code == 400


def test_mentions_parsed_and_validated():
    t, _clock, (alice, bob, boss), (a, _b, _m), task = setup()
    tid = task["id"]
    create_test_user(t.db, username="gone", is_active=0)
    c = ok(post(a, tid, "@bob 和 @BOSS 看一下，@nobody 不存在、@gone 已停用，信箱 x@bob.com 不算，@bob 重複"), 201)
    assert c["mentions"] == [bob["id"], boss["id"]]
    c2 = ok(post(a, tid, "句尾提及 @alice."), 201)
    assert c2["mentions"] == [alice["id"]]


def test_unread_counts_and_aggregate_fields():
    t, _clock, _u, (a, b, m), task = setup()
    tid = task["id"]
    other = ok(m.request("POST", "/api/tasks", {"title": "沒有留言"}), 201)
    ok(post(a, tid, "Alice 的話"), 201)
    ok(post(a, tid, "@bob 看這裡"), 201)
    mine = ok(post(b, tid, "Bob 自己的話"), 201)

    def stats(api, task_id):
        listed = {x["id"]: x for x in ok(api.get("/api/tasks"))}[task_id]
        detail = ok(api.get(f"/api/tasks/{task_id}"))
        assert (listed["commentCount"], listed["unreadComments"]) == (detail["commentCount"], detail["unreadComments"])
        return detail["commentCount"], detail["unreadComments"]

    # 自己的留言不算未讀
    assert stats(b, tid) == (3, 2)
    assert stats(a, tid) == (3, 1)
    assert stats(b, other["id"]) == (0, 0)
    # 已讀後清零；之後他人新留言才算
    assert ok(b.request("POST", f"/api/tasks/{tid}/comments/read"))["lastReadCommentId"] == mine["id"]
    assert stats(b, tid) == (3, 0)
    assert threads(b, tid)["lastReadCommentId"] == mine["id"]
    ok(post(a, tid, "新的"), 201)
    assert stats(b, tid) == (4, 1)
    # 刪除的留言不計入
    c = ok(post(a, tid, "要刪掉"), 201)
    ok(a.request("DELETE", f"/api/tasks/{tid}/comments/{c['id']}"))
    assert stats(b, tid) == (4, 1)
    # 標記已讀不記錄變更流水，且唯讀成員（無 comments.write）也能標記
    n = t.db.scalar("SELECT count(*) FROM changes")
    t.db.execute("INSERT INTO role_permissions (role, capability, allowed, updated_at) VALUES ('user', 'comments.write', 0, 1)")
    from server.app.permissions import invalidate

    invalidate(t.db)
    ok(b.request("POST", f"/api/tasks/{tid}/comments/read"))
    assert t.db.scalar("SELECT count(*) FROM changes") == n
    assert post(b, tid, "不能寫").status_code == 403


def test_list_aggregate_has_no_n_plus_one():
    t, _clock, _u, (a, _b, m), _task = setup()
    for i in range(30):
        tk = ok(m.request("POST", "/api/tasks", {"title": f"任務 {i}"}), 201)
        ok(post(a, tk["id"], "hi"), 201)
    statements: list[str] = []
    t.db.conn.set_trace_callback(statements.append)
    try:
        ok(a.get("/api/tasks"))
    finally:
        t.db.conn.set_trace_callback(None)
    assert sum(1 for s in statements if "task_comments" in s) == 1


def test_rate_limit():
    _t, clock, _u, (a, b, _m), task = setup()
    tid = task["id"]
    for i in range(RATE_LIMIT):
        ok(post(a, tid, f"洗 {i}"), 201)
    res = post(a, tid, "再一則")
    assert res.status_code == 429 and "稍候" in res.json()["error"]["message"]
    # 不影響其他人；一分鐘後恢復
    ok(post(b, tid, "我還可以"), 201)
    clock.advance(MIN + 1)
    ok(post(a, tid, "恢復了"), 201)


def test_auth_and_permission_matrix():
    t, _clock, _u, (a, _b, m), task = setup()
    tid = task["id"]
    anon = client(t)
    assert anon.get(f"/api/tasks/{tid}/comments").status_code == 401
    assert anon.request("POST", f"/api/tasks/{tid}/comments", {"body": "x"}).status_code == 401
    # 收回 user 的 comments.write → 403；仍可讀
    ok(
        create_root(t).request(
            "PUT", "/api/admin/permissions", {"changes": [{"role": "user", "capability": "comments.write", "allowed": False}]}
        )
    )
    assert post(a, tid, "x").status_code == 403
    assert a.get(f"/api/tasks/{tid}/comments").status_code == 200
    # comments.write 與 tasks.edit 分開：manager 仍可留言
    assert post(m, tid, "管理者可以").status_code == 201


def create_root(t):
    return login_as(t, create_test_user(t.db, role="root"))


def test_cascade_on_task_hard_delete():
    t, _clock, _u, (a, b, _m), task = setup()
    tid = task["id"]
    root = ok(post(a, tid, "根"), 201)
    ok(post(b, tid, "回", parentId=root["id"]), 201)
    ok(b.request("POST", f"/api/tasks/{tid}/comments/read"))
    with t.db.tx() as conn:
        conn.execute("DELETE FROM tasks WHERE id = ?", (tid,))
    assert t.db.scalar("SELECT count(*) FROM task_comments") == 0
    assert t.db.scalar("SELECT count(*) FROM task_comment_reads") == 0


def test_uid_trigger():
    t, _clock, _u, (a, _b, _m), task = setup()
    c = ok(post(a, task["id"], "x"), 201)
    uid = t.db.scalar("SELECT uid FROM task_comments WHERE id = ?", (c["id"],))
    assert isinstance(uid, str) and len(uid) == 32


# ── 匯出 / 匯入 ──


def test_export_import_roundtrip(tmp_path):
    src = Env(tmp_path, name="a")
    api = src.api
    task = ok(api.request("POST", "/api/tasks", {"title": "有討論的任務", "descriptionLocked": True}), 201)
    alice_api = login_as(src.t, src.member)
    root = ok(post(alice_api, task["id"], "@admin-a 請看"), 201)
    reply = ok(post(api, task["id"], "收到", parentId=root["id"]), 201)
    ok(post(alice_api, task["id"], "謝謝", parentId=root["id"], replyToId=reply["id"]), 201)
    ok(api.request("POST", f"/api/tasks/{task['id']}/comments/{root['id']}/resolve"))
    gone = ok(post(api, task["id"], "要刪的"), 201)
    ok(api.request("DELETE", f"/api/tasks/{task['id']}/comments/{gone['id']}"))
    doc = export(src)
    assert len(doc["taskComments"]) == 4
    first = doc["taskComments"][0]
    assert first["authorUsername"] == "alice" and first["mentionUsernames"] == ["admin-a"]
    assert first["threadResolvedByUsername"] == "admin-a"
    assert doc["taskComments"][2]["replyToUid"] == doc["taskComments"][1]["uid"]
    t_item = next(x for x in doc["tasks"] if x["title"] == "有討論的任務")
    assert t_item["descriptionLocked"] is True and t_item["lockedByUsername"] == "admin-a"

    dst = Env(tmp_path, name="b")
    pv = preview(dst, doc)
    assert pv["taskComments"]["new"] == 4
    result = apply(dst, pv["token"], missingUsers="create")
    assert result["taskComments"]["created"] == 4
    again = export(dst)
    by_uid = lambda items: sorted(items, key=lambda x: x["uid"])  # noqa: E731
    assert by_uid(again["taskComments"]) == by_uid(doc["taskComments"])
    # 再匯入一次：不重複
    result2 = apply(dst, preview(dst, doc)["token"])
    assert result2["taskComments"]["created"] == 0 and result2["taskComments"]["unchanged"] == 4
    assert dst.db.scalar("SELECT count(*) FROM task_comments") == 4


def test_import_old_file_without_comments(tmp_path):
    src = Env(tmp_path, name="a")
    ok(src.api.request("POST", "/api/tasks", {"title": "舊檔"}), 201)
    doc = export(src)
    del doc["taskComments"]
    for x in doc["tasks"]:
        for k in ("descriptionLocked", "lockedByUsername", "lockedAt"):
            del x[k]
    dst = Env(tmp_path, name="b")
    pv = preview(dst, doc)
    assert pv["taskComments"]["total"] == 0
    apply(dst, pv["token"], missingUsers="create")


def test_import_rejects_dangling_comment_refs(tmp_path):
    src = Env(tmp_path, name="a")
    task = ok(src.api.request("POST", "/api/tasks", {"title": "x"}), 201)
    ok(post(src.api, task["id"], "根"), 201)
    doc = export(src)
    doc["taskComments"][0]["parentUid"] = "f" * 32
    res = src.api.request("POST", "/api/admin/data/import/preview", doc)
    assert res.status_code == 400


# ── 描述鎖定 ──


def test_description_lock_rules():
    t, clock, (_alice, _bob, boss), (a, _b, m), task = setup()
    tid = task["id"]
    assert task["descriptionLocked"] is False and task["lockedBy"] is None
    # 一般成員不能切換鎖
    res = a.request("PATCH", f"/api/tasks/{tid}", {"descriptionLocked": True})
    assert res.status_code == 403 and res.json()["error"]["message"] == "沒有權限執行此操作"
    clock.advance(MIN)
    locked = ok(m.request("PATCH", f"/api/tasks/{tid}", {"descriptionLocked": True}))
    assert locked["descriptionLocked"] is True and locked["lockedBy"] == boss["id"] and locked["lockedAt"] == clock.now()
    got = ok(a.get(f"/api/tasks/{tid}"))
    assert (got["descriptionLocked"], got["lockedBy"]) == (True, boss["id"])
    assert any(x["id"] == tid and x["descriptionLocked"] for x in ok(a.get("/api/tasks")))
    # 鎖定後一般成員改描述 → 403 且訊息親切
    res = a.request("PATCH", f"/api/tasks/{tid}", {"description": "我改一下"})
    assert res.status_code == 403
    assert res.json()["error"]["message"] == "描述已由管理者鎖定，請把補充寫在討論區"
    # 內容相同（未實際修改）不擋；其他欄位不受影響
    ok(a.request("PATCH", f"/api/tasks/{tid}", {"description": ""}))
    ok(a.request("PATCH", f"/api/tasks/{tid}", {"title": "改標題可以", "progress": 30}))
    # 有權限者仍可編輯
    ok(m.request("PATCH", f"/api/tasks/{tid}", {"description": "PM 的描述"}))
    # 解鎖後恢復
    n = t.db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'task'")
    unlocked = ok(m.request("PATCH", f"/api/tasks/{tid}", {"descriptionLocked": False}))
    assert unlocked["descriptionLocked"] is False and unlocked["lockedBy"] is None and unlocked["lockedAt"] is None
    assert t.db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'task'") == n + 1
    ok(a.request("PATCH", f"/api/tasks/{tid}", {"description": "大家都能改了"}))
    # 建立時直接鎖定：需 tasks.lock
    assert a.request("POST", "/api/tasks", {"title": "x", "descriptionLocked": True}).status_code == 403
    created = ok(m.request("POST", "/api/tasks", {"title": "建立後鎖定", "descriptionLocked": True}), 201)
    assert created["descriptionLocked"] is True and created["lockedBy"] == boss["id"]
    # 非布林拒絕
    assert m.request("PATCH", f"/api/tasks/{tid}", {"descriptionLocked": 1}).status_code == 400
