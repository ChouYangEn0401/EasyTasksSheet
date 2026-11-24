import { describe, expect, it } from 'vitest';
import { client, loginAs } from '../../../../tests/helpers/auth.ts';
import { createFakeClock, createTestApp, createTestUser } from '../../../../tests/helpers/db.ts';
import type { OverviewResponse } from '../../../shared/overview.ts';
import { tasks } from '../../db/schema.ts';
import { sortMembers, weekOf } from './compute.ts';

// 種子狀態：1 待辦(todo)、2 進行中(doing)、3 審查中(doing)、4 完成(done)
const TODO = 1;
const DOING = 2;
const REVIEW = 3;
const DONE = 4;
const at = (iso: string) => Date.parse(iso);

/** 固定測試資料：假時鐘 2026-01-05（週一）09:00 +08:00 */
async function setup() {
  const clock = createFakeClock();
  const { app, db } = createTestApp({ now: clock.now });
  const alice = await createTestUser(db, { displayName: 'Alice' });
  const bob = await createTestUser(db, { displayName: 'Bob' });
  const carol = await createTestUser(db, { displayName: 'Carol' });
  const dave = await createTestUser(db, { displayName: 'Dave' });
  const eve = await createTestUser(db, { displayName: 'Eve', isActive: false });

  let seq = 0;
  const add = (t: {
    statusId: number;
    assigneeId?: number | null;
    dueDate?: string | null;
    estimateHours?: number | null;
    updatedAt?: number;
    deletedAt?: number;
  }) => {
    seq += 1;
    return db
      .insert(tasks)
      .values({
        projectId: 1,
        title: `T${seq}`,
        statusId: t.statusId,
        assigneeId: t.assigneeId ?? null,
        dueDate: t.dueDate ?? null,
        estimateHours: t.estimateHours ?? null,
        updatedAt: t.updatedAt ?? clock.now(),
        createdAt: at('2025-12-01T00:00:00+08:00'),
        deletedAt: t.deletedAt ?? null,
        updatedBy: alice.id,
      })
      .returning()
      .get();
  };

  // Alice：進行中 2（含審查中）、待辦 1（逾期）、完成 2（一筆本週、一筆上週）
  const a1 = add({ statusId: DOING, assigneeId: alice.id, dueDate: '2026-01-10', estimateHours: 3 });
  const a2 = add({ statusId: REVIEW, assigneeId: alice.id, updatedAt: at('2026-01-05T08:30:00+08:00') });
  add({ statusId: TODO, assigneeId: alice.id, dueDate: '2026-01-04', estimateHours: 2 });
  add({ statusId: DONE, assigneeId: alice.id, estimateHours: 5, updatedAt: at('2026-01-05T00:00:00+08:00') });
  add({ statusId: DONE, assigneeId: alice.id, updatedAt: at('2026-01-04T23:59:59+08:00') });
  // Bob：只有待辦（目前無任務）
  add({ statusId: TODO, assigneeId: bob.id, estimateHours: 1.5 });
  add({ statusId: TODO, assigneeId: bob.id, dueDate: '2026-01-01', estimateHours: 2 });
  // Carol：沒有任何任務（已刪除的不算）
  add({ statusId: DOING, assigneeId: carol.id, deletedAt: clock.now() });
  // Dave：進行中且逾期、待辦逾期、已完成（到期已過但完成不算逾期；週日晚上更新仍屬本週）
  add({ statusId: DOING, assigneeId: dave.id, dueDate: '2025-12-30', estimateHours: 4 });
  add({ statusId: TODO, assigneeId: dave.id, dueDate: '2026-01-02' });
  add({
    statusId: DONE,
    assigneeId: dave.id,
    dueDate: '2025-12-01',
    updatedAt: at('2026-01-11T23:00:00+08:00'),
  });
  // Eve（停用）：不列入成員，但計入狀態總數
  add({ statusId: DOING, assigneeId: eve.id });
  // 未指派
  add({ statusId: TODO, estimateHours: 2 });
  add({ statusId: DOING });
  add({ statusId: DONE, updatedAt: at('2026-01-12T00:00:00+08:00') }); // 下週一 00:00，不算本週

  const api = await loginAs(app, alice);
  return { app, api, alice, bob, carol, dave, eve, a1, a2 };
}

describe('GET /api/overview', () => {
  it('未登入回 401', async () => {
    const { app } = createTestApp();
    expect((await client(app).get('/api/overview')).status).toBe(401);
  });

  it('以固定測試資料驗證彙總數字', async () => {
    const { api, alice, bob, carol, dave, a1, a2 } = await setup();
    const res = await api.get('/api/overview');
    expect(res.status).toBe(200);
    const o = (await res.json()) as OverviewResponse;

    expect(o.today).toBe('2026-01-05');
    expect(o.weekRange).toEqual({ start: '2026-01-05', end: '2026-01-11' });
    expect(o.totals.byStatus.map((s) => [s.name, s.category, s.count])).toEqual([
      ['待辦', 'todo', 5],
      ['進行中', 'doing', 4],
      ['審查中', 'doing', 1],
      ['完成', 'done', 4],
    ]);
    expect(o.totals.overdue).toBe(4);
    expect(o.totals.doneThisWeek).toBe(2);
    expect(o.totals.idleMembers).toBe(2);
    expect(o.totals.activeMembers).toBe(4);

    // 排序：無任務（待辦少 → 多）在前，其後進行中（逾期多 → 少）
    expect(o.members.map((m) => m.user.displayName)).toEqual(['Carol', 'Bob', 'Dave', 'Alice']);
    const m = Object.fromEntries(o.members.map((x) => [x.user.id, x]));

    expect(m[alice.id]).toMatchObject({
      idle: false,
      counts: { todo: 1, doing: 2, done: 2 },
      overdue: 1,
      remainingHours: 5,
      unestimatedCount: 1,
      lastUpdatedAt: at('2026-01-05T09:00:00+08:00'),
    });
    // 進行中任務依到期日排序，無到期日在後
    expect(m[alice.id]!.doing.map((d) => d.id)).toEqual([a1.id, a2.id]);
    expect(m[alice.id]!.doing[0]).toMatchObject({ title: a1.title, statusId: DOING, dueDate: '2026-01-10' });

    expect(m[bob.id]).toMatchObject({
      idle: true,
      doing: [],
      counts: { todo: 2, doing: 0, done: 0 },
      overdue: 1,
      remainingHours: 3.5,
      unestimatedCount: 0,
    });
    expect(m[carol.id]).toMatchObject({
      idle: true,
      doing: [],
      counts: { todo: 0, doing: 0, done: 0 },
      overdue: 0,
      remainingHours: 0,
      lastUpdatedAt: null,
    });
    expect(m[dave.id]).toMatchObject({
      idle: false,
      counts: { todo: 1, doing: 1, done: 1 },
      overdue: 2,
      remainingHours: 4,
      unestimatedCount: 1,
    });
    expect(o.unassigned).toEqual({ openCount: 2, remainingHours: 2, unestimatedCount: 1 });
  });
});

describe('weekOf / sortMembers', () => {
  it('以 Asia/Taipei 計算本週，跨 UTC 日界仍正確', () => {
    // UTC 1/4 16:30 = 台北 1/5（週一）00:30
    const w = weekOf(at('2026-01-04T16:30:00Z'), 'Asia/Taipei');
    expect(w).toMatchObject({ today: '2026-01-05', start: '2026-01-05', end: '2026-01-11' });
    expect(w.startMs).toBe(at('2026-01-05T00:00:00+08:00'));
    expect(w.endMs).toBe(at('2026-01-12T00:00:00+08:00'));
    // 週日
    expect(weekOf(at('2026-11-29T20:00:00+08:00'), 'Asia/Taipei')).toMatchObject({
      start: '2026-11-23',
      end: '2026-11-29',
    });
  });

  it('同條件時依名稱排序', () => {
    const mk = (name: string, idle: boolean, todo: number, overdue: number) => ({
      user: { id: 0, username: name, displayName: name },
      idle,
      counts: { todo, doing: idle ? 0 : 1, done: 0 },
      overdue,
    });
    const sorted = sortMembers([
      mk('b', false, 0, 1),
      mk('a', false, 0, 1),
      mk('z', true, 1, 0),
      mk('y', true, 1, 0),
    ]);
    expect(sorted.map((x) => x.user.displayName)).toEqual(['y', 'z', 'a', 'b']);
  });
});
