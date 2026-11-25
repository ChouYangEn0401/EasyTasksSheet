"""任務依賴（阻擋關係）的純函式：循環偵測、延遲推算、連通元件（延遲鏈）。

不碰資料庫與時鐘：呼叫端傳入任務、依賴邊與「今天」（台北時區的 YYYY-MM-DD，見 today_taipei()）。
規格見 docs/design/delay-link.md。

名詞：
- 前置任務（blocker）：需先完成；被擋住的任務（blocked）：等待前置任務完成。
- 有效邊（active edge）：兩端任務皆未完成且未刪除。已完成 / 軟刪除的任務不再擋人。

延遲推算（只看有效邊，依拓撲序沿鏈傳遞）：
- 未被擋住的任務：預計完成 = max(到期日（無則開始日）, 今天)；兩者皆無 → 無法推算（None）。
- 被擋住的任務：bound = max(前置預計完成 + 1 + lag)；
  預計開始 = max(開始日, bound)（無開始日則為 bound）；
  有開始與到期 → 預計完成 = 預計開始 + 原持續天數；只有到期 → max(到期, bound)；
  否則預計完成 = 預計開始。
  任一前置無法推算 → unknownBlockerDate=True，本身也無法推算（不顯示延後天數）。
- delayDays = max(0, 預計完成 − 原到期日)；無到期日或無法推算 → None。
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

TAIPEI = timezone(timedelta(hours=8))


def today_taipei(now_ms: int) -> str:
    """unix ms → 台北時區的日期字串（台灣無日光節約，固定 +08:00）"""
    return datetime.fromtimestamp(now_ms / 1000, TAIPEI).date().isoformat()


def _d(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def _s(d: date | None) -> str | None:
    return d.isoformat() if d else None


@dataclass(frozen=True)
class TaskInfo:
    id: int
    start_date: str | None = None
    due_date: str | None = None
    is_done: bool = False
    is_deleted: bool = False


@dataclass(frozen=True)
class Edge:
    blocker: int
    blocked: int
    lag: int = 0


@dataclass
class Projection:
    is_blocked: bool = False
    blocked_by_count: int = 0
    blocks_count: int = 0
    projected_start: str | None = None
    projected_end: str | None = None
    delay_days: int | None = None
    unknown_blocker_date: bool = False
    #: 決定本任務預計開始日的前置任務（bound 最大者；推算臨界路徑用）
    driver: int | None = None
    blocker_ids: list[int] = field(default_factory=list)

    def as_api(self) -> dict[str, Any]:
        return {
            "isBlocked": self.is_blocked,
            "blockedByCount": self.blocked_by_count,
            "blocksCount": self.blocks_count,
            "projectedStart": self.projected_start,
            "projectedEnd": self.projected_end,
            "delayDays": self.delay_days,
            "unknownBlockerDate": self.unknown_blocker_date,
        }


def _is_active(t: TaskInfo | None) -> bool:
    return t is not None and not t.is_done and not t.is_deleted


def active_edges(tasks: dict[int, TaskInfo], edges: Iterable[Edge]) -> list[Edge]:
    return [e for e in edges if _is_active(tasks.get(e.blocker)) and _is_active(tasks.get(e.blocked))]


# ── 循環偵測 ──────────────────────────────────────────────


def find_cycle(edges: Iterable[tuple[int, int]], blocker: int, blocked: int) -> list[int] | None:
    """若新增 blocker → blocked 會形成循環，回傳環上的任務 id（首尾相同，如 [A, B, C, A]）；否則 None。

    等同於檢查既有邊中是否存在 blocked ⇝ blocker 的路徑（迭代 DFS，避免深鏈遞迴過深）。"""
    if blocker == blocked:
        return [blocker, blocker]
    out: dict[int, list[int]] = defaultdict(list)
    for a, b in edges:
        out[a].append(b)
    parent: dict[int, int | None] = {blocked: None}
    stack = [blocked]
    while stack:
        node = stack.pop()
        if node == blocker:
            path = [node]
            while parent[path[-1]] is not None:
                path.append(parent[path[-1]])  # type: ignore[arg-type]
            path.reverse()  # blocked … blocker
            return [blocker, *path]
        for nxt in out.get(node, ()):
            if nxt not in parent:
                parent[nxt] = node
                stack.append(nxt)
    return None


# ── 延遲推算 ──────────────────────────────────────────────


def topo_order(nodes: Iterable[int], edges: Iterable[Edge]) -> list[int]:
    """Kahn 拓撲排序；在環上的節點（理論上不應存在）不會出現在結果中"""
    nodes = list(dict.fromkeys(nodes))
    node_set = set(nodes)
    indeg = {n: 0 for n in nodes}
    out: dict[int, list[int]] = defaultdict(list)
    for e in edges:
        if e.blocker in node_set and e.blocked in node_set:
            out[e.blocker].append(e.blocked)
            indeg[e.blocked] += 1
    q = deque(n for n in nodes if indeg[n] == 0)
    order: list[int] = []
    while q:
        n = q.popleft()
        order.append(n)
        for m in out[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                q.append(m)
    return order


def compute_projections(tasks: dict[int, TaskInfo], edges: Iterable[Edge], today: str) -> dict[int, Projection]:
    """對所有出現在依賴邊上的任務推算延後資訊（不在任何邊上的任務不回傳）"""
    edges = list(edges)
    today_d = date.fromisoformat(today)
    involved = {e.blocker for e in edges} | {e.blocked for e in edges}
    result: dict[int, Projection] = {i: Projection() for i in involved if i in tasks}
    act = active_edges(tasks, edges)
    incoming: dict[int, list[Edge]] = defaultdict(list)
    for e in act:
        incoming[e.blocked].append(e)
        result[e.blocker].blocks_count += 1
    for i, p in result.items():
        p.blocker_ids = sorted({e.blocker for e in incoming.get(i, [])})
        p.blocked_by_count = len(p.blocker_ids)
        p.is_blocked = p.blocked_by_count > 0

    ends: dict[int, date | None] = {}
    active_nodes = [i for i in result if _is_active(tasks[i])]
    ordered = topo_order(active_nodes, act)
    in_order = set(ordered)
    for i in ordered:
        t, p = tasks[i], result[i]
        start, due = _d(t.start_date), _d(t.due_date)
        ins = incoming.get(i, [])
        if not ins:
            base = due or start
            end = max(base, today_d) if base else None
            p.projected_start = _s(start)
        else:
            bound: date | None = None
            unknown = False
            for e in ins:
                be = ends.get(e.blocker)
                if be is None:
                    unknown = True
                    continue
                cand = be + timedelta(days=1 + max(0, e.lag))
                if bound is None or cand > bound or (cand == bound and p.driver is not None and e.blocker < p.driver):
                    bound = cand
                    p.driver = e.blocker
            if unknown or bound is None:
                p.unknown_blocker_date = True
                ends[i] = None
                continue
            pstart = max(start, bound) if start else bound
            if start and due:
                end = pstart + (due - start)
            elif due:
                end = max(due, bound)
            else:
                end = pstart
            p.projected_start = _s(pstart)
        ends[i] = end
        p.projected_end = _s(end)
        if end is not None and due is not None:
            p.delay_days = max(0, (end - due).days)
    # 在環上（資料異常）的節點：視為無法推算
    for i in active_nodes:
        if i not in in_order:
            result[i].unknown_blocker_date = True
    return result


# ── 連通元件（延遲鏈） ─────────────────────────────────────


def components(edges: Iterable[Edge]) -> list[list[int]]:
    """弱連通元件（union-find）；每個元件內 id 由小到大，元件依最小 id 排序"""
    parent: dict[int, int] = {}

    def find(x: int) -> int:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for e in edges:
        ra, rb = find(e.blocker), find(e.blocked)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    groups: dict[int, list[int]] = defaultdict(list)
    for n in list(parent):
        groups[find(n)].append(n)
    return sorted((sorted(g) for g in groups.values()), key=lambda g: g[0])


def layer_depths(nodes: Iterable[int], edges: Iterable[Edge]) -> dict[int, int]:
    """層數：沒有前置者為 0，其餘為最長前置路徑長度（拓撲序）。環上節點（異常）放在最深層之後。"""
    nodes = list(nodes)
    edges = [e for e in edges]
    depth = {n: 0 for n in nodes}
    order = topo_order(nodes, edges)
    incoming: dict[int, list[int]] = defaultdict(list)
    node_set = set(nodes)
    for e in edges:
        if e.blocker in node_set and e.blocked in node_set:
            incoming[e.blocked].append(e.blocker)
    for n in order:
        if incoming[n]:
            depth[n] = max(depth[b] + 1 for b in incoming[n])
    leftover = [n for n in nodes if n not in set(order)]
    if leftover:
        top = max(depth.values(), default=0) + 1
        for n in leftover:
            depth[n] = top
    return depth


def critical_path(nodes: list[int], proj: dict[int, Projection], depth: dict[int, int]) -> list[int]:
    """最長延遲路徑：從預計最晚完成（同日比延後天數、再比層數）的任務，沿「決定開始日的前置任務」回溯。
    nodes 只放未完成的任務。回傳由起點到終點的 id。沒有可推算日期時，取最深層的節點回溯。"""
    cands = [n for n in nodes if n in proj]
    if not cands:
        return []

    def key(n: int) -> tuple[Any, ...]:
        p = proj[n]
        return (p.projected_end or "", p.delay_days or 0, depth.get(n, 0), -n)

    end = max(cands, key=key)
    path = [end]
    seen = {end}
    cur = proj[end]
    while True:
        nxt = cur.driver
        if nxt is None:
            # 無法推算（unknown）時改沿最深的前置任務回溯
            blockers = [b for b in cur.blocker_ids if b in proj and b not in seen]
            nxt = max(blockers, key=lambda b: (depth.get(b, 0), -b)) if blockers else None
        if nxt is None or nxt in seen or nxt not in proj:
            break
        path.append(nxt)
        seen.add(nxt)
        cur = proj[nxt]
    path.reverse()
    return path
