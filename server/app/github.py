"""選配的 GitHub REST 用戶端（只用標準庫 urllib；工程追蹤的 GitHub 連動用）。

- token 只在 server 端使用，絕不回傳前端
- 每個請求都有逾時；任何網路 / HTTP 錯誤一律轉成 GitHubError（中文訊息），由呼叫端決定如何回報
- 測試以 app.state.github_client 注入假的用戶端（只需實作 get_issue / list_open_issues / create_issue）
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Protocol

#: https://github.com/<owner>/<repo>/issues/<n>（可帶結尾斜線、?query、#fragment；pull request 網址不解析）
_ISSUE_URL = re.compile(
    r"^https?://(?:www\.)?github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100})/issues/(\d{1,9})/?(?:[?#].*)?$",
    re.I,
)
_REPO = re.compile(r"^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9._-]{1,100})$")

TIMEOUT_SECONDS = 10
#: 匯入時最多讀幾頁（每頁 100 筆）
MAX_PAGES = 5


def parse_issue_url(url: str | None) -> tuple[str, int] | None:
    """GitHub issue 網址 → (小寫 owner/name, 編號)；其他網址回 None"""
    if not url:
        return None
    m = _ISSUE_URL.match(url.strip())
    if not m:
        return None
    number = int(m.group(3))
    if number <= 0:
        return None
    return f"{m.group(1)}/{m.group(2)}".lower(), number


def normalize_repo(value: str) -> str | None:
    """'owner/name'、'https://github.com/owner/name(.git)' → 小寫 owner/name；格式不符回 None"""
    s = value.strip()
    s = re.sub(r"^https?://(?:www\.)?github\.com/", "", s, flags=re.I)
    s = re.sub(r"(\.git)?/?$", "", s)
    m = _REPO.match(s)
    return f"{m.group(1)}/{m.group(2)}".lower() if m else None


class GitHubError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.message = message
        self.status = status


class GitHubClientProtocol(Protocol):
    """回傳的 issue 為精簡欄位：number、title、body、state（open/closed）、html_url、is_pull"""

    def get_issue(self, repo: str, number: int) -> dict[str, Any]: ...

    def list_open_issues(self, repo: str) -> list[dict[str, Any]]: ...

    def create_issue(self, repo: str, title: str, body: str) -> dict[str, Any]: ...


def _slim(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "number": int(raw["number"]),
        "title": str(raw.get("title") or ""),
        "body": str(raw.get("body") or ""),
        "state": "closed" if raw.get("state") == "closed" else "open",
        "html_url": str(raw.get("html_url") or ""),
        "is_pull": "pull_request" in raw,
    }


def _status_message(status: int) -> str:
    if status == 401:
        return "GitHub token 無效或已過期"
    if status == 403 or status == 429:
        return "GitHub 拒絕請求（token 權限不足或已達速率限制）"
    if status == 404:
        return "找不到此 GitHub issue / repo（或 token 沒有權限）"
    if status == 410:
        return "此 repo 已停用 issue 功能"
    if status == 422:
        return "GitHub 不接受此內容"
    return f"GitHub 回應錯誤（HTTP {status}）"


class GitHubClient:
    def __init__(self, token: str, api_url: str = "https://api.github.com", timeout: float = TIMEOUT_SECONDS):
        self.token = token
        self.api_url = api_url.rstrip("/")
        self.timeout = timeout

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.api_url + path,
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "tasks-sheets",
                **({"Content-Type": "application/json"} if data is not None else {}),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:  # noqa: S310（網址來自設定）
                return json.loads(res.read().decode("utf-8") or "null")
        except urllib.error.HTTPError as e:
            raise GitHubError(_status_message(e.code), e.code) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise GitHubError("無法連線 GitHub（逾時或網路錯誤）") from None
        except ValueError:
            raise GitHubError("GitHub 回應格式錯誤") from None

    @staticmethod
    def _repo_path(repo: str) -> str:
        owner, name = repo.split("/", 1)
        return f"/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}"

    def get_issue(self, repo: str, number: int) -> dict[str, Any]:
        return _slim(self._request("GET", f"{self._repo_path(repo)}/issues/{int(number)}"))

    def list_open_issues(self, repo: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for page in range(1, MAX_PAGES + 1):
            items = self._request("GET", f"{self._repo_path(repo)}/issues?state=open&per_page=100&page={page}")
            if not isinstance(items, list):
                raise GitHubError("GitHub 回應格式錯誤")
            out.extend(_slim(i) for i in items)
            if len(items) < 100:
                break
        # /issues 也會列出 pull request，略過
        return [i for i in out if not i["is_pull"]]

    def create_issue(self, repo: str, title: str, body: str) -> dict[str, Any]:
        return _slim(self._request("POST", f"{self._repo_path(repo)}/issues", {"title": title, "body": body}))
