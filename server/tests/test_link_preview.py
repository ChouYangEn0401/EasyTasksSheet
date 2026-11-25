"""連結預覽：SSRF 防護全套、HTML 解析、逾時 / 大小上限、API 整合"""

from __future__ import annotations

import http.server
import socket
import threading

import pytest

from server.app.link_preview import (
    MAX_REDIRECTS,
    PreviewError,
    SafeFetcher,
    Target,
    check_url,
    is_public_ip,
    parse_html,
    parse_ipv4_loose,
)

from .helpers import create_test_app, create_test_user, login_as

PUBLIC = "93.184.215.14"

HTML = b"""<!doctype html><html><head>
<meta charset="utf-8"><title>  Fallback   Title </title>
<meta property="og:title" content="OG &amp; Title">
<meta property="og:description" content="Desc &lt;b&gt;bold&lt;/b&gt;">
<meta property="og:image" content="/img/cover.png">
<meta property="og:site_name" content="Example Site">
<link rel="icon" href="https://cdn.example.com/fav.ico">
<script>var secret = "should not appear";</script>
<style>.x{}</style>
</head><body><h1>Hello</h1><p>World   paragraph</p><script>alert(1)</script><p>&lt;script&gt;x&lt;/script&gt;</p></body></html>"""


class FakeResp:
    def __init__(self, status=200, headers=None, body=b"", chunk=65536, on_read=None):
        self.status = status
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}
        self._body = body
        self._pos = 0
        self._chunk = chunk
        self.reads = 0
        self.closed = False
        self._on_read = on_read

    def read(self, n):
        self.reads += 1
        if self._on_read:
            self._on_read()
        n = min(n, self._chunk)
        out = self._body[self._pos : self._pos + n]
        self._pos += len(out)
        return out

    def close(self):
        self.closed = True


class FakeNet:
    """可注入的 resolver + transport：記錄連線的目標 IP"""

    def __init__(self, dns=None, routes=None):
        self.dns = dns or {}
        self.routes = routes or {}
        self.connected: list[Target] = []

    def resolve(self, host, port):
        if host not in self.dns:
            raise socket.gaierror("no such host")
        v = self.dns[host]
        return v if isinstance(v, list) else [v]

    def transport(self, target, headers, timeout):
        self.connected.append(target)
        assert "cookie" not in {k.lower() for k in headers}
        assert "authorization" not in {k.lower() for k in headers}
        r = self.routes.get((target.host, target.path))
        if r is None:
            return FakeResp(404)
        return r() if callable(r) else r

    def fetcher(self, **kw):
        return SafeFetcher(resolver=self.resolve, transport=self.transport, **kw)


def html_resp(body=HTML, ctype="text/html; charset=utf-8"):
    return lambda: FakeResp(200, {"content-type": ctype}, body)


# ── 位址判斷 ──


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://127.8.9.10/",
        "http://10.1.2.3/",
        "http://172.16.0.1/",
        "http://172.31.255.255/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://0.0.0.0/",
        "http://100.64.0.1/",
        "http://224.0.0.1/",
        "http://255.255.255.255/",
        "http://[::1]/",
        "http://[::]/",
        "http://[fc00::1]/",
        "http://[fd12:3456::1]/",
        "http://[fe80::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:7f00:1]/",
        "http://[::ffff:169.254.169.254]/",
        "http://[64:ff9b::a9fe:a9fe]/",
        "http://[2002:7f00:1::]/",
        "http://[::127.0.0.1]/",
        "http://2130706433/",  # 十進位
        "http://0x7f000001/",  # 十六進位
        "http://0x7f.0x0.0x0.0x1/",
        "http://0177.0.0.1/",  # 八進位
        "http://017700000001/",
        "http://127.1/",
        "http://10.1/",
        "http://localhost/",
        "http://LOCALHOST./",
        "http://foo.localhost/",
        "http://127.0.0.1:8080/admin",
    ],
)
def test_blocks_private_addresses(url):
    net = FakeNet(dns={"localhost": "127.0.0.1", "foo.localhost": "127.0.0.1"})
    with pytest.raises(PreviewError, match="內部網路"):
        net.fetcher().fetch(url)
    assert net.connected == []


@pytest.mark.parametrize(
    "url,msg",
    [
        ("ftp://example.com/x", "http / https"),
        ("file:///etc/passwd", "http / https"),
        ("javascript:alert(1)", "http / https"),
        ("gopher://example.com/", "http / https"),
        ("http://user:pass@example.com/", "帳號密碼"),
        ("http:///nohost", "主機"),
        ("http://example.com:99999/", "格式錯誤"),
    ],
)
def test_rejects_bad_urls(url, msg):
    net = FakeNet(dns={"example.com": PUBLIC})
    with pytest.raises(PreviewError, match=msg):
        net.fetcher().fetch(url)
    assert net.connected == []


def test_loose_ipv4_parser():
    assert str(parse_ipv4_loose("2130706433")) == "127.0.0.1"
    assert str(parse_ipv4_loose("0x7f.1")) == "127.0.0.1"
    assert str(parse_ipv4_loose("0300.0250.1.1")) == "192.168.1.1"
    assert parse_ipv4_loose("example.com") is None
    assert parse_ipv4_loose("256.1.1.1") is None
    assert parse_ipv4_loose("1.2.3.4.5") is None


def test_public_ips_allowed():
    import ipaddress

    for ip in (PUBLIC, "8.8.8.8", "2606:4700:4700::1111"):
        assert is_public_ip(ipaddress.ip_address(ip)), ip
    for ip in ("::ffff:8.8.8.8",):  # mapped 的公開位址本身仍屬保留段，拒絕
        assert not is_public_ip(ipaddress.ip_address(ip))


def test_dns_resolving_to_private_is_blocked():
    net = FakeNet(dns={"evil.example": "10.0.0.5", "mixed.example": [PUBLIC, "127.0.0.1"], "v6.example": "::1"})
    for host in ("evil.example", "mixed.example", "v6.example"):
        with pytest.raises(PreviewError, match="內部網路"):
            net.fetcher().fetch(f"https://{host}/")
    assert net.connected == []
    with pytest.raises(PreviewError, match="無法解析"):
        net.fetcher().fetch("https://nonexistent.example/")


def test_connects_to_validated_ip_dns_pinning():
    """連線目標是驗證過的 IP；第二次解析（rebinding）不會被使用"""
    answers = iter([PUBLIC, "127.0.0.1"])
    net = FakeNet(routes={("site.example", "/page?q=1"): html_resp()})
    f = SafeFetcher(resolver=lambda h, p: [next(answers)], transport=net.transport)
    data = f.fetch("https://site.example/page?q=1")
    assert data["title"] == "OG & Title"
    assert len(net.connected) == 1
    t = net.connected[0]
    assert (t.ip, t.host, t.port, t.scheme) == (PUBLIC, "site.example", 443, "https")


def test_redirect_to_private_is_blocked():
    net = FakeNet(
        dns={"a.example": PUBLIC, "internal.example": "192.168.0.10"},
        routes={
            ("a.example", "/"): lambda: FakeResp(302, {"location": "http://169.254.169.254/latest/"}),
            ("a.example", "/2"): lambda: FakeResp(301, {"location": "//internal.example/x"}),
            ("a.example", "/3"): lambda: FakeResp(307, {"location": "http://2130706433/"}),
        },
    )
    for path in ("/", "/2", "/3"):
        with pytest.raises(PreviewError, match="內部網路"):
            net.fetcher().fetch(f"http://a.example{path}")
    assert all(t.ip == PUBLIC for t in net.connected)


def test_redirect_followed_and_limited():
    net = FakeNet(
        dns={"a.example": PUBLIC, "b.example": "8.8.8.8"},
        routes={
            ("a.example", "/start"): lambda: FakeResp(302, {"location": "https://b.example/final"}),
            ("b.example", "/final"): html_resp(),
            ("a.example", "/loop"): lambda: FakeResp(302, {"location": "/loop"}),
            ("a.example", "/noloc"): lambda: FakeResp(302, {}),
        },
    )
    data = net.fetcher().fetch("http://a.example/start")
    assert data["url"] == "https://b.example/final"
    assert net.connected[-1].ip == "8.8.8.8"
    net.connected.clear()
    with pytest.raises(PreviewError, match="重新導向次數過多"):
        net.fetcher().fetch("http://a.example/loop")
    assert len(net.connected) == MAX_REDIRECTS + 1
    with pytest.raises(PreviewError, match="缺少目的地"):
        net.fetcher().fetch("http://a.example/noloc")


def test_large_response_reads_only_first_megabyte():
    big = b"<html><head><title>Big</title></head><body>" + b"x" * (5 * 1024 * 1024)
    resp = FakeResp(200, {"content-type": "text/html"}, big)
    net = FakeNet(dns={"big.example": PUBLIC}, routes={("big.example", "/"): lambda: resp})
    data = net.fetcher().fetch("http://big.example/")
    assert data["title"] == "Big"
    assert resp._pos <= 1024 * 1024
    assert resp.closed
    assert len(data["summary"]) <= 300


def test_non_html_records_type_and_domain_only():
    resp = FakeResp(200, {"content-type": "application/pdf"}, b"%PDF-" + b"x" * 1000)
    net = FakeNet(dns={"files.example": PUBLIC}, routes={("files.example", "/a.pdf"): lambda: resp})
    data = net.fetcher().fetch("https://files.example/a.pdf")
    assert data["contentType"] == "application/pdf"
    assert data["siteName"] == "files.example"
    assert data["title"] is None and data["summary"] is None
    assert resp.reads == 0  # 不讀內容


def test_timeouts():
    def boom(target, headers, timeout):
        raise socket.timeout("timed out")

    f = SafeFetcher(resolver=lambda h, p: [PUBLIC], transport=boom)
    with pytest.raises(PreviewError, match="逾時"):
        f.fetch("http://slow.example/")

    # 傳輸層給的剩餘時間不超過整體期限
    seen = []

    def capture(target, headers, timeout):
        seen.append(timeout)
        return FakeResp(200, {"content-type": "text/html"}, b"<title>x</title>")

    SafeFetcher(resolver=lambda h, p: [PUBLIC], transport=capture).fetch("http://a.example/")
    assert 0 < seen[0] <= 10

    # 逐塊慢慢送（slowloris）：超過整體 10 秒即中止
    now = [0.0]

    def tick():
        now[0] += 3

    resp = FakeResp(200, {"content-type": "text/html"}, b"<p>" + b"a" * 100000, chunk=10, on_read=tick)
    f = SafeFetcher(resolver=lambda h, p: [PUBLIC], transport=lambda *a: resp, clock=lambda: now[0])
    with pytest.raises(PreviewError, match="逾時"):
        f.fetch("http://drip.example/")
    assert resp.reads <= 4 and resp.closed


def test_http_errors_and_connection_failures():
    net = FakeNet(dns={"a.example": PUBLIC}, routes={("a.example", "/500"): lambda: FakeResp(500)})
    with pytest.raises(PreviewError, match="HTTP 500"):
        net.fetcher().fetch("http://a.example/500")

    def refused(*a):
        raise ConnectionRefusedError()

    with pytest.raises(PreviewError, match="無法連線"):
        SafeFetcher(resolver=lambda h, p: [PUBLIC], transport=refused).fetch("http://a.example/")


def test_parse_html_metadata_as_plain_text():
    data = parse_html(HTML, "text/html; charset=utf-8", "https://www.example.com/post/1")
    assert data["title"] == "OG & Title"
    assert data["description"] == "Desc <b>bold</b>"  # 純文字（前端以文字顯示、會被轉義）
    assert data["imageUrl"] == "https://www.example.com/img/cover.png"
    assert data["faviconUrl"] == "https://cdn.example.com/fav.ico"
    assert data["siteName"] == "Example Site"
    assert "should not appear" not in data["summary"]
    assert "alert(1)" not in data["summary"]
    assert data["summary"].startswith("Hello World paragraph")

    # 沒有 og 標籤：退回 <title>、預設 favicon、網域；javascript: 圖片網址被丟棄
    plain = b"<title>Only\n title</title><meta property='og:image' content='javascript:alert(1)'><p>" + "字" .encode() * 500
    d = parse_html(plain, "text/html", "http://site.example/a/b")
    assert d["title"] == "Only title"
    assert d["imageUrl"] is None
    assert d["faviconUrl"] == "http://site.example/favicon.ico"
    assert d["siteName"] == "site.example"
    assert len(d["summary"]) == 300

    # 編碼：Big5 meta charset
    big5 = '<meta charset="big5"><title>中文標題</title>'.encode("big5")
    assert parse_html(big5, "text/html", "http://x.example/")["title"] == "中文標題"


def test_allow_private_option():
    net = FakeNet(routes={("127.0.0.1", "/"): html_resp()})
    data = net.fetcher(allow_private=True).fetch("http://127.0.0.1/")
    assert data["title"] == "OG & Title"
    # 即使允許內網，仍只接受 http / https
    with pytest.raises(PreviewError):
        net.fetcher(allow_private=True).fetch("file:///etc/passwd")


def test_check_url_idn():
    t = check_url("https://例子.測試/路徑", lambda h, p: [PUBLIC], False)
    assert t.host.startswith("xn--") and t.ip == PUBLIC


def test_real_transport_against_local_server():
    """預設 transport：連到驗證過的 IP、送出 Host 標頭與 User-Agent、不帶 cookie（允許內網模式）"""
    seen = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            seen["host"] = self.headers.get("Host")
            seen["ua"] = self.headers.get("User-Agent")
            seen["cookie"] = self.headers.get("Cookie")
            if self.path == "/go":
                self.send_response(302)
                self.send_header("Location", "/page")
                self.end_headers()
                return
            body = HTML
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    try:
        port = srv.server_address[1]
        data = SafeFetcher(allow_private=True).fetch(f"http://localhost:{port}/go")
        assert data["title"] == "OG & Title"
        assert seen["host"] == f"localhost:{port}"
        assert "TasksSheets-LinkPreview" in seen["ua"]
        assert seen["cookie"] is None
        # 預設（不允許內網）直接拒絕，不會連線
        seen.clear()
        with pytest.raises(PreviewError):
            SafeFetcher().fetch(f"http://127.0.0.1:{port}/page")
        assert seen == {}
    finally:
        srv.shutdown()
        srv.server_close()


# ── API 整合 ──


class StubFetcher:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls: list[str] = []

    def fetch(self, url):
        self.calls.append(url)
        if self.error:
            raise PreviewError(self.error)
        return {"url": url, "contentType": "text/html", **self.result}


META = {
    "title": "<b>標題</b>",
    "description": "說明",
    "imageUrl": "https://img.example/a.png",
    "faviconUrl": "https://img.example/f.ico",
    "siteName": "Example",
    "summary": "摘要文字",
}


def setup_api(fetcher):
    t = create_test_app()
    t.app.state.link_preview_enabled = True
    t.app.state.link_fetcher = fetcher
    api = login_as(t, create_test_user(t.db))
    return t, api


def test_preview_fetched_on_create_and_update():
    stub = StubFetcher(META)
    t, api = setup_api(stub)
    issue = api.request("POST", "/api/eng/issues", {"title": "有連結", "url": "https://site.example/a"}).json()
    listed = api.get("/api/eng/issues").json()
    p = listed["previews"][str(issue["id"])]
    assert p["status"] == "ok" and p["title"] == "<b>標題</b>" and p["url"] == "https://site.example/a"
    assert p["siteName"] == "Example" and p["fetchedAt"] is not None
    assert listed["linkPreviewEnabled"] is True

    # 只改其他欄位不重抓
    api.request("PATCH", f"/api/eng/issues/{issue['id']}", {"status": "doing"})
    assert stub.calls == ["https://site.example/a"]
    # 改連結 → 重抓
    api.request("PATCH", f"/api/eng/issues/{issue['id']}", {"url": "https://site.example/b"})
    assert stub.calls[-1] == "https://site.example/b"
    # 清除連結 → 預覽刪除
    api.request("PATCH", f"/api/eng/issues/{issue['id']}", {"url": None})
    assert str(issue["id"]) not in api.get("/api/eng/issues").json()["previews"]
    # GitHub issue 連結沿用 GitHub 同步，不抓預覽
    n = len(stub.calls)
    api.request("PATCH", f"/api/eng/issues/{issue['id']}", {"url": "https://github.com/a/b/issues/1"})
    assert len(stub.calls) == n
    assert str(issue["id"]) not in api.get("/api/eng/issues").json()["previews"]


def test_preview_failure_does_not_block_saving():
    t, api = setup_api(StubFetcher(error="不允許連到本機或內部網路位址"))
    res = api.request("POST", "/api/eng/issues", {"title": "內網", "url": "http://192.168.0.1/"})
    assert res.status_code == 201
    p = api.get("/api/eng/issues").json()["previews"][str(res.json()["id"])]
    assert p["status"] == "error" and "內部網路" in p["error"]


def test_refresh_endpoint():
    stub = StubFetcher(META)
    t, api = setup_api(stub)
    issue = api.request("POST", "/api/eng/issues", {"title": "x", "url": "https://site.example/a"}).json()
    res = api.request("POST", f"/api/eng/issues/{issue['id']}/preview", {})
    assert res.status_code == 200 and res.json()["preview"]["title"] == "<b>標題</b>"
    assert stub.calls == ["https://site.example/a"] * 2

    plain = api.request("POST", "/api/eng/issues", {"title": "無連結"}).json()
    assert api.request("POST", f"/api/eng/issues/{plain['id']}/preview", {}).status_code == 400
    assert api.request("POST", "/api/eng/issues/9999/preview", {}).status_code == 404

    t.app.state.link_preview_enabled = False
    assert api.request("POST", f"/api/eng/issues/{issue['id']}/preview", {}).status_code == 503
    # 停用時新增連結不抓取
    n = len(stub.calls)
    api.request("POST", "/api/eng/issues", {"title": "y", "url": "https://site.example/c"})
    assert len(stub.calls) == n


def test_preview_removed_with_issue():
    t, api = setup_api(StubFetcher(META))
    issue = api.request("POST", "/api/eng/issues", {"title": "x", "url": "https://site.example/a"}).json()
    assert t.db.scalar("SELECT count(*) FROM link_previews") == 1
    api.request("DELETE", f"/api/eng/issues/{issue['id']}")
    assert t.db.scalar("SELECT count(*) FROM link_previews") == 0
