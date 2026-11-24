import { describe, expect, it } from 'vitest';
import { client, loginAs } from '../../../../tests/helpers/auth.ts';
import { createFakeClock, createTestApp, createTestUser } from '../../../../tests/helpers/db.ts';
import { sortOrderForMove, type PersonalItem, type PinnedTask } from '../../../shared/personal.ts';
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
const typed = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

describe('sortOrderForMove', () => {
  const list = [{ sortOrder: 1 }, { sortOrder: 2 }, { sortOrder: 3 }];
  it('取新鄰居的中間值；移到頭尾則 ±1', () => {
    expect(sortOrderForMove(list, 2, 0)).toBe(0);
    expect(sortOrderForMove(list, 0, 2)).toBe(4);
    expect(sortOrderForMove(list, 0, 1)).toBe(2.5);
    expect(sortOrderForMove(list, 2, 1)).toBe(1.5);
    expect(sortOrderForMove([{ sortOrder: 7 }], 0, 0)).toBe(7);
  });
});

describe('/api/personal 自由待辦', () => {
  it('未登入回 401', async () => {
    const { app } = await setup();
    expect((await client(app).get('/api/personal')).status).toBe(401);
    expect((await client(app).get('/api/personal/pins')).status).toBe(401);
  });

  it('新增排在最上方；勾選 / 改標題 / 備註 / 排序；重新讀取保留；寫入皆記錄變更', async () => {
    const { a, alice, clock, changeRows } = await setup();
    const first = await typed<PersonalItem>(
      await a.request('POST', '/api/personal', { title: ' 訂購試劑 ' }),
    );
    expect(first).toMatchObject({
      userId: alice.id,
      title: '訂購試劑',
      note: '',
      isDone: false,
      taskId: null,
    });
    clock.advance(1000);
    const res = await a.request('POST', '/api/personal', { title: '回覆審稿意見', note: '週五前' });
    expect(res.status).toBe(201);
    const second = await typed<PersonalItem>(res);
    expect(second.sortOrder).toBeLessThan(first.sortOrder);
    let list = await typed<PersonalItem[]>(await a.get('/api/personal'));
    expect(list.map((i) => i.title)).toEqual(['回覆審稿意見', '訂購試劑']);

    // 空白標題無效
    expect((await a.request('POST', '/api/personal', { title: '   ' })).status).toBe(400);

    clock.advance(1000);
    const patched = await typed<PersonalItem>(
      await a.request('PATCH', `/api/personal/${first.id}`, {
        isDone: true,
        title: '訂購試劑 x2',
        note: '找廠商',
        sortOrder: second.sortOrder - 1,
      }),
    );
    expect(patched).toMatchObject({
      isDone: true,
      title: '訂購試劑 x2',
      note: '找廠商',
      updatedAt: clock.now(),
    });
    list = await typed<PersonalItem[]>(await a.get('/api/personal'));
    expect(list.map((i) => [i.title, i.isDone])).toEqual([
      ['訂購試劑 x2', true],
      ['回覆審稿意見', false],
    ]);
    expect((await a.request('PATCH', `/api/personal/${first.id}`, { title: '' })).status).toBe(400);
    expect((await a.request('PATCH', `/api/personal/${first.id}`, {})).status).toBe(400);
    expect((await a.request('PATCH', '/api/personal/9999', { isDone: true })).status).toBe(404);

    // 清除已完成
    const cleared = await json(await a.request('DELETE', '/api/personal/done'));
    expect(cleared).toEqual({ ok: true, deleted: 1 });
    expect((await a.request('DELETE', `/api/personal/${second.id}`)).status).toBe(200);
    expect(await json(await a.get('/api/personal'))).toEqual([]);

    expect(changeRows().map((r) => [r.entityType, r.entityId, r.action, r.actorId])).toEqual([
      ['personal', first.id, 'create', alice.id],
      ['personal', second.id, 'create', alice.id],
      ['personal', first.id, 'update', alice.id],
      ['personal', first.id, 'delete', alice.id],
      ['personal', second.id, 'delete', alice.id],
    ]);
  });

  it('只有本人能改：他人改 / 刪回 403，指定他人寫入回 403；他人可唯讀檢視', async () => {
    const { a, b, alice, bob, changeRows } = await setup();
    const item = await typed<PersonalItem>(
      await a.request('POST', '/api/personal', { title: 'Alice 的待辦' }),
    );
    const before = changeRows().length;

    expect((await b.request('PATCH', `/api/personal/${item.id}`, { isDone: true })).status).toBe(403);
    expect((await b.request('DELETE', `/api/personal/${item.id}`)).status).toBe(403);
    expect((await b.request('POST', `/api/personal?user=${alice.id}`, { title: '代寫' })).status).toBe(403);
    expect((await b.request('DELETE', `/api/personal/done?user=${alice.id}`)).status).toBe(403);
    expect((await b.request('PUT', `/api/personal/pins/1?user=${alice.id}`)).status).toBe(403);
    expect((await b.request('DELETE', `/api/personal/pins/1?user=${alice.id}`)).status).toBe(403);
    const forbiddenBody = await json(await b.request('DELETE', `/api/personal/${item.id}`));
    expect(forbiddenBody.error.code).toBe('FORBIDDEN');
    expect(changeRows().length).toBe(before);

    // 唯讀檢視
    const seen = await typed<PersonalItem[]>(await b.get(`/api/personal?user=${alice.id}`));
    expect(seen.map((i) => i.title)).toEqual(['Alice 的待辦']);
    expect(await json(await b.get(`/api/personal?user=${bob.id}`))).toEqual([]);
    expect(await json(await a.get('/api/personal/pins?user=' + bob.id))).toEqual([]);
    // 本人資料不受影響
    expect((await typed<PersonalItem[]>(await a.get('/api/personal')))[0]!.isDone).toBe(false);
  });

  it('檢視不存在或已停用的成員回 404；?user 格式錯誤回 400', async () => {
    const { db, a } = await setup();
    const gone = await createTestUser(db, { isActive: false });
    expect((await a.get('/api/personal?user=9999')).status).toBe(404);
    expect((await a.get(`/api/personal/pins?user=${gone.id}`)).status).toBe(404);
    expect((await a.get('/api/personal?user=abc')).status).toBe(400);
  });
});

describe('/api/personal/pins 標記', () => {
  it('標記冪等、依標記時間新→舊；取消標記；任務刪除後自動消失；不影響他人的標記', async () => {
    const { a, b, alice, clock, changeRows } = await setup();
    const t1 = await json(await a.request('POST', '/api/tasks', { title: '資料清理' }));
    const t2 = await json(await a.request('POST', '/api/tasks', { title: '撰寫週報' }));
    const base = changeRows().length;

    const put = await a.request('PUT', `/api/personal/pins/${t1.id}`);
    expect(put.status).toBe(201);
    const pin = await typed<PersonalItem>(put);
    expect(pin).toMatchObject({ userId: alice.id, taskId: t1.id });
    expect((await a.request('PUT', `/api/personal/pins/${t1.id}`)).status).toBe(200);
    clock.advance(1000);
    await a.request('PUT', `/api/personal/pins/${t2.id}`);
    await b.request('PUT', `/api/personal/pins/${t1.id}`);

    let pins = await typed<PinnedTask[]>(await a.get('/api/personal/pins'));
    expect(pins.map((p) => p.task.title)).toEqual(['撰寫週報', '資料清理']);
    expect(pins[0]!.task).toMatchObject({
      id: t2.id,
      statusId: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    // 標記不出現在自由待辦
    expect(await json(await a.get('/api/personal'))).toEqual([]);
    // 標記列不能以待辦 API 修改
    expect((await a.request('PATCH', `/api/personal/${pin.id}`, { isDone: true })).status).toBe(404);

    expect((await a.request('PUT', '/api/personal/pins/9999')).status).toBe(404);

    // 取消標記（冪等）
    expect((await a.request('DELETE', `/api/personal/pins/${t2.id}`)).status).toBe(200);
    expect((await a.request('DELETE', `/api/personal/pins/${t2.id}`)).status).toBe(200);
    pins = await typed<PinnedTask[]>(await a.get('/api/personal/pins'));
    expect(pins.map((p) => p.task.id)).toEqual([t1.id]);

    // 任務軟刪除後，標記清單不再出現；也不能再標記
    await b.request('DELETE', `/api/tasks/${t1.id}`);
    expect(await json(await a.get('/api/personal/pins'))).toEqual([]);
    expect(await json(await b.get('/api/personal/pins'))).toEqual([]);
    expect((await a.request('PUT', `/api/personal/pins/${t1.id}`)).status).toBe(404);

    const pinChanges = changeRows()
      .slice(base)
      .filter((r) => r.entityType === 'personal')
      .map((r) => r.action);
    // a 標記 t1、t2，b 標記 t1，a 取消 t2（重複的 PUT / DELETE 不記錄）
    expect(pinChanges).toEqual(['create', 'create', 'create', 'delete']);
  });
});
