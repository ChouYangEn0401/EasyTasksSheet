"""附件：上傳 / 拒絕 / 下載標頭 / Range / 刪除 / CSRF / 備份往返 / 匯出元資料"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from pathlib import Path

import pytest

from server import cli
from server.app import attachments as att
from server.app import backup as bk
from server.app import data_transfer as dt
from server.app.db import create_db, run_migrations, run_seed

from .helpers import create_test_app, create_test_user, login_as

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + bytes(range(90))
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 60
PDF = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n"
MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 200
MOV = b"\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00qt  " + b"\x00" * 100
WEBM = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\xf7\x81\x01\x42\x82\x84webm" + b"\x00" * 100
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 50
WAV = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 40
ZIP = b"PK\x03\x04" + b"\x00" * 60


@pytest.fixture
def env():
    t = create_test_app()
    member = create_test_user(t.db)
    api = login_as(t, member)
    issue = api.request("POST", "/api/eng/issues", {"title": "附件測試"}).json()
    return t, api, member, issue


def upload(t, api, iid, files, headers=None, cookie=True):
    """files：[(檔名, bytes, content-type)]"""
    h = {"origin": "http://localhost"}
    if cookie and api.cookie:
        h["cookie"] = api.cookie
    h.update(headers or {})
    t.http.cookies.clear()
    res = t.http.post(
        f"/api/eng/issues/{iid}/attachments",
        files=[("files", (name, data, ctype)) for name, data, ctype in files],
        headers=h,
    )
    t.http.cookies.clear()
    return res


def get(t, api, path, headers=None):
    h = {"cookie": api.cookie, **(headers or {})}
    t.http.cookies.clear()
    return t.http.get(path, headers=h)


def att_dir(t) -> Path:
    return Path(t.app.state.attachments_dir)


def stored_files(t) -> list[str]:
    return sorted(p.name for p in att_dir(t).iterdir()) if att_dir(t).exists() else []


def set_limits(t, max_bytes=1000, video=5000, files=10):
    t.app.state.attachment_limits = att.Limits(max_bytes=max_bytes, video_max_bytes=video, max_files=files)


# ── 上傳成功 ──


def test_upload_multiple_and_list(env):
    t, api, member, issue = env
    res = upload(
        t,
        api,
        issue["id"],
        [
            ("截圖.png", PNG, "image/png"),
            ("報告.pdf", PDF, "application/pdf"),
            ("notes.txt", "第一行\n第二行".encode(), "text/plain"),
            ("demo.mp4", MP4, "video/mp4"),
        ],
    )
    assert res.status_code == 201, res.text
    items = res.json()["attachments"]
    assert [i["name"] for i in items] == ["截圖.png", "報告.pdf", "notes.txt", "demo.mp4"]
    assert [i["kind"] for i in items] == ["image", "pdf", "text", "video"]
    assert items[0]["mime"] == "image/png" and items[0]["size"] == len(PNG)
    assert items[0]["thumbUrl"] == f"/api/attachments/{items[0]['id']}/thumb"
    assert items[1]["thumbUrl"] is None
    assert items[0]["uploadedBy"] == member["id"]

    # 檔名為隨機 32 碼 hex，與使用者檔名無關；SHA-256 正確
    rows = t.db.all("SELECT * FROM attachments ORDER BY id")
    assert all(len(r["stored_name"]) == 32 for r in rows)
    assert stored_files(t) == sorted(r["stored_name"] for r in rows)
    assert rows[0]["sha256"] == hashlib.sha256(PNG).hexdigest()
    assert rows[0]["entity_type"] == "manual_issue" and rows[0]["uid"]

    listed = api.get("/api/eng/issues").json()
    assert [a["name"] for a in listed["attachments"][str(issue["id"])]] == [i["name"] for i in items]
    assert listed["attachmentLimits"]["maxFiles"] == 10
    # 變更流水（前端即時同步）
    assert t.db.scalar("SELECT count(*) FROM changes WHERE entity_type = 'repo' AND action = 'update'") == 1


def test_all_whitelisted_kinds(env):
    t, api, _m, issue = env
    files = [
        ("a.jpg", JPEG, "image/jpeg"),
        ("b.mov", MOV, "video/quicktime"),
        ("c.webm", WEBM, "video/webm"),
        ("d.mp3", MP3, "audio/mpeg"),
        ("e.wav", WAV, "audio/wav"),
        ("f.zip", ZIP, "application/zip"),
        ("g.docx", ZIP, "application/octet-stream"),
        ("h.csv", b"a,b\n1,2\n", "text/csv"),
    ]
    res = upload(t, api, issue["id"], files)
    assert res.status_code == 201, res.text
    kinds = [i["kind"] for i in res.json()["attachments"]]
    assert kinds == ["image", "video", "video", "audio", "audio", "archive", "document", "text"]
    # Content-Type 取自白名單，不信任瀏覽器送來的值
    assert res.json()["attachments"][6]["mime"].startswith("application/vnd.openxmlformats")


# ── 拒絕 ──


def test_reject_not_logged_in(env):
    t, api, _m, issue = env
    res = upload(t, api, issue["id"], [("a.png", PNG, "image/png")], cookie=False)
    assert res.status_code == 401
    assert stored_files(t) == []


def test_reject_unknown_issue(env):
    t, api, _m, _issue = env
    assert upload(t, api, 9999, [("a.png", PNG, "image/png")]).status_code == 404


def test_reject_type_and_fake_content(env):
    t, api, _m, issue = env
    for name, data, msg in [
        ("virus.exe", b"MZ\x90\x00", "不允許上傳"),
        ("noext", b"hello", "無副檔名"),
        ("logo.svg", b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "不允許上傳"),
        ("fake.png", b"<html>not an image</html>", "內容與副檔名不符"),
        ("fake.jpg", PNG, "內容與副檔名不符"),
        ("fake.mp4", b"\x00\x00\x00\x18notftyp" + b"\x00" * 50, "內容與副檔名不符"),
        ("fake.webm", b"\x1a\x45\xdf\xa3" + b"\x00" * 60, "內容與副檔名不符"),
        ("fake.pdf", b"hello", "內容與副檔名不符"),
        ("bin.txt", b"abc\x00def", "內容與副檔名不符"),
        ("empty.png", b"", "空檔案"),
    ]:
        res = upload(t, api, issue["id"], [(name, data, "image/png")])
        assert res.status_code == 400, name
        assert msg in res.json()["error"]["message"], (name, res.json())
    # 一批中有一個不合格 → 全部不寫入
    res = upload(t, api, issue["id"], [("ok.png", PNG, "image/png"), ("bad.exe", b"MZ", "x")])
    assert res.status_code == 400
    assert stored_files(t) == []
    assert t.db.scalar("SELECT count(*) FROM attachments") == 0


def test_reject_too_large_streaming_and_cleanup(env):
    t, api, _m, issue = env
    set_limits(t, max_bytes=100, video=1000)
    res = upload(t, api, issue["id"], [("big.png", PNG + b"\x00" * 200, "image/png")])
    assert res.status_code == 413
    assert "超過單檔上限" in res.json()["error"]["message"]
    # 暫存檔已清除
    assert stored_files(t) == []

    # 影片有較高的上限
    mp4 = MP4[:24] + b"\x00" * 476
    res = upload(t, api, issue["id"], [("clip.mp4", mp4, "video/mp4")])
    assert res.status_code == 201, res.text
    # 但影片也有上限；前一個合格檔案已寫入的暫存檔也會清掉
    res = upload(t, api, issue["id"], [("a.txt", b"ok", "text/plain"), ("long.mp4", MP4 + b"\x00" * 2000, "video/mp4")])
    assert res.status_code == 413
    assert len(stored_files(t)) == 1  # 只剩先前成功的 clip.mp4
    assert not [n for n in stored_files(t) if n.startswith(".tmp-")]
    # 一般檔案改副檔名為 .mp4 也逃不過內容驗證
    res = upload(t, api, issue["id"], [("pic.mp4", PNG + b"\x00" * 300, "video/mp4")])
    assert res.status_code == 400


def test_reject_huge_content_length_early(env):
    t, api, _m, issue = env
    set_limits(t, max_bytes=100, video=200, files=2)
    h = {"cookie": api.cookie, "origin": "http://localhost", "content-type": "multipart/form-data; boundary=x"}
    t.http.cookies.clear()
    res = t.http.post(
        f"/api/eng/issues/{issue['id']}/attachments",
        content=b"--x--\r\n",
        headers={**h, "content-length": str(10**9)},
    )
    assert res.status_code in (413, 400)


def test_filename_traversal_is_neutralized(env):
    t, api, _m, issue = env
    res = upload(t, api, issue["id"], [("../../../evil.png", PNG, "image/png"), ("..\\..\\x‮.txt", b"a", "x")])
    assert res.status_code == 201, res.text
    names = [i["name"] for i in res.json()["attachments"]]
    assert names == ["evil.png", "x.txt"]
    root = att_dir(t).resolve()
    assert not (root.parent / "evil.png").exists()
    assert all(len(n) == 32 for n in stored_files(t))
    # stored_path 不接受非 hex 名稱
    with pytest.raises(Exception):
        att.stored_path(root, "../app.db")


def test_file_count_limit(env):
    t, api, _m, issue = env
    set_limits(t, files=2)
    res = upload(t, api, issue["id"], [(f"{i}.txt", b"x", "text/plain") for i in range(3)])
    assert res.status_code == 400 and "最多 2 個附件" in res.json()["error"]["message"]
    assert stored_files(t) == []
    assert upload(t, api, issue["id"], [("1.txt", b"x", "t"), ("2.txt", b"y", "t")]).status_code == 201
    res = upload(t, api, issue["id"], [("3.txt", b"z", "text/plain")])
    assert res.status_code == 400 and "最多 2 個附件" in res.json()["error"]["message"]


def test_reject_non_multipart_and_no_files(env):
    t, api, _m, issue = env
    # JSON 送到上傳端點：通過 CSRF（JSON），但端點要求 multipart
    res = api.request("POST", f"/api/eng/issues/{issue['id']}/attachments", {"x": 1})
    assert res.status_code == 400
    h = {"cookie": api.cookie, "origin": "http://localhost"}
    t.http.cookies.clear()
    res = t.http.post(f"/api/eng/issues/{issue['id']}/attachments", data={"note": "沒有檔案"}, files={}, headers=h)
    # httpx 無檔案時送 urlencoded → CSRF 擋下
    assert res.status_code in (400, 403)


# ── CSRF / Origin ──


def test_csrf_multipart_requires_same_origin(env):
    t, api, _m, issue = env
    # 沒有 Origin
    h = {"cookie": api.cookie}
    t.http.cookies.clear()
    res = t.http.post(
        f"/api/eng/issues/{issue['id']}/attachments", files=[("f", ("a.png", PNG, "image/png"))], headers=h
    )
    assert res.status_code == 403
    # 跨站 Origin
    res = upload(t, api, issue["id"], [("a.png", PNG, "image/png")], headers={"origin": "http://evil.test"})
    assert res.status_code == 403
    # 其他端點仍不接受 multipart
    t.http.cookies.clear()
    res = t.http.post(
        "/api/eng/issues",
        files=[("f", ("a.png", PNG, "image/png"))],
        headers={"cookie": api.cookie, "origin": "http://localhost"},
    )
    assert res.status_code == 403
    t.http.cookies.clear()
    res = t.http.patch(
        f"/api/eng/issues/{issue['id']}/attachments",
        files=[("f", ("a.png", PNG, "image/png"))],
        headers={"cookie": api.cookie, "origin": "http://localhost"},
    )
    assert res.status_code == 403
    assert stored_files(t) == []


# ── 下載 ──


def _upload_one(t, api, iid, name, data, ctype="application/octet-stream"):
    res = upload(t, api, iid, [(name, data, ctype)])
    assert res.status_code == 201, res.text
    return res.json()["attachments"][0]


def test_download_headers(env):
    t, api, _m, issue = env
    img = _upload_one(t, api, issue["id"], "圖 1.png", PNG)
    res = get(t, api, img["url"])
    assert res.status_code == 200 and res.content == PNG
    assert res.headers["content-type"] == "image/png"
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["content-disposition"].startswith("inline;")
    assert "filename*=UTF-8''%E5%9C%96%201.png" in res.headers["content-disposition"]
    assert "sandbox" in res.headers["content-security-policy"]
    assert res.headers["accept-ranges"] == "bytes"
    # ?download=1 強制下載
    assert get(t, api, img["url"] + "?download=1").headers["content-disposition"].startswith("attachment;")

    txt = _upload_one(t, api, issue["id"], "a.txt", b"<script>alert(1)</script>")
    res = get(t, api, txt["url"])
    assert res.headers["content-disposition"].startswith("attachment;")
    assert res.headers["content-type"].startswith("text/plain")

    pdf = _upload_one(t, api, issue["id"], "r.pdf", PDF)
    res = get(t, api, pdf["url"])
    assert res.headers["content-disposition"].startswith("inline;")
    assert "sandbox" not in res.headers["content-security-policy"]

    # 未登入不可下載
    t.http.cookies.clear()
    assert t.http.get(img["url"]).status_code == 401
    assert get(t, api, "/api/attachments/9999").status_code == 404


def test_svg_never_inline(env):
    """SVG 不在白名單；即使資料庫裡有（例如舊資料 / 手動匯入），下載也一律 attachment + sandbox"""
    t, api, member, issue = env
    root = att.ensure_dir(att_dir(t))
    name = att.new_stored_name()
    (root / name).write_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
    with t.db.tx() as conn:
        cur = conn.execute(
            "INSERT INTO attachments (entity_type, entity_id, original_name, stored_name, mime, size, sha256, "
            "uploaded_by, created_at) VALUES ('manual_issue', ?, 'x.svg', ?, 'image/svg+xml', 10, 'x', ?, 1)",
            (issue["id"], name, member["id"]),
        )
    res = get(t, api, f"/api/attachments/{cur.lastrowid}")
    assert res.headers["content-disposition"].startswith("attachment;")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in res.headers["content-security-policy"]
    # 也沒有縮圖
    assert get(t, api, f"/api/attachments/{cur.lastrowid}/thumb").status_code == 404


def test_thumb_falls_back_to_original(env):
    t, api, _m, issue = env
    img = _upload_one(t, api, issue["id"], "a.png", PNG)
    res = get(t, api, img["thumbUrl"])
    assert res.status_code == 200
    try:
        import PIL  # noqa: F401
    except ImportError:
        assert res.content == PNG
    pdf = _upload_one(t, api, issue["id"], "r.pdf", PDF)
    assert get(t, api, f"/api/attachments/{pdf['id']}/thumb").status_code == 404


def test_range_requests(env):
    t, api, _m, issue = env
    data = MP4[:24] + bytes(i % 256 for i in range(76))  # 100 bytes
    assert len(data) == 100
    v = _upload_one(t, api, issue["id"], "clip.mp4", data, "video/mp4")
    url = v["url"]

    res = get(t, api, url, {"range": "bytes=0-9"})
    assert res.status_code == 206
    assert res.content == data[:10]
    assert res.headers["content-range"] == "bytes 0-9/100"
    assert res.headers["content-length"] == "10"
    assert res.headers["accept-ranges"] == "bytes"
    assert res.headers["content-type"] == "video/mp4"

    # suffix range：最後 5 bytes
    res = get(t, api, url, {"range": "bytes=-5"})
    assert res.status_code == 206 and res.content == data[-5:]
    assert res.headers["content-range"] == "bytes 95-99/100"

    # 開放結尾
    res = get(t, api, url, {"range": "bytes=90-"})
    assert res.status_code == 206 and res.content == data[90:]

    # 結尾超過檔尾 → 截到檔尾
    res = get(t, api, url, {"range": "bytes=95-500"})
    assert res.status_code == 206 and res.content == data[95:]
    assert res.headers["content-range"] == "bytes 95-99/100"

    # 起點超過檔尾 → 416
    res = get(t, api, url, {"range": "bytes=200-300"})
    assert res.status_code == 416
    assert res.headers.get("content-range") == "bytes */100"

    # 非法範圍（起點大於終點、格式錯誤、單位不對）→ 416
    for bad in ("bytes=50-10", "bytes=abc", "items=0-1", "bytes=-0", "bytes=-"):
        res = get(t, api, url, {"range": bad})
        assert res.status_code == 416, bad
        assert res.headers["content-range"] == "bytes */100"


# ── 刪除 ──


def test_delete_attachment_and_issue(env):
    t, api, _m, issue = env
    a, b = upload(t, api, issue["id"], [("a.png", PNG, "image/png"), ("b.txt", b"x", "text/plain")]).json()[
        "attachments"
    ]
    assert len(stored_files(t)) == 2
    assert api.request("DELETE", a["url"]).json() == {"ok": True}
    assert api.request("DELETE", a["url"]).status_code == 404
    assert len(stored_files(t)) == 1
    assert get(t, api, a["url"]).status_code == 404

    # 刪除問題 → 附件資料列（trigger）與檔案一併刪除
    assert api.request("DELETE", f"/api/eng/issues/{issue['id']}").status_code == 200
    assert t.db.scalar("SELECT count(*) FROM attachments") == 0
    assert stored_files(t) == []
    assert get(t, api, b["url"]).status_code == 404


def test_prune_orphans(env):
    t, api, _m, issue = env
    _upload_one(t, api, issue["id"], "a.png", PNG)
    orphan = att.new_stored_name()
    (att_dir(t) / orphan).write_bytes(b"x")
    old_tmp = att_dir(t) / ".tmp-old"
    old_tmp.write_bytes(b"x")
    os.utime(old_tmp, (1, 1))
    new_tmp = att_dir(t) / ".tmp-new"
    new_tmp.write_bytes(b"x")
    with t.db.tx() as conn:
        removed = att.prune_orphans(conn, att_dir(t))
    assert sorted(removed) == sorted([orphan, ".tmp-old"])
    assert new_tmp.exists() and len([n for n in stored_files(t) if len(n) == 32]) == 1


# ── 備份 / 匯出 ──


def test_backup_and_restore_with_attachments(tmp_path, monkeypatch, capsys):
    db_path = tmp_path / "data" / "app.db"
    att_root = tmp_path / "data" / "attachments"
    db = create_db(str(db_path))
    run_migrations(db)
    run_seed(db)
    att_root.mkdir(parents=True)
    names = [att.new_stored_name() for _ in range(2)]
    for i, n in enumerate(names):
        (att_root / n).write_bytes(f"file {i}".encode())
        db.execute(
            "INSERT INTO attachments (entity_type, entity_id, original_name, stored_name, mime, size, sha256, "
            "created_at) VALUES ('manual_issue', 1, ?, ?, 'text/plain; charset=utf-8', 6, 'x', 1)",
            (f"{i}.txt", n),
        )
    (att_root / att.new_stored_name()).write_bytes(b"orphan")  # 不在資料庫的檔案不備份
    out = tmp_path / "backups"
    r = bk.backup(db_path, out, keep=2, now=datetime(2026, 1, 1, 3), attachments_dir=att_root)
    assert r.attachments == out / "app-20260101-030000.db.attachments"
    assert sorted(p.name for p in r.attachments.iterdir()) == sorted(names)
    assert r.missing_attachments == []

    # 保留份數：舊備份的附件資料夾一起清除
    bk.backup(db_path, out, keep=2, now=datetime(2026, 1, 2, 3), attachments_dir=att_root)
    r3 = bk.backup(db_path, out, keep=2, now=datetime(2026, 1, 3, 3), attachments_dir=att_root)
    assert r3.removed == [r.file]
    assert not r.attachments.exists()

    # 備份後刪掉一個檔案、資料庫也刪掉一筆 → 還原後兩者都回來
    (att_root / names[0]).unlink()
    db.execute("DELETE FROM attachments WHERE stored_name = ?", (names[0],))
    db.close()
    monkeypatch.setenv("ATTACHMENTS_DIR", str(att_root))
    assert cli.main(["restore", str(r3.file), "--db", str(db_path), "--yes"]) == 0
    out_text = capsys.readouterr().out
    assert "已還原附件目錄" in out_text
    assert sorted(p.name for p in att_root.iterdir()) == sorted(names)
    assert (att_root / names[0]).read_bytes() == b"file 0"
    assert list(tmp_path.joinpath("data").glob("attachments.before-restore-*"))
    db2 = create_db(str(db_path))
    try:
        assert db2.scalar("SELECT count(*) FROM attachments") == 2
    finally:
        db2.close()


def test_cli_backup_includes_attachments(tmp_path, monkeypatch, capsys):
    db_path = tmp_path / "app.db"
    db = create_db(str(db_path))
    run_migrations(db)
    db.close()
    att_root = tmp_path / "att"
    att_root.mkdir()
    monkeypatch.setenv("ATTACHMENTS_DIR", str(att_root))
    assert cli.main(["backup", "--db", str(db_path), "--out", str(tmp_path / "b")]) == 0
    assert "附件" in capsys.readouterr().out
    files = bk.list_backups(db_path, tmp_path / "b")
    assert bk.attachments_backup_dir(files[-1]).is_dir()
    assert cli.main(["backup", "--db", str(db_path), "--out", str(tmp_path / "c"), "--no-attachments"]) == 0
    assert not bk.attachments_backup_dir(bk.list_backups(db_path, tmp_path / "c")[-1]).exists()


def test_export_contains_attachment_metadata_only(env):
    t, api, member, issue = env
    _upload_one(t, api, issue["id"], "a.png", PNG)
    doc = dt.export_document(t.db, 1)
    assert len(doc["attachments"]) == 1
    meta = doc["attachments"][0]
    assert meta["name"] == "a.png" and meta["size"] == len(PNG) and meta["entityType"] == "manual_issue"
    assert meta["entityUid"] == t.db.scalar("SELECT uid FROM manual_issues WHERE id = ?", (issue["id"],))
    assert meta["uploadedByUsername"] == member["username"]
    assert "stored_name" not in json.dumps(doc) and "storedName" not in meta
    # 匯出檔仍可匯入（附件清單忽略）；舊版匯出檔（沒有 attachments）也可
    parsed = dt.parse_document(json.dumps(doc))
    assert parsed["attachments"][0]["name"] == "a.png"
    del doc["attachments"]
    dt.parse_document(json.dumps(doc))
