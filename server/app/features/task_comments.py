"""/api/tasks/:id/comments：任務討論區（留言 + 討論串）。規格見 docs/design/task-discussion.md。

- 只支援兩層：根訊息（parent_id NULL）＋ 回覆（parent_id 一律指向根訊息）；reply_to_id 只用於顯示「回覆 @某人」。
- 讀取登入即可；寫入需 comments.write（全域寫入守門，permissions.WRITE_GUARDS）；
  刪除他人訊息需 comments.moderate；編輯只限作者本人。標記已讀不受寫入守門（WRITE_GUARD_EXEMPT）。
- 軟刪除：保留討論串結構，API 回傳 body 為空字串並帶 deletedAt。
- 每次寫入記錄變更流水 entity `task_comment`（entity_id = 留言 id），前端據此重抓討論區與清單徽章。
- 速率限制：同一使用者每分鐘最多 RATE_LIMIT 則（防洗版）。
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Annotated, Any, Iterable

from fastapi import APIRouter, Request
from pydantic import StringConstraints

from .. import audit_events
from ..changes import record_change
from ..context import get_ctx
from ..errors import bad_request, conflict, not_found, too_many_requests
from ..permissions import can, denied
from ..schemas import DbId, _Input
from ..validate import ID_MAX, parse_id, read_json

router = APIRouter()

BODY_MAX = 4000
DEFAULT_THREADS = 20
MAX_THREADS = 50
#: 討論串列表中每串最多附上的最新回覆數；其餘以 /replies 載入
THREAD_REPLY_PREVIEW = 10
DEFAULT_REPLIES = 20
MAX_REPLIES = 100
RATE_LIMIT = 30
RATE_WINDOW_MS = 60_000

Body = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=BODY_MAX)]

#: @帳號：帳號規則為小寫英數與 . _ -（admin.py）；前面不可緊接英數（避免 email 被誤判）
_MENTION = re.compile(r"(?<![A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})")


class CommentCreateInput(_Input):
    body: Body
    parentId: DbId | None = None
    replyToId: DbId | None = None


class CommentUpdateInput(_Input):
    body: Body


# ── 共用 ────────────────────────────────────────────────────


def parse_mentions(conn: sqlite3.Connection, body: str) -> list[int]:
    """解析 @帳號 → 存在且啟用中的成員 id（依出現順序、去重）；不存在的帳號視為一般文字"""
    names: list[str] = []
    for m in _MENTION.finditer(body):
        name = m.group(1).rstrip(".-_").lower()
        if name and name not in names:
            names.append(name)
    if not names:
        return []
    rows = conn.execute(
        f"SELECT id, lower(username) AS u FROM users WHERE is_active = 1 AND lower(username) IN ({','.join('?' * len(names))})",
        tuple(names),
    ).fetchall()
    by_name = {r["u"]: r["id"] for r in rows}
    return [by_name[n] for n in names if n in by_name]


def comment_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    deleted = row["deleted_at"] is not None
    return {
        "id": row["id"],
        "taskId": row["task_id"],
        "parentId": row["parent_id"],
        "replyToId": row["reply_to_id"],
        "authorId": row["author_id"],
        "body": "" if deleted else row["body"],
        "mentions": [] if deleted else json.loads(row["mentions"] or "[]"),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "editedAt": row["edited_at"],
        "deletedAt": row["deleted_at"],
        "deletedBy": row["deleted_by"],
        "threadResolvedAt": row["thread_resolved_at"],
        "threadResolvedBy": row["thread_resolved_by"],
    }


def comment_stats(conn: sqlite3.Connection, user_id: int | None, task_ids: Iterable[int] | None = None) -> dict[int, tuple[int, int]]:
    """各任務的（未刪除留言數, 目前使用者的未讀數）；單一聚合查詢。
    未讀 = 他人的未刪除留言且 id 大於自己的已讀位置（自己的留言不算未讀）。task_ids 為 None 時查全部。"""
    params: list[Any] = [user_id or 0, user_id or 0]
    where = "c.deleted_at IS NULL"
    if task_ids is not None:
        ids = list(task_ids)
        if not ids:
            return {}
        where += f" AND c.task_id IN ({','.join('?' * len(ids))})"
        params.extend(ids)
    rows = conn.execute(
        "SELECT c.task_id AS tid, count(*) AS cnt, "
        "sum(CASE WHEN (c.author_id IS NULL OR c.author_id != ?) AND c.id > coalesce(r.last_read_comment_id, 0) "
        "THEN 1 ELSE 0 END) AS unread "
        "FROM task_comments c LEFT JOIN task_comment_reads r ON r.task_id = c.task_id AND r.user_id = ? "
        f"WHERE {where} GROUP BY c.task_id",
        tuple(params),
    ).fetchall()
    return {r["tid"]: (r["cnt"], r["unread"] or 0) for r in rows}


def with_comment_stats(task: dict[str, Any], stats: dict[int, tuple[int, int]]) -> dict[str, Any]:
    cnt, unread = stats.get(task["id"], (0, 0))
    task["commentCount"] = cnt
    task["unreadComments"] = unread
    return task


def _task_or_404(conn: sqlite3.Connection, task_id: int) -> sqlite3.Row:
    task = conn.execute("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL", (task_id,)).fetchone()
    if task is None:
        raise not_found("此任務不存在或已被刪除")
    return task


def _comment_or_404(conn: sqlite3.Connection, task_id: int, cid: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM task_comments WHERE id = ? AND task_id = ?", (cid, task_id)).fetchone()
    if row is None:
        raise not_found("找不到這則訊息")
    return row


def _int_param(request: Request, name: str, default: int, lo: int, hi: int) -> int:
    raw = request.query_params.get(name)
    if raw is None or raw == "":
        return default
    try:
        v = int(raw)
    except ValueError:
        raise bad_request(f"{name} 須為整數") from None
    return max(lo, min(hi, v))


# ── 讀取 ────────────────────────────────────────────────────


def _parse_cursor(raw: str | None) -> tuple[int, int] | None:
    """討論串游標：`<最新活動時間>_<根訊息 id>`"""
    if not raw:
        return None
    m = re.fullmatch(r"([0-9]{1,19})_([0-9]{1,19})", raw)
    if not m or int(m.group(1)) > ID_MAX or int(m.group(2)) > ID_MAX:
        raise bad_request("before 格式錯誤")
    return int(m.group(1)), int(m.group(2))


def _replies(conn: sqlite3.Connection, root_ids: list[int], per_root: int) -> dict[int, list[sqlite3.Row]]:
    """每個根訊息最新 per_root 則回覆（依時間舊→新）"""
    if not root_ids:
        return {}
    rows = conn.execute(
        "SELECT * FROM (SELECT c.*, row_number() OVER (PARTITION BY parent_id ORDER BY id DESC) AS rn "
        f"FROM task_comments c WHERE parent_id IN ({','.join('?' * len(root_ids))})) WHERE rn <= ? ORDER BY id",
        (*root_ids, per_root),
    ).fetchall()
    out: dict[int, list[sqlite3.Row]] = {}
    for r in rows:
        out.setdefault(r["parent_id"], []).append(r)
    return out


@router.get("/{id}/comments")
async def list_threads(request: Request, id: str):
    """最近的討論串（依串內最新活動時間新→舊），每串附最新 THREAD_REPLY_PREVIEW 則回覆與 replyCount。
    已刪除且沒有任何未刪除回覆的根訊息不列出。"""
    ctx = get_ctx(request)
    tid = parse_id(id)
    limit = _int_param(request, "limit", DEFAULT_THREADS, 1, MAX_THREADS)
    cursor = _parse_cursor(request.query_params.get("before"))
    with ctx.db.lock:
        conn = ctx.db.conn
        _task_or_404(conn, tid)
        cond = ""
        params: list[Any] = [tid]
        if cursor:
            cond = "WHERE act < ? OR (act = ? AND id < ?)"
            params += [cursor[0], cursor[0], cursor[1]]
        heads = conn.execute(
            "WITH t AS (SELECT r.id AS id, max(r.created_at, coalesce((SELECT max(c.created_at) FROM task_comments c "
            "WHERE c.parent_id = r.id), 0)) AS act, (SELECT count(*) FROM task_comments c WHERE c.parent_id = r.id) AS n "
            "FROM task_comments r WHERE r.task_id = ? AND r.parent_id IS NULL AND (r.deleted_at IS NULL OR EXISTS "
            "(SELECT 1 FROM task_comments c WHERE c.parent_id = r.id AND c.deleted_at IS NULL))) "
            f"SELECT id, act, n FROM t {cond} ORDER BY act DESC, id DESC LIMIT ?",
            (*params, limit + 1),
        ).fetchall()
        has_more = len(heads) > limit
        heads = heads[:limit]
        ids = [h["id"] for h in heads]
        roots = (
            {r["id"]: r for r in conn.execute(f"SELECT * FROM task_comments WHERE id IN ({','.join('?' * len(ids))})", ids)}
            if ids
            else {}
        )
        replies = _replies(conn, ids, THREAD_REPLY_PREVIEW)
        read = conn.execute(
            "SELECT last_read_comment_id FROM task_comment_reads WHERE user_id = ? AND task_id = ?", (ctx.user["id"], tid)
        ).fetchone()
    threads = [
        {
            **comment_to_dict(roots[h["id"]]),
            "replies": [comment_to_dict(r) for r in replies.get(h["id"], [])],
            "replyCount": h["n"],
            "lastActivityAt": h["act"],
        }
        for h in heads
    ]
    last = heads[-1] if heads else None
    return {
        "threads": threads,
        "hasMore": has_more,
        "nextBefore": f"{last['act']}_{last['id']}" if has_more and last else None,
        "lastReadCommentId": read["last_read_comment_id"] if read else None,
    }


@router.get("/{id}/comments/{root_id}/replies")
async def list_replies(request: Request, id: str, root_id: str):
    """某討論串較早的回覆：id < before 的最新 limit 則（依時間舊→新）"""
    ctx = get_ctx(request)
    tid, rid = parse_id(id), parse_id(root_id)
    limit = _int_param(request, "limit", DEFAULT_REPLIES, 1, MAX_REPLIES)
    before_raw = request.query_params.get("before")
    before = parse_id(before_raw) if before_raw else None
    with ctx.db.lock:
        conn = ctx.db.conn
        _task_or_404(conn, tid)
        root = _comment_or_404(conn, tid, rid)
        if root["parent_id"] is not None:
            raise bad_request("只能載入討論串第一則訊息的回覆")
        rows = conn.execute(
            "SELECT * FROM task_comments WHERE parent_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
            (rid, before, before, limit + 1),
        ).fetchall()
    has_more = len(rows) > limit
    rows = list(reversed(rows[:limit]))
    return {"replies": [comment_to_dict(r) for r in rows], "hasMore": has_more}


# ── 寫入 ────────────────────────────────────────────────────


def _check_rate(conn: sqlite3.Connection, user_id: int, now: int) -> None:
    n = conn.execute(
        "SELECT count(*) FROM task_comments WHERE author_id = ? AND created_at > ?", (user_id, now - RATE_WINDOW_MS)
    ).fetchone()[0]
    if n >= RATE_LIMIT:
        raise too_many_requests("留言有點太快了，請稍候一分鐘再繼續")


@router.post("/{id}/comments", status_code=201)
async def create_comment(request: Request, id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    data = await read_json(request, CommentCreateInput)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        _task_or_404(conn, tid)
        t = ctx.now()
        _check_rate(conn, uid, t)
        parent_id = data.parentId
        reply_to = data.replyToId
        if reply_to is not None and parent_id is None:
            raise bad_request("回覆某則訊息時須指定所屬的討論串（parentId）")
        if parent_id is not None:
            parent = conn.execute("SELECT * FROM task_comments WHERE id = ?", (parent_id,)).fetchone()
            if parent is None or parent["task_id"] != tid:
                raise bad_request("找不到要回覆的討論串")
            if parent["parent_id"] is not None:
                raise bad_request("回覆只能指向討論串的第一則訊息（只支援兩層）")
        if reply_to is not None:
            target = conn.execute("SELECT * FROM task_comments WHERE id = ?", (reply_to,)).fetchone()
            if target is None or target["task_id"] != tid or (target["id"] != parent_id and target["parent_id"] != parent_id):
                raise bad_request("要回覆的訊息不在此討論串中")
        mentions = parse_mentions(conn, data.body)
        cur = conn.execute(
            "INSERT INTO task_comments (task_id, parent_id, reply_to_id, author_id, body, mentions, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (tid, parent_id, reply_to, uid, data.body, json.dumps(mentions), t, t),
        )
        cid = int(cur.lastrowid)  # type: ignore[arg-type]
        record_change(conn, "task_comment", cid, "create", uid, t)
        row = conn.execute("SELECT * FROM task_comments WHERE id = ?", (cid,)).fetchone()
        audit_events.comment_created(conn, ctx.user, row, t)
    return comment_to_dict(row)


@router.patch("/{id}/comments/{cid}")
async def update_comment(request: Request, id: str, cid: str):
    """只有作者本人可編輯（保留 edited_at）"""
    ctx = get_ctx(request)
    tid, comment_id = parse_id(id), parse_id(cid)
    data = await read_json(request, CommentUpdateInput)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        _task_or_404(conn, tid)
        row = _comment_or_404(conn, tid, comment_id)
        if row["author_id"] != uid:
            raise denied()
        if row["deleted_at"] is not None:
            raise conflict("這則訊息已刪除，無法編輯")
        t = ctx.now()
        if data.body != row["body"]:
            mentions = parse_mentions(conn, data.body)
            conn.execute(
                "UPDATE task_comments SET body = ?, mentions = ?, edited_at = ?, updated_at = ? WHERE id = ?",
                (data.body, json.dumps(mentions), t, t, comment_id),
            )
            record_change(conn, "task_comment", comment_id, "update", uid, t)
            before = row
            row = conn.execute("SELECT * FROM task_comments WHERE id = ?", (comment_id,)).fetchone()
            audit_events.comment_edited(conn, ctx.user, before, row, t)
        row = conn.execute("SELECT * FROM task_comments WHERE id = ?", (comment_id,)).fetchone()
    return comment_to_dict(row)


@router.delete("/{id}/comments/{cid}")
async def delete_comment(request: Request, id: str, cid: str):
    """作者本人或具 comments.moderate 者可刪除（軟刪除，保留討論串結構）"""
    ctx = get_ctx(request)
    tid, comment_id = parse_id(id), parse_id(cid)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        _task_or_404(conn, tid)
        row = _comment_or_404(conn, tid, comment_id)
        if row["author_id"] != uid and not can(ctx.user, "comments.moderate", ctx.db):
            raise denied()
        if row["deleted_at"] is None:
            t = ctx.now()
            conn.execute(
                "UPDATE task_comments SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?",
                (t, uid, t, comment_id),
            )
            record_change(conn, "task_comment", comment_id, "delete", uid, t)
            audit_events.comment_deleted(conn, ctx.user, row, t)
        row = conn.execute("SELECT * FROM task_comments WHERE id = ?", (comment_id,)).fetchone()
    return comment_to_dict(row)


def _set_resolved(request: Request, id: str, root_id: str, resolved: bool) -> dict[str, Any]:
    ctx = get_ctx(request)
    tid, rid = parse_id(id), parse_id(root_id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        task = _task_or_404(conn, tid)
        row = _comment_or_404(conn, tid, rid)
        if row["parent_id"] is not None:
            raise bad_request("只有討論串的第一則訊息可以標記已解決")
        allowed = row["author_id"] == uid or task["assignee_id"] == uid or can(ctx.user, "comments.moderate", ctx.db)
        if not allowed:
            raise denied()
        if (row["thread_resolved_at"] is not None) != resolved:
            t = ctx.now()
            conn.execute(
                "UPDATE task_comments SET thread_resolved_at = ?, thread_resolved_by = ?, updated_at = ? WHERE id = ?",
                (t if resolved else None, uid if resolved else None, t, rid),
            )
            record_change(conn, "task_comment", rid, "update", uid, t)
            audit_events.comment_resolved(conn, ctx.user, row, resolved, t)
        row = conn.execute("SELECT * FROM task_comments WHERE id = ?", (rid,)).fetchone()
    return comment_to_dict(row)


@router.post("/{id}/comments/{root_id}/resolve")
async def resolve_thread(request: Request, id: str, root_id: str):
    """作者、任務負責人或具 comments.moderate 者可標記"""
    return _set_resolved(request, id, root_id, True)


@router.post("/{id}/comments/{root_id}/unresolve")
async def unresolve_thread(request: Request, id: str, root_id: str):
    return _set_resolved(request, id, root_id, False)


@router.post("/{id}/comments/read")
async def mark_read(request: Request, id: str):
    """把自己在此任務的已讀位置更新到最新一則留言（只影響自己，不記錄變更流水）"""
    ctx = get_ctx(request)
    tid = parse_id(id)
    uid = ctx.user["id"]
    with ctx.db.tx() as conn:
        _task_or_404(conn, tid)
        last = conn.execute("SELECT max(id) FROM task_comments WHERE task_id = ?", (tid,)).fetchone()[0]
        t = ctx.now()
        conn.execute(
            "INSERT INTO task_comment_reads (user_id, task_id, last_read_comment_id, last_read_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (user_id, task_id) DO UPDATE SET "
            "last_read_comment_id = max(coalesce(last_read_comment_id, 0), coalesce(excluded.last_read_comment_id, 0)), "
            "last_read_at = excluded.last_read_at",
            (uid, tid, last, t),
        )
    return {"lastReadCommentId": last}

