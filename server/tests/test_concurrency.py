"""多人併發驗證（docs/multi-user.md §併發測試）。

以 uvicorn 實際提供 app（檔案型 SQLite，WAL），多個執行緒各自以 httpx 同時操作；隨機種子固定可重現
（環境變數 CONCURRENCY_SEED 可覆寫）。
"""

from __future__ import annotations

import dataclasses
import json
import os
import random
import threading
import time
from collections import Counter
from types import SimpleNamespace
from typing import Any, Iterator

import httpx
import pytest

from server.app.app import create_app
from server.app.db import create_db, run_migrations, run_seed
from server.app.presence import registry_for
from server.app.sync_hub import hub_for, sync_options

from .helpers import TEST_PASSWORD, create_test_user
from .test_sync import LiveServer, SseReader, wait_until

SEED = int(os.environ.get("CONCURRENCY_SEED", "20261125"))
USERS = 8
OPS_PER_USER = 30  # 8 × 30 = 240 次混合操作
_SYNC_DEFAULTS = dataclasses.asdict(sync_options)


@pytest.fixture(autouse=True)
def _restore_options() -> Iterator[None]:
    yield
    for k, v in _SYNC_DEFAULTS.items():
        setattr(sync_options, k, v)


@pytest.fixture
def server(tmp_path):
    db = create_db(str(tmp_path / "concurrency.db"))
    run_migrations(db)
    run_seed(db)
    s = LiveServer(create_app(db))
    yield s, db
    s.close()
    db.close()


def login(s: LiveServer, user: dict) -> httpx.Client:
    c = httpx.Client(base_url=s.url, timeout=30, headers={"origin": s.url})
    res = c.post("/api/auth/login", json={"username": user["username"], "password": TEST_PASSWORD})
    assert res.status_code == 200, res.text
    return c


def test_db_pragmas(server):
    _s, db = server
    assert db.scalar("PRAGMA journal_mode") == "wal"
    assert db.scalar("PRAGMA synchronous") == 1  # NORMAL
    assert db.scalar("PRAGMA busy_timeout") == 5000


def test_eight_users_mixed_operations(server):
    s, db = server
    users = [create_test_user(db, display_name=f"成員{i}") for i in range(USERS)]
    clients = [login(s, u) for u in users]
    start_id = int(db.scalar("SELECT coalesce(max(id), 0) FROM changes"))

    # 共用任務池（大家同時改同一批任務）
    seed_tasks = [clients[0].post("/api/tasks", json={"title": f"共用 {i}"}).json()["id"] for i in range(10)]
    pool_lock = threading.Lock()
    task_pool = list(seed_tasks)

    barrier = threading.Barrier(USERS)
    results: list[dict[str, Any]] = []
    results_lock = threading.Lock()
    failures: list[str] = []

    def record(user_idx: int, op: str, res: httpx.Response) -> None:
        if res.status_code >= 500 or "database is locked" in res.text:
            failures.append(f"{op} → {res.status_code} {res.text[:200]}")
        with results_lock:
            results.append({"user": user_idx, "op": op, "status": res.status_code})

    def worker(i: int) -> None:
        rng = random.Random(SEED + i)
        c = clients[i]
        own_personal: list[int] = []
        barrier.wait()
        for n in range(OPS_PER_USER):
            r = rng.random()
            if r < 0.18:
                res = c.post("/api/tasks", json={"title": f"u{i}-{n}"})
                record(i, "task.create", res)
                if res.status_code == 201:
                    with pool_lock:
                        task_pool.append(res.json()["id"])
            elif r < 0.45:
                with pool_lock:
                    tid = rng.choice(task_pool)
                field = rng.choice(["title", "progress", "priority", "description"])
                value = {
                    "title": f"u{i} 改名 {n}",
                    "progress": rng.randint(0, 100),
                    "priority": rng.choice(["none", "low", "medium", "high", "urgent"]),
                    "description": f"描述 {i}-{n}",
                }[field]
                record(i, "task.update", c.patch(f"/api/tasks/{tid}", json={field: value}))
            elif r < 0.52:
                with pool_lock:
                    tid = rng.choice(task_pool)
                record(i, "task.delete", c.delete(f"/api/tasks/{tid}"))
            elif r < 0.64:
                if own_personal and rng.random() < 0.5:
                    pid = rng.choice(own_personal)
                    record(i, "personal.update", c.patch(f"/api/personal/{pid}", json={"isDone": rng.random() < 0.5}))
                else:
                    res = c.post("/api/personal", json={"title": f"待辦 {i}-{n}"})
                    record(i, "personal.create", res)
                    if res.status_code == 201:
                        own_personal.append(res.json()["id"])
            elif r < 0.72:
                record(i, "feedback.create", c.post("/api/feedback", json={"kind": "feedback", "title": f"回饋 {i}-{n}"}))
            elif r < 0.80:
                record(i, "presence", c.put("/api/presence", json={"view": rng.choice(["清單", "甘特圖", "總覽"])}))
            elif r < 0.90:
                record(i, "overview", c.get("/api/overview"))
            else:
                record(i, "changes", c.get(f"/api/changes?since={start_id}"))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(USERS)]
    t0 = time.monotonic()
    for th in threads:
        th.start()
    for th in threads:
        th.join(120)
    elapsed = time.monotonic() - t0
    for c in clients:
        c.close()

    assert not failures, failures[:5]
    assert len(results) == USERS * OPS_PER_USER
    by_status = Counter(r["status"] for r in results)
    assert all(code < 500 for code in by_status), by_status
    # 4xx 只可能是「刪掉的任務又被別人改 / 刪」（404）
    assert set(by_status) <= {200, 201, 404}, by_status

    # changes 流水：序號連續遞增無遺漏，且每次成功寫入恰好一筆
    ids = [r[0] for r in db.all("SELECT id FROM changes WHERE id > ? ORDER BY id", (start_id,))]
    assert ids == list(range(start_id + 1, start_id + 1 + len(ids)))
    writes = sum(
        1
        for r in results
        if r["op"].split(".")[0] in {"task", "personal", "feedback"} and r["status"] in (200, 201)
    )
    assert len(ids) == writes + len(seed_tasks)

    # 最終資料一致：刪除者皆有 delete 流水；未刪除任務的最後一筆流水不是 delete
    deleted = {r[0] for r in db.all("SELECT id FROM tasks WHERE deleted_at IS NOT NULL")}
    delete_changes = {
        r[0] for r in db.all("SELECT entity_id FROM changes WHERE entity_type = 'task' AND action = 'delete'")
    }
    assert deleted == delete_changes
    print(
        f"\n[concurrency] seed={SEED} users={USERS} ops={len(results)} elapsed={elapsed:.2f}s "
        f"changes={len(ids)} statuses={dict(by_status)}"
    )


def test_same_task_concurrent_patch_field_merge(server):
    s, db = server
    a_user, b_user = create_test_user(db), create_test_user(db)
    a, b = login(s, a_user), login(s, b_user)
    tid = a.post("/api/tasks", json={"title": "原標題"}).json()["id"]

    def race(body_a: dict, body_b: dict) -> tuple[dict, dict]:
        barrier = threading.Barrier(2)
        out: dict[str, Any] = {}

        def run(name: str, c: httpx.Client, body: dict) -> None:
            barrier.wait()
            res = c.patch(f"/api/tasks/{tid}", json=body)
            assert res.status_code == 200, res.text
            out[name] = res.json()

        ts = [threading.Thread(target=run, args=("a", a, body_a)), threading.Thread(target=run, args=("b", b, body_b))]
        for t in ts:
            t.start()
        for t in ts:
            t.join(10)
        return out["a"], out["b"]

    # 不同欄位：兩者都保留（欄位層級合併）
    for round_ in range(10):
        race({"title": f"A 改的標題 {round_}"}, {"progress": round_ * 10})
        final = a.get(f"/api/tasks/{tid}").json()
        assert final["title"] == f"A 改的標題 {round_}"
        assert final["progress"] == round_ * 10

    # 同欄位：後寫者勝，且 changes 有兩筆
    before = int(db.scalar("SELECT max(id) FROM changes"))
    ra, rb = race({"title": "A 版本"}, {"title": "B 版本"})
    final = a.get(f"/api/tasks/{tid}").json()
    later = ra if ra["updatedAt"] > rb["updatedAt"] else rb
    rows = db.all("SELECT actor_id FROM changes WHERE id > ? AND entity_type = 'task' ORDER BY id", (before,))
    assert len(rows) == 2
    last_actor = rows[-1]["actor_id"]
    assert final["title"] == ("A 版本" if last_actor == a_user["id"] else "B 版本")
    if ra["updatedAt"] != rb["updatedAt"]:
        assert final["title"] == later["title"]
    a.close()
    b.close()


def test_thirty_sse_connections_with_writes(server):
    sync_options.poll_ms = 50
    s, db = server
    users = [create_test_user(db) for _ in range(6)]
    writer = login(s, users[0])
    cookies = []
    for u in users:
        c = login(s, u)
        cookies.append(f"sid={c.cookies.get('sid')}")
        c.close()
    # 30 條連線（每人 5 個分頁），各自一個 httpx 連線池
    readers: list[SseReader] = []
    own_clients: list[httpx.Client] = []
    for i in range(30):
        srv = SimpleNamespace(http=httpx.Client(base_url=s.url, timeout=httpx.Timeout(10, read=None)))
        readers.append(SseReader(srv, cookies[i % len(cookies)]))  # type: ignore[arg-type]
        own_clients.append(srv.http)
    for r in readers:
        assert r.res.status_code == 200
        r.kind("ready", timeout=5)
    hub = hub_for(db)
    reg = registry_for(db)
    assert hub.size == 30 and reg.size == 30

    latencies: list[float] = []
    stop = threading.Event()

    def background_writes() -> None:
        n = 0
        while not stop.is_set():
            writer.post("/api/personal", json={"title": f"背景 {n}"})
            n += 1
            time.sleep(0.02)

    bg = threading.Thread(target=background_writes)
    bg.start()
    try:
        for k in range(5):
            sent = time.monotonic()
            tid = writer.post("/api/tasks", json={"title": f"推送 {k}"}).json()["id"]
            for r in readers:
                r.next(
                    lambda e: e["event"] == "change"
                    and json.loads(e["data"])["entityType"] == "task"
                    and json.loads(e["data"])["entityId"] == tid,
                    timeout=2.0,
                )
            latencies.append(time.monotonic() - sent)
    finally:
        stop.set()
        bg.join(10)
    assert max(latencies) < 2.0, latencies

    for r in readers:
        r.cancel()
        r.res.close()
    wait_until(lambda: hub.size == 0, 5)
    wait_until(lambda: reg.size == 0, 5)
    wait_until(lambda: hub._task is None and reg._task is None, 5)
    writer.close()
    for c in own_clients:
        c.close()
    print(f"\n[sse] 30 connections, max latency {max(latencies) * 1000:.0f} ms")
