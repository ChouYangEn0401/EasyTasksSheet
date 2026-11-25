import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  layoutChain,
  navTarget,
  orderColumns,
  relatives,
  roundedPolyline,
  stackedOrder,
} from './delayLinkLayout.ts';
import {
  blockedBadgeText,
  blockedTooltip,
  chainCaption,
  chainsSummary,
  delayPhrase,
  nodeBadge,
  shortDate,
} from './depText.ts';

// A(1) → B(2) → D(4)，A → C(3) → D，A → D（跨欄）
const nodes = [
  { id: 1, depth: 0, criticalDelay: true },
  { id: 2, depth: 1 },
  { id: 3, depth: 1, criticalDelay: true },
  { id: 4, depth: 2, criticalDelay: true },
];
const edges = [
  { from: 1, to: 2 },
  { from: 1, to: 3, critical: true },
  { from: 2, to: 4, lagDays: 2 },
  { from: 3, to: 4, critical: true },
  { from: 1, to: 4 },
];

describe('orderColumns', () => {
  it('依 depth 分欄，主線排最上面', () => {
    expect(orderColumns(nodes, edges)).toEqual([[1], [3, 2], [4]]);
  });

  it('非主線依前置任務的列位（重心）排序', () => {
    const cols = orderColumns(
      [
        { id: 10, depth: 0 },
        { id: 11, depth: 0 },
        { id: 20, depth: 1 },
        { id: 21, depth: 1 },
      ],
      [
        { from: 11, to: 20 },
        { from: 10, to: 21 },
      ],
    );
    expect(cols[0]).toEqual([10, 11]);
    expect(cols[1]).toEqual([21, 20]);
  });
});

describe('layoutChain', () => {
  const lay = layoutChain(nodes, edges);
  const { nodeWidth: w, nodeHeight: h, colGap, rowGap, padding } = DEFAULT_LAYOUT;

  it('節點座標與畫布大小', () => {
    expect(lay.byId.get(1)).toMatchObject({ col: 0, row: 0, x: padding, y: padding });
    expect(lay.byId.get(2)).toMatchObject({
      col: 1,
      row: 1,
      x: padding + w + colGap,
      y: padding + h + rowGap,
    });
    expect(lay.width).toBe(padding * 2 + 3 * w + 2 * colGap);
    expect(lay.height).toBe(padding * 2 + 2 * h + rowGap);
  });

  it('相鄰欄為曲線，起訖點在節點左右邊的中央', () => {
    const e = lay.edges.find((x) => x.from === 1 && x.to === 3)!;
    expect(e.routed).toBe(false);
    expect(e.critical).toBe(true);
    expect(e.path.startsWith(`M ${padding + w} ${padding + h / 2} C`)).toBe(true);
    expect(e.path.endsWith(`${padding + w + colGap} ${padding + h / 2}`)).toBe(true);
    const lagEdge = lay.edges.find((x) => x.from === 2 && x.to === 4)!;
    expect(lagEdge.lagDays).toBe(2);
  });

  it('跨欄的邊走列間通道，不穿過中間欄的節點', () => {
    const e = lay.edges.find((x) => x.from === 1 && x.to === 4)!;
    expect(e.routed).toBe(true);
    // 通道 y 不落在任何節點的垂直範圍內
    for (const n of lay.nodes) {
      const inside = e.labelY > n.y && e.labelY < n.y + h;
      const overlapsX = e.labelX > n.x && e.labelX < n.x + w;
      expect(inside && overlapsX).toBe(false);
    }
  });

  it('沒有邊的單一節點也能排版', () => {
    const single = layoutChain([{ id: 9, depth: 0 }], []);
    expect(single.nodes).toHaveLength(1);
    expect(single.edges).toHaveLength(0);
  });

  it('大鏈（60 個節點）排版不重疊', () => {
    const big = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, depth: Math.floor(i / 6) }));
    const bigEdges = big.filter((n) => n.depth > 0).map((n) => ({ from: n.id - 6, to: n.id }));
    const l = layoutChain(big, bigEdges);
    const seen = new Set(l.nodes.map((n) => `${n.x},${n.y}`));
    expect(seen.size).toBe(60);
    expect(l.columns).toHaveLength(10);
  });
});

describe('導覽與上下游', () => {
  const lay = layoutChain(nodes, edges);
  it('relatives', () => {
    const r = relatives(3, edges);
    expect([...r.up]).toEqual([1]);
    expect([...r.down]).toEqual([4]);
    expect([...relatives(4, edges).up].sort()).toEqual([1, 2, 3]);
  });
  it('方向鍵沿箭頭移動', () => {
    expect(navTarget(lay, edges, 1, 'ArrowRight')).toBe(3);
    expect(navTarget(lay, edges, 3, 'ArrowDown')).toBe(2);
    expect(navTarget(lay, edges, 2, 'ArrowUp')).toBe(3);
    expect(navTarget(lay, edges, 2, 'ArrowRight')).toBe(4);
    expect(navTarget(lay, edges, 4, 'ArrowLeft')).toBe(3);
    expect(navTarget(lay, edges, 1, 'ArrowLeft')).toBeNull();
    expect(navTarget(lay, edges, 3, 'End')).toBe(4);
    expect(navTarget(lay, edges, 4, 'Home')).toBe(1);
  });
  it('窄螢幕堆疊順序與縮排', () => {
    expect(stackedOrder(lay)).toEqual([
      { id: 1, indent: 0 },
      { id: 3, indent: 1 },
      { id: 2, indent: 1 },
      { id: 4, indent: 2 },
    ]);
  });
  it('roundedPolyline', () => {
    expect(
      roundedPolyline([
        [0, 0],
        [10, 0],
        [10, 20],
      ]),
    ).toBe('M 0 0 L 5 0 Q 10 0 10 5 L 10 20');
  });
});

describe('文案', () => {
  it('shortDate', () => {
    expect(shortDate('2026-12-20', '2026-11-25')).toBe('12/20');
    expect(shortDate('2027-01-03', '2026-11-25')).toBe('2027/01/03');
    expect(shortDate(null)).toBe('');
  });
  it('delayPhrase', () => {
    expect(delayPhrase({ delayDays: 3, projectedEnd: '2026-12-20' }, '2026-11-25')).toBe(
      '預計延後 3 天（到 12/20）',
    );
    expect(delayPhrase({ delayDays: 0, projectedEnd: '2026-12-20' })).toBe('預計可如期');
    expect(delayPhrase({ delayDays: null, projectedEnd: null, unknownBlockerDate: true })).toBe(
      '對方尚未排程',
    );
    expect(delayPhrase({ delayDays: null, projectedEnd: '2026-12-01' }, '2026-11-25')).toBe(
      '預計 12/01 完成',
    );
  });
  it('看板徽章與 Tooltip', () => {
    expect(blockedBadgeText({ delayDays: 3, projectedEnd: '2026-12-20' }, '2026-11-25')).toBe(
      '等待中 · 預計延後 3 天 → 12/20',
    );
    expect(blockedBadgeText({ delayDays: null, projectedEnd: null })).toBe('等待中');
    expect(blockedBadgeText({ delayDays: 0, projectedEnd: '2026-12-20' })).toBe('等待中');
    expect(
      blockedTooltip(
        { blockedByCount: 2, delayDays: 3, projectedEnd: '2026-12-20', dueDate: '2026-12-17' },
        '2026-11-25',
      ),
    ).toBe('正在等待 2 個前置任務完成。依前置任務的時程，預計 12/20 完成（原定 12/17）');
  });
  it('節點徽章', () => {
    const base = { isDone: false, delayDays: null, projectedEnd: null, unknownBlockerDate: false };
    expect(nodeBadge({ ...base, delayDays: 3 })).toMatchObject({ tone: 'warning', text: '+3 天' });
    expect(nodeBadge({ ...base, delayDays: 0 })).toMatchObject({ tone: 'success', text: '準時' });
    expect(nodeBadge({ ...base, unknownBlockerDate: true })).toMatchObject({
      tone: 'neutral',
      text: '待排程',
    });
    expect(nodeBadge({ ...base, isDone: true })).toMatchObject({ text: '已完成' });
  });
  it('摘要', () => {
    expect(chainsSummary([])).toBe('目前沒有依賴鏈');
    expect(chainsSummary([{ summary: { maxDelayDays: 2 } }, { summary: { maxDelayDays: 5 } }])).toBe(
      '共 2 條依賴鏈・最長預計延後 5 天',
    );
    expect(chainsSummary([{ summary: { maxDelayDays: 0 } }])).toBe('共 1 條依賴鏈・目前都可如期');
    expect(
      chainCaption({ nodeCount: 3, maxDelayDays: 2, finalProjectedEnd: '2026-12-20' }, '2026-11-25'),
    ).toBe('3 個任務・預計 12/20 全部完成・最多延後 2 天');
  });
});
