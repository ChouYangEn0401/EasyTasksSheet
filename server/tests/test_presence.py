"""/api/presence 與 SSE `presence` 事件（docs/design/presence.md）。"""

from __future__ import annotations

import dataclasses
import json
from typing import Iterator

import pytest

from server.app.presence import presence_options, registry_for
from server.app.sync_hub import sync_options

from .helpers import MIN, FakeClock, create_test_app, create_test_user, login_as
from .test_sync import SseReader, live, wait_until  # noqa: F401 — live 為 fixture

_DEFAULTS = dataclasses.asdict(presence_options)
_SYNC_DEFAULTS = dataclasses.asdict(sync_options)
SEC = 1000


@pytest.fixture(autouse=True)
def _restore_options() -> Iterator[None]:
    yield
    for k, v in _DEFAULTS.items():
        setattr(presence_options, k, v)
    for k, v in _SYNC_DEFAULTS.items():
        setattr(sync_options, k, v)


def setup():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    alice = create_test_user(t.db, display_name="Alice")
    bob = create_test_user(t.db, display_name="晴恩")
    a = login_as(t, alice)
    b = login_as(t, bob)
    return t, clock, alice, bob, a, b


def members(c) -> dict[int, dict]:
    res = c.get("/api/presence")
    assert res.status_code == 200, res.text
    return {m["userId"]: m for m in res.json()["members"]}


def put(c, body: dict):
    res = c.request("PUT", "/api/presence", body)
    assert res.status_code == 200, res.text
    return res


def test_requires_login_and_csrf():
    t = create_test_app()
    assert t.http.get("/api/presence").status_code == 401
    _t, _clock, _alice, _bob, a, _b = setup()
    res = a.request("PUT", "/api/presence", {"view": "x"}, headers={"content-type": "text/plain"})
    assert res.status_code == 403


def test_defaults_and_config():
    _t, _clock, _alice, _bob, a, _b = setup()
    body = a.get("/api/presence").json()
    assert body["onlineMs"] == presence_options.online_ms
    assert body["idleMs"] == presence_options.idle_ms
    assert body["keepaliveMs"] <= 20_000
    assert body["keepaliveMs"] <= presence_options.online_ms // 2


def test_report_view_and_entity_then_timeouts():
    t, clock, alice, bob, a, b = setup()
    task = a.request("POST", "/api/tasks", {"title": "ntu ranking new workflow"}).json()

    m = members(a)
    assert m[bob["id"]]["status"] == "offline"
    assert m[bob["id"]]["lastSeenAt"] is None

    put(b, {"view": "甘特圖", "entity": {"type": "task", "id": task["id"], "mode": "editing"}})
    m = members(a)[bob["id"]]
    assert m == {
        "userId": bob["id"],
        "status": "online",
        "view": "甘特圖",
        "entity": {"type": "task", "id": task["id"], "title": "ntu ranking new workflow", "mode": "editing"},
        "lastSeenAt": clock.now(),
        "lastView": "甘特圖",
    }
    # 只含必要欄位
    assert set(m) == {"userId", "status", "view", "entity", "lastSeenAt", "lastView"}

    clock.advance(presence_options.online_ms)
    assert members(a)[bob["id"]]["status"] == "idle"
    # 閒置時仍顯示最後在看的頁面
    assert members(a)[bob["id"]]["view"] == "甘特圖"

    clock.advance(presence_options.idle_ms)
    m = members(a)[bob["id"]]
    assert m["status"] == "offline"
    assert m["view"] is None and m["entity"] is None
    assert m["lastView"] == "甘特圖"
    assert m["lastSeenAt"] == clock.now() - presence_options.online_ms - presence_options.idle_ms
    assert bob["id"] not in registry_for(t.db).entries


def test_state_idle_and_away():
    _t, _clock, _alice, bob, a, b = setup()
    put(b, {"view": "清單"})
    put(b, {"view": "清單", "state": "idle"})
    assert members(a)[bob["id"]]["status"] == "idle"
    put(b, {"view": "清單", "state": "away"})
    m = members(a)[bob["id"]]
    assert m["status"] == "offline"
    assert m["lastView"] == "清單"


def test_hidden_clears_view_and_entity():
    t, _clock, _alice, bob, a, b = setup()
    task = a.request("POST", "/api/tasks", {"title": "秘密"}).json()
    put(b, {"view": "清單", "entity": {"type": "task", "id": task["id"]}, "hidden": True})
    m = members(a)[bob["id"]]
    assert m["status"] == "online"
    assert m["view"] is None and m["entity"] is None and m["lastView"] is None
    assert t.db.scalar("SELECT last_view FROM user_presence WHERE user_id = ?", (bob["id"],)) is None


def test_deleted_or_missing_task_is_dropped():
    _t, _clock, _alice, bob, a, b = setup()
    task = a.request("POST", "/api/tasks", {"title": "將刪除"}).json()
    a.request("DELETE", f"/api/tasks/{task['id']}")
    put(b, {"view": "清單", "entity": {"type": "task", "id": task["id"]}})
    assert members(a)[bob["id"]]["entity"] is None
    put(b, {"view": "清單", "entity": {"type": "task", "id": 999999}})
    assert members(a)[bob["id"]]["entity"] is None


def test_title_truncated():
    _t, _clock, _alice, bob, a, b = setup()
    task = a.request("POST", "/api/tasks", {"title": "長" * 200}).json()
    put(b, {"view": "清單", "entity": {"type": "task", "id": task["id"]}})
    title = members(a)[bob["id"]]["entity"]["title"]
    assert len(title) == 60 and title.endswith("…")


def test_validation():
    _t, _clock, _alice, _bob, a, _b = setup()
    for bad in [
        {"view": "x" * 41},
        {"view": 1},
        {"entity": {"type": "feedback", "id": 1}},
        {"entity": {"type": "task", "id": 0}},
        {"entity": {"type": "task", "id": 1, "mode": "typing"}},
        {"state": "busy"},
    ]:
        res = a.request("PUT", "/api/presence", bad)
        assert res.status_code == 400, bad


def test_inactive_users_hidden():
    t, _clock, _alice, _bob, a, _b = setup()
    gone = create_test_user(t.db, is_active=0)
    assert gone["id"] not in members(a)


# ── 閒置計時：presence 不得延長 session ──


def test_presence_does_not_refresh_idle():
    t, clock, alice, _bob, a, _b = setup()

    def last_active() -> int | None:
        return t.db.scalar("SELECT last_active_at FROM sessions WHERE user_id = ?", (alice["id"],))

    before = last_active()
    clock.advance(MIN)
    put(a, {"view": "總覽"})
    assert a.get("/api/presence").status_code == 200
    assert last_active() == before
    # 對照：一般寫入（非 GET）仍會刷新
    a.request("POST", "/api/tasks", {"title": "x"})
    assert last_active() == clock.now()


def test_presence_keepalive_cannot_keep_session_alive():
    """只送 presence（每 20 秒）也會在閒置逾時後被登出"""
    t, clock, _alice, _bob, a, _b = setup()
    idle_ms = t.app.state.settings.idle_timeout_ms
    elapsed = 0
    while elapsed + 20 * SEC < idle_ms:
        clock.advance(20 * SEC)
        elapsed += 20 * SEC
        put(a, {"view": "甘特圖"})
    clock.advance(idle_ms - elapsed)
    res = a.request("PUT", "/api/presence", {"view": "甘特圖"})
    assert res.status_code == 401
    assert a.get("/api/auth/me").status_code == 401


# ── 重啟後由 DB 補「最後上線」 ──


def test_last_seen_survives_restart():
    t, clock, _alice, bob, a, b = setup()
    put(b, {"view": "問題回饋"})
    seen = clock.now()
    # 模擬重啟：記憶體中的登錄清空
    registry_for(t.db).entries.clear()
    registry_for(t.db).published.clear()
    m = members(a)[bob["id"]]
    assert m["status"] == "offline"
    assert m["lastSeenAt"] == seen
    assert m["lastView"] == "問題回饋"


def test_persist_throttled_but_view_change_immediate():
    t, clock, _alice, bob, _a, b = setup()

    def row():
        r = t.db.one("SELECT last_seen_at, last_view FROM user_presence WHERE user_id = ?", (bob["id"],))
        return (r["last_seen_at"], r["last_view"])

    put(b, {"view": "清單"})
    first = clock.now()
    clock.advance(20 * SEC)
    put(b, {"view": "清單"})
    assert row() == (first, "清單")  # keepalive 不每次寫 DB
    clock.advance(1 * SEC)
    put(b, {"view": "看板"})
    assert row() == (clock.now(), "看板")


# ── SSE 推送 ──


def test_sse_presence_events_only_on_change(live):
    sync_options.poll_ms = 20
    presence_options.sweep_ms = 20
    t, clock, alice, bob, a, b = setup()
    server = live(t.app)
    sse = SseReader(server, a.cookie)
    sse.kind("ready")
    reg = registry_for(t.db)
    assert reg.size == 1

    put(b, {"view": "甘特圖"})
    ev = json.loads(sse.kind("presence")["data"])
    assert [(m["userId"], m["status"], m["view"]) for m in ev["members"]] == [(bob["id"], "online", "甘特圖")]

    # keepalive（內容相同）不廣播
    clock.advance(10 * SEC)
    put(b, {"view": "甘特圖"})
    with pytest.raises(AssertionError):
        sse.kind("presence", timeout=0.3)

    # 逾時：sweeper 自動轉 idle → offline
    clock.advance(presence_options.online_ms)
    ev = json.loads(sse.kind("presence")["data"])
    assert ev["members"][0]["status"] == "idle"
    clock.advance(presence_options.idle_ms)
    ev = json.loads(sse.kind("presence")["data"])
    assert ev["members"][0]["status"] == "offline"
    assert ev["members"][0]["lastView"] == "甘特圖"

    sse.cancel()
    wait_until(lambda: reg.size == 0)
    wait_until(lambda: reg._task is None)
    _ = alice
