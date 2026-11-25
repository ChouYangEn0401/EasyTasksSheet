"""/api/changes 與 /api/events（SSE）。

SSE 需要真正的串流與斷線，故以 uvicorn（背景執行緒、隨機埠）實際提供同一個 app，
再用 httpx 串流讀取；寫入類請求仍走 TestClient（同一個 DB）。
"""

from __future__ import annotations

import dataclasses
import json
import queue
import socket
import threading
import time
from typing import Callable, Iterator

import httpx
import pytest
import uvicorn

from server.app.sync_hub import hub_for, sync_options

from .helpers import MIN, Client, FakeClock, create_test_app, create_test_user, login_as

_DEFAULTS = dataclasses.asdict(sync_options)


@pytest.fixture(autouse=True)
def _restore_options() -> Iterator[None]:
    yield
    for k, v in _DEFAULTS.items():
        setattr(sync_options, k, v)


def setup():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    alice = create_test_user(t.db, display_name="Alice")
    bob = create_test_user(t.db, display_name="Bob")
    a = login_as(t, alice)
    b = login_as(t, bob)
    return t, clock, alice, bob, a, b


def create_task(c: Client, title: str) -> dict:
    res = c.request("POST", "/api/tasks", {"title": title})
    assert res.status_code == 201, res.text
    return res.json()


def wait_until(pred: Callable[[], bool], timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError("timeout")
        time.sleep(0.01)


# ── 真實伺服器與 SSE 讀取工具 ──


class LiveServer:
    def __init__(self, app) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
        self.url = f"http://127.0.0.1:{sock.getsockname()[1]}"
        self.server = uvicorn.Server(uvicorn.Config(app, lifespan="off", log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, kwargs={"sockets": [sock]}, daemon=True)
        self.thread.start()
        wait_until(lambda: self.server.started, 10)
        self.http = httpx.Client(base_url=self.url, timeout=httpx.Timeout(10, read=None))

    def close(self) -> None:
        self.http.close()
        self.server.should_exit = True
        self.server.force_exit = True
        self.thread.join(10)


@pytest.fixture
def live():
    servers: list[LiveServer] = []

    def start(app) -> LiveServer:
        s = LiveServer(app)
        servers.append(s)
        return s

    yield start
    for s in servers:
        s.close()


class SseReader:
    """背景執行緒讀取 SSE；next(pred) 等到符合條件的事件"""

    def __init__(self, server: LiveServer, cookie: str, path: str = "/api/events", headers: dict | None = None):
        req = server.http.build_request("GET", path, headers={"cookie": cookie, **(headers or {})})
        self.res = server.http.send(req, stream=True)
        self.events: queue.Queue = queue.Queue()
        self.backlog: list[dict] = []
        self.closed = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        buf = ""
        try:
            for chunk in self.res.iter_text():
                buf += chunk
                while "\n\n" in buf:
                    block, buf = buf.split("\n\n", 1)
                    ev: dict = {"event": "message", "data": "", "id": None}
                    data = []
                    for line in block.split("\n"):
                        if line.startswith("event: "):
                            ev["event"] = line[7:]
                        elif line.startswith("data: "):
                            data.append(line[6:])
                        elif line.startswith("id: "):
                            ev["id"] = line[4:]
                        elif line.startswith("retry: "):
                            ev["retry"] = line[7:]
                    ev["data"] = "\n".join(data)
                    self.events.put(ev)
        except Exception:  # noqa: BLE001 — 我方關閉連線
            pass
        finally:
            self.closed.set()

    def next(self, pred: Callable[[dict], bool] = lambda e: True, timeout: float = 3.0) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            for i, ev in enumerate(self.backlog):
                if pred(ev):
                    return self.backlog.pop(i)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("timeout waiting for SSE event")
            try:
                self.backlog.append(self.events.get(timeout=remaining))
            except queue.Empty:
                pass

    def kind(self, name: str, timeout: float = 3.0) -> dict:
        return self.next(lambda e: e["event"] == name, timeout)

    def cancel(self) -> None:
        self.res.close()


# ── GET /api/changes ──


def test_changes_requires_login():
    t = create_test_app()
    assert t.http.get("/api/changes").status_code == 401


def test_changes_since():
    t, _clock, alice, _bob, a, _b = setup()
    start = a.get("/api/changes").json()
    assert start == {"changes": [], "latestId": start["latestId"], "hasMore": False, "reset": False}

    task = create_task(a, "新任務")
    a.request("PATCH", f"/api/tasks/{task['id']}", {"title": "改名"})

    body = a.get(f"/api/changes?since={start['latestId']}").json()
    assert [(c["entityType"], c["entityId"], c["action"], c["actorId"]) for c in body["changes"]] == [
        ("task", task["id"], "create", alice["id"]),
        ("task", task["id"], "update", alice["id"]),
    ]
    assert set(body["changes"][0]) == {"id", "entityType", "entityId", "action", "actorId", "createdAt"}
    assert body["latestId"] == body["changes"][1]["id"]
    assert body["hasMore"] is False and body["reset"] is False

    again = a.get(f"/api/changes?since={body['latestId']}").json()
    assert again["changes"] == []


def test_changes_has_more():
    _t, _clock, _alice, _bob, a, _b = setup()
    sync_options.max_batch = 2
    latest = a.get("/api/changes").json()["latestId"]
    for title in ["a", "b", "c"]:
        create_task(a, title)
    body = a.get(f"/api/changes?since={latest}").json()
    assert len(body["changes"]) == 2
    assert body["hasMore"] is True
    assert body["latestId"] == body["changes"][1]["id"]


def test_changes_reset_when_pruned():
    t, _clock, _alice, _bob, a, _b = setup()
    latest = a.get("/api/changes").json()["latestId"]
    for title in ["a", "b", "c"]:
        create_task(a, title)
    ids = [r[0] for r in t.db.all("SELECT id FROM changes WHERE id > ? ORDER BY id", (latest,))]
    t.db.execute("DELETE FROM changes WHERE id <= ?", (ids[1],))
    body = a.get(f"/api/changes?since={latest}").json()
    assert body["reset"] is True
    assert [c["id"] for c in body["changes"]] == [ids[2]]


def test_changes_since_validation():
    _t, _clock, _alice, _bob, a, _b = setup()
    for bad in ["abc", "-1", "1.5"]:
        res = a.get(f"/api/changes?since={bad}")
        assert res.status_code == 400, bad
        assert res.json()["error"]["code"] == "VALIDATION_ERROR"
    assert a.get("/api/changes?since=0").status_code == 200


def test_changes_does_not_refresh_idle():
    t, clock, alice, _bob, a, _b = setup()

    def last_active() -> int:
        return t.db.scalar("SELECT last_active_at FROM sessions WHERE user_id = ?", (alice["id"],))

    before = last_active()
    clock.advance(MIN)
    assert a.get("/api/changes?since=0").status_code == 200
    assert last_active() == before


# ── GET /api/events（SSE）──


def test_events_requires_login():
    t = create_test_app()
    assert t.http.get("/api/events").status_code == 401


def test_events_since_validation():
    _t, _clock, _alice, _bob, a, _b = setup()
    assert a.get("/api/events?since=abc").status_code == 400


def test_events_push_and_cleanup(live):
    sync_options.poll_ms = 20
    t, _clock, _alice, bob, a, b = setup()
    server = live(t.app)
    sse = SseReader(server, a.cookie)
    assert sse.res.status_code == 200
    assert sse.res.headers["content-type"].startswith("text/event-stream")
    assert "no-transform" in sse.res.headers["cache-control"]
    assert "no-cache" in sse.res.headers["cache-control"]
    assert sse.res.headers["x-accel-buffering"] == "no"
    assert "content-encoding" not in sse.res.headers

    ready = sse.kind("ready")
    assert ready["retry"] == "3000"
    ready_data = json.loads(ready["data"])
    assert ready_data["reset"] is False
    assert ready_data["latestId"] == (t.db.scalar("SELECT max(id) FROM changes") or 0)
    hub = hub_for(t.db)
    assert hub.size == 1

    # 第二條連線共用同一個 hub
    other = SseReader(server, b.cookie)
    other.kind("ready")
    assert hub.size == 2

    task = create_task(b, "來自 Bob")
    ev = sse.kind("change")
    change = json.loads(ev["data"])
    assert change["entityType"] == "task"
    assert change["entityId"] == task["id"]
    assert change["action"] == "create"
    assert change["actorId"] == bob["id"]
    assert ev["id"] == str(change["id"])
    assert json.loads(other.kind("change")["data"])["id"] == change["id"]

    b.request("DELETE", f"/api/tasks/{task['id']}")
    deleted = json.loads(sse.kind("change")["data"])
    assert deleted["entityId"] == task["id"] and deleted["action"] == "delete"

    # 斷線後釋放訂閱（不必等到下一次心跳）；全部斷線後 hub 停止輪詢
    other.cancel()
    wait_until(lambda: hub.size == 1)
    create_task(b, "仍會推送")
    assert json.loads(sse.kind("change")["data"])["action"] == "create"
    sse.cancel()
    wait_until(lambda: hub.size == 0)
    wait_until(lambda: hub._task is None)


def test_events_replay_since_and_last_event_id(live):
    sync_options.poll_ms = 20
    t, _clock, _alice, _bob, a, b = setup()
    server = live(t.app)
    latest = a.get("/api/changes").json()["latestId"]
    t1 = create_task(b, "一")
    t2 = create_task(b, "二")

    sse = SseReader(server, a.cookie, f"/api/events?since={latest}")
    assert json.loads(sse.kind("ready")["data"])["reset"] is False
    first = json.loads(sse.kind("change")["data"])
    second = json.loads(sse.kind("change")["data"])
    assert [first["entityId"], second["entityId"]] == [t1["id"], t2["id"]]
    sse.cancel()

    via_header = SseReader(server, a.cookie, headers={"last-event-id": str(first["id"])})
    via_header.kind("ready")
    replayed = json.loads(via_header.kind("change")["data"])
    assert replayed["entityId"] == t2["id"]
    # 重播後不重複推送，新變更照常推送
    t3 = create_task(b, "三")
    assert json.loads(via_header.kind("change")["data"])["entityId"] == t3["id"]
    with pytest.raises(AssertionError):
        via_header.kind("change", timeout=0.3)
    via_header.cancel()


def test_events_reset_when_replay_incomplete(live):
    sync_options.max_batch = 1
    t, _clock, _alice, _bob, a, b = setup()
    server = live(t.app)
    latest = a.get("/api/changes").json()["latestId"]
    create_task(b, "一")
    create_task(b, "二")
    sse = SseReader(server, a.cookie, f"/api/events?since={latest}")
    ready = json.loads(sse.kind("ready")["data"])
    assert ready == {"latestId": t.db.scalar("SELECT max(id) FROM changes"), "reset": True}
    with pytest.raises(AssertionError):
        sse.kind("change", timeout=0.3)
    sse.cancel()


def test_events_heartbeat_idle_and_expired(live):
    sync_options.heartbeat_ms = 50
    t, clock, alice, _bob, a, _b = setup()
    server = live(t.app)
    sse = SseReader(server, a.cookie)
    sse.kind("ready")
    ping = sse.kind("ping")
    assert ping["data"] == ""

    def last_active() -> int | None:
        return t.db.scalar("SELECT last_active_at FROM sessions WHERE user_id = ?", (alice["id"],))

    before = last_active()
    clock.advance(10 * MIN)
    sse.backlog.clear()
    sse.kind("ping")
    assert last_active() == before

    clock.advance(60 * MIN)
    sse.kind("expired")
    # 伺服器關閉串流並釋放訂閱
    assert sse.closed.wait(3)
    wait_until(lambda: hub_for(t.db).size == 0)


def test_events_expired_when_logged_out(live):
    sync_options.heartbeat_ms = 50
    t, _clock, _alice, _bob, a, _b = setup()
    server = live(t.app)
    sse = SseReader(server, a.cookie)
    sse.kind("ready")
    sse.kind("ping")
    assert a.request("POST", "/api/auth/logout", {}).status_code in (200, 204)
    sse.kind("expired")
    assert sse.closed.wait(3)
