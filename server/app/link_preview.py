"""連結預覽：抓取網頁 metadata（標題、說明、og:image、favicon、網站名稱、前 300 字摘要）。

不做整頁截圖（需要伺服器端無頭瀏覽器）。安全（SSRF）措施：
- 只允許 http / https，網址不得含帳密；主機名一律解析成 IP 後檢查，拒絕私有 / 迴圈 / 連結本地 / 保留 /
  多點傳送位址（IPv4 與 IPv6，含 IPv4-mapped、NAT64、6to4 內嵌的 IPv4），以及十進位 / 十六進位 / 八進位等
  非標準 IPv4 寫法（以 inet_aton 規則自行解析後同樣檢查）。localhost / *.localhost 直接拒絕。
- 連線時直接連到「已驗證的 IP」（HTTP 設 Host 標頭、HTTPS 以 SNI 與憑證驗證原主機名），避免 DNS rebinding。
- 重新導向最多 3 次，每次重新驗證網址與 IP。
- 逾時：連線 5 秒、整體 10 秒；回應最多讀 1 MB；只解析 text/html（其他類型只記錄 content-type 與網域）。
- 不帶 cookie / 認證、不執行 JS、Accept-Encoding: identity；以標準庫 html.parser 解析；輸出全部當純文字。
LINK_PREVIEW_ALLOW_PRIVATE=true 時才允許內網位址（僅供測試 / 內網部署，有 SSRF 風險）。
"""

from __future__ import annotations

import http.client
import ipaddress
import re
import socket
import ssl
import time
import unicodedata
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any, Callable, Protocol
from urllib.parse import urljoin, urlsplit

USER_AGENT = "TasksSheets-LinkPreview/1.0 (metadata only; no JavaScript)"
MAX_BYTES = 1024 * 1024
MAX_REDIRECTS = 3
CONNECT_TIMEOUT = 5.0
TOTAL_TIMEOUT = 10.0
SUMMARY_CHARS = 300


class PreviewError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


# ── 位址檢查 ────────────────────────────────────────────────

_BLOCKED_V4 = [
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "255.255.255.255/32",
    )
]
_BLOCKED_V6 = [
    ipaddress.ip_network(n)
    for n in (
        "::/128",
        "::1/128",
        "::ffff:0:0/96",
        "64:ff9b::/96",
        "64:ff9b:1::/48",
        "100::/64",
        "2001::/23",
        "2001:db8::/32",
        "2002::/16",
        "fc00::/7",
        "fe80::/10",
        "fec0::/10",
        "ff00::/8",
    )
]


def _embedded_v4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip.sixtofour is not None:
        return ip.sixtofour
    if ip in ipaddress.ip_network("64:ff9b::/96"):
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    if ip.teredo is not None:
        return ip.teredo[1]
    # IPv4-compatible（已廢棄）::a.b.c.d
    if int(ip) >> 32 == 0:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return None


def is_public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """只有可公開路由的單播位址才允許"""
    if isinstance(ip, ipaddress.IPv6Address):
        inner = _embedded_v4(ip)
        if inner is not None and not is_public_ip(inner):
            return False
        if any(ip in n for n in _BLOCKED_V6):
            return False
    else:
        if any(ip in n for n in _BLOCKED_V4):
            return False
    return ip.is_global and not ip.is_multicast and not ip.is_reserved and not ip.is_loopback


def parse_ipv4_loose(host: str) -> ipaddress.IPv4Address | None:
    """inet_aton 相容寫法：127.1、2130706433、0x7f000001、0177.0.0.1 等；不是 IPv4 寫法回傳 None"""
    parts = host.split(".")
    if parts and parts[-1] == "":
        parts = parts[:-1]  # 結尾的點
    if not 1 <= len(parts) <= 4:
        return None
    nums: list[int] = []
    for p in parts:
        if re.fullmatch(r"0[xX][0-9a-fA-F]*", p):
            v = int(p[2:] or "0", 16)
        elif re.fullmatch(r"0[0-7]+", p):
            v = int(p, 8)
        elif re.fullmatch(r"[0-9]+", p):
            v = int(p, 10)
        else:
            return None
        nums.append(v)
    *head, last = nums
    if any(v > 255 for v in head) or last >= 256 ** (4 - len(head)):
        return None
    value = 0
    for v in head:
        value = value * 256 + v
    value = value * 256 ** (4 - len(head)) + last
    return ipaddress.IPv4Address(value)


def ip_literal(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    h = host.strip("[]").split("%", 1)[0]
    try:
        return ipaddress.ip_address(h)
    except ValueError:
        return parse_ipv4_loose(h)


Resolver = Callable[[str, int], list[str]]


def system_resolver(host: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(i[4][0]) for i in infos]


@dataclass
class Target:
    scheme: str
    host: str
    port: int
    ip: str
    path: str  # 含 query
    #: 全部驗證過的 IP（依解析順序；第一個連不上時依序嘗試下一個）
    ips: tuple[str, ...] = ()


def check_url(url: str, resolver: Resolver, allow_private: bool) -> Target:
    """驗證網址並解析出要連線的 IP（全部解析結果都必須是公開位址）"""
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        raise PreviewError("網址格式錯誤") from None
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise PreviewError("只支援 http / https 網址")
    if parts.username is not None or parts.password is not None:
        raise PreviewError("網址不可包含帳號密碼")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise PreviewError("網址缺少主機名稱")
    port = port or (443 if scheme == "https" else 80)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query

    literal = ip_literal(host)
    if literal is not None:
        ips = [str(literal)]
    else:
        if not allow_private and (host == "localhost" or host.endswith(".localhost")):
            raise PreviewError("不允許連到本機或內部網路位址")
        if not re.fullmatch(r"[a-z0-9.-]+", host) and not host.startswith("xn--"):
            try:
                host = host.encode("idna").decode("ascii")
            except UnicodeError:
                raise PreviewError("主機名稱無效") from None
        try:
            ips = resolver(host, port)
        except (OSError, UnicodeError):
            raise PreviewError("無法解析主機名稱") from None
        if not ips:
            raise PreviewError("無法解析主機名稱")
    parsed = []
    for raw in ips:
        ip = ip_literal(raw)
        if ip is None:
            raise PreviewError("無法解析主機名稱")
        if not allow_private and not is_public_ip(ip):
            raise PreviewError("不允許連到本機或內部網路位址")
        parsed.append(ip)
    unique = tuple(dict.fromkeys(str(ip) for ip in parsed))
    return Target(scheme, host, port, unique[0], path, unique)


# ── 傳輸 ────────────────────────────────────────────────────


class RawResponse(Protocol):
    status: int
    headers: dict[str, str]

    def read(self, n: int) -> bytes: ...

    def close(self) -> None: ...


Transport = Callable[[Target, dict[str, str], float], RawResponse]


class _HttpResponse:
    def __init__(self, conn: http.client.HTTPConnection, resp: http.client.HTTPResponse):
        self._conn = conn
        self._resp = resp
        self.status = resp.status
        self.headers = {k.lower(): v for k, v in resp.getheaders()}

    def read(self, n: int) -> bytes:
        return self._resp.read1(n) if hasattr(self._resp, "read1") else self._resp.read(n)

    def set_timeout(self, t: float) -> None:
        if self._conn.sock is not None:
            self._conn.sock.settimeout(max(0.1, t))

    def close(self) -> None:
        self._resp.close()
        self._conn.close()


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, ip: str, *a: Any, **kw: Any):
        super().__init__(*a, **kw)
        self._ip = ip

    def connect(self) -> None:
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, ip: str, *a: Any, **kw: Any):
        super().__init__(*a, **kw)
        self._ip = ip

    def connect(self) -> None:
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        ctx = ssl.create_default_context()
        self.sock = ctx.wrap_socket(sock, server_hostname=self.host)


def default_transport(target: Target, headers: dict[str, str], timeout: float) -> RawResponse:
    """連到已驗證的 IP（不再做 DNS 解析）"""
    cls = _PinnedHTTPS if target.scheme == "https" else _PinnedHTTP
    conn = cls(target.ip, target.host, target.port, timeout=min(CONNECT_TIMEOUT, timeout))
    host_header = target.host if target.port in (80, 443) else f"{target.host}:{target.port}"
    try:
        conn.request("GET", target.path, headers={**headers, "Host": host_header})
        resp = conn.getresponse()
    except Exception:
        conn.close()
        raise
    return _HttpResponse(conn, resp)


# ── HTML 解析 ───────────────────────────────────────────────


class _MetaParser(HTMLParser):
    _SKIP = {"script", "style", "noscript", "template", "svg", "head", "iframe", "object"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.in_title = False
        self.meta: dict[str, str] = {}
        self.icons: list[str] = []
        self.text: list[str] = []
        self.text_len = 0
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title":
            self.in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or "").strip().lower()
            if key and "content" in a and key not in self.meta:
                self.meta[key] = a["content"]
        elif tag == "link":
            rel = a.get("rel", "").lower().split()
            if "icon" in rel or "apple-touch-icon" in rel:
                if a.get("href"):
                    self.icons.append(a["href"])
        if tag in self._SKIP:
            self.skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False
        if tag in self._SKIP:
            self.skip_depth = max(0, self.skip_depth - 1)

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title += data
            return
        if self.skip_depth == 0 and self.text_len < SUMMARY_CHARS * 4:
            s = data.strip()
            if s:
                self.text.append(s)
                self.text_len += len(s)


def clean_text(s: str | None, limit: int) -> str | None:
    if not s:
        return None
    s = "".join(" " if unicodedata.category(ch)[0] in ("C", "Z") else ch for ch in s)
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return None
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def _abs_url(base: str, href: str | None) -> str | None:
    if not href:
        return None
    try:
        u = urljoin(base, href.strip())
        parts = urlsplit(u)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname or len(u) > 1000:
        return None
    return u


def _charset(content_type: str, body: bytes) -> str:
    m = re.search(r"charset=[\"']?([\w-]+)", content_type, re.I)
    if not m:
        m = re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", body[:4096], re.I)  # type: ignore[assignment]
        if m:
            return m.group(1).decode("ascii", "ignore")  # type: ignore[union-attr]
        return "utf-8"
    return m.group(1)


def parse_html(body: bytes, content_type: str, final_url: str) -> dict[str, Any]:
    enc = _charset(content_type, body)
    try:
        text = body.decode(enc, errors="replace")
    except LookupError:
        text = body.decode("utf-8", errors="replace")
    p = _MetaParser()
    try:
        p.feed(text)
        p.close()
    except Exception:  # noqa: BLE001（壞掉的 HTML 也盡量取到已解析的部分）
        pass
    m = p.meta
    host = urlsplit(final_url).hostname or ""
    favicon = _abs_url(final_url, p.icons[0] if p.icons else "/favicon.ico")
    return {
        "title": clean_text(m.get("og:title") or m.get("twitter:title") or p.title, 300),
        "description": clean_text(
            m.get("og:description") or m.get("description") or m.get("twitter:description"), 500
        ),
        "imageUrl": _abs_url(final_url, m.get("og:image") or m.get("og:image:url") or m.get("twitter:image")),
        "faviconUrl": favicon,
        "siteName": clean_text(m.get("og:site_name"), 100) or host,
        "summary": clean_text(" ".join(p.text), SUMMARY_CHARS),
    }


# ── 抓取 ────────────────────────────────────────────────────


class SafeFetcher:
    """可注入 resolver / transport / clock（測試用）"""

    def __init__(
        self,
        allow_private: bool = False,
        resolver: Resolver | None = None,
        transport: Transport | None = None,
        clock: Callable[[], float] = time.monotonic,
        max_bytes: int = MAX_BYTES,
        total_timeout: float = TOTAL_TIMEOUT,
    ):
        self.allow_private = allow_private
        self.resolver = resolver or system_resolver
        self.transport = transport or default_transport
        self.clock = clock
        self.max_bytes = max_bytes
        self.total_timeout = total_timeout

    def fetch(self, url: str) -> dict[str, Any]:
        """回傳 metadata dict；失敗丟 PreviewError（訊息可直接顯示）"""
        deadline = self.clock() + self.total_timeout
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            "Accept-Encoding": "identity",
            "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        }
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            target = check_url(current, self.resolver, self.allow_private)
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise PreviewError("抓取逾時")
            try:
                resp = self._connect(target, headers, deadline)
            except (socket.timeout, TimeoutError):
                raise PreviewError("抓取逾時") from None
            except ssl.SSLError:
                raise PreviewError("HTTPS 憑證驗證失敗") from None
            except PreviewError:
                raise
            except (OSError, http.client.HTTPException):
                raise PreviewError("無法連線到該網站") from None
            try:
                if 300 <= resp.status < 400 and resp.status != 304:
                    loc = resp.headers.get("location")
                    if not loc:
                        raise PreviewError(f"重新導向缺少目的地（HTTP {resp.status}）")
                    current = urljoin(current, loc.strip())
                    continue
                if resp.status >= 400:
                    raise PreviewError(f"網站回應錯誤（HTTP {resp.status}）")
                content_type = resp.headers.get("content-type", "")
                ctype = content_type.split(";", 1)[0].strip().lower()
                host = urlsplit(current).hostname or ""
                if ctype not in ("text/html", "application/xhtml+xml"):
                    return {
                        "url": current,
                        "contentType": ctype or None,
                        "siteName": host,
                        "title": None,
                        "description": None,
                        "imageUrl": None,
                        "faviconUrl": None,
                        "summary": None,
                    }
                body = self._read(resp, deadline)
            finally:
                try:
                    resp.close()
                except Exception:  # noqa: BLE001
                    pass
            data = parse_html(body, content_type, current)
            return {"url": current, "contentType": ctype, **data}
        raise PreviewError(f"重新導向次數過多（超過 {MAX_REDIRECTS} 次）")

    def _connect(self, target: Target, headers: dict[str, str], deadline: float) -> RawResponse:
        """依序嘗試每個已驗證的 IP（例如 localhost 先解析到 ::1）；只有「連線被拒 / 無法連線」才換下一個"""
        ips = target.ips or (target.ip,)
        for i, ip in enumerate(ips):
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise PreviewError("抓取逾時")
            t = Target(target.scheme, target.host, target.port, ip, target.path, target.ips)
            try:
                return self.transport(t, headers, remaining)
            except (ConnectionRefusedError, ConnectionResetError, OSError) as e:
                if isinstance(e, (socket.timeout, TimeoutError, ssl.SSLError)) or i == len(ips) - 1:
                    raise
        raise PreviewError("無法連線到該網站")

    def _read(self, resp: RawResponse, deadline: float) -> bytes:
        """最多讀 max_bytes（只取前段，超過的部分不讀）；超過整體期限即中止"""
        chunks: list[bytes] = []
        total = 0
        while total < self.max_bytes:
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise PreviewError("抓取逾時")
            setter = getattr(resp, "set_timeout", None)
            if setter is not None:
                setter(min(CONNECT_TIMEOUT, remaining))
            try:
                chunk = resp.read(min(65536, self.max_bytes - total))
            except (socket.timeout, TimeoutError):
                raise PreviewError("抓取逾時") from None
            except (OSError, http.client.HTTPException):
                raise PreviewError("讀取網頁內容失敗") from None
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        return b"".join(chunks)[: self.max_bytes]
