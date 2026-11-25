import { describe, expect, it } from 'vitest';
import type { MachineGroup } from '../../../shared/engManual.ts';
import {
  countByStatus,
  extrasCount,
  groupByOwner,
  inView,
  readPersonView,
  unassignedCount,
  writePersonView,
} from './personView.ts';

type Rec = MachineGroup['records'][number];
const rec = (id: number, ownerId: number | null, status = 'active'): Rec =>
  ({
    id,
    ownerId,
    status,
    path: `C:/p${id}`,
    branch: `b${id}`,
    hint: null,
    lastSeenAt: null,
    moveTo: null,
  }) as unknown as Rec;
const group = (
  machine: string,
  records: Rec[],
  opts: { unregistered?: number; pending?: boolean } = {},
): MachineGroup =>
  ({
    key: `name:${machine}`,
    machine,
    machineId: null,
    reportedAt: null,
    stale: false,
    repos: [
      {
        sourceId: 1,
        repo: 'r',
        pending: opts.pending ? { reason: 'empty', previous: 3, count: 0, at: 1 } : null,
      },
    ],
    records,
    reports: Array.from({ length: opts.unregistered ?? 0 }, (_, i) => ({
      id: 100 + i,
      path: `C:/u${i}`,
      registered: false,
      movedFrom: null,
      missingSince: null,
    })),
  }) as unknown as MachineGroup;

const NAMES: Record<number, string> = { 1: '我', 2: 'Bob', 3: 'Alice', 4: 'Carol' };
const nameOf = (id: number) => NAMES[id] ?? `#${id}`;

describe('readPersonView / writePersonView', () => {
  it('預設為我自己，all 與數字可解析，其餘為 invalid', () => {
    expect(readPersonView(null, 1)).toEqual({ kind: 'user', id: 1 });
    expect(readPersonView('all', 1)).toEqual({ kind: 'all' });
    expect(readPersonView('7', 1)).toEqual({ kind: 'user', id: 7 });
    expect(readPersonView('abc', 1)).toEqual({ kind: 'invalid' });
    expect(readPersonView('0', 1)).toEqual({ kind: 'invalid' });
  });
  it('寫回網址：我自己不帶參數、保留其他參數', () => {
    const base = new URLSearchParams('tab=worktrees');
    expect(writePersonView(base, '1', 1).toString()).toBe('tab=worktrees');
    expect(writePersonView(base, 'all', 1).toString()).toBe('tab=worktrees&user=all');
    expect(writePersonView(new URLSearchParams('tab=worktrees&user=all'), '1', 1).toString()).toBe(
      'tab=worktrees',
    );
  });
});

describe('groupByOwner', () => {
  const machines = [
    group('A', [rec(1, 1), rec(2, 2), rec(3, null)], { unregistered: 2 }),
    group('B', [rec(4, 3), rec(5, 1)], { pending: true }),
    group('C', [rec(6, 2)]),
  ];

  it('單一成員：只含該成員紀錄，電腦為第二層，不含別人的電腦', () => {
    const [b] = groupByOwner(machines, { kind: 'user', id: 1 }, 1, nameOf);
    expect(b?.ownerId).toBe(1);
    expect(b?.slices.map((s) => [s.group.machine, s.records.map((r) => r.id)])).toEqual([
      ['A', [1]],
      ['B', [5]],
    ]);
    expect(b?.count).toBe(2);
    // 電腦層級提示跟著有自己紀錄的電腦
    expect(b?.slices.every((s) => s.extras)).toBe(true);
  });

  it('單一成員沒有任何紀錄：仍回傳一個空區塊', () => {
    const out = groupByOwner(machines, { kind: 'user', id: 4 }, 1, nameOf);
    expect(out).toHaveLength(1);
    expect(out[0]?.count).toBe(0);
    expect(out[0]?.slices).toEqual([]);
  });

  it('全部成員：我自己在前、其餘依名稱、未指派最後', () => {
    const out = groupByOwner(machines, { kind: 'all' }, 1, nameOf);
    expect(out.map((b) => b.ownerId)).toEqual([1, 3, 2, null]); // 我、Alice、Bob（名稱排序）、未指派
    const mine = out[0];
    expect(mine?.slices.map((s) => s.group.machine)).toEqual(['A', 'B']);
    expect(mine?.slices.some((s) => s.extras)).toBe(false);
  });

  it('未指派卡片收納各電腦的未登記回報 / 待確認，即使該電腦沒有未指派紀錄', () => {
    const out = groupByOwner(machines, { kind: 'all' }, 1, nameOf);
    const none = out.at(-1);
    expect(none?.ownerId).toBeNull();
    expect(none?.count).toBe(1);
    expect(none?.slices.map((s) => [s.group.machine, s.records.length, s.extras])).toEqual([
      ['A', 1, true],
      ['B', 0, true],
    ]);
  });

  it('沒有未指派紀錄也沒有提示時不產生未指派卡片', () => {
    const out = groupByOwner([group('A', [rec(1, 2)])], { kind: 'all' }, 1, nameOf);
    expect(out.map((b) => b.ownerId)).toEqual([2]);
  });

  it('我自己沒有紀錄時不出現在全部成員（沒有空卡片）', () => {
    const out = groupByOwner([group('A', [rec(1, 2)])], { kind: 'all' }, 1, nameOf);
    expect(out.some((b) => b.ownerId === 1)).toBe(false);
  });
});

describe('輔助計算', () => {
  const machines = [
    group('A', [rec(1, null), rec(2, 1)], { unregistered: 1 }),
    group('B', [rec(3, null)], { pending: true }),
  ];
  it('未指派與提示筆數', () => {
    expect(unassignedCount(machines)).toBe(2);
    expect(extrasCount(machines)).toBe(2);
  });
  it('狀態摘要依首次出現順序', () => {
    expect(countByStatus([{ status: 'idle' }, { status: 'active' }, { status: 'idle' }])).toEqual([
      { status: 'idle', count: 2 },
      { status: 'active', count: 1 },
    ]);
  });
  it('回收區範圍：單一成員只留負責人為該成員者', () => {
    const rows = [{ ownerId: 1 }, { ownerId: null }, { ownerId: 2 }];
    expect(inView(rows, { kind: 'user', id: 1 })).toEqual([{ ownerId: 1 }]);
    expect(inView(rows, { kind: 'all' })).toHaveLength(3);
  });
});
