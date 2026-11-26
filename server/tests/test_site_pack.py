"""整站搬家包（server/app/sitepack.py、features/site_pack.py、cli pack-*）。

涵蓋：加解密與竄改偵測、版本相容、全新 server 的公開還原、已有資料時的三道關卡
（root 權限＋再次輸入密碼＋本機還原解鎖＋確認字樣）、還原前自動備份、session 全部失效、稽核紀錄、CLI。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.app import sitepack as sp
from server.app.db import create_db, run_migrations, run_seed
from server.app.features.users import ensure_admin

from .helpers import TEST_PASSWORD, TestApp, create_test_user

ORIGIN = {"origin": "http://localhost"}
ATT_NAME = "0123456789abcdef0123456789abcdef"


# ── 測試用的網站 ─────────────────────────────────────────


def make_site(tmp: Path, name: str, *, pristine: bool = False) -> TestApp:
    """以檔案資料庫建立一個網站（搬家包的還原前備份需要檔案資料庫）"""
    root = tmp / name
    db = create_db(str(root / "data" / "app.db"))
    run_migrations(db)
    run_seed(db)
    if pristine:
        ensure_admin(db, log=lambda m: None)
    t = TestApp(db=db)
    t.app.state.attachments_dir = str(root / "data" / "attachments")
    t.app.state.backup_dir = str(root / "backups")
    t.app.state.restore_unlock_dir = str(root / "data")
    Path(t.app.state.attachments_dir).mkdir(parents=True, exist_ok=True)
    return t


def login_cookie(t: TestApp, username: str, password: str = TEST_PASSWORD) -> str:
    res = t.http.post("/api/auth/login", json={"username": username, "password": password}, headers=ORIGIN)
    assert res.status_code == 200, res.text
    return res.headers["set-cookie"].split(";")[0]


def api(t: TestApp, method: str, path: str, cookie: str = "", **kw):  # type: ignore[no-untyped-def]
    headers = {**ORIGIN, **({"cookie": cookie} if cookie else {}), **kw.pop("headers", {})}
    t.http.cookies.clear()
    res = t.http.request(method, path, headers=headers, **kw)
    t.http.cookies.clear()
    return res


def seed_source(t: TestApp) -> tuple[dict, str]:
    """來源網站：一個 root、兩筆任務、一個附件"""
    boss = create_test_user(t.db, username="boss", role="root")
    cookie = login_cookie(t, "boss")
    for title in ("搬家任務 A", "搬家任務 B"):
        assert api(t, "POST", "/api/tasks", cookie, json={"title": title}).status_code == 201
    data = os.urandom(1_500_000)  # 讓搬家包超過一個加密段落（1 MiB）
    (Path(t.app.state.attachments_dir) / ATT_NAME).write_bytes(data)
    t.db.execute(
        "INSERT INTO attachments (uid, entity_type, entity_id, original_name, stored_name, mime, size, sha256, uploaded_by, created_at)"
        " VALUES ('att-1', 'eng_issue', 1, 'a.bin', ?, 'application/octet-stream', ?, '', ?, 0)",
        (ATT_NAME, len(data), boss["id"]),
    )
    return boss, cookie


def export_pack(t: TestApp, out: Path) -> sp.PackResult:
    return sp.build_pack(t.db, t.app.state.attachments_dir, out, created_by="boss")


def upload(t: TestApp, path: str, pack: Path, cookie: str = "", **fields: str):  # type: ignore[no-untyped-def]
    with pack.open("rb") as f:
        return api(t, "POST", path, cookie, files={"file": (pack.name, f, "application/octet-stream")}, data=fields)


def titles(t: TestApp) -> list[str]:
    return sorted(r["title"] for r in t.db.all("SELECT title FROM tasks"))


@pytest.fixture
def source(tmp_path):  # type: ignore[no-untyped-def]
    t = make_site(tmp_path, "source")
    seed_source(t)
    return t


@pytest.fixture
def pack(source, tmp_path):  # type: ignore[no-untyped-def]
    return export_pack(source, tmp_path / "out")


# ── 密語 ─────────────────────────────────────────────────


def test_passphrase_is_eight_known_words():
    words = set(sp._words())
    assert len(words) == 7772
    phrase = sp.generate_passphrase()
    parts = phrase.split("-")
    assert len(parts) == 8 and all(p in words for p in parts)
    assert sp.generate_passphrase() != phrase


def test_passphrase_normalization_tolerates_spacing_and_case():
    assert sp.normalize_passphrase("  Orbit clever\nMAPLE_tundra ") == "orbit-clever-maple-tundra"
    assert sp.normalize_passphrase("orbit-clever-maple-tundra") == "orbit-clever-maple-tundra"


# ── 加解密 ───────────────────────────────────────────────


def test_roundtrip_with_reformatted_passphrase(pack, tmp_path):
    messy = "  " + pack.passphrase.upper().replace("-", " ") + "\n"
    opened = sp.open_pack(pack.file, messy, tmp_path)
    try:
        assert opened.manifest["counts"]["tasks"] == 2
        assert opened.manifest["counts"]["attachments"] == 1
        assert (opened.attachments / ATT_NAME).stat().st_size == 1_500_000
    finally:
        opened.cleanup()


def test_wrong_passphrase_rejected(pack):
    with pytest.raises(sp.PackError) as e:
        sp.open_pack(pack.file, "wrong " * 8)
    assert e.value.code == "PACK_DECRYPT"


@pytest.mark.parametrize("where", ["header", "body", "last"])
def test_tampered_byte_rejected(pack, tmp_path, where):
    data = bytearray(pack.file.read_bytes())
    pos = {"header": 20, "body": len(data) // 2, "last": len(data) - 5}[where]
    data[pos] ^= 0x01
    bad = tmp_path / "bad.etpack"
    bad.write_bytes(bytes(data))
    with pytest.raises(sp.PackError):
        sp.open_pack(bad, pack.passphrase)


@pytest.mark.parametrize("cut", [5, 1024 * 1024])
def test_truncated_pack_rejected(pack, tmp_path, cut):
    data = pack.file.read_bytes()
    assert len(data) > 1024 * 1024 + 100  # 至少兩段，才能測「整段被截掉」
    bad = tmp_path / "cut.etpack"
    bad.write_bytes(data[:-cut])
    with pytest.raises(sp.PackError):
        sp.open_pack(bad, pack.passphrase)


def test_appended_data_rejected(pack, tmp_path):
    bad = tmp_path / "extra.etpack"
    bad.write_bytes(pack.file.read_bytes() + b"\x00\x00\x00\x20" + b"x" * 32)
    with pytest.raises(sp.PackError):
        sp.open_pack(bad, pack.passphrase)


def test_not_a_pack_rejected(tmp_path):
    f = tmp_path / "x.etpack"
    f.write_bytes(b"SQLite format 3\x00" + b"\x00" * 100)
    with pytest.raises(sp.PackError) as e:
        sp.open_pack(f, "a b c")
    assert e.value.code == "PACK_NOT_PACK"


def test_newer_pack_rejected():
    with pytest.raises(sp.PackError) as e:
        sp.check_compatible({"migrations": ["0000_init", "9999_from_the_future"]})
    assert e.value.code == "PACK_TOO_NEW"


# ── 全新 server：登入前還原 ─────────────────────────────


def test_status_reports_pristine_only_before_first_login(tmp_path):
    t = make_site(tmp_path, "fresh", pristine=True)
    assert api(t, "GET", "/api/setup/status").json()["pristine"] is True
    t.db.execute("UPDATE users SET must_change_password = 0")
    assert api(t, "GET", "/api/setup/status").json()["pristine"] is False


def test_fresh_server_restore_brings_accounts_tasks_attachments(pack, tmp_path):
    t = make_site(tmp_path, "fresh", pristine=True)
    res = upload(t, "/api/setup/restore", pack.file, passphrase=pack.passphrase)
    assert res.status_code == 200, res.text
    assert res.json()["counts"]["tasks"] == 2
    assert titles(t) == ["搬家任務 A", "搬家任務 B"]
    # 原本的帳號密碼可以登入；新 server 的預設 admin 已被取代
    login_cookie(t, "boss")
    assert api(t, "POST", "/api/auth/login", json={"username": "admin", "password": "password"}).status_code == 401
    assert (Path(t.app.state.attachments_dir) / ATT_NAME).stat().st_size == 1_500_000
    # 還原前自動備份、稽核紀錄
    assert list(Path(t.app.state.backup_dir).glob("app-before-pack-restore-*.db"))
    row = t.db.one("SELECT summary, actor_name FROM audit_log WHERE action = 'pack_restore'")
    assert row is not None and "整站搬家包" in row["summary"]
    assert api(t, "GET", "/api/setup/status").json()["pristine"] is False


def test_fresh_server_wrong_passphrase_changes_nothing(pack, tmp_path):
    t = make_site(tmp_path, "fresh", pristine=True)
    res = upload(t, "/api/setup/restore", pack.file, passphrase="nope nope nope")
    assert res.status_code == 400 and res.json()["error"]["code"] == "PACK_DECRYPT"
    assert titles(t) == [] and api(t, "GET", "/api/setup/status").json()["pristine"] is True


def test_public_restore_refused_when_server_has_data(pack, tmp_path):
    t = make_site(tmp_path, "inuse")
    create_test_user(t.db, username="owner", role="root")
    t.db.execute("UPDATE users SET must_change_password = 0")
    before = titles(t)
    res = upload(t, "/api/setup/restore", pack.file, passphrase=pack.passphrase)
    assert res.status_code == 403 and res.json()["error"]["code"] == "NOT_PRISTINE"
    assert titles(t) == before
    # 解鎖也不能讓「公開」還原通過
    sp.allow_restore(t.app.state.restore_unlock_dir)
    assert upload(t, "/api/setup/restore", pack.file, passphrase=pack.passphrase).status_code == 403


def test_restore_upload_requires_same_origin(pack, tmp_path):
    t = make_site(tmp_path, "fresh", pristine=True)
    t.http.cookies.clear()
    with pack.file.open("rb") as f:
        res = t.http.post("/api/setup/restore", files={"file": ("p.etpack", f)}, data={"passphrase": pack.passphrase})
    assert res.status_code == 403
    assert titles(t) == []


# ── 已有資料的 server：三道關卡 ─────────────────────────


@pytest.fixture
def inuse(tmp_path):  # type: ignore[no-untyped-def]
    t = make_site(tmp_path, "inuse")
    create_test_user(t.db, username="owner", role="root")
    create_test_user(t.db, username="mgr", role="manager")
    cookie = login_cookie(t, "owner")
    assert api(t, "POST", "/api/tasks", cookie, json={"title": "server 原本的任務"}).status_code == 201
    return t, cookie


def _admin_restore(t, pack, cookie, **override):  # type: ignore[no-untyped-def]
    fields = {"passphrase": pack.passphrase, "password": TEST_PASSWORD, "confirm": sp.CONFIRM_TEXT, **override}
    return upload(t, "/api/admin/data/pack/restore", pack.file, cookie, **fields)


def test_admin_restore_locked_without_machine_unlock(inuse, pack):
    t, cookie = inuse
    res = _admin_restore(t, pack, cookie)
    assert res.status_code == 403 and res.json()["error"]["code"] == "RESTORE_LOCKED"
    assert titles(t) == ["server 原本的任務"]


def test_admin_restore_wrong_password_or_confirm(inuse, pack):
    t, cookie = inuse
    sp.allow_restore(t.app.state.restore_unlock_dir)
    assert _admin_restore(t, pack, cookie, password="not-my-password").status_code == 403
    assert _admin_restore(t, pack, cookie, confirm="ok").status_code == 400
    assert _admin_restore(t, pack, cookie, passphrase="bad bad bad").status_code == 400
    assert titles(t) == ["server 原本的任務"]
    assert sp.unlock_expires_at(t.app.state.restore_unlock_dir) is not None  # 失敗不消耗解鎖


def test_admin_restore_requires_root(inuse, pack):
    t, _ = inuse
    sp.allow_restore(t.app.state.restore_unlock_dir)
    mgr = login_cookie(t, "mgr")
    assert _admin_restore(t, pack, mgr).status_code == 403
    assert api(t, "POST", "/api/admin/data/pack", mgr, json={"password": TEST_PASSWORD}).status_code == 403
    assert titles(t) == ["server 原本的任務"]


def test_admin_restore_success_consumes_unlock_and_logs_everyone_out(inuse, pack):
    t, cookie = inuse
    sp.allow_restore(t.app.state.restore_unlock_dir)
    res = _admin_restore(t, pack, cookie)
    assert res.status_code == 200, res.text
    assert titles(t) == ["搬家任務 A", "搬家任務 B"]
    assert sp.unlock_expires_at(t.app.state.restore_unlock_dir) is None
    assert api(t, "GET", "/api/auth/me", cookie).status_code == 401
    # 還原前的資料可以用一般 restore 換回
    pre = Path(t.app.state.backup_dir) / res.json()["preRestoreBackup"]
    with __import__("sqlite3").connect(pre) as c:
        assert [r[0] for r in c.execute("SELECT title FROM tasks")] == ["server 原本的任務"]


def test_unlock_expires(tmp_path):
    d = tmp_path / "data"
    sp.allow_restore(d, minutes=1, now=1000.0)
    assert sp.unlock_expires_at(d, now=1030.0) == 1060.0
    assert sp.unlock_expires_at(d, now=1061.0) is None
    assert not sp.unlock_path(d).exists()


# ── 匯出 API ─────────────────────────────────────────────


def test_export_requires_password_and_downloads_once(source):
    boss_cookie = login_cookie(source, "boss")
    assert api(source, "POST", "/api/admin/data/pack", boss_cookie, json={"password": "wrong"}).status_code == 403
    res = api(source, "POST", "/api/admin/data/pack", boss_cookie, json={"password": TEST_PASSWORD})
    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["passphrase"].split("-")) == 8 and body["manifest"]["counts"]["tasks"] == 2
    other = create_test_user(source.db, username="root2", role="root")
    assert api(source, "GET", f"/api/admin/data/pack/{body['id']}", login_cookie(source, other["username"])).status_code == 404
    dl = api(source, "GET", f"/api/admin/data/pack/{body['id']}", boss_cookie)
    assert dl.status_code == 200 and dl.content[: len(sp.MAGIC)] == sp.MAGIC
    assert api(source, "GET", f"/api/admin/data/pack/{body['id']}", boss_cookie).status_code == 404
    pack = source.app.state.backup_dir + "/dl.etpack"
    Path(pack).write_bytes(dl.content)
    opened = sp.open_pack(pack, body["passphrase"])
    assert opened.manifest["counts"]["tasks"] == 2
    opened.cleanup()


# ── CLI ──────────────────────────────────────────────────


def test_cli_export_import_roundtrip(source, tmp_path, capsys):
    from server import cli

    src_db = source.db.path
    assert cli.main(["pack-export", "--db", src_db, "--out", str(tmp_path / "cli-out"), "--attachments", source.app.state.attachments_dir]) == 0
    out = capsys.readouterr().out
    phrase = out.strip().splitlines()[-1].strip()
    pack = next((tmp_path / "cli-out").glob("*.etpack"))

    target = tmp_path / "target"
    common = ["--db", str(target / "app.db"), "--attachments", str(target / "att"), "--out", str(target / "bk")]
    # 全新資料庫：不需要 --replace
    assert cli.main(["pack-import", str(pack), "--passphrase", phrase, *common]) == 0
    db = create_db(str(target / "app.db"))
    assert sorted(r["title"] for r in db.all("SELECT title FROM tasks")) == ["搬家任務 A", "搬家任務 B"]
    db.close()
    # 已有資料：沒有 --replace --yes 就拒絕
    assert cli.main(["pack-import", str(pack), "--passphrase", phrase, *common]) == 1
    assert cli.main(["pack-import", str(pack), "--passphrase", phrase, "--replace", "--yes", *common]) == 0
    assert list((target / "bk").glob("app-before-pack-restore-*.db"))


def test_cli_allow_restore(tmp_path):
    from server import cli

    db = str(tmp_path / "data" / "app.db")
    assert cli.main(["allow-restore", "--db", db, "--minutes", "5"]) == 0
    assert sp.unlock_expires_at(tmp_path / "data") is not None
    assert cli.main(["allow-restore", "--db", db, "--revoke"]) == 0
    assert sp.unlock_expires_at(tmp_path / "data") is None
    assert cli.main(["allow-restore", "--db", db, "--minutes", "999"]) == 1


def test_manifest_has_no_passphrase(pack, tmp_path):
    opened = sp.open_pack(pack.file, pack.passphrase, tmp_path)
    try:
        assert pack.passphrase not in json.dumps(opened.manifest)
    finally:
        opened.cleanup()
