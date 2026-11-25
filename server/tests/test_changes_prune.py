"""changes 流水的保留期限修剪：啟動 / 每日節流 / 修剪後 since 重連 / 保留天數 0 的語意"""

from __future__ import annotations

import pytest

from server.app import changes
from server.app.changes import maybe_prune, prune_changes, prune_on_startup, record_change
from server.app.config import ConfigError, load_config

from .helpers import FakeClock, create_test_app, create_test_user, login_as

DAY = 86_400_000


def _insert_aged(conn, now, age_days):
    conn.execute(  # 直接寫表，避免 record_change 順便修剪
        "INSERT INTO changes (entity_type, entity_id, action, actor_id, created_at) VALUES ('task', 1, 'update', NULL, ?)",
        (now - age_days * DAY,),
    )


def _ages(db, now):
    return [round((now - r[0]) / DAY) for r in db.all("SELECT created_at FROM changes ORDER BY id")]


def _fresh():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    t.db.execute("DELETE FROM changes")
    changes._last_prune.clear()
    return t, clock.now()


def test_prune_deletes_only_older_than_retention():
    t, now = _fresh()
    with t.db.tx() as conn:
        for age in (400, 31, 29, 1):
            _insert_aged(conn, now, age)
        assert prune_changes(conn, now - 30 * DAY) == 2
    assert _ages(t.db, now) == [29, 1]


def test_prune_on_startup():
    t, now = _fresh()
    with t.db.tx() as conn:
        for age in (90, 40, 5):
            conn.execute(
                "INSERT INTO changes (entity_type, entity_id, action, actor_id, created_at) VALUES ('task', 1, 'update', NULL, ?)",
                (now - age * DAY,),
            )
    assert prune_on_startup(t.db, now=now, days=30) == 2
    assert _ages(t.db, now) == [5]


def test_prune_throttled_once_per_day():
    t, now = _fresh()

    def raw(conn, age):
        conn.execute(
            "INSERT INTO changes (entity_type, entity_id, action, actor_id, created_at) VALUES ('task', 1, 'update', NULL, ?)",
            (now - age * DAY,),
        )

    with t.db.tx() as conn:
        raw(conn, 100)
        assert maybe_prune(conn, now, days=30) == 1
        raw(conn, 100)
        assert maybe_prune(conn, now + 1000, days=30) == 0  # 同一天內不再修剪
        assert maybe_prune(conn, now + DAY + 1, days=30) == 1
    # record_change 寫入時順便檢查（距上次已超過一天）
    with t.db.tx() as conn:
        raw(conn, 100)
        record_change(conn, "task", 2, "create", None, now + 3 * DAY)
    assert t.db.scalar("SELECT count(*) FROM changes WHERE created_at < ?", (now - 30 * DAY,)) == 0


def test_startup_prune_arms_throttle():
    t, now = _fresh()
    prune_on_startup(t.db, now=now, days=30)
    with t.db.tx() as conn:
        conn.execute(
            "INSERT INTO changes (entity_type, entity_id, action, actor_id, created_at) VALUES ('task', 1, 'update', NULL, ?)",
            (now - 100 * DAY,),
        )
        assert maybe_prune(conn, now + 1000, days=30) == 0


def test_zero_or_negative_retention_disables_prune():
    t, now = _fresh()
    with t.db.tx() as conn:
        conn.execute(
            "INSERT INTO changes (entity_type, entity_id, action, actor_id, created_at) VALUES ('task', 1, 'update', NULL, ?)",
            (now - 1000 * DAY,),
        )
        assert maybe_prune(conn, now, days=0) == 0
        assert maybe_prune(conn, now, days=-1) == 0
    assert prune_on_startup(t.db, now=now, days=0) == 0
    assert t.db.scalar("SELECT count(*) FROM changes") == 1
    with pytest.raises(ConfigError):  # 設定檔不接受 <= 0（程式內部傳入時才有「不修剪」的防呆）
        load_config({"CHANGES_RETENTION_DAYS": "0"})
    assert load_config({}).CHANGES_RETENTION_DAYS == 30


def test_reconnect_with_old_since_gets_reset_after_prune():
    clock = FakeClock()
    t = create_test_app(now=clock.now)
    user = create_test_user(t.db, display_name="Alice")
    a = login_as(t, user)
    now = clock.now()
    prune_on_startup(t.db, now=now, days=30)  # 啟動修剪，同一天內寫入不再觸發修剪
    with t.db.tx() as conn:
        _insert_aged(conn, now, 60)
        old1 = conn.execute("SELECT max(id) FROM changes").fetchone()[0]
        _insert_aged(conn, now, 50)
    res = a.request("POST", "/api/tasks", {"title": "new"})
    assert res.status_code == 201
    since = old1 - 1
    assert a.get(f"/api/changes?since={since}").json()["reset"] is False  # 修剪前可完整補漏
    with t.db.tx() as conn:
        assert prune_changes(conn, now - 30 * DAY) >= 2
    body = a.get(f"/api/changes?since={since}").json()
    assert body["reset"] is True
    assert all(c["id"] > old1 for c in body["changes"]) and body["changes"]
    # 剛好接上最小 id 的客戶端不需要 reset
    first = t.db.scalar("SELECT min(id) FROM changes")
    assert a.get(f"/api/changes?since={first - 1}").json()["reset"] is False
