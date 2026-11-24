import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AdminTempPasswordResponse, AdminUser } from '../../../shared/admin.ts';
import { isLastActiveAdmin } from '../../../shared/admin.ts';
import { client, login, loginAs } from '../../../../tests/helpers/auth.ts';
import { createFakeClock, createTestApp, createTestUser } from '../../../../tests/helpers/db.ts';
import { changes, sessions, users } from '../../db/schema.ts';
import { generateTempPassword } from './service.ts';

const MIN = 60_000;

async function setup() {
  const clock = createFakeClock();
  const { app, db } = createTestApp({ now: clock.now });
  const admin = await createTestUser(db, { role: 'admin' });
  const member = await createTestUser(db);
  const adminApi = await loginAs(app, admin);
  return { app, db, clock, admin, member, adminApi };
}

const changeCount = (db: ReturnType<typeof createTestApp>['db'], userId: number) =>
  db
    .select()
    .from(changes)
    .where(eq(changes.entityId, userId))
    .all()
    .filter((c) => c.entityType === 'user').length;

describe('權限', () => {
  it('一般成員存取 /api/admin/* 一律 403；未登入 401', async () => {
    const { app, member } = await setup();
    const api = await loginAs(app, member);
    const calls = [
      api.get('/api/admin/users'),
      api.request('POST', '/api/admin/users', { username: 'x-user', displayName: 'X' }),
      api.request('PATCH', `/api/admin/users/${member.id}`, { role: 'admin' }),
      api.request('POST', `/api/admin/users/${member.id}/reset-password`),
      api.request('POST', `/api/admin/users/${member.id}/unlock`),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
    expect((await client(app).get('/api/admin/users')).status).toBe(401);
  });
});

describe('列出與新增', () => {
  it('列出全部成員（含停用者），不含 passwordHash', async () => {
    const { db, adminApi } = await setup();
    await createTestUser(db, { isActive: false });
    const res = await adminApi.get('/api/admin/users');
    expect(res.status).toBe(200);
    const list = (await res.json()) as AdminUser[];
    expect(list).toHaveLength(3);
    expect(list.some((u) => !u.isActive)).toBe(true);
    expect(JSON.stringify(list)).not.toContain('argon2');
    expect(list.every((u) => u.lockedUntil === null)).toBe(true);
  });

  it('新增成員回傳一次臨時密碼；可用該密碼登入且須改密碼；記錄變更', async () => {
    const { app, db, admin, adminApi } = await setup();
    const res = await adminApi.request('POST', '/api/admin/users', {
      username: '  New.User ',
      displayName: '李大華',
      role: 'member',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as AdminTempPasswordResponse;
    expect(body.user).toMatchObject({
      username: 'new.user',
      displayName: '李大華',
      mustChangePassword: true,
    });
    expect(body.tempPassword).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);

    const row = db.select().from(users).where(eq(users.id, body.user.id)).get()!;
    expect(row.passwordHash).not.toContain(body.tempPassword);
    const log = db.select().from(changes).where(eq(changes.entityId, body.user.id)).all();
    expect(log).toContainEqual(
      expect.objectContaining({ entityType: 'user', action: 'create', actorId: admin.id }),
    );

    const loginRes = await login(app, 'new.user', body.tempPassword);
    expect(loginRes.status).toBe(200);
    expect((await loginRes.json()).user.mustChangePassword).toBe(true);
    // 列表不再回傳臨時密碼
    expect(await (await adminApi.get('/api/admin/users')).text()).not.toContain(body.tempPassword);
  });

  it('帳號重複回 409「此帳號已被使用」；格式錯誤回 400', async () => {
    const { member, adminApi } = await setup();
    const dup = await adminApi.request('POST', '/api/admin/users', {
      username: member.username.toUpperCase(),
      displayName: 'Dup',
    });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toMatchObject({
      message: '此帳號已被使用',
      details: { field: 'username' },
    });
    for (const username of ['ab', '有中文', '-start', 'a b c']) {
      const bad = await adminApi.request('POST', '/api/admin/users', { username, displayName: 'X' });
      expect(bad.status, username).toBe(400);
    }
    const noName = await adminApi.request('POST', '/api/admin/users', {
      username: 'okname',
      displayName: ' ',
    });
    expect(noName.status).toBe(400);
  });

  it('臨時密碼：每次不同，長度 14', () => {
    const set = new Set(Array.from({ length: 50 }, generateTempPassword));
    expect(set.size).toBe(50);
    for (const p of set) expect(p).toHaveLength(14);
  });
});

describe('編輯、停用 / 啟用', () => {
  it('調整顯示名稱與角色；updatedAt 更新並記錄變更', async () => {
    const { db, clock, member, adminApi } = await setup();
    const before = changeCount(db, member.id);
    clock.advance(5 * MIN);
    const res = await adminApi.request('PATCH', `/api/admin/users/${member.id}`, {
      displayName: '新名字',
      role: 'admin',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminUser;
    expect(body).toMatchObject({ displayName: '新名字', role: 'admin' });
    expect(body.updatedAt).toBe(clock.now());
    expect(changeCount(db, member.id)).toBe(before + 1);
  });

  it('不接受修改帳號或未知欄位', async () => {
    const { member, adminApi } = await setup();
    const res = await adminApi.request('PATCH', `/api/admin/users/${member.id}`, { username: 'hacked' });
    expect(res.status).toBe(400);
    expect((await adminApi.request('PATCH', '/api/admin/users/9999', { displayName: 'x' })).status).toBe(404);
  });

  it('停用後該成員既有 session 立即失效、無法登入；重新啟用後可登入', async () => {
    const { app, db, member, adminApi } = await setup();
    const memberApi = await loginAs(app, member);
    const memberApi2 = await loginAs(app, member);
    expect((await memberApi.get('/api/auth/me')).status).toBe(200);

    const res = await adminApi.request('PATCH', `/api/admin/users/${member.id}`, { isActive: false });
    expect(res.status).toBe(200);
    expect((await res.json()).isActive).toBe(false);
    expect(db.select().from(sessions).where(eq(sessions.userId, member.id)).all()).toHaveLength(0);
    expect((await memberApi.get('/api/auth/me')).status).toBe(401);
    expect((await memberApi2.get('/api/tasks')).status).toBe(401);
    expect((await login(app, member.username)).status).toBe(401);

    const on = await adminApi.request('PATCH', `/api/admin/users/${member.id}`, { isActive: true });
    expect((await on.json()).isActive).toBe(true);
    expect((await login(app, member.username)).status).toBe(200);
  });

  it('不可停用或降級最後一位管理員（409）；有其他管理員時可以', async () => {
    const { db, admin, adminApi } = await setup();
    // 停用中的管理員不算數
    await createTestUser(db, { role: 'admin', isActive: false });
    for (const patch of [{ isActive: false }, { role: 'member' }]) {
      const res = await adminApi.request('PATCH', `/api/admin/users/${admin.id}`, patch);
      expect(res.status).toBe(409);
      expect((await res.json()).error.message).toBe('至少需保留一位管理員');
    }
    expect(db.select().from(users).where(eq(users.id, admin.id)).get()).toMatchObject({
      role: 'admin',
      isActive: true,
    });

    await createTestUser(db, { role: 'admin' });
    const demote = await adminApi.request('PATCH', `/api/admin/users/${admin.id}`, { role: 'member' });
    expect(demote.status).toBe(200);
    // 降級後自己已非管理員
    expect((await adminApi.get('/api/admin/users')).status).toBe(403);
  });

  it('停用自己（仍有其他管理員）會立即登出', async () => {
    const { db, admin, adminApi } = await setup();
    await createTestUser(db, { role: 'admin' });
    const res = await adminApi.request('PATCH', `/api/admin/users/${admin.id}`, { isActive: false });
    expect(res.status).toBe(200);
    expect((await adminApi.get('/api/auth/me')).status).toBe(401);
  });
});

describe('重設密碼與解除鎖定', () => {
  it('重設密碼：舊密碼失效、session 失效、須改密碼，回傳一次臨時密碼並記錄變更', async () => {
    const { app, db, member, adminApi } = await setup();
    const memberApi = await loginAs(app, member);
    const before = changeCount(db, member.id);
    const res = await adminApi.request('POST', `/api/admin/users/${member.id}/reset-password`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminTempPasswordResponse;
    expect(body.user.mustChangePassword).toBe(true);
    expect((await memberApi.get('/api/auth/me')).status).toBe(401);
    expect((await login(app, member.username)).status).toBe(401);
    expect((await login(app, member.username, body.tempPassword)).status).toBe(200);
    expect(changeCount(db, member.id)).toBe(before + 1);
  });

  it('重設自己的密碼時保留目前 session', async () => {
    const { admin, adminApi } = await setup();
    const res = await adminApi.request('POST', `/api/admin/users/${admin.id}/reset-password`);
    expect(res.status).toBe(200);
    const me = await adminApi.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect((await me.json()).user.mustChangePassword).toBe(true);
  });

  it('已停用的成員不可重設密碼', async () => {
    const { db, adminApi } = await setup();
    const off = await createTestUser(db, { isActive: false });
    expect((await adminApi.request('POST', `/api/admin/users/${off.id}/reset-password`)).status).toBe(409);
  });

  it('連續失敗被鎖定時列表顯示 lockedUntil；解除鎖定後可立即登入並記錄變更', async () => {
    const { app, db, clock, member, adminApi } = await setup();
    for (let i = 0; i < 5; i++) {
      await login(app, member.username, 'wrong-password');
      clock.advance(MIN);
    }
    expect((await login(app, member.username)).status).toBe(429);

    const list = (await (await adminApi.get('/api/admin/users')).json()) as AdminUser[];
    const locked = list.find((u) => u.id === member.id)!;
    expect(locked.lockedUntil).toBeGreaterThan(clock.now());

    const before = changeCount(db, member.id);
    const res = await adminApi.request('POST', `/api/admin/users/${member.id}/unlock`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as AdminUser).lockedUntil).toBeNull();
    expect(changeCount(db, member.id)).toBe(before + 1);
    expect((await login(app, member.username)).status).toBe(200);
  });
});

describe('isLastActiveAdmin', () => {
  const a = (id: number, role: string, isActive = true) => ({ id, role, isActive });
  it('只在目標為唯一啟用中管理員時為 true', () => {
    expect(isLastActiveAdmin(a(1, 'admin'), [a(1, 'admin'), a(2, 'member')])).toBe(true);
    expect(isLastActiveAdmin(a(1, 'admin'), [a(1, 'admin'), a(2, 'admin', false)])).toBe(true);
    expect(isLastActiveAdmin(a(1, 'admin'), [a(1, 'admin'), a(2, 'admin')])).toBe(false);
    expect(isLastActiveAdmin(a(2, 'member'), [a(1, 'admin'), a(2, 'member')])).toBe(false);
    expect(isLastActiveAdmin(a(1, 'admin', false), [a(1, 'admin', false)])).toBe(false);
  });
});
