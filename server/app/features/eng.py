"""/api/eng：工程追蹤（手動輸入優先；docs/design/eng-tracking.md）。

- 問題（manual_issues）：任何成員可新增 / 編輯 / 結案 / 刪除；狀態值為 eng_statuses 的 key（eng_status.py）
- Worktree 紀錄（worktree_records）：任何成員可新增 / 編輯；刪除為「移到回收區」（軟刪除，可還原；
  永久清空需 eng.trash.purge）。**任何自動流程（回報、掃描）都不會刪除紀錄**
- 回報（worktree_reports）：各人電腦以 scripts/report_worktrees.py 回報 `git worktree list` 快照，
  POST /api/eng/worktrees/report 免 session，只以 WORKTREE_REPORT_TOKEN 驗證（未設定一律 403）。
  以電腦識別碼（machine_id）為鍵；最新回報找不到的項目只標記 missing_since、不刪除；
  空清單或筆數驟減的回報先攔下（pending），由有權限者在頁面確認後才採用
- 掃描（POST /worktrees/scan、/scan/apply；eng.scan）：在伺服器本機對 WORKTREE_SCAN_ROOTS 內的資料夾執行唯讀 git
  （server/app/worktree_scan.py），預覽後登記；未設定 WORKTREE_SCAN_ROOTS 時停用
- 紀錄與回報的比對只是參考提示（可能遺失 / 回報中找不到 / 可能搬動 / 未登記）
- GitHub 連動（選配，需 GITHUB_TOKEN）：「連結」為 GitHub issue 網址時自動解析 repo / 編號；
  同步 / 匯入 / 在 GitHub 建立 / 專案連動設定。GET 不做網路呼叫，過期時由前端呼叫 /issues/sync
  權限：專案連動設定（PUT /github-links）需 github.manage（manager 以上），其餘全員可用

變更紀錄沿用既有實體類型（前端即時同步已對應到 ['eng']）：問題與回報記為 repo、worktree 紀錄記為 worktree_plan。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated, Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import AfterValidator, BaseModel, Field, StringConstraints
from starlette.concurrency import run_in_threadpool

from ..changes import record_change
from ..config import config
from ..context import Ctx, get_ctx
from ..errors import HttpError, bad_request, forbidden, not_found
from ..github import GitHubClient, GitHubClientProtocol, GitHubError, normalize_repo, parse_issue_url
from ..permissions import can, require
from ..validate import parse_id, present, read_json
from .. import worktree_scan as ws
from ..schemas import SQL_INT_MAX, UID_PATTERN, DbId, SqlInt
from ..timeutil import DAY_MS
from . import eng_attach
from .eng_status import check_value, default_key, keys_in_category

router = APIRouter()

#: 回收區：超過此天數標示「已超過保留期」，但仍不會自動清除（只有管理者按「清空回收區」才永久刪除）
TRASH_RETENTION_DAYS = 30
#: 可疑回報：筆數減少超過一半且減少至少這麼多筆
DROP_MIN = 5


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
    status: _text(50, 1) = None  # type: ignore[valid-type]
    assigneeId: DbId | None = None
    url: OptionalUrl = None


class IssueCreateInput(IssueUpdateInput):
    title: _text(200, 1)  # type: ignore[valid-type]


class RecordUpdateInput(_Input):
    machine: _text(100, 1) = None  # type: ignore[valid-type]
    path: _text(500, 1) = None  # type: ignore[valid-type]
    branch: _text(200) = None  # type: ignore[valid-type]
    ownerId: DbId | None = None
    purpose: _text(200) = None  # type: ignore[valid-type]
    status: _text(50, 1) = None  # type: ignore[valid-type]
    note: _text(2000) = None  # type: ignore[valid-type]
    repo: _text(100) = None  # type: ignore[valid-type]
    headSha: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{7,64}$")] | None = None


MachineId = Annotated[str, StringConstraints(pattern=UID_PATTERN)]


class RecordCreateInput(RecordUpdateInput):
    machine: _text(100, 1)  # type: ignore[valid-type]
    path: _text(500, 1)  # type: ignore[valid-type]
    #: 由回報「登記」時帶入該電腦的識別碼
    machineId: MachineId | None = None
    source: Literal["manual", "report"] = "manual"


class ReportedWorktree(_Input):
    path: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    branch: Annotated[str, StringConstraints(max_length=300)] | None = None
    headSha: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{7,64}$")] | None = None
    isDirty: bool = False
    ahead: Annotated[int, Field(ge=0, le=SQL_INT_MAX)] | None = None
    behind: Annotated[int, Field(ge=0, le=SQL_INT_MAX)] | None = None
    lastCommitAt: SqlInt | None = None
    isPrunable: bool = False
    isMerged: bool = False


class ReportInput(_Input):
    #: 電腦名稱（顯示用；舊版腳本用 reporter）
    machine: _text(100, 1) = None  # type: ignore[valid-type]
    reporter: _text(100, 1) = None  # type: ignore[valid-type]
    #: 穩定的電腦識別碼（~/.tasks-sheets/machine.json）；舊版腳本沒有 → 以名稱暫代
    machineId: MachineId | None = None
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
        "machineId": r["machine_id"],
        "source": r["source"],
        "repo": r["repo"],
        "headSha": r["head_sha"],
        "deletedAt": r["deleted_at"],
        "deletedBy": r["deleted_by"],
        "createdBy": r["created_by"],
        "updatedBy": r["updated_by"],
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
    }


def _report(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "machine": r["machine"],
        "machineId": r["machine_id"],
        "missingSince": r["missing_since"],
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


def source_key(machine_id: str | None, machine: str) -> str:
    """電腦分組鍵：有識別碼用識別碼（改名 / 同名不混淆），舊資料沒有則以名稱暫代"""
    return f"id:{machine_id}" if machine_id else f"name:{machine_key(machine)}"


def _check_user(conn: sqlite3.Connection, uid: int | None, label: str) -> None:
    if uid is not None and not conn.execute("SELECT 1 FROM users WHERE id = ?", (uid,)).fetchone():
        raise bad_request(f"{label}不存在")


def check_active_owner(conn: sqlite3.Connection, uid: int | None, label: str = "負責人") -> None:
    """批次登記（掃描 / 貼上）指定的負責人：必須存在且啟用"""
    if uid is None:
        return
    row = conn.execute("SELECT is_active FROM users WHERE id = ?", (uid,)).fetchone()
    if row is None:
        raise bad_request(f"{label}不存在")
    if not row["is_active"]:
        raise bad_request(f"{label}已停用")


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
    # 已結案類（category = closed）排在後面
    rows = db.all(
        "SELECT mi.* FROM manual_issues mi LEFT JOIN eng_statuses s ON s.kind = 'issue' AND s.key = mi.status "
        "ORDER BY CASE s.category WHEN 'closed' THEN 1 ELSE 0 END, mi.updated_at DESC, mi.id DESC"
    )
    links = db.all("SELECT * FROM eng_github_links ORDER BY project COLLATE NOCASE")
    return {
        "githubEnabled": _github_token(request) is not None,
        "syncMinutes": config.GITHUB_SYNC_MINUTES,
        "links": [_link(r) for r in links],
        "issues": [_issue(r) for r in rows],
        **eng_attach.issue_extras(request),
    }


@router.post("/issues")
async def create_issue(request: Request, background: BackgroundTasks):
    ctx = get_ctx(request)
    fields = present(await read_json(request, IssueCreateInput))
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        _check_user(conn, fields.get("assigneeId"), "負責人")
        if "status" in fields:
            check_value(conn, "issue", fields["status"])
        else:
            fields["status"] = default_key(conn, "issue")
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
    if row["url"]:
        eng_attach.schedule_preview(request, background, iid, row["url"])
    return JSONResponse(_issue(row), status_code=201)


@router.patch("/issues/{id}")
async def update_issue(request: Request, id: str, background: BackgroundTasks):
    ctx = get_ctx(request)
    iid = parse_id(id)
    fields = present(await read_json(request, IssueUpdateInput))
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        current = conn.execute("SELECT url, status FROM manual_issues WHERE id = ?", (iid,)).fetchone()
        if current is None:
            raise not_found(_ISSUE_NOT_FOUND)
        _check_user(conn, fields.get("assigneeId"), "負責人")
        if "status" in fields:
            check_value(conn, "issue", fields["status"], current["status"])
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
    if "url" in fields and (fields["url"] or None) != current["url"]:
        eng_attach.schedule_preview(request, background, iid, row["url"])
    return _issue(row)


@router.delete("/issues/{id}")
async def delete_issue(request: Request, id: str):
    ctx = get_ctx(request)
    iid = parse_id(id)
    with ctx.db.tx() as conn:
        stored = eng_attach.issue_stored_names(conn, iid)
        # 附件與預覽的資料列由 trigger（0008）一併刪除
        if conn.execute("DELETE FROM manual_issues WHERE id = ?", (iid,)).rowcount == 0:
            raise not_found(_ISSUE_NOT_FOUND)
        record_change(conn, "repo", iid, "delete", ctx.user["id"], ctx.now())
    eng_attach.remove_stored(request, stored)
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
    id: DbId | None = None


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


def github_changes(
    row: sqlite3.Row | dict[str, Any],
    gh: dict[str, Any],
    closed_keys: frozenset[str] | set[str] = frozenset({"closed", "wontfix"}),
    reopen_key: str = "open",
) -> dict[str, Any]:
    """同步規則：只有 GitHub 端「有變動」時才覆蓋本地欄位（本地手動改的狀態 / 標題不會被蓋回去）。

    - GitHub 狀態由「非關閉」→ closed：本地若不是已結案類（category = closed）則改為已結案（closed）
    - GitHub 狀態由 closed → open（重開）：本地若為已結案類則改回預設的未結案狀態
    - GitHub 標題與上次同步的不同：覆蓋本地標題（第一次同步不覆蓋）
    回傳要更新的本地欄位（不含 github_* 紀錄欄位）
    """
    out: dict[str, Any] = {}
    prev_state, new_state = row["github_state"], gh["state"]
    if new_state != prev_state:
        if new_state == "closed" and row["status"] not in closed_keys:
            out["status"] = "closed"
        elif new_state == "open" and prev_state == "closed" and row["status"] in closed_keys:
            out["status"] = reopen_key
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
        closed_keys = keys_in_category(conn, "issue", "closed")
        reopen = default_key(conn, "issue")
        for iid, res in results.items():
            if isinstance(res, GitHubError):
                failed.append({"id": iid, "message": res.message})
                continue
            row = conn.execute("SELECT * FROM manual_issues WHERE id = ?", (iid,)).fetchone()
            if row is None:  # 同步期間被刪除
                continue
            sets = github_changes(row, res, closed_keys, reopen)
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
        open_key = default_key(conn, "issue")
        for gh in items:
            if gh["number"] in existing or gh.get("is_pull"):
                continue
            existing.add(gh["number"])
            title = (gh["title"] or "").strip()[:200] or f"#{gh['number']}"
            cur = conn.execute(
                "INSERT INTO manual_issues (title, description, project, status, url, github_repo, github_number, "
                "github_state, github_title, github_synced_at, created_by, updated_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    title,
                    (gh["body"] or "").strip()[:5000],
                    data.project,
                    open_key,
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
    "repo": "repo",
    "headSha": "head_sha",
    "machineId": "machine_id",
    "source": "source",
}
_RECORD_NOT_FOUND = "此紀錄不存在或已被刪除"


def _same_machine(rec: sqlite3.Row | dict[str, Any], machine: str, machine_id: str | None) -> bool:
    """紀錄是否屬於這台電腦：雙方都有識別碼時比對識別碼，否則比對名稱（不分大小寫）"""
    if machine_id and rec["machine_id"]:
        return bool(rec["machine_id"] == machine_id)
    return machine_key(rec["machine"]) == machine_key(machine)


def _check_record(
    conn: sqlite3.Connection, machine: str, path: str, machine_id: str | None = None, self_id: int | None = None
) -> None:
    """同一台電腦的同一路徑只能有一筆紀錄（回收區中的不算）"""
    pk = path_key(path)
    for r in conn.execute("SELECT id, machine, machine_id, path FROM worktree_records WHERE deleted_at IS NULL").fetchall():
        if r["id"] != self_id and path_key(r["path"]) == pk and _same_machine(r, machine, machine_id):
            raise HttpError(409, "CONFLICT", "此電腦的這個路徑已有紀錄", {"field": "path"})


@router.post("/worktree-records")
async def create_record(request: Request):
    ctx = get_ctx(request)
    fields = present(await read_json(request, RecordCreateInput))
    fields.setdefault("source", "manual")
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        _check_user(conn, fields.get("ownerId"), "負責人")
        _check_record(conn, fields["machine"], fields["path"], fields.get("machineId"))
        if "status" in fields:
            check_value(conn, "worktree", fields["status"])
        else:
            fields["status"] = default_key(conn, "worktree")
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
        current = conn.execute("SELECT * FROM worktree_records WHERE id = ? AND deleted_at IS NULL", (rid,)).fetchone()
        if current is None:
            raise not_found(_RECORD_NOT_FOUND)
        _check_user(conn, fields.get("ownerId"), "負責人")
        _check_record(
            conn,
            fields.get("machine", current["machine"]),
            fields.get("path", current["path"]),
            current["machine_id"],
            rid,
        )
        if "status" in fields:
            check_value(conn, "worktree", fields["status"], current["status"])
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
    """移到回收區（軟刪除）：可在「已刪除」檢視還原；只有 eng.trash.purge 可永久清空"""
    ctx = get_ctx(request)
    rid = parse_id(id)
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        n = conn.execute(
            "UPDATE worktree_records SET deleted_at = ?, deleted_by = ?, updated_at = ?, updated_by = ? "
            "WHERE id = ? AND deleted_at IS NULL",
            (t, uid, t, uid, rid),
        ).rowcount
        if n == 0:
            raise not_found(_RECORD_NOT_FOUND)
        record_change(conn, "worktree_plan", rid, "delete", uid, t)
    return {"ok": True, "trashed": True}


@router.get("/worktree-records/trash")
async def list_trash(request: Request):
    ctx = get_ctx(request)
    now = ctx.now()
    rows = ctx.db.all("SELECT * FROM worktree_records WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC")
    return {
        "retentionDays": TRASH_RETENTION_DAYS,
        "records": [
            {**_record(r), "expired": now - r["deleted_at"] > TRASH_RETENTION_DAYS * DAY_MS} for r in rows
        ],
    }


@router.post("/worktree-records/{id}/restore")
async def restore_record(request: Request, id: str):
    ctx = get_ctx(request)
    rid = parse_id(id)
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        row = conn.execute("SELECT * FROM worktree_records WHERE id = ? AND deleted_at IS NOT NULL", (rid,)).fetchone()
        if row is None:
            raise not_found("回收區中找不到此紀錄")
        _check_record(conn, row["machine"], row["path"], row["machine_id"], rid)
        conn.execute(
            "UPDATE worktree_records SET deleted_at = NULL, deleted_by = NULL, updated_at = ?, updated_by = ? WHERE id = ?",
            (t, uid, rid),
        )
        record_change(conn, "worktree_plan", rid, "update", uid, t)
        row = conn.execute("SELECT * FROM worktree_records WHERE id = ?", (rid,)).fetchone()
    return _record(row)


class PurgeInput(_Input):
    confirm: bool


@router.post("/worktree-records/trash/purge")
async def purge_trash(request: Request, ctx: Ctx = Depends(require("eng.trash.purge"))):
    """永久刪除回收區中的全部紀錄（唯一會真正刪除 worktree 紀錄的路徑；需明確確認）"""
    data = await read_json(request, PurgeInput)
    if data.confirm is not True:
        raise bad_request("請確認要永久清空回收區")
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        ids = [r[0] for r in conn.execute("SELECT id FROM worktree_records WHERE deleted_at IS NOT NULL").fetchall()]
        conn.execute("DELETE FROM worktree_records WHERE deleted_at IS NOT NULL")
        for rid in ids:
            record_change(conn, "worktree_plan", rid, "delete", uid, t)
    return {"ok": True, "purged": len(ids)}


# ── 紀錄 × 回報（依電腦分組） ──


def _stale_days(request: Request) -> float:
    return float(getattr(request.app.state, "worktree_stale_days", config.WORKTREE_STALE_DAYS))


def _move_key(branch: str | None, head: str | None) -> tuple[str, str] | None:
    """搬動比對鍵：分支 + HEAD（沒有 HEAD 無法判斷）"""
    return (branch or "", head) if head else None


def build_overview(
    records: list[dict[str, Any]],
    reports: list[dict[str, Any]],
    sources: list[dict[str, Any]] | None = None,
    done_keys: set[str] | frozenset[str] = frozenset({"lost", "cleaned"}),
    now: int | None = None,
    stale_days: float = 2,
) -> list[dict[str, Any]]:
    """依電腦（machine_id；舊資料以名稱暫代）分組，標出參考提示：

    紀錄的 hint（該電腦有回報過才判斷；狀態屬於 done 類別者不提示）：
    - 'moved'：此路徑不在最新回報，但有一個未登記的回報項目分支與 HEAD 相同 → 可能是搬動 / 改名（moveTo）
    - 'vanished'：上次回報有看到、最新回報找不到（lastSeenAt）
    - 'missing'：回報中從未出現此路徑
    回報的 registered = False：回報有、但沒有對應的紀錄（未登記）；movedFrom = 疑似由哪筆紀錄搬來
    電腦的 stale：超過 stale_days 天沒有回報；pending：被攔下待確認的可疑回報
    """
    sources = sources or []
    groups: dict[str, dict[str, Any]] = {}

    def group(key: str, machine: str, machine_id: str | None) -> dict[str, Any]:
        if key not in groups:
            groups[key] = {
                "key": key,
                "machine": machine.strip(),
                "machineId": machine_id,
                "reportedAt": None,
                "stale": False,
                "repos": [],
                "records": [],
                "reports": [],
            }
        return groups[key]

    # 名稱 → 分組鍵（給沒有識別碼的紀錄用；同名多台時取最近回報者）
    by_name: dict[str, tuple[int, str]] = {}
    for s in sources:
        g = group(s["machineKey"], s["machine"], s["machineId"])
        g["machine"] = s["machine"].strip() or g["machine"]
        g["reportedAt"] = max(g["reportedAt"] or 0, s["lastReportAt"])
        g["repos"].append(
            {
                "sourceId": s["id"],
                "repo": s["repo"],
                "reportedAt": s["lastReportAt"],
                "appliedAt": s["lastAppliedAt"],
                "pending": s["pending"],
            }
        )
        nk = machine_key(s["machine"])
        if nk not in by_name or by_name[nk][0] < s["lastReportAt"]:
            by_name[nk] = (s["lastReportAt"], s["machineKey"])

    def record_group(rec: dict[str, Any]) -> dict[str, Any]:
        if rec.get("machineId"):
            return group(source_key(rec["machineId"], rec["machine"]), rec["machine"], rec["machineId"])
        hit = by_name.get(machine_key(rec["machine"]))
        if hit:
            return groups[hit[1]]
        return group(source_key(None, rec["machine"]), rec["machine"], None)

    for rep in reports:
        g = group(source_key(rep.get("machineId"), rep["machine"]), rep["machine"], rep.get("machineId"))
        g["reports"].append(dict(rep))
        if not any(r["repo"] == rep["repo"] for r in g["repos"]):
            # 沒有 source 列的舊資料（理論上 migration 已回填）
            g["reportedAt"] = max(g["reportedAt"] or 0, rep["reportedAt"])

    rec_groups = [(rec, record_group(rec)) for rec in records]
    # 沒有識別碼的電腦：顯示名稱以手動紀錄的寫法優先
    for rec, g in reversed(rec_groups):
        if g["key"].startswith("name:"):
            g["machine"] = rec["machine"].strip()
    for g in groups.values():
        paths = {path_key(rec["path"]) for rec, rg in rec_groups if rg is g}
        for rep in g["reports"]:
            rep["registered"] = path_key(rep["path"]) in paths
            rep["movedFrom"] = None

    for rec, g in rec_groups:
        out = {**rec, "hint": None, "lastSeenAt": None, "moveTo": None}
        g["records"].append(out)
        if g["reportedAt"] is None or rec["status"] in done_keys:
            continue
        pk = path_key(rec["path"])
        seen = next((r for r in g["reports"] if path_key(r["path"]) == pk), None)
        if seen is not None and seen["missingSince"] is None:
            continue
        out["hint"] = "vanished" if seen is not None else "missing"
        if seen is not None:
            out["lastSeenAt"] = seen["reportedAt"]
        mk = _move_key(seen["branch"], seen["headSha"]) if seen else _move_key(rec.get("branch"), rec.get("headSha"))
        if mk is None:
            continue
        cand = next(
            (
                r
                for r in g["reports"]
                if r["missingSince"] is None
                and not r["registered"]
                and r["movedFrom"] is None
                and _move_key(r["branch"], r["headSha"]) == mk
            ),
            None,
        )
        if cand is not None:
            out["hint"] = "moved"
            out["moveTo"] = {"path": cand["path"], "reportId": cand["id"]}
            cand["movedFrom"] = rec["id"]

    if now is not None:
        for g in groups.values():
            g["stale"] = g["reportedAt"] is not None and now - g["reportedAt"] > stale_days * DAY_MS
    return sorted(groups.values(), key=lambda g: (machine_key(g["machine"]), g["key"]))


def _report_token(request: Request) -> str | None:
    """回報 token；測試可以 app.state.eng_report_token 覆寫"""
    return getattr(request.app.state, "eng_report_token", config.WORKTREE_REPORT_TOKEN) or None


def _source(r: sqlite3.Row) -> dict[str, Any]:
    pending = None
    if r["pending_json"] is not None:
        pending = {
            "reason": r["pending_reason"],
            "count": r["pending_count"],
            "previous": r["pending_previous"],
            "at": r["pending_at"],
        }
    return {
        "id": r["id"],
        "machineKey": r["machine_key"],
        "machineId": r["machine_id"],
        "machine": r["machine"],
        "repo": r["repo"],
        "lastReportAt": r["last_report_at"],
        "lastAppliedAt": r["last_applied_at"],
        "pending": pending,
    }


@router.get("/worktrees")
async def worktrees_overview(request: Request):
    ctx = get_ctx(request)
    db = ctx.db
    with db.tx() as conn:
        records = [
            _record(r)
            for r in conn.execute(
                "SELECT * FROM worktree_records WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC"
            ).fetchall()
        ]
        reports = [_report(r) for r in conn.execute("SELECT * FROM worktree_reports ORDER BY repo, branch, path").fetchall()]
        sources = [_source(r) for r in conn.execute("SELECT * FROM worktree_report_sources ORDER BY repo").fetchall()]
        done = keys_in_category(conn, "worktree", "done")
        trash = conn.execute("SELECT count(*) FROM worktree_records WHERE deleted_at IS NOT NULL").fetchone()[0]
    stale_days = _stale_days(request)
    roots = _scan_roots(request)
    scan: dict[str, Any] = {"enabled": roots is not None and len(roots) > 0}
    if can(ctx.user, "eng.scan", db):
        local = ws.local_machine(create=False, home=_machine_home(request))
        scan.update(roots=[str(r) for r in roots or []], machine=local["machineName"])
    return {
        "reportEnabled": _report_token(request) is not None,
        "staleDays": stale_days,
        "trashCount": trash,
        "scan": scan,
        "machines": build_overview(records, reports, sources, done, ctx.now(), stale_days),
    }


def _sha(s: str) -> bytes:
    return hashlib.sha256(s.encode("utf-8")).digest()


def _group_reports(conn: sqlite3.Connection, machine_id: str | None, machine: str, repo: str) -> list[sqlite3.Row]:
    if machine_id:
        return conn.execute(
            "SELECT * FROM worktree_reports WHERE machine_id = ? AND repo = ?", (machine_id, repo)
        ).fetchall()
    return conn.execute(
        "SELECT * FROM worktree_reports WHERE machine_id IS NULL AND lower(trim(machine)) = ? AND repo = ?",
        (machine_key(machine), repo),
    ).fetchall()


def apply_snapshot(
    conn: sqlite3.Connection, machine_id: str | None, machine: str, repo: str, worktrees: list[dict[str, Any]], t: int
) -> dict[str, int]:
    """採用一份回報快照：有出現的更新（清除 missing_since），沒出現的只標 missing_since。**不刪除任何列**"""
    rows = {path_key(r["path"]): r for r in _group_reports(conn, machine_id, machine, repo)}
    seen: set[str] = set()
    for w in worktrees:
        pk = path_key(w["path"])
        if pk in seen:
            continue
        seen.add(pk)
        values = (
            machine,
            machine_id,
            w["path"],
            w.get("branch"),
            w.get("headSha"),
            int(bool(w.get("isDirty"))),
            w.get("ahead"),
            w.get("behind"),
            w.get("lastCommitAt"),
            int(bool(w.get("isPrunable"))),
            int(bool(w.get("isMerged"))),
            t,
        )
        if pk in rows:
            conn.execute(
                "UPDATE worktree_reports SET machine = ?, machine_id = ?, path = ?, branch = ?, head_sha = ?, is_dirty = ?, "
                "ahead = ?, behind = ?, last_commit_at = ?, is_prunable = ?, is_merged = ?, reported_at = ?, "
                "missing_since = NULL WHERE id = ?",
                (*values, rows[pk]["id"]),
            )
        else:
            conn.execute(
                "INSERT INTO worktree_reports (machine, machine_id, path, branch, head_sha, is_dirty, ahead, behind, "
                "last_commit_at, is_prunable, is_merged, reported_at, repo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (*values, repo),
            )
    gone = 0
    for pk, r in rows.items():
        if pk not in seen and r["missing_since"] is None:
            conn.execute("UPDATE worktree_reports SET missing_since = ? WHERE id = ?", (t, r["id"]))
            gone += 1
    return {"seen": len(seen), "missing": gone}


def suspicious(previous: int, count: int) -> str | None:
    """可疑回報：先前有資料但這次是空清單（empty）；或減少超過一半且減少至少 DROP_MIN 筆（drop）"""
    if previous > 0 and count == 0:
        return "empty"
    if previous - count >= DROP_MIN and count * 2 < previous:
        return "drop"
    return None


_HELD_MESSAGE = {
    "empty": "回報為空，已保留舊資料；請到工作樹頁面確認是否採用這次回報",
    "drop": "回報筆數驟減，已保留舊資料；請到工作樹頁面確認是否採用這次回報",
}


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
    mid = data.machineId
    key = source_key(mid, machine)
    ctx = get_ctx(request)
    t = ctx.now()
    worktrees = [w.model_dump() for w in data.worktrees]
    with ctx.db.tx() as conn:
        src = conn.execute(
            "SELECT * FROM worktree_report_sources WHERE machine_key = ? AND repo = ?", (key, repo)
        ).fetchone()
        if src is None and mid:
            # 新版腳本第一次帶識別碼回報：接手同名、沒有識別碼的舊回報（只接手無 id 者，不會併到別台電腦）
            legacy_key = source_key(None, machine)
            legacy = conn.execute(
                "SELECT * FROM worktree_report_sources WHERE machine_key = ? AND repo = ?", (legacy_key, repo)
            ).fetchone()
            if legacy is not None:
                conn.execute(
                    "UPDATE worktree_report_sources SET machine_key = ?, machine_id = ? WHERE id = ?", (key, mid, legacy["id"])
                )
                conn.execute(
                    "UPDATE worktree_reports SET machine_id = ? WHERE machine_id IS NULL AND lower(trim(machine)) = ? AND repo = ?",
                    (mid, machine_key(machine), repo),
                )
                src = conn.execute("SELECT * FROM worktree_report_sources WHERE id = ?", (legacy["id"],)).fetchone()
        if src is None:
            cur = conn.execute(
                "INSERT INTO worktree_report_sources (machine_key, machine_id, machine, repo, last_report_at) VALUES (?, ?, ?, ?, ?)",
                (key, mid, machine, repo, t),
            )
            src = conn.execute("SELECT * FROM worktree_report_sources WHERE id = ?", (cur.lastrowid,)).fetchone()
        previous = sum(1 for r in _group_reports(conn, mid, machine, repo) if r["missing_since"] is None)
        reason = suspicious(previous, len(worktrees))
        if reason:
            # 可疑：保留舊快照，整份回報先存起來等人確認（**不改動任何既有資料**）
            conn.execute(
                "UPDATE worktree_report_sources SET machine = ?, last_report_at = ?, pending_json = ?, pending_reason = ?, "
                "pending_count = ?, pending_previous = ?, pending_at = ? WHERE id = ?",
                (machine, t, json.dumps(worktrees), reason, len(worktrees), previous, t, src["id"]),
            )
        else:
            apply_snapshot(conn, mid, machine, repo, worktrees, t)
            conn.execute(
                "UPDATE worktree_report_sources SET machine = ?, last_report_at = ?, last_applied_at = ?, pending_json = NULL, "
                "pending_reason = NULL, pending_count = NULL, pending_previous = NULL, pending_at = NULL WHERE id = ?",
                (machine, t, t, src["id"]),
            )
        record_change(conn, "repo", 0, "update", None, t)
    body: dict[str, Any] = {"ok": True, "machine": machine, "repo": repo, "count": len(worktrees)}
    if mid:
        body["machineId"] = mid
    if reason:
        body.update(held=True, reason=reason, previous=previous, message=_HELD_MESSAGE[reason])
    return body


def _pending_source(conn: sqlite3.Connection, sid: int) -> sqlite3.Row:
    src = conn.execute("SELECT * FROM worktree_report_sources WHERE id = ?", (sid,)).fetchone()
    if src is None or src["pending_json"] is None:
        raise not_found("沒有待確認的回報（可能已被處理）")
    return src


@router.post("/worktrees/pending/{id}/accept")
async def accept_pending(request: Request, id: str):
    """確認採用被攔下的回報：與一般回報相同，沒出現的項目只標「回報中找不到」，紀錄一律保留"""
    ctx = get_ctx(request)
    sid = parse_id(id)
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        src = _pending_source(conn, sid)
        worktrees = json.loads(src["pending_json"])
        result = apply_snapshot(conn, src["machine_id"], src["machine"], src["repo"], worktrees, src["pending_at"])
        conn.execute(
            "UPDATE worktree_report_sources SET last_applied_at = ?, pending_json = NULL, pending_reason = NULL, "
            "pending_count = NULL, pending_previous = NULL, pending_at = NULL WHERE id = ?",
            (t, sid),
        )
        record_change(conn, "repo", 0, "update", uid, t)
    return {"ok": True, **result}


@router.post("/worktrees/pending/{id}/discard")
async def discard_pending(request: Request, id: str):
    """忽略被攔下的回報（保留目前的快照）"""
    ctx = get_ctx(request)
    sid = parse_id(id)
    with ctx.db.tx() as conn:
        _pending_source(conn, sid)
        conn.execute(
            "UPDATE worktree_report_sources SET pending_json = NULL, pending_reason = NULL, pending_count = NULL, "
            "pending_previous = NULL, pending_at = NULL WHERE id = ?",
            (sid,),
        )
        record_change(conn, "repo", 0, "update", ctx.user["id"], ctx.now())
    return {"ok": True}


# ── 掃描本機專案（eng.scan；WORKTREE_SCAN_ROOTS） ──


class ScanInput(_Input):
    path: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    machine: _text(100) = None  # type: ignore[valid-type]
    repo: _text(100) = None  # type: ignore[valid-type]


class ScanApplyInput(ScanInput):
    #: 要登記 / 更新路徑的 worktree 路徑（預覽中勾選者）
    paths: Annotated[list[Annotated[str, StringConstraints(max_length=1000)]], Field(max_length=ws.MAX_WORKTREES)]
    #: 新登記紀錄的負責人（選填；預設為呼叫者；必須存在且啟用）
    ownerId: Annotated[int, Field(ge=1)] | None = None


def _scan_roots(request: Request) -> list[Any] | None:
    """允許掃描的資料夾；None = 未設定（功能停用）。測試可以 app.state.worktree_scan_roots 覆寫"""
    raw = getattr(request.app.state, "worktree_scan_roots", config.WORKTREE_SCAN_ROOTS)
    if not raw:
        return None
    return ws.parse_roots(raw)


def _machine_home(request: Request) -> str | None:
    return getattr(request.app.state, "machine_home", None)


_SCAN_DISABLED = "伺服器未設定 WORKTREE_SCAN_ROOTS，掃描本機專案功能停用"


def plan_scan(
    conn: sqlite3.Connection, machine: str, machine_id: str | None, result: ws.ScanResult
) -> list[dict[str, Any]]:
    """掃描結果 × 既有紀錄：new（未登記）/ existing（已登記）/ moved（路徑不同但分支與 HEAD 相同的紀錄 → 可能搬動）"""
    recs = [
        r
        for r in conn.execute("SELECT * FROM worktree_records WHERE deleted_at IS NULL").fetchall()
        if _same_machine(r, machine, machine_id)
    ]
    by_path = {path_key(r["path"]): r for r in recs}
    scanned = {path_key(w.path) for w in result.worktrees}
    used: set[int] = set()
    items: list[dict[str, Any]] = []
    for w in result.worktrees:
        item = {**w.to_dict(), "action": "new", "recordId": None, "recordPath": None}
        rec = by_path.get(path_key(w.path))
        if rec is not None:
            item.update(action="existing", recordId=rec["id"], recordPath=rec["path"])
        else:
            mk = _move_key(w.branch, w.headSha)
            moved = next(
                (
                    r
                    for r in recs
                    if mk is not None
                    and r["id"] not in used
                    and path_key(r["path"]) not in scanned
                    and _move_key(r["branch"] or None, r["head_sha"]) == mk
                ),
                None,
            )
            if moved is not None:
                used.add(moved["id"])
                item.update(action="moved", recordId=moved["id"], recordPath=moved["path"])
        items.append(item)
    return items


def apply_scan(
    conn: sqlite3.Connection,
    items: list[dict[str, Any]],
    selected: set[str],
    machine: str,
    machine_id: str | None,
    repo: str,
    uid: int | None,
    t: int,
    owner_id: int | None = None,
) -> dict[str, int]:
    """登記勾選的項目：new → 新增紀錄（來源 scan）；moved → 更新該紀錄的路徑；existing → 更新分支與 HEAD"""
    created = moved = updated = 0
    merged_ok = conn.execute(
        "SELECT 1 FROM eng_statuses WHERE kind = 'worktree' AND key = 'merged' AND is_archived = 0"
    ).fetchone()
    default = default_key(conn, "worktree")
    for it in items:
        if path_key(it["path"]) not in selected:
            continue
        if it["action"] == "new":
            status = "merged" if it["isMerged"] and merged_ok else default
            cur = conn.execute(
                "INSERT INTO worktree_records (machine, machine_id, path, branch, status, repo, head_sha, source, "
                "owner_id, created_by, updated_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'scan', ?, ?, ?, ?, ?)",
                (machine, machine_id, it["path"], it["branch"] or "", status, repo, it["headSha"], owner_id, uid, uid, t, t),
            )
            record_change(conn, "worktree_plan", int(cur.lastrowid), "create", uid, t)  # type: ignore[arg-type]
            created += 1
        elif it["action"] in ("moved", "existing"):
            sets: dict[str, Any] = {"branch": it["branch"] or "", "head_sha": it["headSha"]}
            if it["action"] == "moved":
                sets["path"] = it["path"]
            if machine_id:
                sets["machine_id"] = machine_id
            if repo:
                sets["repo"] = repo
            sets.update(updated_by=uid, updated_at=t)
            conn.execute(
                f"UPDATE worktree_records SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?",
                (*sets.values(), it["recordId"]),
            )
            record_change(conn, "worktree_plan", it["recordId"], "update", uid, t)
            if it["action"] == "moved":
                moved += 1
            else:
                updated += 1
    return {"created": created, "moved": moved, "updated": updated}


async def _run_scan(request: Request, data: ScanInput) -> tuple[ws.ScanResult, str, str | None]:
    roots = _scan_roots(request)
    if not roots:
        raise HttpError(409, "SCAN_DISABLED", _SCAN_DISABLED)
    git = getattr(request.app.state, "git_runner", None) or ws.Git(config.GIT_TIMEOUT_MS)
    try:
        target = ws.resolve_target(data.path, roots)
        result = await run_in_threadpool(ws.scan_repo, target, git, data.repo or None)
    except ws.ScanError as e:
        raise HttpError(400, e.code, e.message) from None
    local = ws.local_machine(create=False, home=_machine_home(request))
    machine = data.machine or local["machineName"] or "本機"
    # 只有沿用本機名稱時才帶本機識別碼（指定其他電腦名稱時以名稱比對）
    machine_id = local["machineId"] if not data.machine or machine_key(data.machine) == machine_key(local["machineName"] or "") else None
    return result, machine, machine_id


def _counts(items: list[dict[str, Any]]) -> dict[str, int]:
    return {a: sum(1 for i in items if i["action"] == a) for a in ("new", "existing", "moved")}


@router.post("/worktrees/scan")
async def scan_preview(request: Request, ctx: Ctx = Depends(require("eng.scan"))):
    """預覽（不寫入）：列出新發現 / 已登記 / 可能搬動"""
    data = await read_json(request, ScanInput)
    result, machine, machine_id = await _run_scan(request, data)
    with ctx.db.tx() as conn:
        items = plan_scan(conn, machine, machine_id, result)
    return {
        "repo": result.repo,
        "repoPath": result.repoPath,
        "base": result.base,
        "machine": machine,
        "truncated": result.truncated,
        "counts": _counts(items),
        "items": items,
    }


@router.post("/worktrees/scan/apply")
async def scan_apply(request: Request, ctx: Ctx = Depends(require("eng.scan"))):
    """重新掃描（不採信前端傳來的內容）後，登記勾選的路徑"""
    data = await read_json(request, ScanApplyInput)
    result, machine, machine_id = await _run_scan(request, data)
    selected = {path_key(p) for p in data.paths}
    uid = ctx.user["id"]
    t = ctx.now()
    with ctx.db.tx() as conn:
        owner_id = data.ownerId if data.ownerId is not None else uid
        check_active_owner(conn, owner_id)
        items = plan_scan(conn, machine, machine_id, result)
        out = apply_scan(conn, items, selected, machine, machine_id, result.repo, uid, t, owner_id)
    return {"ok": True, "machine": machine, "repo": result.repo, **out}
