"""任務依賴（阻擋關係）API 與延遲鏈（docs/design/delay-link.md）。

- GET    /api/tasks/delay-chains                     依賴圖的連通元件（鏈）＋延後推算
- GET    /api/tasks/{id}/dependencies                {blockedBy, blocks, self}
- POST   /api/tasks/{id}/dependencies                {direction, targetId, lagDays?, note?}（冪等；成環 409）
- PATCH  /api/tasks/{id}/dependencies/{depId}        {lagDays?, note?}
- DELETE /api/tasks/{id}/dependencies/{depId}

寫入需 tasks.edit（由 permissions.WRITE_GUARDS 的 /api/tasks 規則涵蓋），讀取登入即可。
寫入時兩端任務各記一筆 task update（SSE 讓看板與他人畫面即時更新），並更新兩端的 updated_at。
此 router 須在 tasks.router 之前掛載（/delay-chains 不可被 /{id} 攔截）。
"""

from __future__ import annotations

import re
import sqlite3
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import Field, StringConstraints

from .. import audit_events
from ..changes import record_change
from ..context import get_ctx
from ..db import Database
from ..dependency_calc import (
    Edge,
    Projection,
    TaskInfo,
    active_edges,
    components,
    compute_projections,
    critical_path,
    find_cycle,
    layer_depths,
    today_local,
)
from ..errors import HttpError, bad_request, not_found, validation_error
from ..schemas import DbId, _Input
from ..validate import parse_id, present, read_json

router = APIRouter()

MAX_LAG_DAYS = 365
LagDays = Annotated[int, Field(ge=0, le=MAX_LAG_DAYS)]
Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


class DependencyCreateInput(_Input):
    direction: Literal["blocked_by", "blocks"]
    targetId: DbId
    lagDays: LagDays = None  # type: ignore[assignment]
    note: Note = None  # type: ignore[assignment]


class DependencyUpdateInput(_Input):
    lagDays: LagDays = None  # type: ignore[assignment]
    note: Note = None  # type: ignore[assignment]


# ── 資料載入 ──────────────────────────────────────────────

_TASK_COLS = (
    "t.id, t.title, t.status_id, t.assignee_id, t.project_id, t.start_date, t.due_date, t.deleted_at, "
    "s.category AS category"
)
_INVOLVED = "SELECT blocker_task_id FROM task_dependencies UNION SELECT blocked_task_id FROM task_dependencies"


def _info(r: sqlite3.Row) -> TaskInfo:
    return TaskInfo(
        id=r["id"],
        start_date=r["start_date"],
        due_date=r["due_date"],
        is_done=r["category"] == "done",
        is_deleted=r["deleted_at"] is not None,
    )


def load_graph(conn: sqlite3.Connection) -> tuple[dict[int, sqlite3.Row], list[sqlite3.Row]]:
    """依賴邊與所有出現在邊上的任務（含已完成 / 軟刪除；兩次查詢，不產生 N+1）"""
    deps = conn.execute("SELECT * FROM task_dependencies ORDER BY id").fetchall()
    if not deps:
        return {}, []
    rows = conn.execute(
        f"SELECT {_TASK_COLS} FROM tasks t JOIN statuses s ON s.id = t.status_id WHERE t.id IN ({_INVOLVED})"
    ).fetchall()
    return {r["id"]: r for r in rows}, deps


def _edges(deps: list[sqlite3.Row]) -> list[Edge]:
    return [Edge(d["blocker_task_id"], d["blocked_task_id"], d["lag_days"]) for d in deps]


def _project(conn: sqlite3.Connection, today: str) -> tuple[dict[int, sqlite3.Row], list[sqlite3.Row], dict[int, Projection]]:
    tasks, deps = load_graph(conn)
    infos = {i: _info(r) for i, r in tasks.items()}
    return tasks, deps, compute_projections(infos, _edges(deps), today)


EMPTY_FIELDS: dict[str, Any] = {
    "isBlocked": False,
    "blockedByCount": 0,
    "blocksCount": 0,
    "delayDays": None,
    "projectedEnd": None,
}


def attach_dependency_fields(db: Database, items: list[dict[str, Any]], now_ms: int) -> list[dict[str, Any]]:
    """GET /api/tasks 用：一次批次推算後把依賴欄位加到每筆任務（不改既有欄位）"""
    with db.lock:
        return attach_dependency_fields_conn(db.conn, items, now_ms)


def attach_dependency_fields_conn(
    conn: sqlite3.Connection, items: list[dict[str, Any]], now_ms: int
) -> list[dict[str, Any]]:
    """同 attach_dependency_fields，但使用呼叫端已持有的連線（可在 transaction 內呼叫，如單筆任務回應）"""
    _tasks, _deps, proj = _project(conn, today_local(now_ms))
    for item in items:
        p = proj.get(item["id"])
        if p is None:
            item.update(EMPTY_FIELDS)
        else:
            item.update(
                {
                    "isBlocked": p.is_blocked,
                    "blockedByCount": p.blocked_by_count,
                    "blocksCount": p.blocks_count,
                    "delayDays": p.delay_days,
                    "projectedEnd": p.projected_end,
                }
            )
    return items


# ── 共用 ─────────────────────────────────────────────────


def _task_row(conn: sqlite3.Connection, task_id: int) -> sqlite3.Row | None:
    return conn.execute(
        f"SELECT {_TASK_COLS} FROM tasks t JOIN statuses s ON s.id = t.status_id "
        "WHERE t.id = ? AND t.deleted_at IS NULL",
        (task_id,),
    ).fetchone()


def _brief(r: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": r["id"],
        "title": r["title"],
        "statusId": r["status_id"],
        "assigneeId": r["assignee_id"],
        "projectId": r["project_id"],
        "startDate": r["start_date"],
        "dueDate": r["due_date"],
        "isDone": r["category"] == "done",
    }


def _proj_api(proj: dict[int, Projection], task_id: int) -> dict[str, Any]:
    return (proj.get(task_id) or Projection()).as_api()


def _dep_item(dep: sqlite3.Row, other: sqlite3.Row, proj: dict[int, Projection]) -> dict[str, Any]:
    return {
        "id": dep["id"],
        "blockerId": dep["blocker_task_id"],
        "blockedId": dep["blocked_task_id"],
        "type": dep["type"],
        "lagDays": dep["lag_days"],
        "note": dep["note"],
        "createdBy": dep["created_by"],
        "createdAt": dep["created_at"],
        "updatedAt": dep["updated_at"],
        "task": _brief(other),
        "projection": _proj_api(proj, other["id"]),
    }


def _touch(conn: sqlite3.Connection, ids: list[int], actor: int, t: int) -> None:
    """兩端任務更新 updated_at 並各記一筆 task update（看板等畫面經 SSE 重抓）"""
    for tid in dict.fromkeys(ids):
        cur = conn.execute(
            "UPDATE tasks SET updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL", (t, actor, tid)
        )
        if cur.rowcount:
            record_change(conn, "task", tid, "update", actor, t)


def _find_dep(conn: sqlite3.Connection, task_id: int, dep_id: int) -> sqlite3.Row:
    dep = conn.execute(
        "SELECT * FROM task_dependencies WHERE id = ? AND (blocker_task_id = ? OR blocked_task_id = ?)",
        (dep_id, task_id, task_id),
    ).fetchone()
    if dep is None:
        raise not_found("此依賴關係不存在或已被移除")
    return dep


def _other_id(dep: sqlite3.Row, task_id: int) -> int:
    return dep["blocked_task_id"] if dep["blocker_task_id"] == task_id else dep["blocker_task_id"]


def _item_for(conn: sqlite3.Connection, dep: sqlite3.Row, task_id: int, today: str) -> dict[str, Any]:
    _tasks, _deps, proj = _project(conn, today)
    other = conn.execute(
        f"SELECT {_TASK_COLS} FROM tasks t JOIN statuses s ON s.id = t.status_id WHERE t.id = ?",
        (_other_id(dep, task_id),),
    ).fetchone()
    item = _dep_item(dep, other, proj)
    item["direction"] = "blocked_by" if dep["blocked_task_id"] == task_id else "blocks"
    item["self"] = _proj_api(proj, task_id)
    return item


def _cycle_error(conn: sqlite3.Connection, cycle: list[int]) -> HttpError:
    ids = tuple(dict.fromkeys(cycle))
    titles = {
        r["id"]: r["title"]
        for r in conn.execute(f"SELECT id, title FROM tasks WHERE id IN ({','.join('?' * len(ids))})", ids)
    }
    names = [f"「{titles.get(i, f'#{i}')}」" for i in cycle]
    return HttpError(
        409,
        "DEPENDENCY_CYCLE",
        f"無法建立：{' → '.join(names)} 會形成循環",
        {"cycle": [{"id": i, "title": titles.get(i, "")} for i in cycle]},
    )


# ── 延遲鏈 ───────────────────────────────────────────────

_ID_LIST = re.compile(r"^[0-9]+(,[0-9]+)*$")
_ASSIGNEE_LIST = re.compile(r"^([0-9]+|none)(,([0-9]+|none))*$")


def _query_issue(name: str, message: str) -> HttpError:
    return validation_error([{"path": [name], "message": message, "code": "invalid_string"}])


def _parse_filters(qp: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name in ("project", "status"):
        raw = qp.get(name)
        if raw is None or raw == "":
            continue
        if not _ID_LIST.fullmatch(raw):
            raise _query_issue(name, "格式須為逗號分隔的 id")
        out[name] = {int(x) for x in raw.split(",")}
    raw = qp.get("assignee")
    if raw:
        if not _ASSIGNEE_LIST.fullmatch(raw):
            raise _query_issue("assignee", "格式須為逗號分隔的 id 或 none")
        out["assignee"] = {None if p == "none" else int(p) for p in raw.split(",")}
    q = (qp.get("q") or "").strip()
    if len(q) > 200:
        raise _query_issue("q", "最多 200 字")
    if q:
        out["q"] = q.lower()
    return out


def _matches(r: sqlite3.Row, f: dict[str, Any]) -> bool:
    if "project" in f and r["project_id"] not in f["project"]:
        return False
    if "status" in f and r["status_id"] not in f["status"]:
        return False
    if "assignee" in f and r["assignee_id"] not in f["assignee"]:
        return False
    if "q" in f and f["q"] not in (r["title"] or "").lower():
        return False
    return True


def build_delay_chains(
    tasks: dict[int, sqlite3.Row],
    deps: list[sqlite3.Row],
    proj: dict[int, Projection],
    filters: dict[str, Any],
    include_done: bool,
) -> list[dict[str, Any]]:
    """連通元件 → 鏈（純資料轉換；任一節點符合篩選則整條鏈保留）"""
    infos = {i: _info(r) for i, r in tasks.items()}
    alive = [d for d in deps if not infos[d["blocker_task_id"]].is_deleted and not infos[d["blocked_task_id"]].is_deleted]
    all_edges = _edges(alive)
    act = active_edges(infos, all_edges)
    act_pairs = {(e.blocker, e.blocked) for e in act}
    visible = all_edges if include_done else act
    dep_by_pair = {(d["blocker_task_id"], d["blocked_task_id"]): d for d in alive}

    chains: list[dict[str, Any]] = []
    for comp in components(visible):
        if filters and not any(_matches(tasks[n], filters) for n in comp):
            continue
        comp_set = set(comp)
        comp_edges = [e for e in visible if e.blocker in comp_set]
        depth = layer_depths(comp, comp_edges)
        active_nodes = [n for n in comp if not infos[n].is_done]
        crit = critical_path(active_nodes, proj, depth)
        crit_set = set(crit)
        nodes = []
        for n in sorted(comp, key=lambda i: (depth[i], i)):
            r, p = tasks[n], proj.get(n) or Projection()
            nodes.append(
                {
                    **_brief(r),
                    "projectedStart": p.projected_start,
                    "projectedEnd": p.projected_end,
                    "delayDays": p.delay_days,
                    "isBlocked": p.is_blocked,
                    "unknownBlockerDate": p.unknown_blocker_date,
                    "depth": depth[n],
                    "blockerIds": sorted(e.blocker for e in comp_edges if e.blocked == n),
                    "criticalDelay": n in crit_set,
                }
            )
        edges = []
        for e in comp_edges:
            d = dep_by_pair[(e.blocker, e.blocked)]
            edges.append(
                {
                    "id": d["id"],
                    "from": e.blocker,
                    "to": e.blocked,
                    "lagDays": e.lag,
                    "note": d["note"],
                    "active": (e.blocker, e.blocked) in act_pairs,
                    "critical": _adjacent(crit, e.blocker, e.blocked),
                }
            )
        delays = [p.delay_days for n in active_nodes if (p := proj.get(n)) and p.delay_days is not None]
        ends = [p.projected_end for n in active_nodes if (p := proj.get(n)) and p.projected_end]
        start_nodes = [n for n in active_nodes if not any((b, n) in act_pairs for b in comp)]
        chains.append(
            {
                "id": comp[0],
                "nodes": nodes,
                "edges": edges,
                "summary": {
                    "nodeCount": len(comp),
                    "edgeCount": len(comp_edges),
                    "maxDelayDays": max(delays, default=0),
                    "finalProjectedEnd": max(ends, default=None),
                    "criticalPath": crit,
                    "startNodes": start_nodes,
                    "doneCount": len(comp) - len(active_nodes),
                },
            }
        )
    chains.sort(key=lambda c: (-c["summary"]["maxDelayDays"], -c["summary"]["nodeCount"], c["id"]))
    return chains


def _adjacent(path: list[int], a: int, b: int) -> bool:
    return any(path[i] == a and path[i + 1] == b for i in range(len(path) - 1))


@router.get("/delay-chains")
async def delay_chains(request: Request):
    ctx = get_ctx(request)
    qp = request.query_params
    filters = _parse_filters(qp)
    include_done = (qp.get("includeDone") or "").lower() in ("1", "true", "yes")
    today = today_local(ctx.now())
    with ctx.db.lock:
        tasks, deps, proj = _project(ctx.db.conn, today)
    chains = build_delay_chains(tasks, deps, proj, filters, include_done)
    return {"today": today, "chains": chains}


# ── 單一任務的依賴 ─────────────────────────────────────────


@router.get("/{id}/dependencies")
async def list_dependencies(request: Request, id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    today = today_local(ctx.now())
    with ctx.db.lock:
        conn = ctx.db.conn
        if _task_row(conn, tid) is None:
            raise not_found("此任務不存在或已被刪除")
        tasks, deps, proj = _project(conn, today)
    blocked_by, blocks = [], []
    for d in deps:
        if d["blocked_task_id"] == tid:
            other = tasks.get(d["blocker_task_id"])
            target = blocked_by
        elif d["blocker_task_id"] == tid:
            other = tasks.get(d["blocked_task_id"])
            target = blocks
        else:
            continue
        if other is None or other["deleted_at"] is not None:
            continue
        target.append(_dep_item(d, other, proj))
    return {"blockedBy": blocked_by, "blocks": blocks, "self": _proj_api(proj, tid)}


@router.post("/{id}/dependencies")
async def create_dependency(request: Request, id: str):
    ctx = get_ctx(request)
    tid = parse_id(id)
    data = await read_json(request, DependencyCreateInput)
    target = data.targetId
    if target == tid:
        raise bad_request("任務不能等待自己完成")
    blocker, blocked = (target, tid) if data.direction == "blocked_by" else (tid, target)
    actor = ctx.user["id"]
    today = today_local(ctx.now())
    with ctx.db.tx() as conn:
        if _task_row(conn, tid) is None:
            raise not_found("此任務不存在或已被刪除")
        if _task_row(conn, target) is None:
            raise not_found("要連結的任務不存在或已被刪除")
        existing = conn.execute(
            "SELECT * FROM task_dependencies WHERE blocker_task_id = ? AND blocked_task_id = ?", (blocker, blocked)
        ).fetchone()
        if existing is not None:
            return _item_for(conn, existing, tid, today)
        pairs = [(r[0], r[1]) for r in conn.execute("SELECT blocker_task_id, blocked_task_id FROM task_dependencies")]
        cycle = find_cycle(pairs, blocker, blocked)
        if cycle is not None:
            raise _cycle_error(conn, cycle)
        t = ctx.now()
        cur = conn.execute(
            "INSERT INTO task_dependencies (blocker_task_id, blocked_task_id, type, lag_days, note, created_by, "
            "created_at, updated_at) VALUES (?, ?, 'finish_to_start', ?, ?, ?, ?, ?)",
            (blocker, blocked, data.lagDays or 0, data.note or "", actor, t, t),
        )
        _touch(conn, [blocker, blocked], actor, t)
        dep = conn.execute("SELECT * FROM task_dependencies WHERE id = ?", (cur.lastrowid,)).fetchone()
        audit_events.link_created(conn, ctx.user, "dependency", dep, t, task_id=tid)
        item = _item_for(conn, dep, tid, today)
    return JSONResponse(item, status_code=201)


@router.patch("/{id}/dependencies/{dep_id}")
async def update_dependency(request: Request, id: str, dep_id: str):
    ctx = get_ctx(request)
    tid, did = parse_id(id), parse_id(dep_id)
    fields = present(await read_json(request, DependencyUpdateInput))
    actor = ctx.user["id"]
    today = today_local(ctx.now())
    with ctx.db.tx() as conn:
        if _task_row(conn, tid) is None:
            raise not_found("此任務不存在或已被刪除")
        dep = _find_dep(conn, tid, did)
        sets: dict[str, Any] = {}
        if fields.get("lagDays") is not None:
            sets["lag_days"] = fields["lagDays"]
        if fields.get("note") is not None:
            sets["note"] = fields["note"]
        if sets:
            t = ctx.now()
            sets["updated_at"] = t
            conn.execute(
                f"UPDATE task_dependencies SET {', '.join(f'{c} = ?' for c in sets)} WHERE id = ?",
                (*sets.values(), did),
            )
            _touch(conn, [dep["blocker_task_id"], dep["blocked_task_id"]], actor, t)
            dep = conn.execute("SELECT * FROM task_dependencies WHERE id = ?", (did,)).fetchone()
        return _item_for(conn, dep, tid, today)


@router.delete("/{id}/dependencies/{dep_id}")
async def delete_dependency(request: Request, id: str, dep_id: str):
    ctx = get_ctx(request)
    tid, did = parse_id(id), parse_id(dep_id)
    actor = ctx.user["id"]
    with ctx.db.tx() as conn:
        if _task_row(conn, tid) is None:
            raise not_found("此任務不存在或已被刪除")
        dep = _find_dep(conn, tid, did)
        conn.execute("DELETE FROM task_dependencies WHERE id = ?", (did,))
        t = ctx.now()
        _touch(conn, [dep["blocker_task_id"], dep["blocked_task_id"]], actor, t)
        audit_events.link_deleted(conn, ctx.user, "dependency", dep, t, task_id=tid)
    # 回傳足以「復原」的內容（前端撤銷時以 POST 重新建立）
    return {
        "ok": True,
        "removed": {
            "direction": "blocked_by" if dep["blocked_task_id"] == tid else "blocks",
            "targetId": _other_id(dep, tid),
            "lagDays": dep["lag_days"],
            "note": dep["note"],
        },
    }
