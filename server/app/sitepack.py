"""整站搬家包（.etpack）：把整個網站（資料庫＋附件）打包成一個用密語加密的檔案，在另一台 server 還原。

設計（docs/design/site-pack.md）：
- 內容：zip（manifest.json、app.db、attachments/<32 位十六進位>）。
- 加密：密語 → Argon2id（64 MiB、t=3、p=4）→ 32 bytes 金鑰 → AES-256-GCM，以 1 MiB 為一段（STREAM 結構）：
  nonce = 7 bytes 隨機前綴 + 4 bytes 段落序號 + 1 byte「最後一段」旗標，所有段落以整個檔頭當 AAD。
  任一位元被改、段落被調換或截斷都會驗證失敗；密語錯誤與檔案損壞一律回同一個訊息。
- 密語：EFF 字表隨機 8 個字（約 103 位元），只在匯出時顯示一次，伺服器不保存。
- 還原安全：
  * 全新 server（只有一個尚未完成首次改密碼的帳號、沒有任務）：登入前即可還原，不需其他條件。
  * 已有資料的 server：root 登入＋再次輸入自己的密碼＋機器上的「還原解鎖」（只能在 server 本機用
    `python -m server.cli allow-restore` 開啟，30 分鐘失效、用一次即關閉）＋輸入確認字樣。
  * 不論哪種，還原前一律先把現有資料完整備份到 BACKUP_DIR（不可關閉）；還原後所有 session 失效。
- 版本：搬家包裡的 migration 必須是本機程式已知的子集合（搬家包較新 → 拒絕；較舊 → 還原後自動升級）。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import struct
import tempfile
import threading
import time
import zipfile
from contextlib import closing
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, BinaryIO, Callable

from argon2.low_level import Type, hash_secret_raw
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .backup import _STORED_RE, _backup_attachments, _link_or_copy, integrity_check, timestamp
from .db import MIGRATIONS_DIR, Database, _migration_files

MAGIC = b"ETPACK\x00\x01"
FORMAT = "easytasks-site-pack"
FORMAT_VERSION = 1
EXTENSION = ".etpack"
CHUNK = 1 << 20
PASSPHRASE_WORDS = 8
#: Argon2id 參數（寫進檔頭，解密時照檔頭；上限避免惡意檔頭耗盡記憶體）
KDF_TIME, KDF_MEMORY_KIB, KDF_PARALLELISM = 3, 64 * 1024, 4
_KDF_MAX_MEMORY_KIB, _KDF_MAX_TIME = 256 * 1024, 10
_HEADER_MAX = 4096
UNLOCK_FILE = "restore-unlock.json"
UNLOCK_MINUTES = 30
CONFIRM_TEXT = "取代全部"
WRONG_KEY_MESSAGE = "無法解開搬家包：密語不正確，或檔案已損壞"

#: 同一時間只允許一個匯入（也限制 Argon2 同時佔用的記憶體）
RESTORE_LOCK = threading.Lock()


class PackError(ValueError):
    """搬家包格式、密語、版本或還原條件不符；message 可直接顯示給使用者"""

    def __init__(self, message: str, code: str = "PACK_INVALID", status: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


# ── 密語 ─────────────────────────────────────────────────


@lru_cache(maxsize=1)
def _words() -> tuple[str, ...]:
    path = Path(__file__).with_name("wordlist") / "eff_large_wordlist.txt"
    words = tuple(w.strip() for w in path.read_text(encoding="ascii").splitlines() if w.strip())
    if len(words) < 7000 or any(not re.fullmatch(r"[a-z]+", w) for w in words):
        raise RuntimeError(f"字表內容不正確：{path}")
    return words


def generate_passphrase(n: int = PASSPHRASE_WORDS) -> str:
    words = _words()
    return "-".join(secrets.choice(words) for _ in range(n))


def normalize_passphrase(text: str) -> str:
    """容許大小寫、空白、換行、連字號、底線等差異：只取英文字母組成的字，以 - 連接"""
    return "-".join(re.findall(r"[a-z]+", (text or "").lower()))


def _derive_key(passphrase: str, salt: bytes, t: int, m: int, p: int) -> bytes:
    norm = normalize_passphrase(passphrase)
    if not norm:
        raise PackError("請輸入解鎖密語", "PASSPHRASE_REQUIRED")
    return hash_secret_raw(norm.encode("ascii"), salt, time_cost=t, memory_cost=m, parallelism=p, hash_len=32, type=Type.ID)


# ── 串流加解密 ───────────────────────────────────────────


def _nonce(prefix: bytes, counter: int, last: bool) -> bytes:
    return prefix + struct.pack(">I", counter) + (b"\x01" if last else b"\x00")


class _EncryptingWriter:
    """寫入的明文以 CHUNK 為單位加密寫到 out；close() 寫出帶「最後一段」旗標的段落"""

    def __init__(self, out: BinaryIO, passphrase: str):
        salt = secrets.token_bytes(16)
        self._prefix = secrets.token_bytes(7)
        header = {
            "format": FORMAT,
            "version": FORMAT_VERSION,
            "cipher": "aes-256-gcm",
            "chunk": CHUNK,
            "noncePrefix": base64.b64encode(self._prefix).decode(),
            "kdf": {
                "name": "argon2id",
                "t": KDF_TIME,
                "m": KDF_MEMORY_KIB,
                "p": KDF_PARALLELISM,
                "salt": base64.b64encode(salt).decode(),
            },
        }
        hb = json.dumps(header, separators=(",", ":")).encode()
        self._aad = MAGIC + struct.pack(">I", len(hb)) + hb
        self._aes = AESGCM(_derive_key(passphrase, salt, KDF_TIME, KDF_MEMORY_KIB, KDF_PARALLELISM))
        self._out = out
        self._buf = bytearray()
        self._counter = 0
        self._closed = False
        out.write(self._aad)

    def _emit(self, data: bytes, last: bool) -> None:
        ct = self._aes.encrypt(_nonce(self._prefix, self._counter, last), data, self._aad)
        self._out.write(struct.pack(">I", len(ct)))
        self._out.write(ct)
        self._counter += 1

    def write(self, data: bytes) -> int:
        self._buf += data
        # 至少留一個位元組到 close()，確保最後一段一定帶旗標
        while len(self._buf) > CHUNK:
            self._emit(bytes(self._buf[:CHUNK]), False)
            del self._buf[:CHUNK]
        return len(data)

    def flush(self) -> None:
        pass

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._emit(bytes(self._buf), True)
            self._buf.clear()


def _read_exact(f: BinaryIO, n: int) -> bytes:
    data = f.read(n)
    if len(data) != n:
        raise PackError("搬家包不完整（檔案被截斷）", "PACK_TRUNCATED")
    return data


def read_header(f: BinaryIO) -> tuple[dict[str, Any], bytes]:
    if f.read(len(MAGIC)) != MAGIC:
        raise PackError("這不是整站搬家包（.etpack）檔案", "PACK_NOT_PACK")
    (n,) = struct.unpack(">I", _read_exact(f, 4))
    if n <= 0 or n > _HEADER_MAX:
        raise PackError("搬家包檔頭不正確", "PACK_INVALID")
    hb = _read_exact(f, n)
    try:
        header = json.loads(hb)
        kdf = header["kdf"]
        ok = (
            header.get("format") == FORMAT
            and header.get("cipher") == "aes-256-gcm"
            and kdf.get("name") == "argon2id"
            and isinstance(header.get("chunk"), int)
            and 0 < header["chunk"] <= 16 * CHUNK
            and len(base64.b64decode(header["noncePrefix"])) == 7
            and 1 <= int(kdf["t"]) <= _KDF_MAX_TIME
            and 8 <= int(kdf["m"]) <= _KDF_MAX_MEMORY_KIB
            and 1 <= int(kdf["p"]) <= 16
            and len(base64.b64decode(kdf["salt"])) >= 16
        )
    except (ValueError, KeyError, TypeError, AttributeError):
        ok = False
    if not ok:
        raise PackError("搬家包檔頭不正確", "PACK_INVALID")
    if header.get("version") != FORMAT_VERSION:
        raise PackError(f"不支援的搬家包格式版本：{header.get('version')}", "PACK_VERSION")
    return header, MAGIC + struct.pack(">I", n) + hb


def decrypt_to(src: BinaryIO, dst: BinaryIO, passphrase: str) -> None:
    header, aad = read_header(src)
    kdf = header["kdf"]
    key = _derive_key(passphrase, base64.b64decode(kdf["salt"]), int(kdf["t"]), int(kdf["m"]), int(kdf["p"]))
    aes = AESGCM(key)
    prefix = base64.b64decode(header["noncePrefix"])
    max_ct = header["chunk"] + 16
    counter = 0
    while True:
        (n,) = struct.unpack(">I", _read_exact(src, 4))
        if n < 16 or n > max_ct:
            raise PackError(WRONG_KEY_MESSAGE, "PACK_DECRYPT")
        ct = _read_exact(src, n)
        pt: bytes | None = None
        last = False
        for last in (False, True):
            try:
                pt = aes.decrypt(_nonce(prefix, counter, last), ct, aad)
                break
            except InvalidTag:
                continue
        if pt is None:
            raise PackError(WRONG_KEY_MESSAGE, "PACK_DECRYPT")
        dst.write(pt)
        counter += 1
        if last:
            if src.read(1):
                raise PackError(WRONG_KEY_MESSAGE, "PACK_DECRYPT")
            return


# ── 建立搬家包 ───────────────────────────────────────────


@dataclass
class PackResult:
    file: Path
    passphrase: str
    manifest: dict[str, Any]


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _db_summary(db_file: Path) -> dict[str, Any]:
    with closing(sqlite3.connect(db_file)) as c:
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}

        def count(t: str) -> int:
            return int(c.execute(f"SELECT count(*) FROM {t}").fetchone()[0]) if t in tables else 0

        migrations = sorted(r[0] for r in c.execute("SELECT name FROM _migrations")) if "_migrations" in tables else []
        return {
            "migrations": migrations,
            "counts": {t: count(t) for t in ("users", "projects", "tasks", "feedback_items", "attachments")},
        }


def pack_filename(now_ts: str | None = None) -> str:
    return f"easytasks-{now_ts or timestamp()}{EXTENSION}"


def build_pack(
    db: Database,
    attachments_dir: str | Path,
    out_dir: str | Path,
    *,
    created_by: str | None = None,
    passphrase: str | None = None,
) -> PackResult:
    """建立整站搬家包。服務運行中可執行（資料庫以 VACUUM INTO 取一致快照）。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    phrase = passphrase or generate_passphrase()
    work = Path(tempfile.mkdtemp(prefix="etpack-build-", dir=out_dir))
    try:
        snap = work / "app.db"
        with db.lock:
            db.conn.execute("VACUUM INTO ?", (str(snap),))
        integrity_check(snap, to_single_file=True)
        att = work / "attachments"
        missing = _backup_attachments(snap, Path(attachments_dir), att)
        summary = _db_summary(snap)
        manifest = {
            "format": FORMAT,
            "formatVersion": FORMAT_VERSION,
            "createdAt": int(time.time() * 1000),
            "createdBy": created_by,
            "migrations": summary["migrations"],
            "counts": summary["counts"],
            "attachmentFiles": sorted(p.name for p in att.iterdir()),
            "missingAttachments": missing,
            "dbSha256": _sha256(snap),
        }
        final = out_dir / pack_filename()
        i = 2
        while final.exists():
            final = out_dir / pack_filename(f"{timestamp()}-{i}")
            i += 1
        partial = final.with_name(final.name + ".partial")
        with partial.open("wb") as raw:
            enc = _EncryptingWriter(raw, phrase)
            with zipfile.ZipFile(enc, "w", allowZip64=True) as z:  # type: ignore[arg-type]
                z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1), zipfile.ZIP_DEFLATED)
                z.write(snap, "app.db", zipfile.ZIP_DEFLATED)
                for p in sorted(att.iterdir()):
                    z.write(p, f"attachments/{p.name}", zipfile.ZIP_STORED)
            enc.close()
        partial.replace(final)
        return PackResult(file=final, passphrase=phrase, manifest=manifest)
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── 開啟搬家包 ───────────────────────────────────────────


@dataclass
class OpenedPack:
    manifest: dict[str, Any]
    db_file: Path
    attachments: Path
    workdir: Path

    def cleanup(self) -> None:
        shutil.rmtree(self.workdir, ignore_errors=True)


def open_pack(pack: str | Path, passphrase: str, work_parent: str | Path | None = None) -> OpenedPack:
    """解密並檢查搬家包，解到暫存資料夾；呼叫端用完要 cleanup()"""
    work = Path(tempfile.mkdtemp(prefix="etpack-open-", dir=work_parent))
    try:
        plain = work / "pack.zip"
        with Path(pack).open("rb") as src, plain.open("wb") as dst:
            decrypt_to(src, dst, passphrase)
        att = work / "attachments"
        att.mkdir()
        db_file = work / "app.db"
        try:
            with zipfile.ZipFile(plain) as z:
                names = z.namelist()
                if "manifest.json" not in names or "app.db" not in names:
                    raise PackError("搬家包內容不完整（缺少 manifest.json 或 app.db）")
                for name in names:
                    if name in ("manifest.json", "app.db"):
                        continue
                    m = re.fullmatch(r"attachments/([0-9a-f]{32})", name)
                    if not m:
                        raise PackError(f"搬家包含有不認得的檔案：{name[:80]}")
                manifest = json.loads(z.read("manifest.json"))
                with z.open("app.db") as s, db_file.open("wb") as d:
                    shutil.copyfileobj(s, d, 1 << 20)
                for name in names:
                    if name.startswith("attachments/"):
                        with z.open(name) as s, (att / name.split("/", 1)[1]).open("wb") as d:
                            shutil.copyfileobj(s, d, 1 << 20)
        except (zipfile.BadZipFile, ValueError, KeyError) as e:
            if isinstance(e, PackError):
                raise
            raise PackError("搬家包內容損壞") from None
        plain.unlink()
        if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
            raise PackError("搬家包的說明檔（manifest）不正確")
        if manifest.get("dbSha256") != _sha256(db_file):
            raise PackError("搬家包的資料庫與說明檔不一致")
        try:
            integrity_check(db_file)
        except Exception:
            raise PackError("搬家包裡的資料庫已損壞") from None
        return OpenedPack(manifest=manifest, db_file=db_file, attachments=att, workdir=work)
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise


def check_compatible(manifest: dict[str, Any], migrations_dir: Path = MIGRATIONS_DIR) -> None:
    known = {f.stem for f in _migration_files(migrations_dir)}
    unknown = sorted(set(manifest.get("migrations") or []) - known)
    if unknown:
        raise PackError(
            "搬家包來自比這台 server 新的程式版本，請先更新這台 server 的程式再還原"
            f"（不認得的資料庫版本：{', '.join(unknown[:3])}）",
            "PACK_TOO_NEW",
        )


# ── 還原條件 ─────────────────────────────────────────────


def users_empty(db: Database) -> bool:
    """完全沒有帳號（剛建立的資料庫，尚未建立預設管理員）"""
    return int(db.scalar("SELECT count(*) FROM users") or 0) == 0


def is_pristine(db: Database) -> bool:
    """全新 server：只有一個帳號、它還沒完成首次改密碼，且沒有任何任務"""
    users = db.all("SELECT must_change_password FROM users")
    if len(users) != 1 or not users[0]["must_change_password"]:
        return False
    return int(db.scalar("SELECT count(*) FROM tasks") or 0) == 0


def unlock_path(data_dir: str | Path) -> Path:
    return Path(data_dir) / UNLOCK_FILE


def allow_restore(data_dir: str | Path, minutes: int = UNLOCK_MINUTES, now: float | None = None) -> float:
    """在 server 本機開啟「還原解鎖」（只能由能操作這台機器的人執行）。回傳到期時間（unix 秒）"""
    if not 1 <= minutes <= 120:
        raise PackError("解鎖時間必須在 1 到 120 分鐘之間")
    expires = (now or time.time()) + minutes * 60
    p = unlock_path(data_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps({"expiresAt": expires}), encoding="utf-8")
    os.replace(tmp, p)
    return expires


def unlock_expires_at(data_dir: str | Path, now: float | None = None) -> float | None:
    """還原解鎖仍有效時回傳到期時間，否則 None（過期的檔案順手刪除）"""
    p = unlock_path(data_dir)
    try:
        expires = float(json.loads(p.read_text(encoding="utf-8"))["expiresAt"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if expires <= (now or time.time()):
        p.unlink(missing_ok=True)
        return None
    return expires


def revoke_unlock(data_dir: str | Path) -> None:
    unlock_path(data_dir).unlink(missing_ok=True)


# ── 套用還原 ─────────────────────────────────────────────


@dataclass
class RestoreResult:
    manifest: dict[str, Any]
    pre_restore_backup: Path | None
    applied_migrations: list[str]


def _replace_attachments(src: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".restoring")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    for f in src.iterdir():
        if f.is_file() and _STORED_RE.fullmatch(f.name):
            _link_or_copy(f, tmp / f.name)
    old = target.with_name(target.name + ".replaced")
    shutil.rmtree(old, ignore_errors=True)
    if target.exists():
        os.replace(target, old)
    os.replace(tmp, target)
    shutil.rmtree(old, ignore_errors=True)


def apply_restore(
    db: Database,
    opened: OpenedPack,
    *,
    attachments_dir: str | Path,
    backup_dir: str | Path,
    after_restore: Callable[[sqlite3.Connection], None] | None = None,
) -> RestoreResult:
    """以搬家包取代整個網站的資料（服務運行中可執行）。

    1. 先把現有資料庫與附件完整備份到 backup_dir（不可略過；失敗就中止，不動任何資料）
    2. 以 SQLite backup API 把搬家包的資料庫整份寫進目前的資料庫（持有 db.lock，其他請求暫時等待）
    3. 換上附件、套用較新的 migration、清除所有 session
    """
    from .db import run_migrations
    from .permissions import invalidate

    check_compatible(opened.manifest)
    backup_dir = Path(backup_dir)
    backup_dir.mkdir(parents=True, exist_ok=True)
    with db.lock:
        pre: Path | None = None
        if db.path != ":memory:":
            pre = backup_dir / f"{Path(db.path).stem}-before-pack-restore-{timestamp()}.db"
            i = 2
            while pre.exists():
                pre = backup_dir / f"{Path(db.path).stem}-before-pack-restore-{timestamp()}-{i}.db"
                i += 1
            partial = pre.with_name(pre.name + ".partial")
            db.conn.execute("VACUUM INTO ?", (str(partial),))
            integrity_check(partial, to_single_file=True)
            partial.replace(pre)
            _backup_attachments(pre, Path(attachments_dir), Path(f"{pre}.attachments"))

        with closing(sqlite3.connect(opened.db_file)) as src:
            src.backup(db.conn)
        db.conn.execute("PRAGMA journal_mode = WAL")
        db.conn.execute("PRAGMA foreign_keys = ON")
        _replace_attachments(opened.attachments, Path(attachments_dir))
        applied = run_migrations(db)
        with db.tx() as conn:
            conn.execute("DELETE FROM sessions")
            if after_restore is not None:
                after_restore(conn)
        invalidate(db)
    return RestoreResult(manifest=opened.manifest, pre_restore_backup=pre, applied_migrations=applied)
