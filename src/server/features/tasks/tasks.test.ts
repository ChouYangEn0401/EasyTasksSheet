import { describe, expect, it } from 'vitest';
import { loginAs } from '../../../../tests/helpers/auth.ts';
import { createFakeClock, createTestApp, createTestUser } from '../../../../tests/helpers/db.ts';
import { changes } from '../../db/schema.ts';

async function setup() {
  const clock = createFakeClock();
  const { app, db } = createTestApp({ now: clock.now });
  const alice = await createTestUser(db, { displayName: 'Alice' });
  const bob = await createTestUser(db, { displayName: 'Bob' });
  const a = await loginAs(app, alice);
  const b = await loginAs(app, bob);
  const changeCount = () => db.select().from(changes).all().length;
  return { app, db, clock, alice, bob, a, b, changeCount };
}

const json = async (res: Response) => {
  const body = await res.json();
  return body;
};

describe('users / statuses / projects', () => {
  it('成員列表不含密碼雜湊；狀態與預設專案使用調色盤鍵名', async () => {
    const { a, alice } = await setup();
    const list = await json(await a.get('/api/users'));
    expect(list.map((u: { id: number }) => u.id)).toContain(alice.id);
    expect(list[0].passwordHash).toBeUndefined();

    const statuses = await json(await a.get('/api/statuses'));
    expect(statuses.map((s: { name: string; color: string }) => [s.name, s.color])).toEqual([
      ['待辦', 'gray'],
      ['進行中', 'blue'],
      ['審查中', 'purple'],
      ['完成', 'green'],
    ]);
    const projects = await json(await a.get('/api/projects'));
    expect(projects).toMatchObject([{ name: '預設專案', color: 'blue' }]);
  });

  it('可新增、修改專案；color 須為調色盤鍵名；寫入記錄變更', async () => {
    const { a, changeCount } = await setup();
    const before = changeCount();
    const created = await a.request('POST', '/api/projects', { name: '新專案', color: 'teal' });
    expect(created.status).toBe(201);
    const p = await json(created);
    expect(p).toMatchObject({ name: '新專案', color: 'teal', sortOrder: 2 });
    expect((await a.request('POST', '/api/projects', { name: 'x', color: '#ff0000' })).status).toBe(400);
    const patched = await json(await a.request('PATCH', `/api/projects/${p.id}`, { isArchived: true }));
    expect(patched).toMatchObject({ name: '新專案', isArchived: true });
    expect((await a.request('PATCH', '/api/projects/999', { name: 'y' })).status).toBe(404);
    expect(changeCount()).toBe(before + 2);
  });
});

describe('tasks', () => {
  it('只給 title 即可建立，其餘有預設值', async () => {
    const { a, alice, clock } = await setup();
    const res = await a.request('POST', '/api/tasks', { title: '  只有標題  ' });
    expect(res.status).toBe(201);
    const t = await json(res);
    expect(t).toMatchObject({
      title: '只有標題',
      projectId: 1,
      statusId: 1,
      assigneeId: null,
      priority: 'none',
      progress: 0,
      custom: {},
      createdBy: alice.id,
      updatedBy: alice.id,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      deletedAt: null,
    });
    expect((await a.request('POST', '/api/tasks', { title: '' })).status).toBe(400);
    expect((await a.request('POST', '/api/tasks', { title: 'x', statusId: 999 })).status).toBe(400);
  });

  it('建立時所有欄位皆可選填指定（Kanban 欄尾新增）', async () => {
    const { a, bob } = await setup();
    const t = await json(
      await a.request('POST', '/api/tasks', {
        title: '完整',
        statusId: 3,
        assigneeId: bob.id,
        sortOrder: 7.5,
        startDate: '2026-01-05',
        dueDate: '2026-01-09',
        estimateHours: 4,
        priority: 'high',
      }),
    );
    expect(t).toMatchObject({ statusId: 3, assigneeId: bob.id, sortOrder: 7.5, dueDate: '2026-01-09' });
  });

  it('成員 A 可修改成員 B 的任務；PATCH 只改送來的欄位，updated_at / updated_by 正確', async () => {
    const { a, b, alice, bob, clock, changeCount } = await setup();
    const t = await json(await b.request('POST', '/api/tasks', { title: 'B 的任務', description: '說明' }));
    clock.advance(5 * 60_000);
    const before = changeCount();
    const res = await a.request('PATCH', `/api/tasks/${t.id}`, { progress: 50, assigneeId: alice.id });
    expect(res.status).toBe(200);
    const u = await json(res);
    expect(u).toMatchObject({
      title: 'B 的任務',
      description: '說明',
      progress: 50,
      assigneeId: alice.id,
      createdBy: bob.id,
      updatedBy: alice.id,
      updatedAt: clock.now(),
    });
    expect(changeCount()).toBe(before + 1);
    expect((await a.request('PATCH', `/api/tasks/${t.id}`, { progress: 101 })).status).toBe(400);
  });

  it('軟刪除後不出現在列表，GET / PATCH 回 404，DB 仍保留', async () => {
    const { a, db } = await setup();
    const t = await json(await a.request('POST', '/api/tasks', { title: '要刪' }));
    expect((await a.request('DELETE', `/api/tasks/${t.id}`)).status).toBe(200);
    expect(await json(await a.get('/api/tasks'))).toEqual([]);
    expect((await a.get(`/api/tasks/${t.id}`)).status).toBe(404);
    expect((await a.request('PATCH', `/api/tasks/${t.id}`, { title: 'x' })).status).toBe(404);
    expect((await a.request('DELETE', `/api/tasks/${t.id}`)).status).toBe(404);
    const row = db.$client.prepare('select deleted_at from tasks where id = ?').get(t.id) as {
      deleted_at: number;
    };
    expect(row.deleted_at).toBeGreaterThan(0);
    const actions = db
      .select()
      .from(changes)
      .all()
      .map((c) => c.action);
    expect(actions).toEqual(['create', 'delete']);
  });

  it('列表篩選：多值逗號分隔、assignee=none、q 關鍵字', async () => {
    const { a, alice, bob } = await setup();
    const p2 = await json(await a.request('POST', '/api/projects', { name: 'P2' }));
    const mk = (body: object) => a.request('POST', '/api/tasks', body).then(json);
    const t1 = await mk({ title: 'Alpha 報告', assigneeId: alice.id });
    const t2 = await mk({ title: 'beta 實驗', assigneeId: bob.id, statusId: 2, projectId: p2.id });
    const t3 = await mk({ title: '未指派 alpha', statusId: 4 });
    const ids = async (qs: string) =>
      (await json(await a.get(`/api/tasks${qs}`))).map((t: { id: number }) => t.id);

    expect(await ids('')).toEqual([t1.id, t2.id, t3.id]);
    expect(await ids(`?assignee=${alice.id},${bob.id}`)).toEqual([t1.id, t2.id]);
    expect(await ids('?assignee=none')).toEqual([t3.id]);
    expect(await ids(`?assignee=none,${bob.id}`)).toEqual([t2.id, t3.id]);
    expect(await ids('?status=2,4')).toEqual([t2.id, t3.id]);
    expect(await ids(`?project=${p2.id}`)).toEqual([t2.id]);
    expect(await ids('?q=ALPHA')).toEqual([t1.id, t3.id]);
    expect(await ids(`?q=alpha&assignee=none`)).toEqual([t3.id]);
    expect((await a.get('/api/tasks?status=abc')).status).toBe(400);
  });
});

describe('自訂 property', () => {
  it('依型別驗證，錯誤型別回 400；PATCH 逐鍵合併、null 清除', async () => {
    const { a, bob, changeCount } = await setup();
    const mk = (body: object) => a.request('POST', '/api/properties', body).then(json);
    const num = await mk({ name: '點數', type: 'number' });
    const sel = await mk({
      name: '類別',
      type: 'select',
      options: [
        { id: 'a', label: 'A', color: 'red' },
        { id: 'b', label: 'B' },
      ],
    });
    const multi = await mk({ name: '標籤', type: 'multi_select', options: [{ id: 'x', label: 'X' }] });
    const date = await mk({ name: '日期', type: 'date' });
    const check = await mk({ name: '完成', type: 'checkbox' });
    const url = await mk({ name: '連結', type: 'url' });
    const person = await mk({ name: '審查人', type: 'person' });
    const text = await mk({ name: '備註', type: 'text' });
    const p2 = await json(await a.request('POST', '/api/projects', { name: 'P2' }));
    const other = await mk({ name: 'P2 專屬', type: 'text', projectId: p2.id });
    expect(await json(await a.get('/api/properties'))).toHaveLength(9);

    const valid = {
      [num.id]: 3,
      [sel.id]: 'a',
      [multi.id]: ['x'],
      [date.id]: '2026-02-01',
      [check.id]: true,
      [url.id]: 'https://example.com',
      [person.id]: bob.id,
      [text.id]: '文字',
    };
    const created = await a.request('POST', '/api/tasks', { title: 't', custom: valid });
    expect(created.status).toBe(201);
    const t = await json(created);
    expect(t.custom).toEqual(Object.fromEntries(Object.entries(valid).map(([k, v]) => [String(k), v])));

    const invalid = [
      { [num.id]: '3' },
      { [sel.id]: 'zzz' },
      { [multi.id]: 'x' },
      { [date.id]: '2026/02/01' },
      { [check.id]: 'yes' },
      { [url.id]: 'not a url' },
      { [person.id]: 9999 },
      { [text.id]: 5 },
      { 9999: 'unknown' },
      { [other.id]: '不屬於此專案' },
    ];
    for (const custom of invalid) {
      const res = await a.request('PATCH', `/api/tasks/${t.id}`, { custom });
      expect(res.status, JSON.stringify(custom)).toBe(400);
    }

    const before = changeCount();
    const patched = await json(
      await a.request('PATCH', `/api/tasks/${t.id}`, { custom: { [num.id]: 5, [text.id]: null } }),
    );
    expect(patched.custom[num.id]).toBe(5);
    expect(patched.custom[sel.id]).toBe('a');
    expect(text.id in patched.custom).toBe(false);
    expect(changeCount()).toBe(before + 1);
  });

  it('可修改與刪除定義；刪除後不影響任務資料', async () => {
    const { a, changeCount } = await setup();
    const before = changeCount();
    const p = await json(await a.request('POST', '/api/properties', { name: '點數', type: 'number' }));
    const t = await json(await a.request('POST', '/api/tasks', { title: 't', custom: { [p.id]: 1 } }));
    const renamed = await json(await a.request('PATCH', `/api/properties/${p.id}`, { name: '故事點' }));
    expect(renamed).toMatchObject({ name: '故事點', type: 'number' });
    expect((await a.request('DELETE', `/api/properties/${p.id}`)).status).toBe(200);
    expect((await a.request('DELETE', `/api/properties/${p.id}`)).status).toBe(404);
    expect(await json(await a.get('/api/properties'))).toEqual([]);
    expect((await json(await a.get(`/api/tasks/${t.id}`))).custom).toEqual({ [p.id]: 1 });
    expect(
      (
        await a.request('POST', '/api/properties', {
          name: 's',
          type: 'select',
          options: [
            { id: 'a', label: 'A' },
            { id: 'a', label: 'B' },
          ],
        })
      ).status,
    ).toBe(400);
    expect(changeCount()).toBe(before + 4);
  });
});
