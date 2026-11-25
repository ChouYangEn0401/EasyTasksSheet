/**
 * 延遲鏈的分層排版（純函式，不依賴 React / DOM；docs/design/delay-link.md §版面）。
 * - 分層：以 depth（最長前置路徑長度）分欄，由左到右
 * - 同層排序：最長延遲路徑上的任務排最上面（讓主線成一直線），其餘依前置任務的平均列位（重心法，向下再向上各掃一次）
 * - 箭頭：相鄰欄以 S 形曲線連接；跨欄的邊改走「列與列之間的空白通道」折線，避免穿過中間欄的節點
 */

export type LayoutNodeInput = { id: number; depth: number; criticalDelay?: boolean };
export type LayoutEdgeInput = {
  from: number;
  to: number;
  lagDays?: number;
  critical?: boolean;
  active?: boolean;
};

export type LayoutOptions = {
  nodeWidth: number;
  nodeHeight: number;
  colGap: number;
  rowGap: number;
  padding: number;
};

export const DEFAULT_LAYOUT: LayoutOptions = {
  nodeWidth: 232,
  nodeHeight: 112,
  colGap: 72,
  rowGap: 20,
  padding: 16,
};

export type PlacedNode = { id: number; col: number; row: number; x: number; y: number };
export type PlacedEdge = {
  from: number;
  to: number;
  path: string;
  /** lag 標籤位置 */
  labelX: number;
  labelY: number;
  lagDays: number;
  critical: boolean;
  active: boolean;
  /** 是否繞行通道（跨欄） */
  routed: boolean;
};

export type ChainLayout = {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
  columns: number[][];
  byId: Map<number, PlacedNode>;
};

/** 依 depth 分欄，並決定同欄順序 */
export function orderColumns(nodes: LayoutNodeInput[], edges: LayoutEdgeInput[]): number[][] {
  const maxDepth = Math.max(0, ...nodes.map((n) => n.depth));
  const cols: number[][] = Array.from({ length: maxDepth + 1 }, () => []);
  const critical = new Set(nodes.filter((n) => n.criticalDelay).map((n) => n.id));
  for (const n of [...nodes].sort((a, b) => a.id - b.id)) cols[n.depth]!.push(n.id);
  const preds = new Map<number, number[]>();
  const succs = new Map<number, number[]>();
  for (const e of edges) {
    (preds.get(e.to) ?? preds.set(e.to, []).get(e.to)!).push(e.from);
    (succs.get(e.from) ?? succs.set(e.from, []).get(e.from)!).push(e.to);
  }
  const rowOf = new Map<number, number>();
  const index = () => cols.forEach((c) => c.forEach((id, i) => rowOf.set(id, i)));
  index();
  const sortCol = (col: number[], neighbors: Map<number, number[]>) => {
    const bary = (id: number) => {
      const ns = (neighbors.get(id) ?? []).filter((n) => rowOf.has(n));
      return ns.length ? ns.reduce((s, n) => s + rowOf.get(n)!, 0) / ns.length : rowOf.get(id)!;
    };
    const keyed = col.map((id) => ({ id, crit: critical.has(id) ? 0 : 1, b: bary(id) }));
    keyed.sort((a, b) => a.crit - b.crit || a.b - b.b || a.id - b.id);
    col.splice(0, col.length, ...keyed.map((k) => k.id));
    col.forEach((id, i) => rowOf.set(id, i));
  };
  // 第 0 欄：主線優先，其餘依後繼的位置
  for (let i = 1; i < cols.length; i++) sortCol(cols[i]!, preds);
  for (let i = cols.length - 2; i >= 0; i--) sortCol(cols[i]!, succs);
  for (let i = 1; i < cols.length; i++) sortCol(cols[i]!, preds);
  index();
  return cols;
}

/** 完整排版：節點座標、箭頭路徑與畫布大小 */
export function layoutChain(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  opts: LayoutOptions = DEFAULT_LAYOUT,
): ChainLayout {
  const { nodeWidth: w, nodeHeight: h, colGap, rowGap, padding } = opts;
  const columns = orderColumns(nodes, edges);
  const placed: PlacedNode[] = [];
  const byId = new Map<number, PlacedNode>();
  columns.forEach((col, c) =>
    col.forEach((id, r) => {
      const p = { id, col: c, row: r, x: padding + c * (w + colGap), y: padding + r * (h + rowGap) };
      placed.push(p);
      byId.set(id, p);
    }),
  );
  const rows = Math.max(1, ...columns.map((c) => c.length));
  const width = padding * 2 + columns.length * w + Math.max(0, columns.length - 1) * colGap;
  const height = padding * 2 + rows * h + (rows - 1) * rowGap;

  // 跨欄邊的通道：列與列之間（含最上方 padding 區）的 y；同一通道上的多條邊稍微錯開
  const laneUse = new Map<number, number>();
  const laneYs = Array.from({ length: rows + 1 }, (_, i) =>
    i === 0 ? padding / 2 : padding + i * (h + rowGap) - rowGap / 2,
  );

  const placedEdges: PlacedEdge[] = [];
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const sx = a.x + w;
    const sy = a.y + h / 2;
    const tx = b.x;
    const ty = b.y + h / 2;
    const base = {
      from: e.from,
      to: e.to,
      lagDays: e.lagDays ?? 0,
      critical: !!e.critical,
      active: e.active !== false,
    };
    if (b.col - a.col <= 1) {
      const dx = Math.max(24, (tx - sx) / 2);
      placedEdges.push({
        ...base,
        path: `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`,
        labelX: (sx + tx) / 2,
        labelY: (sy + ty) / 2,
        routed: false,
      });
      continue;
    }
    // 選最接近兩端中點的通道
    const mid = (sy + ty) / 2;
    let lane = 0;
    laneYs.forEach((y, i) => {
      if (Math.abs(y - mid) < Math.abs(laneYs[lane]! - mid)) lane = i;
    });
    const used = laneUse.get(lane) ?? 0;
    laneUse.set(lane, used + 1);
    const ly = laneYs[lane]! + ((used % 3) - (used % 3 === 2 ? 3 : 0)) * 4;
    const gx1 = sx + colGap / 2;
    const gx2 = tx - colGap / 2;
    placedEdges.push({
      ...base,
      path: roundedPolyline([
        [sx, sy],
        [gx1, sy],
        [gx1, ly],
        [gx2, ly],
        [gx2, ty],
        [tx, ty],
      ]),
      labelX: (gx1 + gx2) / 2,
      labelY: ly,
      routed: true,
    });
  }
  return { nodes: placed, edges: placedEdges, width, height, columns, byId };
}

/** 折線轉為帶小圓角的 SVG path */
export function roundedPolyline(points: [number, number][], radius = 8): string {
  if (points.length < 2) return '';
  const [x0, y0] = points[0]!;
  let d = `M ${x0} ${y0}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]!;
    const [cx, cy] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    const r1 = Math.min(radius, Math.hypot(cx - px, cy - py) / 2);
    const r2 = Math.min(radius, Math.hypot(nx - cx, ny - cy) / 2);
    const r = Math.min(r1, r2);
    if (r === 0) {
      d += ` L ${cx} ${cy}`;
      continue;
    }
    const ux = Math.sign(cx - px);
    const uy = Math.sign(cy - py);
    const vx = Math.sign(nx - cx);
    const vy = Math.sign(ny - cy);
    d += ` L ${cx - ux * r} ${cy - uy * r} Q ${cx} ${cy} ${cx + vx * r} ${cy + vy * r}`;
  }
  const [lx, ly] = points[points.length - 1]!;
  return `${d} L ${lx} ${ly}`;
}

/** 某節點的所有上游（前置，遞移）與下游（後續，遞移） */
export function relatives(id: number, edges: LayoutEdgeInput[]): { up: Set<number>; down: Set<number> } {
  const walk = (start: number, next: (n: number) => number[]) => {
    const seen = new Set<number>();
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      for (const m of next(n)) {
        if (!seen.has(m)) {
          seen.add(m);
          stack.push(m);
        }
      }
    }
    return seen;
  };
  return {
    up: walk(id, (n) => edges.filter((e) => e.to === n).map((e) => e.from)),
    down: walk(id, (n) => edges.filter((e) => e.from === n).map((e) => e.to)),
  };
}

export type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * 鍵盤導覽：← / → 沿箭頭走到前置 / 後續任務（多個時取列位最接近者），↑ / ↓ 同欄上下，Home / End 第一 / 最後一個。
 * 無可移動目標時回傳 null。
 */
export function navTarget(
  layout: ChainLayout,
  edges: LayoutEdgeInput[],
  id: number,
  key: NavKey,
): number | null {
  const cur = layout.byId.get(id);
  if (!cur) return null;
  const closest = (ids: number[]) => {
    const cands = ids.map((i) => layout.byId.get(i)).filter((p): p is PlacedNode => !!p);
    if (!cands.length) return null;
    cands.sort((a, b) => Math.abs(a.row - cur.row) - Math.abs(b.row - cur.row) || a.row - b.row);
    return cands[0]!.id;
  };
  switch (key) {
    case 'ArrowRight':
      return closest(edges.filter((e) => e.from === id).map((e) => e.to));
    case 'ArrowLeft':
      return closest(edges.filter((e) => e.to === id).map((e) => e.from));
    case 'ArrowUp':
      return layout.columns[cur.col]![cur.row - 1] ?? null;
    case 'ArrowDown':
      return layout.columns[cur.col]![cur.row + 1] ?? null;
    case 'Home':
      return layout.columns[0]![0] ?? null;
    case 'End': {
      const last = layout.columns[layout.columns.length - 1]!;
      return last[last.length - 1] ?? null;
    }
  }
}

/** 窄螢幕（≤768px）由上而下堆疊：依欄、再依欄內順序；indent = 層數 */
export function stackedOrder(layout: ChainLayout): { id: number; indent: number }[] {
  return layout.columns.flatMap((col, c) => col.map((id) => ({ id, indent: c })));
}
