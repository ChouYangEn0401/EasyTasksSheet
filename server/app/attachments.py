"""附件（通用機制）：類型白名單、內容魔術數字驗證、串流接收 multipart、檔案存放與下載標頭。

- 檔案存於 ATTACHMENTS_DIR，檔名為隨機 32 碼 hex（stored_name），完全不使用使用者提供的檔名；
  使用者檔名只當顯示文字（original_name，去除路徑與控制字元）。
- 上傳以 python-multipart 的串流 parser 逐塊寫入暫存檔（同目錄 .tmp-*），邊寫邊計算大小與 SHA-256，
  超過上限立即中止並刪除暫存檔；不會把整個檔案載入記憶體。
- 類型以「副檔名白名單」決定，並以內容魔術數字驗證（圖片 / PDF / 影片 / 音訊 / 壓縮檔 / Office）；
  文字檔不得含 NUL 位元組。回應的 Content-Type 一律取自白名單，不信任瀏覽器送來的 Content-Type。
- 下載：點陣圖片、影片、音訊、PDF 可 inline，其餘（含 SVG）一律 Content-Disposition: attachment；
  另加 X-Content-Type-Options: nosniff 與 CSP sandbox。Range 由 Starlette FileResponse 處理（206 / 416）。
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import sqlite3
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable
from urllib.parse import quote

from python_multipart import MultipartParser
from python_multipart.multipart import parse_options_header

from .errors import HttpError, bad_request

MB = 1024 * 1024

# ── 類型白名單 ──────────────────────────────────────────────


@dataclass(frozen=True)
class FileType:
    mime: str
    #: image / video / audio / pdf / text / archive / document
    kind: str
    #: 內容驗證函式（None = 不驗證，例如 Office 舊格式以外的已知容器）
    check: Callable[[bytes], bool] | None = None


def _png(h: bytes) -> bool:
    return h.startswith(b"\x89PNG\r\n\x1a\n")


def _jpeg(h: bytes) -> bool:
    return h.startswith(b"\xff\xd8\xff")


def _gif(h: bytes) -> bool:
    return h[:6] in (b"GIF87a", b"GIF89a")


def _webp(h: bytes) -> bool:
    return h[:4] == b"RIFF" and h[8:12] == b"WEBP"


def _pdf(h: bytes) -> bool:
    return h[:1024].lstrip().startswith(b"%PDF-")


def _zip(h: bytes) -> bool:
    return h[:4] in (b"PK\x03\x04", b"PK\x05\x06")


def _ole(h: bytes) -> bool:
    return h.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")


def _ftyp(h: bytes) -> bytes | None:
    """ISO BMFF（mp4 / mov / m4a）：第 4–8 位元組為 ftyp，回傳 major brand"""
    if len(h) >= 12 and h[4:8] == b"ftyp":
        return h[8:12]
    return None


_AUDIO_BRANDS = {b"M4A ", b"M4B ", b"M4P "}


def _mp4(h: bytes) -> bool:
    brand = _ftyp(h)
    return brand is not None and brand not in _AUDIO_BRANDS


def _mov(h: bytes) -> bool:
    if _ftyp(h) is not None:
        return True
    # 舊式 QuickTime 沒有 ftyp：第一個 atom 為 moov / mdat / wide / free / skip
    return len(h) >= 8 and h[4:8] in (b"moov", b"mdat", b"wide", b"free", b"skip", b"pnot")


def _webm(h: bytes) -> bool:
    return h.startswith(b"\x1a\x45\xdf\xa3") and b"webm" in h[:64]


def _m4a(h: bytes) -> bool:
    return _ftyp(h) is not None


def _mp3(h: bytes) -> bool:
    return h.startswith(b"ID3") or (len(h) >= 2 and h[0] == 0xFF and (h[1] & 0xE0) == 0xE0)


def _wav(h: bytes) -> bool:
    return h[:4] == b"RIFF" and h[8:12] == b"WAVE"


def _text(h: bytes) -> bool:
    return b"\x00" not in h


#: 副檔名 → 類型。不在此表的副檔名一律拒絕
FILE_TYPES: dict[str, FileType] = {
    "png": FileType("image/png", "image", _png),
    "jpg": FileType("image/jpeg", "image", _jpeg),
    "jpeg": FileType("image/jpeg", "image", _jpeg),
    "gif": FileType("image/gif", "image", _gif),
    "webp": FileType("image/webp", "image", _webp),
    "mp4": FileType("video/mp4", "video", _mp4),
    "m4v": FileType("video/mp4", "video", _mp4),
    "webm": FileType("video/webm", "video", _webm),
    "mov": FileType("video/quicktime", "video", _mov),
    "mp3": FileType("audio/mpeg", "audio", _mp3),
    "wav": FileType("audio/wav", "audio", _wav),
    "m4a": FileType("audio/mp4", "audio", _m4a),
    "pdf": FileType("application/pdf", "pdf", _pdf),
    "txt": FileType("text/plain; charset=utf-8", "text", _text),
    "md": FileType("text/markdown; charset=utf-8", "text", _text),
    "csv": FileType("text/csv; charset=utf-8", "text", _text),
    "json": FileType("application/json", "text", _text),
    "log": FileType("text/plain; charset=utf-8", "text", _text),
    "zip": FileType("application/zip", "archive", _zip),
    "docx": FileType("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document", _zip),
    "xlsx": FileType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document", _zip),
    "pptx": FileType("application/vnd.openxmlformats-officedocument.presentationml.presentation", "document", _zip),
    "odt": FileType("application/vnd.oasis.opendocument.text", "document", _zip),
    "ods": FileType("application/vnd.oasis.opendocument.spreadsheet", "document", _zip),
    "odp": FileType("application/vnd.oasis.opendocument.presentation", "document", _zip),
    "doc": FileType("application/msword", "document", _ole),
    "xls": FileType("application/vnd.ms-excel", "document", _ole),
    "ppt": FileType("application/vnd.ms-powerpoint", "document", _ole),
}

ALLOWED_DESCRIPTION = (
    "圖片（png、jpg、gif、webp）、影片（mp4、webm、mov）、音訊（mp3、wav、m4a）、pdf、"
    "文字（txt、md、csv、json、log）、zip、Office 文件（docx、xlsx、pptx、doc、xls、ppt、odt、ods、odp）"
)

#: 可在瀏覽器內直接顯示（inline）的類型；其餘一律下載。SVG 不在白名單內（可能含 script）
INLINE_KINDS = {"image", "video", "audio", "pdf"}
#: 用來驗證內容的前段位元組數
HEAD_BYTES = 8192


def kind_of_mime(mime: str) -> str:
    for t in FILE_TYPES.values():
        if t.mime == mime:
            return t.kind
    return "file"


def extension(name: str) -> str:
    base = name.rsplit(".", 1)
    return base[1].lower() if len(base) == 2 else ""


def safe_display_name(raw: str | None) -> str:
    """使用者檔名只當顯示用：去除路徑、控制字元與首尾空白 / 點，限制長度"""
    name = (raw or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = unicodedata.normalize("NFC", name)
    name = "".join(ch for ch in name if unicodedata.category(ch)[0] != "C")
    name = name.strip().strip(".").strip()
    if not name:
        name = "file"
    if len(name) > 200:
        ext = extension(name)
        name = name[: 200 - len(ext) - 1] + "." + ext if ext and len(ext) < 10 else name[:200]
    return name


@dataclass
class Limits:
    max_bytes: int
    video_max_bytes: int
    max_files: int

    def for_name(self, name: str) -> int:
        t = FILE_TYPES.get(extension(name))
        return self.video_max_bytes if t is not None and t.kind == "video" else self.max_bytes


def mb_text(n: int) -> str:
    v = n / MB
    return f"{v:.0f} MB" if v >= 10 or v == int(v) else f"{v:.1f} MB"


# ── 存放位置 ────────────────────────────────────────────────

_STORED_RE = re.compile(r"^[0-9a-f]{32}$")


def new_stored_name() -> str:
    return secrets.token_hex(16)


def stored_path(root: str | Path, stored_name: str) -> Path:
    """stored_name 必須是 32 碼 hex，且解析後仍在 root 之內（防路徑穿越）"""
    if not _STORED_RE.fullmatch(stored_name or ""):
        raise HttpError(404, "NOT_FOUND", "找不到附件檔案")
    base = Path(root).resolve()
    p = (base / stored_name).resolve()
    if not p.is_relative_to(base):
        raise HttpError(404, "NOT_FOUND", "找不到附件檔案")
    return p


def remove_files(root: str | Path, stored_names: list[str]) -> None:
    for s in stored_names:
        try:
            stored_path(root, s).unlink(missing_ok=True)
        except (HttpError, OSError):
            pass


def prune_orphans(conn: sqlite3.Connection, root: str | Path) -> list[str]:
    """刪除目錄中沒有對應資料列的檔案（例如匯入取代模式刪除問題後）與殘留暫存檔；回傳刪除的檔名"""
    base = Path(root)
    if not base.is_dir():
        return []
    known = {r[0] for r in conn.execute("SELECT stored_name FROM attachments")}
    removed: list[str] = []
    stale = time.time() - 3600  # 暫存檔超過一小時才視為殘留（避免刪到上傳中的檔案）
    for p in base.iterdir():
        if not p.is_file():
            continue
        if (_STORED_RE.fullmatch(p.name) and p.name not in known) or (
            p.name.startswith(".tmp-") and p.stat().st_mtime < stale
        ):
            p.unlink(missing_ok=True)
            removed.append(p.name)
    return removed


# ── 串流接收 multipart ─────────────────────────────────────


@dataclass
class Staged:
    """已寫入暫存檔、尚未驗證的上傳檔"""

    original_name: str
    tmp: Path
    size: int = 0
    head: bytes = b""
    sha: Any = field(default_factory=hashlib.sha256)
    limit: int = 0
    mime: str = ""

    @property
    def sha256(self) -> str:
        return self.sha.hexdigest()


def too_large(message: str) -> HttpError:
    return HttpError(413, "PAYLOAD_TOO_LARGE", message)


class _Receiver:
    def __init__(self, root: Path, limits: Limits, allowed_files: int):
        self.root = root
        self.limits = limits
        self.allowed_files = allowed_files
        self.files: list[Staged] = []
        self.error: HttpError | None = None
        self._headers: dict[str, bytes] = {}
        self._field = b""
        self._value = b""
        self._current: Staged | None = None
        self._fh: Any = None

    # python-multipart callbacks
    def on_part_begin(self) -> None:
        self._headers = {}

    def on_header_field(self, data: bytes, start: int, end: int) -> None:
        self._field += data[start:end]

    def on_header_value(self, data: bytes, start: int, end: int) -> None:
        self._value += data[start:end]

    def on_header_end(self) -> None:
        self._headers[self._field.decode("latin-1").lower()] = self._value
        self._field = b""
        self._value = b""

    def on_headers_finished(self) -> None:
        _, params = parse_options_header(self._headers.get("content-disposition", b""))
        raw = params.get(b"filename")
        if raw is None:
            self._current = None  # 一般欄位：忽略
            return
        if len(self.files) >= self.allowed_files:
            raise bad_request(f"每筆最多 {self.limits.max_files} 個附件")
        try:
            name = raw.decode("utf-8")
        except UnicodeDecodeError:
            name = raw.decode("latin-1")
        name = safe_display_name(name)
        tmp = self.root / f".tmp-{secrets.token_hex(12)}"
        self._fh = open(tmp, "wb")  # noqa: SIM115（於 on_part_end / cleanup 關閉）
        self._current = Staged(original_name=name, tmp=tmp, limit=self.limits.for_name(name))
        self.files.append(self._current)

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        cur = self._current
        if cur is None:
            return
        chunk = data[start:end]
        cur.size += len(chunk)
        if cur.size > cur.limit:
            raise too_large(f"「{cur.original_name}」超過單檔上限 {mb_text(cur.limit)}")
        if len(cur.head) < HEAD_BYTES:
            cur.head += chunk[: HEAD_BYTES - len(cur.head)]
        cur.sha.update(chunk)
        self._fh.write(chunk)

    def on_part_end(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None
        self._current = None

    def close(self) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None


def discard(files: list[Staged]) -> None:
    for f in files:
        try:
            f.tmp.unlink(missing_ok=True)
        except OSError:
            pass


async def receive_multipart(
    content_type: str,
    content_length: str | None,
    stream: AsyncIterator[bytes],
    root: Path,
    limits: Limits,
    allowed_files: int,
) -> list[Staged]:
    """串流解析 multipart/form-data，把檔案寫到 root 下的暫存檔。任何錯誤都會刪除已寫入的暫存檔"""
    ctype, params = parse_options_header(content_type)
    if ctype != b"multipart/form-data" or not params.get(b"boundary"):
        raise bad_request("請以 multipart/form-data 上傳檔案")
    if allowed_files <= 0:
        raise bad_request(f"每筆最多 {limits.max_files} 個附件")
    # 整個請求的粗略上限（逐檔上限另於串流中檢查）
    total_cap = allowed_files * max(limits.max_bytes, limits.video_max_bytes) + MB
    if content_length is not None:
        try:
            if int(content_length) > total_cap:
                raise too_large(f"上傳內容過大（單檔上限 {mb_text(limits.max_bytes)}，影片 {mb_text(limits.video_max_bytes)}）")
        except ValueError:
            raise bad_request("Content-Length 無效") from None
    root.mkdir(parents=True, exist_ok=True)
    rec = _Receiver(root, limits, allowed_files)
    parser = MultipartParser(
        params[b"boundary"],
        {  # type: ignore[arg-type]
            "on_part_begin": rec.on_part_begin,
            "on_header_field": rec.on_header_field,
            "on_header_value": rec.on_header_value,
            "on_header_end": rec.on_header_end,
            "on_headers_finished": rec.on_headers_finished,
            "on_part_data": rec.on_part_data,
            "on_part_end": rec.on_part_end,
        },
    )
    received = 0
    try:
        async for chunk in stream:
            received += len(chunk)
            if received > total_cap:
                raise too_large("上傳內容過大")
            if chunk:
                parser.write(chunk)
        parser.finalize()
    except HttpError:
        rec.close()
        discard(rec.files)
        raise
    except Exception:
        rec.close()
        discard(rec.files)
        raise bad_request("上傳內容格式錯誤") from None
    rec.close()
    if not rec.files:
        raise bad_request("沒有收到任何檔案")
    return rec.files


def validate(f: Staged) -> str | None:
    """回傳錯誤訊息（None = 通過），並設定 f.mime"""
    ext = extension(f.original_name)
    t = FILE_TYPES.get(ext)
    if t is None:
        shown = f".{ext}" if ext else "無副檔名"
        return f"「{f.original_name}」的類型（{shown}）不允許上傳；允許：{ALLOWED_DESCRIPTION}"
    if f.size == 0:
        return f"「{f.original_name}」是空檔案"
    if t.check is not None and not t.check(f.head):
        return f"「{f.original_name}」的內容與副檔名不符（不是有效的 .{ext} 檔）"
    f.mime = t.mime
    return None


# ── 下載標頭 ────────────────────────────────────────────────


def content_disposition(kind: str, name: str, force_download: bool = False) -> str:
    disp = "inline" if kind in INLINE_KINDS and not force_download else "attachment"
    ascii_name = re.sub(r'[^A-Za-z0-9._ -]', "_", name).strip() or "file"
    return f"{disp}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name, safe='')}"


def download_headers(mime: str, name: str, force_download: bool = False) -> dict[str, str]:
    kind = kind_of_mime(mime)
    # 即使被直接開啟也不能執行 script；PDF 例外（瀏覽器內建 PDF 檢視器在 sandbox 下無法顯示，PDF 本身不會執行頁面 script）
    csp = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'"
    if kind != "pdf":
        csp += "; sandbox"
    return {
        "Content-Disposition": content_disposition(kind, name, force_download),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": csp,
        "Cache-Control": "private, max-age=86400",
        "Cross-Origin-Resource-Policy": "same-origin",
    }


def ensure_dir(root: str | Path) -> Path:
    p = Path(root)
    p.mkdir(parents=True, exist_ok=True)
    return p


def move_into_place(f: Staged, root: Path) -> str:
    """暫存檔改名為隨機 stored_name，回傳 stored_name"""
    for _ in range(5):
        name = new_stored_name()
        dest = root / name
        if not dest.exists():
            os.replace(f.tmp, dest)
            return name
    raise RuntimeError("無法產生附件檔名")
