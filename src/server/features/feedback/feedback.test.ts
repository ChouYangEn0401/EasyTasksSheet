import { describe, expect, it } from 'vitest';
import { client, loginAs } from '../../../../tests/helpers/auth.ts';
import { createFakeClock, createTestApp, createTestUser } from '../../../../tests/helpers/db.ts';
import { deriveFeedbackStatus } from '../../../shared/feedback.ts';
import { changes } from '../../db/schema.ts';

async function setup() {
  const clock = createFakeClock();
  const { app, db } = createTestApp({ now: clock.now });
  const alice = await createTestUser(db, { displayName: 'Alice' });
  const bob = await createTestUser(db, { displayName: 'Bob' });
  const a = await loginAs(app, alice);
  const b = await loginAs(app, bob);
  const changeRows = () => db.select().from(changes).all();
  return { app, db, clock, alice, bob, a, b, changeRows };
}

const json = (res: Response) => res.json();

describe('deriveFeedbackStatus', () => {
  it('排入即 scheduled、清空即 open、resolved 優先', () => {
    expect(deriveFeedbackStatus(false, null)).toBe('open');
    expect(deriveFeedbackStatus(false, '2026-11-24')).toBe('scheduled');
    expect(deriveFeedbackStatus(true, '2026-11-24')).toBe('resolved');
    expect(deriveFeedbackStatus(true, null)).toBe('resolved');
  });
});

describe('/api/feedback', () => {
  it('未登入回 401', async () => {
    const { app } = await setup();
    expect((await client(app).get('/api/feedback')).status).toBe(401);
  });

  it('只需 kind + title 即可建立；reporter 為自己、狀態為 open；驗證錯誤回 400', async () => {
    const { a, alice, clock, changeRows } = await setup();
    const res = await a.request('POST', '/api/feedback', { kind: 'problem', title: '  離心機溫度異常 ' });
    expect(res.status).toBe(201);
    const item = await json(res);
    expect(item).toMatchObject({
      kind: 'problem',
      title: '離心機溫度異常',
      body: '',
      status: 'open',
      scheduledDate: null,
      reporterId: alice.id,
      assigneeId: null,
      updatedBy: alice.id,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    expect(changeRows()).toMatchObject([
      { entityType: 'feedback', entityId: item.id, action: 'create', actorId: alice.id },
    ]);

    expect((await a.request('POST', '/api/feedback', { kind: 'problem', title: '  ' })).status).toBe(400);
    expect((await a.request('POST', '/api/feedback', { kind: 'bug', title: 'x' })).status).toBe(400);
    expect((await a.request('POST', '/api/feedback', { title: 'x' })).status).toBe(400);
    expect(
      (await a.request('POST', '/api/feedback', { kind: 'feedback', title: 'x', assigneeId: 999 })).status,
    ).toBe(400);
    expect(
      (
        await a.request('POST', '/api/feedback', {
          kind: 'feedback',
          title: 'x',
          scheduledDate: '2026-02-30',
        })
      ).status,
    ).toBe(400);
    // 建立時帶排程日即為已排程
    const sched = await json(
      await a.request('POST', '/api/feedback', {
        kind: 'feedback',
        title: '週報',
        scheduledDate: '2026-11-26',
      }),
    );
    expect(sched.status).toBe('scheduled');
  });

  it('排程 / 改期 / 取消排程由 scheduledDate 推導狀態；每次寫入記錄變更與 updatedAt / updatedBy', async () => {
    const { a, b, alice, bob, clock, changeRows } = await setup();
    const item = await json(await a.request('POST', '/api/feedback', { kind: 'problem', title: 't' }));

    clock.advance(60_000);
    const scheduled = await json(
      await b.request('PATCH', `/api/feedback/${item.id}`, { scheduledDate: '2026-11-26' }),
    );
    expect(scheduled).toMatchObject({
      status: 'scheduled',
      scheduledDate: '2026-11-26',
      reporterId: alice.id,
      updatedBy: bob.id,
      updatedAt: clock.now(),
      createdAt: item.createdAt,
    });

    const moved = await json(
      await a.request('PATCH', `/api/feedback/${item.id}`, { scheduledDate: '2026-12-01' }),
    );
    expect(moved).toMatchObject({ status: 'scheduled', scheduledDate: '2026-12-01', updatedBy: alice.id });

    // 只改其他欄位不影響狀態
    const edited = await json(
      await a.request('PATCH', `/api/feedback/${item.id}`, {
        title: '新標題',
        body: '內容',
        assigneeId: bob.id,
      }),
    );
    expect(edited).toMatchObject({ title: '新標題', body: '內容', assigneeId: bob.id, status: 'scheduled' });

    const cleared = await json(await a.request('PATCH', `/api/feedback/${item.id}`, { scheduledDate: null }));
    expect(cleared).toMatchObject({ status: 'open', scheduledDate: null });

    expect(changeRows().map((r) => r.action)).toEqual(['create', 'update', 'update', 'update', 'update']);

    // 不可直接寫 status
    const ignored = await json(await a.request('PATCH', `/api/feedback/${item.id}`, { status: 'resolved' }));
    expect(ignored.status).toBe('open');
    expect((await a.request('PATCH', `/api/feedback/${item.id}`, { scheduledDate: '11/26' })).status).toBe(
      400,
    );
    expect((await a.request('PATCH', '/api/feedback/999', { title: 'x' })).status).toBe(404);
  });

  it('標記已解決保留排程日；重新開啟依排程日回到 scheduled / open', async () => {
    const { a } = await setup();
    const item = await json(
      await a.request('POST', '/api/feedback', { kind: 'problem', title: 't', scheduledDate: '2026-11-26' }),
    );
    const resolved = await json(await a.request('PATCH', `/api/feedback/${item.id}`, { resolved: true }));
    expect(resolved).toMatchObject({ status: 'resolved', scheduledDate: '2026-11-26' });

    // 已解決時改排程日仍維持已解決
    const moved = await json(
      await a.request('PATCH', `/api/feedback/${item.id}`, { scheduledDate: '2026-11-27' }),
    );
    expect(moved).toMatchObject({ status: 'resolved', scheduledDate: '2026-11-27' });

    const reopened = await json(await a.request('PATCH', `/api/feedback/${item.id}`, { resolved: false }));
    expect(reopened).toMatchObject({ status: 'scheduled', scheduledDate: '2026-11-27' });

    await a.request('PATCH', `/api/feedback/${item.id}`, { resolved: true, scheduledDate: null });
    const reopenedOpen = await json(
      await a.request('PATCH', `/api/feedback/${item.id}`, { resolved: false }),
    );
    expect(reopenedOpen.status).toBe('open');
  });

  it('列表依建立時間新→舊；可依 kind / status / 排程區間篩選', async () => {
    const { a, clock } = await setup();
    const mk = async (body: object) => {
      clock.advance(1000);
      return json(await a.request('POST', '/api/feedback', body));
    };
    const p1 = await mk({ kind: 'problem', title: 'p1' });
    const f1 = await mk({ kind: 'feedback', title: 'f1', scheduledDate: '2026-11-10' });
    const p2 = await mk({ kind: 'problem', title: 'p2', scheduledDate: '2026-12-05' });
    await a.request('PATCH', `/api/feedback/${p2.id}`, { resolved: true });
    const ids = async (qs: string) =>
      (await json(await a.get(`/api/feedback${qs}`))).map((x: { id: number }) => x.id);

    expect(await ids('')).toEqual([p2.id, f1.id, p1.id]);
    expect(await ids('?kind=problem')).toEqual([p2.id, p1.id]);
    expect(await ids('?status=open,scheduled')).toEqual([f1.id, p1.id]);
    expect(await ids('?kind=problem&status=resolved')).toEqual([p2.id]);
    expect(await ids('?from=2026-11-01&to=2026-11-30')).toEqual([f1.id]);
    expect((await a.get('/api/feedback?status=done')).status).toBe(400);
    expect((await a.get('/api/feedback?kind=bug')).status).toBe(400);
  });

  it('GET / DELETE 單筆；刪除後 404 並記錄變更', async () => {
    const { a, b, bob, changeRows } = await setup();
    const item = await json(await a.request('POST', '/api/feedback', { kind: 'feedback', title: '要刪' }));
    expect(await json(await b.get(`/api/feedback/${item.id}`))).toMatchObject({ id: item.id, title: '要刪' });
    expect((await b.request('DELETE', `/api/feedback/${item.id}`)).status).toBe(200);
    expect((await a.get(`/api/feedback/${item.id}`)).status).toBe(404);
    expect((await a.request('DELETE', `/api/feedback/${item.id}`)).status).toBe(404);
    expect(await json(await a.get('/api/feedback'))).toEqual([]);
    expect(changeRows().at(-1)).toMatchObject({ entityId: item.id, action: 'delete', actorId: bob.id });
  });
});
