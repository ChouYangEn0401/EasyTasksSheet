import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loginAs, type Client } from '../../../../tests/helpers/auth.ts';
import { createFakeClock, createTestApp, createTestUser } from '../../../../tests/helpers/db.ts';
import { sessions } from '../../db/schema.ts';
import { hubFor, syncOptions } from './hub.ts';

const defaults = { ...syncOptions };
afterEach(() => Object.assign(syncOptions, defaults));

async function setup() {
  const clock = createFakeClock();
  const { app, db } = createTestApp({ now: clock.now });
  const alice = await createTestUser(db, { displayName: 'Alice' });
  const bob = await createTestUser(db, { displayName: 'Bob' });
  const a = await loginAs(app, alice);
  const b = await loginAs(app, bob);
  return { app, db, clock, alice, bob, a, b };
}

type SseEvent = { event: string; data: string; id?: string };

/** 讀 SSE 串流的小工具：next(pred) 等到符合條件的事件 */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const queue: SseEvent[] = [];
  const comments: string[] = [];

  async function fill() {
    const { value, done } = await reader.read();
    if (done) throw new Error('stream closed');
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev: SseEvent = { event: 'message', data: '' };
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) comments.push(line);
        else if (line.startsWith('event: ')) ev.event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
        else if (line.startsWith('id: ')) ev.id = line.slice(4);
      }
      ev.data = data.join('\n');
      if (data.length || ev.event !== 'message') queue.push(ev);
    }
  }

  return {
    comments,
    async next(pred: (e: SseEvent) => boolean = () => true, timeoutMs = 3000): Promise<SseEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idx = queue.findIndex(pred);
        if (idx >= 0) return queue.splice(idx, 1)[0]!;
        if (Date.now() > deadline) throw new Error('timeout waiting for SSE event');
        await Promise.race([fill(), new Promise((r) => setTimeout(r, deadline - Date.now()))]);
      }
    },
    async waitComment(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!comments.length) {
        if (Date.now() > deadline) throw new Error('timeout waiting for comment');
        await Promise.race([fill(), new Promise((r) => setTimeout(r, deadline - Date.now()))]);
      }
      return comments.shift()!;
    },
    cancel: () => reader.cancel(),
  };
}

const createTask = (c: Client, title: string) => c.request('POST', '/api/tasks', { title });

describe('GET /api/changes', () => {
  it('未登入回 401', async () => {
    const { app } = createTestApp();
    const res = await app.request('http://localhost/api/changes');
    expect(res.status).toBe(401);
  });

  it('無 since 只回最新 id；有 since 回其後的流水', async () => {
    const { a, alice } = await setup();
    const start = await (await a.get('/api/changes')).json();
    expect(start).toMatchObject({ changes: [], hasMore: false, reset: false });

    const task = await (await createTask(a, '新任務')).json();
    await a.request('PATCH', `/api/tasks/${task.id}`, { title: '改名' });

    const body = await (await a.get(`/api/changes?since=${start.latestId}`)).json();
    expect(body.changes).toMatchObject([
      { entityType: 'task', entityId: task.id, action: 'create', actorId: alice.id },
      { entityType: 'task', entityId: task.id, action: 'update', actorId: alice.id },
    ]);
    expect(body.latestId).toBe(body.changes[1].id);

    const again = await (await a.get(`/api/changes?since=${body.latestId}`)).json();
    expect(again.changes).toEqual([]);
  });

  it('超過上限時 hasMore = true，latestId 為本批最後一筆', async () => {
    const { a } = await setup();
    syncOptions.maxBatch = 2;
    const { latestId } = await (await a.get('/api/changes')).json();
    for (const t of ['a', 'b', 'c']) await createTask(a, t);
    const body = await (await a.get(`/api/changes?since=${latestId}`)).json();
    expect(body.changes).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(body.latestId).toBe(body.changes[1].id);
  });

  it('since 格式錯誤回 400', async () => {
    const { a } = await setup();
    expect((await a.get('/api/changes?since=abc')).status).toBe(400);
  });

  it('GET /api/changes 不刷新閒置計時', async () => {
    const { a, db, clock, alice } = await setup();
    const before = db.select().from(sessions).where(eq(sessions.userId, alice.id)).get()!.lastActiveAt;
    clock.advance(60_000);
    await a.get('/api/changes?since=0');
    const after = db.select().from(sessions).where(eq(sessions.userId, alice.id)).get()!.lastActiveAt;
    expect(after).toBe(before);
  });
});

describe('GET /api/events（SSE）', () => {
  it('未登入回 401', async () => {
    const { app } = createTestApp();
    const res = await app.request('http://localhost/api/events');
    expect(res.status).toBe(401);
  });

  it('推送他人的變更，含 id 與 actor；不壓縮、不快取', async () => {
    syncOptions.pollMs = 20;
    const { a, b, bob, db } = await setup();
    const res = await a.get('/api/events');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    expect(res.headers.get('content-encoding')).toBeNull();
    const sse = sseReader(res);
    const ready = await sse.next((e) => e.event === 'ready');
    expect(JSON.parse(ready.data)).toMatchObject({ reset: false });

    const task = await (await createTask(b, '來自 Bob')).json();
    const ev = await sse.next((e) => e.event === 'change');
    const change = JSON.parse(ev.data);
    expect(change).toMatchObject({
      entityType: 'task',
      entityId: task.id,
      action: 'create',
      actorId: bob.id,
    });
    expect(ev.id).toBe(String(change.id));

    await b.request('DELETE', `/api/tasks/${task.id}`);
    const del = JSON.parse((await sse.next((e) => e.event === 'change')).data);
    expect(del).toMatchObject({ entityId: task.id, action: 'delete' });

    await sse.cancel();
    // 斷線後 hub 釋放訂閱
    await new Promise((r) => setTimeout(r, 30));
    expect(hubFor(db).size).toBe(0);
  });

  it('帶 since（或 Last-Event-ID）重連時先重播漏掉的流水', async () => {
    syncOptions.pollMs = 20;
    const { a, b } = await setup();
    const { latestId } = await (await a.get('/api/changes')).json();
    const t1 = await (await createTask(b, '一')).json();
    const t2 = await (await createTask(b, '二')).json();

    const sse = sseReader(await a.get(`/api/events?since=${latestId}`));
    await sse.next((e) => e.event === 'ready');
    const first = JSON.parse((await sse.next((e) => e.event === 'change')).data);
    const second = JSON.parse((await sse.next((e) => e.event === 'change')).data);
    expect([first.entityId, second.entityId]).toEqual([t1.id, t2.id]);
    await sse.cancel();

    const viaHeader = sseReader(
      await a.request('GET', '/api/events', undefined, { 'last-event-id': String(first.id) }),
    );
    await viaHeader.next((e) => e.event === 'ready');
    const replayed = JSON.parse((await viaHeader.next((e) => e.event === 'change')).data);
    expect(replayed.entityId).toBe(t2.id);
    await viaHeader.cancel();
  });

  it('定時送心跳；SSE 連線不刷新閒置計時，逾時後送 expired 並關閉', async () => {
    syncOptions.heartbeatMs = 30;
    const { a, db, clock, alice } = await setup();
    const sse = sseReader(await a.get('/api/events'));
    await sse.next((e) => e.event === 'ready');
    await sse.next((e) => e.event === 'ping');

    const lastActive = () =>
      db.select().from(sessions).where(eq(sessions.userId, alice.id)).get()?.lastActiveAt;
    const before = lastActive();
    clock.advance(10 * 60_000);
    await sse.next((e) => e.event === 'ping');
    expect(lastActive()).toBe(before);

    clock.advance(60 * 60_000);
    await sse.next((e) => e.event === 'expired');
  });
});
