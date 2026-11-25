"""貼上 git worktree list 輸出：解析器（純函式）與 /api/eng/worktrees/paste/{preview,apply}"""

from __future__ import annotations

import pytest

from server.app import worktree_paste as wp
from server.app.features.eng_paste import DEFAULT_MACHINE

from .helpers import client, create_test_app, create_test_user, login_as

# 已去識別的真實格式範例
SAMPLE = """\
C:/Users/someone/Desktop/local專案/Main-Repo                                      80a0d97a [feat/extrepo-phase2]
C:/Users/someone/AppData/Local/Temp/claude/abc123/scratchpad/master_base          2e213717 (detached HEAD)
C:/Users/someone/Desktop/local專案/Main-Repo/.claude/worktrees/agent-a238ac466903f90b4  33b6a929 [worktree-agent-a238ac466903f90b4] locked
C:/Users/someone/Desktop/local專案/Main-Repo/.claude/worktrees/agent-a458f9f92f1744e0c  ff16b462 [worktree-agent-a458f9f92f1744e0c]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneA                           16687b8d [hotfix/gitea-ssl-fallback]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneB                           241e5bc4 [feat/db_redesign]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneC1                          30145fda [feat/aca-rebuild-r7-fix-c1]
C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneC2                          30145fda [feat/aca-rebuild-ac-redo-support]
"""

PORCELAIN = """\
worktree C:/Users/someone/Desktop/My Repo
HEAD 80a0d97a1111111111111111111111111111aaaa
branch refs/heads/main

worktree C:/Users/someone/AppData/Local/Temp/wt1
HEAD 2e213717aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
detached
locked 正在使用

worktree D:/old/gone
HEAD 33b6a9291111111111111111111111111111bbbb
branch refs/heads/feat/x
prunable gitdir file points to non-existent location

worktree D:/repos/bare.git
bare
"""


def by_path(r: wp.ParseResult) -> dict[str, wp.ParsedWorktree]:
    return {e.path: e for e in r.entries}


# ── 解析器 ──


def test_sample_default_format():
    r = wp.parse_worktree_list(SAMPLE)
    assert len(r.entries) == 8 and r.unparsed == [] and not r.truncated
    main, detached, locked, agent = r.entries[:4]
    assert main.isMain and main.path.endswith("local專案/Main-Repo") and main.sha == "80a0d97a"
    assert main.branch == "feat/extrepo-phase2" and not main.isTemp
    assert detached.isDetached and detached.branch is None and detached.sha == "2e213717"
    assert locked.isLocked and locked.branch == "worktree-agent-a238ac466903f90b4" and locked.isTemp
    assert agent.isTemp and not agent.isLocked
    assert [e.isMain for e in r.entries].count(True) == 1
    assert r.entries[4].branch == "hotfix/gitea-ssl-fallback" and not r.entries[4].isTemp
    assert r.entries[0].lineNo == 1 and r.entries[7].lineNo == 8
    assert r.repo == "Main-Repo"


def test_windows_backslash_and_spaces_and_cjk_paths():
    r = wp.parse_worktree_list(
        "C:\\Users\\王小明\\My Projects\\專案 A   abcdef12 [feat/中文分支]\n"
        "D:\\a b\\c d  1234567 [main]\n"
        "/home/user/my repo/wt one 12345678 [x] \n"
    )
    assert [e.path for e in r.entries] == [
        "C:\\Users\\王小明\\My Projects\\專案 A",
        "D:\\a b\\c d",
        "/home/user/my repo/wt one",
    ]
    assert r.entries[0].branch == "feat/中文分支" and r.entries[1].sha == "1234567"
    assert r.unparsed == []


def test_path_containing_sha_like_token():
    r = wp.parse_worktree_list("C:/x/deadbeef1 abc/foo  80a0d97a [b]\n")
    assert r.entries[0].path == "C:/x/deadbeef1 abc/foo" and r.entries[0].sha == "80a0d97a"


def test_sha_boundaries():
    ok = wp.parse_worktree_list("/p/a 1234567 [a]\n/p/b " + "a" * 40 + " [b]\n")
    assert len(ok.entries) == 2
    bad = wp.parse_worktree_list("/p/a 123456 [a]\n/p/b " + "a" * 41 + " [b]\n/p/c zzzzzzzz [c]\n")
    assert bad.entries == [] and bad.unparsedCount == 3


def test_flags_locked_prunable_with_reason():
    r = wp.parse_worktree_list(
        "/p/a  1234567 [a] locked\n"
        "/p/b  1234567 [b] locked 正在 rebase 中\n"
        "/p/c  1234567 [c] prunable\n"
        "/p/d  1234567 [d] prunable gitdir file points to non-existent location\n"
        "/p/e  1234567 (detached HEAD) locked prunable\n"
        "/p/f  1234567 [f] weird\n"
    )
    a, b, c, d, e = r.entries
    assert a.isLocked and a.lockReason == ""
    assert b.isLocked and b.lockReason == "正在 rebase 中"
    assert c.isPrunable and d.isPrunable and d.prunableReason.startswith("gitdir")
    assert e.isDetached and e.isLocked and e.isPrunable
    assert r.unparsedCount == 1 and r.unparsed[0]["lineNo"] == 6


def test_bare_default_and_verbose_continuation():
    r = wp.parse_worktree_list(
        "/srv/git/repo.git      (bare)\n"
        "/srv/wt/a  1234567 [a]\n"
        "\tprunable: gitdir file points to non-existent location\n"
        "/srv/wt/b  1234567 [b]\n"
        "\tlocked: 保留\n"
    )
    bare, a, b = r.entries
    assert bare.isBare and bare.sha is None and bare.isMain and r.repo == "repo"
    assert a.isPrunable and "non-existent" in a.prunableReason
    assert b.isLocked and b.lockReason == "保留"


def test_porcelain():
    r = wp.parse_worktree_list(PORCELAIN)
    assert len(r.entries) == 4 and r.unparsed == []
    main, tmp, gone, bare = r.entries
    assert main.path == "C:/Users/someone/Desktop/My Repo" and main.branch == "main" and main.isMain
    assert main.sha == "80a0d97a1111111111111111111111111111aaaa" and r.repo == "My Repo"
    assert tmp.isDetached and tmp.isLocked and tmp.lockReason == "正在使用" and tmp.isTemp
    assert gone.branch == "feat/x" and gone.isPrunable and gone.prunableReason
    assert bare.isBare and bare.sha is None
    assert [e.lineNo for e in r.entries] == [1, 5, 10, 15]


def test_porcelain_nul_separated():
    r = wp.parse_worktree_list("worktree C:/a\0HEAD " + "a" * 40 + "\0branch refs/heads/m\0\0worktree C:/b\0HEAD " + "b" * 40 + "\0detached\0\0")
    assert [e.path for e in r.entries] == ["C:/a", "C:/b"] and r.entries[1].isDetached


def test_prompt_blank_and_noise_lines():
    r = wp.parse_worktree_list(
        "C:\\Users\\x>git worktree list\n"
        "PS C:\\Users\\John Doe\\repo> git worktree list\n"
        "$ git worktree list\n"
        "C:\\Users\\x>\n"
        "\n"
        "   \n"
        "C:/repo  1234567 [main]\n"
        "some noise here\n"
        "fatal: not a git repository\n"
    )
    assert len(r.entries) == 1 and r.entries[0].lineNo == 7
    assert [u["text"] for u in r.unparsed] == ["some noise here", "fatal: not a git repository"]
    assert [u["lineNo"] for u in r.unparsed] == [8, 9]


def test_temp_reasons_rules():
    def tr(path, branch=None, detached=False):
        return wp.temp_reasons(path, branch, detached)

    assert tr("C:/r/.claude/worktrees/x")
    assert tr("C:/work/scratchpad/base")
    assert tr("C:\\Users\\u\\AppData\\Local\\Temp\\foo")
    assert tr("/tmp/wt")
    assert tr("C:/work/agent-abc")
    assert tr("C:/work/ok", "worktree-agent-1")
    assert tr("C:/Users/u/AppData/Local/Temp/x", None, True)
    assert tr("C:/work/pyDMS_laneA", "feat/x") == []
    assert tr("C:/work/attempt/wt", "main") == []  # /tmp/ 需完整資料夾比對
    assert tr("C:/work/tmpfoo/wt") == []


def test_limits():
    with pytest.raises(wp.PasteError):
        wp.parse_worktree_list("x" * (wp.MAX_BYTES + 1))
    with pytest.raises(wp.PasteError):
        wp.parse_worktree_list("  \n \n")
    many = "".join(f"/p/wt{i}  1234567 [b{i}]\n" for i in range(wp.MAX_ENTRIES + 20))
    r = wp.parse_worktree_list(many)
    assert len(r.entries) == wp.MAX_ENTRIES and r.truncated
    noise = wp.parse_worktree_list("junk\n" * 300)
    assert noise.entries == [] and noise.unparsedCount == 300 and len(noise.unparsed) == wp.MAX_UNPARSED


# ── API ──


def setup(role: str = "user"):
    t = create_test_app()
    user = create_test_user(t.db, role=role)
    return t, user, login_as(t, user)


def preview(api, text=SAMPLE, **kw):
    return api.request("POST", "/api/eng/worktrees/paste/preview", {"text": text, **kw})


def apply(api, selected, text=SAMPLE, machine="PC-A", **kw):
    return api.request("POST", "/api/eng/worktrees/paste/apply", {"text": text, "machine": machine, "selected": selected, **kw})


def records(t):
    return t.db.all("SELECT * FROM worktree_records WHERE deleted_at IS NULL ORDER BY id")


def test_requires_login_and_capability():
    t = create_test_app()
    assert client(t).request("POST", "/api/eng/worktrees/paste/preview", {"text": SAMPLE}).status_code == 401
    assert client(t).request("POST", "/api/eng/worktrees/paste/apply", {"text": SAMPLE, "machine": "a", "selected": [1]}).status_code == 401
    # 收回 eng.edit 後 403
    admin = create_test_user(t.db, role="root")
    root = login_as(t, admin)
    res = root.request(
        "PUT", "/api/admin/permissions", {"changes": [{"role": "user", "capability": "eng.edit", "allowed": False}]}
    )
    assert res.status_code == 200
    user = create_test_user(t.db, role="user")
    assert preview(login_as(t, user)).status_code == 403


def test_preview_basic():
    _t, _u, api = setup()
    res = preview(api)
    assert res.status_code == 200
    body = res.json()
    assert body["machine"] == DEFAULT_MACHINE and body["repo"] == "Main-Repo" and body["repoGuess"] == "Main-Repo"
    assert body["counts"] == {"new": 8, "existing": 0, "moved": 0} and body["unparsedCount"] == 0
    items = body["items"]
    assert items[0]["isMain"] and not items[0]["isTemp"]
    assert items[1]["isTemp"] and items[1]["isDetached"]
    assert items[2]["isLocked"] and items[2]["isTemp"]
    assert items[4]["isTemp"] is False
    assert preview(api, repo="自訂").json()["repo"] == "自訂"
    assert preview(api, text="   ").status_code == 400
    assert preview(api, text="x" * 250_000).status_code == 400


def test_apply_creates_records_and_changes():
    t, user, api = setup()
    # 只勾選非暫時性（行號 1、5、6）
    res = apply(api, [1, 5, 6])
    assert res.status_code == 200
    assert res.json() | {} == {"ok": True, "machine": "PC-A", "repo": "Main-Repo", "created": 3, "updated": 0, "skipped": 0}
    rows = records(t)
    assert [r["branch"] for r in rows] == ["feat/extrepo-phase2", "hotfix/gitea-ssl-fallback", "feat/db_redesign"]
    r = rows[0]
    assert r["machine"] == "PC-A" and r["source"] == "paste" and r["repo"] == "Main-Repo" and r["head_sha"] == "80a0d97a"
    assert r["status"] == "active" and r["note"] == "由貼上匯入；sha 80a0d97a"
    assert r["created_by"] == user["id"] and r["machine_id"] is None
    n = t.db.one("SELECT count(*) FROM changes WHERE entity_type = 'worktree_plan' AND action = 'create'")[0]
    assert n == 3
    # 預覽現在顯示已存在
    counts = preview(api, machine="pc-a").json()["counts"]
    assert counts == {"new": 5, "existing": 3, "moved": 0}


def test_apply_note_flags_and_status():
    t, _u, api = setup()
    res = apply(api, [3, 2], status="active")
    assert res.json()["created"] == 2
    notes = {r["branch"]: r["note"] for r in records(t)}
    assert notes["worktree-agent-a238ac466903f90b4"] == "由貼上匯入；sha 33b6a929；locked"
    assert notes[""] == "由貼上匯入；sha 2e213717；detached HEAD"


def test_apply_status_validation():
    t, _u, api = setup()
    assert apply(api, [1], status="nope").status_code == 400
    assert records(t) == []
    keys = [s["key"] for s in api.get("/api/eng/statuses?kind=worktree").json()["statuses"]]
    other = next(k for k in keys if k != "active")
    assert apply(api, [1], status=other).status_code == 200
    assert records(t)[0]["status"] == other


def test_apply_idempotent():
    t, _u, api = setup()
    assert apply(api, [1, 5, 6]).json()["created"] == 3
    again = apply(api, [1, 5, 6]).json()
    assert (again["created"], again["updated"], again["skipped"]) == (0, 0, 3)
    assert len(records(t)) == 3
    # 路徑大小寫與斜線方向不同也視為同一筆
    alt = SAMPLE.replace("C:/Users/someone/Desktop/local專案/Main-Repo   ", "c:\\users\\SOMEONE\\desktop\\local專案\\main-repo   ", 1)
    assert apply(api, [1], text=alt).json()["skipped"] == 1 and len(records(t)) == 3
    # 不同電腦同路徑是另一筆
    assert apply(api, [1], machine="PC-B").json()["created"] == 1


def test_apply_reparses_server_side_ignores_tampered_selection():
    t, _u, api = setup()
    # 行號超出範圍、不存在的路徑：不會建立任何東西；也不能送來「解析結果」夾帶欄位
    res = api.request(
        "POST",
        "/api/eng/worktrees/paste/apply",
        {
            "text": SAMPLE,
            "machine": "PC-A",
            "selected": [999, "C:/not/in/paste"],
            "items": [{"path": "C:/evil", "branch": "evil", "sha": "deadbeef"}],
            "path": "C:/evil",
        },
    )
    assert res.status_code == 200 and res.json()["created"] == 0 and records(t) == []
    # 以路徑選取，內容以伺服器解析為準
    p = "c:\\users\\someone\\desktop\\local專案\\worktrees\\pyDMS_laneA"
    assert apply(api, [p]).json()["created"] == 1
    r = records(t)[0]
    assert r["path"] == "C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneA" and r["branch"] == "hotfix/gitea-ssl-fallback"
    # 型別不對 → 400
    assert apply(api, [{"x": 1}]).status_code == 400
    assert apply(api, [1], machine="").status_code == 400


def test_apply_update_existing():
    t, user, api = setup()
    apply(api, [5])
    old = records(t)[0]
    # 使用者自己寫的備註不被蓋掉；貼上匯入的備註會更新
    t.db.execute("UPDATE worktree_records SET note = '我的備註' WHERE id = ?", (old["id"],))
    changed = SAMPLE.replace("[hotfix/gitea-ssl-fallback]", "[hotfix/renamed]").replace("16687b8d", "99999999")
    # 預設略過
    assert apply(api, [5], text=changed).json() | {} == {
        "ok": True, "machine": "PC-A", "repo": "Main-Repo", "created": 0, "updated": 0, "skipped": 1
    }
    assert records(t)[0]["branch"] == "hotfix/gitea-ssl-fallback"
    res = apply(api, [5], text=changed, updateExisting=True).json()
    assert res["updated"] == 1 and res["created"] == 0
    r = records(t)[0]
    assert r["branch"] == "hotfix/renamed" and r["head_sha"] == "99999999" and r["note"] == "我的備註"
    n = t.db.one("SELECT count(*) FROM changes WHERE entity_type = 'worktree_plan' AND action = 'update'")[0]
    assert n >= 1
    # 沒有差異時不算更新
    assert apply(api, [5], text=changed, updateExisting=True).json()["skipped"] == 1


def test_moved_detection_and_apply():
    t, _u, api = setup()
    apply(api, [5])
    moved = SAMPLE.replace("C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneA", "D:/elsewhere/laneA")
    body = preview(api, text=moved, machine="PC-A").json()
    item = next(i for i in body["items"] if i["path"] == "D:/elsewhere/laneA")
    assert item["action"] == "moved" and item["recordPath"].endswith("pyDMS_laneA")
    assert body["counts"]["moved"] == 1
    # 不同分支或不同 sha 不算搬動
    other = moved.replace("16687b8d", "11111111")
    assert preview(api, text=other, machine="PC-A").json()["counts"]["moved"] == 0
    # 套用：更新舊紀錄的路徑（不新增）
    res = apply(api, [5], text=moved).json()
    assert res["updated"] == 1 and res["created"] == 0
    assert [r["path"] for r in records(t)] == ["D:/elsewhere/laneA"]


def test_duplicate_lines_in_paste_only_create_once():
    t, _u, api = setup()
    text = "C:/a/wt  1234567 [x]\nC:\\a\\wt  1234567 [x]\n"
    res = apply(api, [1, 2], text=text).json()
    assert res["created"] == 1 and res["skipped"] == 1 and len(records(t)) == 1


def test_apply_all_or_nothing_on_bad_status():
    t, _u, api = setup()
    assert apply(api, [1, 5], status="missing").status_code == 400
    assert records(t) == []


def test_apply_owner_defaults_to_caller_and_validates():
    t, u, api = setup()
    assert apply(api, [1]).json()["created"] == 1
    assert records(t)[0]["owner_id"] == u["id"]  # 預設為呼叫者
    other = create_test_user(t.db, role="user")
    assert apply(api, [2], ownerId=other["id"]).status_code == 200
    assert records(t)[1]["owner_id"] == other["id"]
    gone = create_test_user(t.db, role="user", is_active=0)
    assert apply(api, [1], machine="PC-Z", ownerId=gone["id"]).status_code == 400
    assert apply(api, [1], machine="PC-Z", ownerId=99999).status_code == 400
    assert len(records(t)) == 2  # 驗證失敗不寫入
