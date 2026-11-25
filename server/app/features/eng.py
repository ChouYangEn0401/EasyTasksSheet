"""/api/eng：工程追蹤（簡化版，手動輸入優先；docs/design/eng-tracking.md）。

- 問題（manual_issues）：任何成員可新增 / 編輯 / 結案 / 刪除
- Worktree 紀錄（worktree_records）：任何成員可新增 / 編輯 / 刪除；狀態一律手動
- 回報（worktree_reports）：各人電腦以 scripts/report-worktrees.mjs 回報 `git worktree list` 快照，
  POST /api/eng/worktrees/report 免 session，只以 WORKTREE_REPORT_TOKEN 驗證（未設定一律 403）
- 伺服器端不執行任何 git 指令；紀錄與回報的比對只是參考提示（可能遺失 / 未登記）
- GitHub 連動（選配，需 GITHUB_TOKEN）：「連結」為 GitHub issue 網址時自動解析 repo / 編號；
  同步 / 匯入 / 在 GitHub 建立 / 專案連動設定。GET 不做網路呼叫，過期時由前端呼叫 /issues/sync
  權限：專案連動設定（PUT /github-links）需 github.manage（manager 以上），其餘全員可用

變更紀錄沿用既有實體類型（前端即時同步已對應到 ['eng']）：問題與回報記為 repo、worktree 紀錄記為 worktree_plan。
"""

from __future__ import annotations

import hashlib
import hmac
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import AfterValidator, BaseModel, Field, StringConstraints
from starlette.concurrency import run_in_threadpool

from ..changes import record_change
from ..config import config
from ..context import Ctx, get_ctx
from ..errors import HttpError, bad_request, forbidden, not_found
from ..github import GitHubClient, GitHubClientProtocol, GitHubError, normalize_repo, parse_issue_url
from ..permissions import require
from ..validate import parse_id, present, read_json

router = APIRouter()

IssueStatus = Literal["open", "doing", "closed"]
WorktreeStatus = Literal["active", "idle", "merged", "lost", "cleaned"]

#: 這些狀態的紀錄不再預期出現在回報中（不提示「可能遺失」）
_GONE_STATUSES = {"lost", "cleaned"}


def _text(max_length: int, min_length: int = 0) -> Any:
    return Annotated[str, StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length)]


def _check_url(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if not re.match(r"^https?://\S+$", v, re.I):
        raise ValueError("連結須以 http:// 或 https:// 開頭")
    return v


OptionalUrl = Annotated[Annotated[str, StringConstraints(max_length=500)] | None, AfterValidator(_check_url)]


# ── 輸入格式 ──


class _Input(BaseModel):
    model_config = {"extra": "ignore"}


class IssueUpdateInput(_Input):
    title: _text(200, 1) = None  # type: ignore[valid-type]
    description: _text(5000) = None  # type: ignore[valid-type]
    project: _text(100) = None  # type: ignore[valid-type]
    status: IssueStatus = None  # type: ignore[assignment]
    assigneeId: int | None = None
    url: OptionalUrl = None


class IssueCreateInput(IssueUpdateInput):
    title: _text(200, 1)  # type: ignore[valid-type]


class RecordUpdateInput(_Input):
    machine: _text(100, 1) = None  # type: ignore[valid-type]
    path: _text(500, 1) = None  # type: ignore[valid-type]
    branch: _text(200) = None  # type: ignore[valid-type]
    ownerId: int | None = None
    purpose: _text(200) = None  # type: ignore[valid-type]
    status: WorktreeStatus = None  # type: ignore[assignment]
    note: _text(2000) = None  # type: ignore[valid-type]


class RecordCreateInput(RecordUpdateInput):
    machine: _text(100, 1)  # type: ignore[valid-type]
    path: _text(500, 1)  # type: ignore[valid-type]


class ReportedWorktree(_Input):
    path: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    branch: Annotated[str, StringConstraints(max_length=300)] | None = None
    headSha: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{7,64}$")] | None = None
    isDirty: bool = False
    ahead: Annotated[int, Field(ge=0)] | None = None
    behind: Annotated[int, Field(ge=0)] | None = None
    lastCommitAt: int | None = None
    isPrunable: bool = False
    isMerged: bool = False


class ReportInput(_Input):
    #: 電腦名稱（舊版腳本用 reporter）
    machine: _text(100, 1) = None  # type: ignore[valid-type]
    reporter: _text(100, 1) = None  # type: ignore[valid-type]
    #: repo 名稱（同一台電腦可回報多個 repo，各自取代自己的快照）
    repo: _text(100) = None  # type: ignore[valid-type]
    worktrees: Annotated[list[ReportedWorktree], Field(max_length=500)]


# ── 轉換 ──


def _issue(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "title": r["title"],
        "description": r["description"],
        "project": r["project"],
        "status": r["status"],
        "assigneeId": r["assignee_id"],
        "url": r["url"],
        "githubRepo": r["github_repo"],
        "githubNumber": r["github_number"],
        "githubState": r["github_state"],
        "syncedAt": r["github_synced_at"],
        "createdBy": r["created_by"],
        "updatedBy": r["updated_by"],
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
    }


def _record(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "machine": r["machine"],
        "path": r["path"],
        "branch": r["branch"],
        "ownerId": r["owner_id"],
        "purpose": r["purpose"],
        "status": r["status"],
        "note": r["note"],
        "createdBy": r["created_by"],
        "updatedBy": r["updated_by"],
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
    }


def _report(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "machine": r["machine"],
        "repo": r["repo"],
        "path": r["path"],
        "branch": r["branch"],
        "headSha": r["head_sha"],
        "isDirty": bool(r["is_dirty"]),
        "ahead": r["ahead"],
        "behind": r["behind"],
        "lastCommitAt": r["last_commit_at"],
        "isPrunable": bool(r["is_prunable"]),
        "isMerged": bool(r["is_merged"]),
        "reportedAt": r["reported_at"],
    }


# ── 路徑 / 電腦名稱比對（與平台無關的字面處理） ──


def path_key(p: str) -> str:
    """統一為正斜線、去除結尾斜線；Windows 路徑不分大小寫"""
    s = p.strip().replace("\\", "/")
    while len(s) > 1 and s.endswith("/") and not re.fullmatch(r"[a-zA-Z]:/", s):
        s = s[:-1]
    if re.match(r"^[a-zA-Z]:/", s) or s.startswith("//"):
        s = s.lower()
    return s


def machine_key(m: str) -> str:
    return m.strip().lower()


def _check_user(conn: sqlite3.Connection, uid: int | None, label: str) -> None:
    if uid is not None and not conn.execute("SELECT 1 FROM users WHERE id = ?", (uid,)).fetchone():
        raise bad_request(f"{label}不存在")


# ── 問題 ──

_ISSUE_COLUMNS = {
    "title": "title",
    "description": "description",
    "project": "project",
    "status": "status",
    "assigneeId": "assignee_id",
    "url": "url",
}
_ISSUE_NOT_FOUND = "此問題不存在或已被刪除"


def _github_columns(url: str | None) -> dict[str, Any]:
    """「連結」對應的 GitHub 欄位：GitHub issue 網址 → repo / 編號（尚未同步）；其他網址 → 全部清空"""
    parsed = parse_issue_url(url)
    return {
        "github_repo": parsed[0] if parsed else None,
        "github_number": parsed[1] if parsed else None,
        "github_state": None,
        "github_title": None,
        "github_synced_at": None,
    }


@router.get("/issues")
async def list_issues(request: Request):
    """全部問題 + GitHub 連動狀態（不在此做任何網路呼叫；過期時由前端呼叫 /issues/sync）"""
    db = get_ctx(request).db
    rows = db.all(
        "SELECT * FROM manual_issues ORDER BY CASE status WHEN 'closed' THEN 1 ELSE 0 END, updated_at DESC, id DESC"
    )
    links = db.all("SELECT * FROM eng_github_links ORDER BY project COLLATE NOCASE")
    return {
        "githubEnabled": _github_token(request) is not None,
        "syncMinutes": config.GITHUB_SYNC_MINUTES,
        "links": [_link(r) for r in links],
        "issues": [_issue(r) for r in rows],
    }


@router.post("/issues")
async def create_issue(request: Request):
    ctx = get_ctx(request)
    fields = present(await read_json(request, IssueCreateInput))
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        _check_user(conn, fields.get("assigneeId"), "負責人")
        values = {_ISSUE_COLUMNS[k]: v for k, v in fields.items()}
        values.update(_github_columns(fields.get("url")))
        values.update(created_by=uid, updated_by=uid, created_at=t, updated_at=t)
        cur = conn.execute(
            f"INSERT INTO manual_issues ({', '.join(values)}) VALUES ({', '.join('?' * len(values))})",
            tuple(values.values()),
        )
        iid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "repo", iid, "create", uid, t)
        row = conn.execute("SELECT * FROM manual_issues WHERE id = ?", (iid,)).fetchone()
    return JSONResponse(_issue(row), status_code=201)


@router.patch("/issues/{id}")
async def update_issue(request: Request, id: str):
    ctx = get_ctx(request)
    iid = parse_id(id)
    fields = present(await read_json(request, IssueUpdateInput))
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        current = conn.execute("SELECT url FROM manual_issues WHERE id = ?", (iid,)).fetchone()
        if current is None:
            raise not_found(_ISSUE_NOT_FOUND)
        _check_user(conn, fields.get("assigneeId"), "負責人")
        sets = {_ISSUE_COLUMNS[k]: v for k, v in fields.items()}
        # 連結改了才重新解析（同一個 GitHub issue 保留同步狀態）
        if "url" in fields and parse_issue_url(fields["url"]) != parse_issue_url(current["url"]):
            sets.update(_github_columns(fields["url"]))
        sets.update(updated_by=uid, updated_at=t)
        conn.execute(
            f"UPDATE manual_issues SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?", (*sets.values(), iid)
        )
        record_change(conn, "repo", iid, "update", uid, t)
        row = conn.execute("SELECT * FROM manual_issues WHERE id = ?", (iid,)).fetchone()
    return _issue(row)


@router.delete("/issues/{id}")
async def delete_issue(request: Request, id: str):
    ctx = get_ctx(request)
    iid = parse_id(id)
    with ctx.db.tx() as conn:
        if conn.execute("DELETE FROM manual_issues WHERE id = ?", (iid,)).rowcount == 0:
            raise not_found(_ISSUE_NOT_FOUND)
        record_change(conn, "repo", iid, "delete", ctx.user["id"], ctx.now())
    return {"ok": True}


# ── GitHub 連動（選配；未設定 GITHUB_TOKEN 時以下端點一律 503，其餘功能不受影響） ──

_NO_TOKEN = "伺服器未設定 GITHUB_TOKEN，GitHub 連動停用"
#: 同步時同時對 GitHub 發出的請求數
_SYNC_WORKERS = 4


class GithubLinkInput(_Input):
    project: _text(100, 1)  # type: ignore[valid-type]
    githubRepo: _text(200, 1)  # type: ignore[valid-type]


class GithubLinksInput(_Input):
    links: Annotated[list[GithubLinkInput], Field(max_length=200)]


class SyncInput(_Input):
    id: Annotated[int, Field(gt=0)] | None = None


class ImportInput(_Input):
    project: _text(100, 1)  # type: ignore[valid-type]


def _link(r: sqlite3.Row) -> dict[str, Any]:
    return {"project": r["project"], "githubRepo": r["github_repo"]}


def _github_token(request: Request) -> str | None:
    """GitHub token；測試可以 app.state.github_token 覆寫。只在 server 端使用，絕不回傳前端"""
    return getattr(request.app.state, "github_token", config.GITHUB_TOKEN) or None


def _github(request: Request) -> GitHubClientProtocol:
    """未設定 token → 503；測試可以 app.state.github_client 注入假的用戶端"""
    token = _github_token(request)
    if token is None:
        raise HttpError(503, "GITHUB_DISABLED", _NO_TOKEN)
    injected = getattr(request.app.state, "github_client", None)
    return injected or GitHubClient(token, config.GITHUB_API_URL)


def _bad_gateway(e: GitHubError) -> HttpError:
    return HttpError(502, "GITHUB_ERROR", e.message)


def github_changes(row: sqlite3.Row | dict[str, Any], gh: dict[str, Any]) -> dict[str, Any]:
    """同步規則：只有 GitHub 端「有變動」時才覆蓋本地欄位（本地手動改的狀態 / 標題不會被蓋回去）。

    - GitHub 狀態由「非關閉」→ closed：本地改為已結案
    - GitHub 狀態由 closed → open（重開）：本地若為已結案則改回未處理
    - GitHub 標題與上次同步的不同：覆蓋本地標題（第一次同步不覆蓋）
    回傳要更新的本地欄位（不含 github_* 紀錄欄位）
    """
    out: dict[str, Any] = {}
    prev_state, new_state = row["github_state"], gh["state"]
    if new_state != prev_state:
        if new_state == "closed" and row["status"] != "closed":
            out["status"] = "closed"
        elif new_state == "open" and prev_state == "closed" and row["status"] == "closed":
            out["status"] = "open"
    title = (gh.get("title") or "").strip()[:200]
    if title and row["github_title"] is not None and title != row["github_title"] and title != row["title"]:
        out["title"] = title
    return out


def _fetch_all(client: GitHubClientProtocol, targets: list[tuple[int, str, int]]) -> dict[int, Any]:
    """平行取回各 issue；結果為 dict 或 GitHubError（單筆失敗不影響其他筆）"""

    def one(target: tuple[int, str, int]) -> tuple[int, Any]:
        iid, repo, number = target
        try:
            return iid, client.get_issue(repo, number)
        except GitHubError as e:
            return iid, e
        except Exception:  # noqa: BLE001（任何意外都不讓整批失敗）
            return iid, GitHubError("同步失敗")

    if not targets:
        return {}
    with ThreadPoolExecutor(max_workers=min(_SYNC_WORKERS, len(targets))) as pool:
        return dict(pool.map(one, targets))


@router.post("/issues/sync")
async def sync_issues(request: Request):
    """向 GitHub 取回有 GitHub 資訊之問題的最新狀態 / 標題；可帶 id 只同步一筆"""
    ctx = get_ctx(request)
    client = _github(request)
    data = await read_json(request, SyncInput)
    if data.id is not None:
        row = ctx.db.one("SELECT * FROM manual_issues WHERE id = ?", (data.id,))
        if row is None:
            raise not_found(_ISSUE_NOT_FOUND)
        if row["github_number"] is None:
            raise bad_request("此問題沒有連結 GitHub issue")
    targets = [
        (r["id"], r["github_repo"], r["github_number"])
        for r in ctx.db.all(
            "SELECT id, github_repo, github_number FROM manual_issues WHERE github_number IS NOT NULL"
            + (" AND id = ?" if data.id is not None else ""),
            (data.id,) if data.id is not None else (),
        )
    ]
    # 網路呼叫在 transaction 外進行，不佔住資料庫
    results = await run_in_threadpool(_fetch_all, client, targets)

    uid = ctx.user["id"]
    t = ctx.now()
    updated: list[int] = []
    failed: list[dict[str, Any]] = []
    with ctx.db.tx() as conn:
        for iid, res in results.items():
            if isinstance(res, GitHubError):
                failed.append({"id": iid, "message": res.message})
                continue
            row = conn.execute("SELECT * FROM manual_issues WHERE id = ?", (iid,)).fetchone()
            if row is None:  # 同步期間被刪除
                continue
            sets = github_changes(row, res)
            if sets:
                sets.update(updated_by=uid, updated_at=t)
                updated.append(iid)
            sets.update(github_state=res["state"], github_title=(res.get("title") or "").strip()[:200], github_synced_at=t)
            conn.execute(
                f"UPDATE manual_issues SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?", (*sets.values(), iid)
            )
            record_change(conn, "repo", iid, "update", uid, t)
    return {"checked": len(targets), "updated": updated, "failed": failed, "syncedAt": t}


@router.put("/github-links")
async def save_github_links(request: Request, ctx: Ctx = Depends(require("github.manage"))):
    """專案連動整批取代：問題的「專案 / Repo」名稱 → GitHub owner/name（github.manage，manager 以上）"""
    _github(request)
    data = await read_json(request, GithubLinksInput)
    links: list[tuple[str, str]] = []
    seen: set[str] = set()
    for link in data.links:
        repo = normalize_repo(link.githubRepo)
        if repo is None:
            raise bad_request(f"「{link.githubRepo}」不是有效的 GitHub repo（格式：owner/name）")
        if link.project.lower() in seen:
            raise bad_request(f"專案「{link.project}」重複")
        seen.add(link.project.lower())
        links.append((link.project, repo))
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        conn.execute("DELETE FROM eng_github_links")
        conn.executemany(
            "INSERT INTO eng_github_links (project, github_repo, updated_by, updated_at) VALUES (?, ?, ?, ?)",
            [(p, r, uid, t) for p, r in links],
        )
        record_change(conn, "repo", 0, "update", uid, t)
        rows = conn.execute("SELECT * FROM eng_github_links ORDER BY project COLLATE NOCASE").fetchall()
    return {"links": [_link(r) for r in rows]}


def _linked_repo(conn: sqlite3.Connection, project: str) -> str:
    row = conn.execute("SELECT github_repo FROM eng_github_links WHERE project = ?", (project.strip(),)).fetchone()
    if row is None:
        raise bad_request(f"專案「{project}」尚未連動 GitHub repo")
    return row["github_repo"]


@router.post("/issues/import")
async def import_issues(request: Request):
    """匯入專案連動 repo 中開啟中的 issue；以 repo + 編號去重，已存在者略過"""
    ctx = get_ctx(request)
    client = _github(request)
    data = await read_json(request, ImportInput)
    with ctx.db.tx() as conn:
        repo = _linked_repo(conn, data.project)
    try:
        items = await run_in_threadpool(client.list_open_issues, repo)
    except GitHubError as e:
        raise _bad_gateway(e) from None

    uid = ctx.user["id"]
    t = ctx.now()
    created: list[int] = []
    with ctx.db.tx() as conn:
        existing = {
            r[0]
            for r in conn.execute("SELECT github_number FROM manual_issues WHERE github_repo = ?", (repo,)).fetchall()
        }
        for gh in items:
            if gh["number"] in existing or gh.get("is_pull"):
                continue
            existing.add(gh["number"])
            title = (gh["title"] or "").strip()[:200] or f"#{gh['number']}"
            cur = conn.execute(
                "INSERT INTO manual_issues (title, description, project, status, url, github_repo, github_number, "
                "github_state, github_title, github_synced_at, created_by, updated_by, created_at, updated_at) "
                "VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    title,
                    (gh["body"] or "").strip()[:5000],
                    data.project,
                    (gh["html_url"] or f"https://github.com/{repo}/issues/{gh['number']}")[:500],
                    repo,
                    gh["number"],
                    gh["state"],
                    title,
                    t,
                    uid,
                    uid,
                    t,
                    t,
                ),
            )
            iid = int(cur.lastrowid)  # type: ignore[arg-type]
            record_change(conn, "repo", iid, "create", uid, t)
            created.append(iid)
    return {"repo": repo, "created": len(created), "skipped": len(items) - len(created)}


@router.post("/issues/{id}/publish")
async def publish_issue(request: Request, id: str):
    """在專案連動的 GitHub repo 建立 issue（標題 / 說明），成功後寫回連結與編號"""
    ctx = get_ctx(request)
    iid = parse_id(id)
    client = _github(request)
    with ctx.db.tx() as conn:
        row = conn.execute("SELECT * FROM manual_issues WHERE id = ?", (iid,)).fetchone()
        if row is None:
            raise not_found(_ISSUE_NOT_FOUND)
        if row["github_number"] is not None:
            raise bad_request("此問題已連結 GitHub issue")
        if not row["project"]:
            raise bad_request("請先填寫專案，並在「GitHub 連動」設定對應的 repo")
        repo = _linked_repo(conn, row["project"])
    try:
        gh = await run_in_threadpool(client.create_issue, repo, row["title"], row["description"])
    except GitHubError as e:
        raise _bad_gateway(e) from None

    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        conn.execute(
            "UPDATE manual_issues SET url = ?, github_repo = ?, github_number = ?, github_state = ?, github_title = ?, "
            "github_synced_at = ?, updated_by = ?, updated_at = ? WHERE id = ?",
            (
                (gh["html_url"] or f"https://github.com/{repo}/issues/{gh['number']}")[:500],
                repo,
                gh["number"],
                gh["state"],
                (gh["title"] or "").strip()[:200],
                t,
                uid,
                t,
                iid,
            ),
        )
        record_change(conn, "repo", iid, "update", uid, t)
        row = conn.execute("SELECT * FROM manual_issues WHERE id = ?", (iid,)).fetchone()
    if row is None:  # 建立期間被刪除（GitHub 端仍已建立）
        raise not_found(_ISSUE_NOT_FOUND)
    return _issue(row)


# ── Worktree 紀錄 ──

_RECORD_COLUMNS = {
    "machine": "machine",
    "path": "path",
    "branch": "branch",
    "ownerId": "owner_id",
    "purpose": "purpose",
    "status": "status",
    "note": "note",
}
_RECORD_NOT_FOUND = "此紀錄不存在或已被刪除"


def _check_record(conn: sqlite3.Connection, machine: str, path: str, self_id: int | None = None) -> None:
    """同一台電腦的同一路徑只能有一筆紀錄"""
    mk, pk = machine_key(machine), path_key(path)
    for r in conn.execute("SELECT id, machine, path FROM worktree_records").fetchall():
        if r["id"] != self_id and machine_key(r["machine"]) == mk and path_key(r["path"]) == pk:
            raise HttpError(409, "CONFLICT", "此電腦的這個路徑已有紀錄", {"field": "path"})


@router.post("/worktree-records")
async def create_record(request: Request):
    ctx = get_ctx(request)
    fields = present(await read_json(request, RecordCreateInput))
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        _check_user(conn, fields.get("ownerId"), "負責人")
        _check_record(conn, fields["machine"], fields["path"])
        cols = [_RECORD_COLUMNS[k] for k in fields] + ["created_by", "updated_by", "created_at", "updated_at"]
        cur = conn.execute(
            f"INSERT INTO worktree_records ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
            (*fields.values(), uid, uid, t, t),
        )
        rid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "worktree_plan", rid, "create", uid, t)
        row = conn.execute("SELECT * FROM worktree_records WHERE id = ?", (rid,)).fetchone()
    return JSONResponse(_record(row), status_code=201)


@router.patch("/worktree-records/{id}")
async def update_record(request: Request, id: str):
    ctx = get_ctx(request)
    rid = parse_id(id)
    fields = present(await read_json(request, RecordUpdateInput))
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        current = conn.execute("SELECT * FROM worktree_records WHERE id = ?", (rid,)).fetchone()
        if current is None:
            raise not_found(_RECORD_NOT_FOUND)
        _check_user(conn, fields.get("ownerId"), "負責人")
        _check_record(conn, fields.get("machine", current["machine"]), fields.get("path", current["path"]), rid)
        sets = {_RECORD_COLUMNS[k]: v for k, v in fields.items()}
        sets.update(updated_by=uid, updated_at=t)
        conn.execute(
            f"UPDATE worktree_records SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?", (*sets.values(), rid)
        )
        record_change(conn, "worktree_plan", rid, "update", uid, t)
        row = conn.execute("SELECT * FROM worktree_records WHERE id = ?", (rid,)).fetchone()
    return _record(row)


@router.delete("/worktree-records/{id}")
async def delete_record(request: Request, id: str):
    ctx = get_ctx(request)
    rid = parse_id(id)
    with ctx.db.tx() as conn:
        if conn.execute("DELETE FROM worktree_records WHERE id = ?", (rid,)).rowcount == 0:
            raise not_found(_RECORD_NOT_FOUND)
        record_change(conn, "worktree_plan", rid, "delete", ctx.user["id"], ctx.now())
    return {"ok": True}


# ── 紀錄 × 回報（依電腦分組） ──


def build_overview(records: list[dict[str, Any]], reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """依電腦分組，標出參考提示：
    - 紀錄的 hint = 'missing'：該電腦有回報過，但最新回報裡沒有此路徑（已遺失 / 已清理的紀錄除外）
    - 回報的 registered = False：回報有、但沒有對應的紀錄（未登記）
    """
    groups: dict[str, dict[str, Any]] = {}

    def group(machine: str) -> dict[str, Any]:
        k = machine_key(machine)
        if k not in groups:
            groups[k] = {"machine": machine.strip(), "reportedAt": None, "records": [], "reports": []}
        return groups[k]

    # 顯示名稱以手動紀錄的寫法優先
    for rec in records:
        group(rec["machine"])
    for rep in reports:
        g = group(rep["machine"])
        g["reportedAt"] = max(g["reportedAt"] or 0, rep["reportedAt"])

    reported_paths = {(machine_key(r["machine"]), path_key(r["path"])) for r in reports}
    recorded_paths = {(machine_key(r["machine"]), path_key(r["path"])) for r in records}
    for rec in records:
        g = group(rec["machine"])
        k = (machine_key(rec["machine"]), path_key(rec["path"]))
        missing = g["reportedAt"] is not None and rec["status"] not in _GONE_STATUSES and k not in reported_paths
        g["records"].append({**rec, "hint": "missing" if missing else None})
    for rep in reports:
        k = (machine_key(rep["machine"]), path_key(rep["path"]))
        group(rep["machine"])["reports"].append({**rep, "registered": k in recorded_paths})
    return sorted(groups.values(), key=lambda g: machine_key(g["machine"]))


def _report_token(request: Request) -> str | None:
    """回報 token；測試可以 app.state.eng_report_token 覆寫"""
    return getattr(request.app.state, "eng_report_token", config.WORKTREE_REPORT_TOKEN) or None


@router.get("/worktrees")
async def worktrees_overview(request: Request):
    db = get_ctx(request).db
    records = [_record(r) for r in db.all("SELECT * FROM worktree_records ORDER BY updated_at DESC, id DESC")]
    reports = [_report(r) for r in db.all("SELECT * FROM worktree_reports ORDER BY repo, branch, path")]
    return {"reportEnabled": _report_token(request) is not None, "machines": build_overview(records, reports)}


def _sha(s: str) -> bytes:
    return hashlib.sha256(s.encode("utf-8")).digest()


@router.post("/worktrees/report")
async def report_worktrees(request: Request):
    """免 session（app.PUBLIC_PATHS），只以 X-Report-Token 或 Authorization: Bearer 驗證；固定時間比較"""
    expected = _report_token(request)
    if not expected:
        raise forbidden("伺服器未設定回報 token（WORKTREE_REPORT_TOKEN），回報功能停用")
    given = request.headers.get("x-report-token")
    if given is None:
        given = re.sub(r"^Bearer\s+", "", request.headers.get("authorization", ""), flags=re.I)
    if not given or not hmac.compare_digest(_sha(given), _sha(expected)):
        raise forbidden("回報 token 錯誤")

    data = await read_json(request, ReportInput)
    machine = data.machine or data.reporter
    if not machine:
        raise bad_request("請指定電腦名稱（machine）")
    repo = data.repo or ""
    ctx = get_ctx(request)
    t = ctx.now()
    with ctx.db.tx() as conn:
        # 同一台電腦、同一 repo 的快照整批取代
        conn.execute("DELETE FROM worktree_reports WHERE lower(machine) = ? AND repo = ?", (machine_key(machine), repo))
        conn.executemany(
            "INSERT INTO worktree_reports (machine, repo, path, branch, head_sha, is_dirty, ahead, behind, "
            "last_commit_at, is_prunable, is_merged, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    machine,
                    repo,
                    w.path,
                    w.branch,
                    w.headSha,
                    int(w.isDirty),
                    w.ahead,
                    w.behind,
                    w.lastCommitAt,
                    int(w.isPrunable),
                    int(w.isMerged),
                    t,
                )
                for w in data.worktrees
            ],
        )
        record_change(conn, "repo", 0, "update", None, t)
    return {"ok": True, "machine": machine, "repo": repo, "count": len(data.worktrees)}
