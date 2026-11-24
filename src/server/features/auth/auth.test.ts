import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { client, login, loginAs } from '../../../../tests/helpers/auth.ts';
import {
  createFakeClock,
  createTestApp,
  createTestDb,
  createTestUser,
} from '../../../../tests/helpers/db.ts';
import { changes, users } from '../../db/schema.ts';
import { verifyPassword } from '../../lib/password.ts';
import { ensureAdmin } from '../users/service.ts';

const MIN = 60_000;

async function setup(settings = {}) {
  const clock = createFakeClock();
  const { app, db } = createTestApp({ now: clock.now, settings });
  const user = await createTestUser(db);
  return { app, db, clock, user };
}

describe('登入 / 登出', () => {
  it('正確帳密可登入，cookie 為 httpOnly + SameSite=Lax，DB 無明文密碼', async () => {
    const { app, db, user } = await setup();
    const res = await login(app, user.username);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toMatchObject({ id: user.id, username: user.username });
    expect(body.user.passwordHash).toBeUndefined();
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i);

    const row = db.select().from(users).where(eq(users.id, user.id)).get()!;
    expect(row.passwordHash).not.toContain(user.password);
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    const dump = JSON.stringify(db.$client.prepare('select * from sessions').all());
    expect(dump).not.toContain(cookie.split(';')[0]!.split('=')[1]);
  });

  it('正式環境（cookieSecure）cookie 帶 Secure', async () => {
    const { app, user } = await setup({ cookieSecure: true });
    const res = await login(app, user.username);
    expect(res.headers.get('set-cookie')).toMatch(/Secure/);
  });

  it('錯誤密碼與不存在的帳號都回 401 且訊息相同；停用帳號無法登入', async () => {
    const { app, db } = await setup();
    const u = await createTestUser(db);
    const inactive = await createTestUser(db, { isActive: false });
    const wrong = await login(app, u.username, 'wrong-password');
    const missing = await login(app, 'nobody', 'wrong-password');
    const disabled = await login(app, inactive.username);
    expect([wrong.status, missing.status, disabled.status]).toEqual([401, 401, 401]);
    const msgs = await Promise.all(
      [wrong, missing, disabled].map(async (r) => (await r.json()).error.message),
    );
    expect(new Set(msgs).size).toBe(1);
  });

  it('登出後 session 失效', async () => {
    const { app, user } = await setup();
    const api = await loginAs(app, user);
    expect((await api.get('/api/auth/me')).status).toBe(200);
    expect((await api.request('POST', '/api/auth/logout')).status).toBe(200);
    expect((await api.get('/api/auth/me')).status).toBe(401);
  });
});

describe('登入失敗限制', () => {
  it('同帳號 15 分鐘內失敗 5 次即鎖定（正確密碼亦 429），15 分鐘後可再登入', async () => {
    const { app, clock, user } = await setup();
    for (let i = 0; i < 5; i++) {
      expect((await login(app, user.username, 'bad-password')).status).toBe(401);
      clock.advance(MIN);
    }
    const locked = await login(app, user.username);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    // 鎖定自最後一次失敗（1 分鐘前）起算 15 分鐘
    expect((await locked.json()).error.details.retryAfterSeconds).toBe(14 * 60);

    // 不存在的帳號同樣會被鎖，不洩漏帳號是否存在
    for (let i = 0; i < 5; i++) await login(app, 'ghost', 'bad-password');
    expect((await login(app, 'ghost', 'bad-password')).status).toBe(429);

    clock.advance(14 * MIN - 1);
    expect((await login(app, user.username)).status).toBe(429);
    clock.advance(1);
    expect((await login(app, user.username)).status).toBe(200);
  });

  it('失敗分散在 15 分鐘以上不會鎖定；成功登入會重置計數', async () => {
    const { app, clock, user } = await setup();
    for (let i = 0; i < 4; i++) await login(app, user.username, 'bad-password');
    expect((await login(app, user.username)).status).toBe(200);
    for (let i = 0; i < 4; i++) await login(app, user.username, 'bad-password');
    expect((await login(app, user.username)).status).toBe(200);

    for (let i = 0; i < 6; i++) {
      expect((await login(app, user.username, 'bad-password')).status).toBe(401);
      clock.advance(4 * MIN);
    }
  });

  it('同 IP 15 分鐘內失敗 20 次即暫拒，其他 IP 不受影響', async () => {
    const { app, clock, user } = await setup();
    const ip = { 'x-forwarded-for': '10.0.0.9' };
    for (let i = 0; i < 20; i++) {
      expect((await login(app, `someone${i % 5}x${i}`, 'bad-password', ip)).status).toBe(401);
    }
    expect((await login(app, user.username, undefined, ip)).status).toBe(429);
    expect((await login(app, user.username, undefined, { 'x-forwarded-for': '10.0.0.10' })).status).toBe(200);
    clock.advance(15 * MIN);
    expect((await login(app, user.username, undefined, ip)).status).toBe(200);
  });
});

describe('session 期限', () => {
  it('登入 9 小時後失效（即使持續 heartbeat，不續期）', async () => {
    const { app, clock, user } = await setup();
    const api = await loginAs(app, user);
    for (let i = 0; i < 17; i++) {
      clock.advance(30 * MIN);
      expect((await api.request('POST', '/api/auth/heartbeat')).status).toBe(200);
    }
    clock.advance(30 * MIN - 1);
    expect((await api.get('/api/auth/me')).status).toBe(200);
    clock.advance(1);
    expect((await api.get('/api/auth/me')).status).toBe(401);
  });

  it('GET 輪詢不刷新閒置計時，閒置 60 分鐘後失效', async () => {
    const { app, clock, user } = await setup();
    const api = await loginAs(app, user);
    for (let i = 0; i < 59; i++) {
      clock.advance(MIN);
      expect((await api.get('/api/tasks')).status).toBe(200);
      await api.get('/api/events'); // SSE（目前為 stub）同樣不刷新
    }
    clock.advance(MIN);
    expect((await api.get('/api/tasks')).status).toBe(401);
  });

  it('heartbeat 與寫入請求會刷新閒置計時', async () => {
    const { app, clock, user } = await setup();
    const api = await loginAs(app, user);
    clock.advance(50 * MIN);
    const hb = await api.request('POST', '/api/auth/heartbeat');
    expect(hb.status).toBe(200);
    expect((await hb.json()).lastActiveAt).toBe(clock.now());
    clock.advance(50 * MIN);
    expect((await api.request('POST', '/api/tasks', { title: '寫入' })).status).toBe(201);
    clock.advance(59 * MIN);
    expect((await api.get('/api/auth/me')).status).toBe(200);
    clock.advance(MIN);
    expect((await api.get('/api/auth/me')).status).toBe(401);
  });

  it('閒置門檻可由設定調整', async () => {
    const { app, clock, user } = await setup({ idleTimeoutMs: 10 * MIN });
    const api = await loginAs(app, user);
    const me = await (await api.get('/api/auth/me')).json();
    expect(me.session.idleTimeoutMs).toBe(10 * MIN);
    expect(me.session.expiresAt).toBe(clock.now() + 9 * 60 * MIN);
    clock.advance(10 * MIN);
    expect((await api.get('/api/auth/me')).status).toBe(401);
  });
});

describe('改密碼', () => {
  it('需驗證目前密碼；成功後清除 must_change_password、舊密碼失效、其他 session 被撤銷', async () => {
    const { app, db, user } = await setup();
    db.update(users).set({ mustChangePassword: true }).where(eq(users.id, user.id)).run();
    const a = await loginAs(app, user);
    const b = await loginAs(app, user);
    expect((await (await a.get('/api/auth/me')).json()).user.mustChangePassword).toBe(true);

    const bad = await a.request('POST', '/api/auth/password', {
      currentPassword: 'nope',
      newPassword: 'new-password-1',
    });
    expect(bad.status).toBe(400);
    const ok = await a.request('POST', '/api/auth/password', {
      currentPassword: user.password,
      newPassword: 'new-password-1',
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).user.mustChangePassword).toBe(false);

    expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await b.get('/api/auth/me')).status).toBe(401);
    expect((await login(app, user.username)).status).toBe(401);
    expect((await login(app, user.username, 'new-password-1')).status).toBe(200);
    expect(db.select().from(changes).where(eq(changes.entityType, 'user')).all()).toHaveLength(1);
  });
});

describe('CSRF', () => {
  it('跨來源 Origin 或非 JSON 的寫入請求回 403', async () => {
    const { app, user } = await setup();
    const api = await loginAs(app, user);
    const evil = await api.request('POST', '/api/tasks', { title: 'x' }, { origin: 'http://evil.example' });
    expect(evil.status).toBe(403);
    const form = await api.request('POST', '/api/tasks', { title: 'x' }, { 'content-type': 'text/plain' });
    expect(form.status).toBe(403);
    const loginForm = await client(app).request(
      'POST',
      '/api/auth/login',
      { username: user.username, password: user.password },
      { origin: 'http://evil.example' },
    );
    expect(loginForm.status).toBe(403);
  });

  it('APP_ORIGIN 設定時只接受該 Origin', async () => {
    const { app, user } = await setup({ appOrigin: 'https://tasks.lab' });
    const api = await loginAs(app, user).catch(() => null);
    expect(api).toBeNull(); // 測試 client 送 http://localhost
    const ok = await login(app, user.username, undefined, { origin: 'https://tasks.lab' });
    expect(ok.status).toBe(200);
  });
});

describe('預設管理員', () => {
  it('未設定密碼時產生隨機密碼並只顯示一次，首次登入需改密碼', async () => {
    const db = createTestDb();
    const logs: string[] = [];
    const admin = await ensureAdmin(db, {}, (m) => logs.push(m));
    expect(admin).toMatchObject({ username: 'admin', role: 'admin', mustChangePassword: true });
    expect(logs).toHaveLength(1);
    const password = /初始密碼：(\S+?)（/.exec(logs[0]!)![1]!;
    expect(await verifyPassword(admin!.passwordHash, password)).toBe(true);
    // 已有帳號時不再建立
    expect(await ensureAdmin(db, {}, (m) => logs.push(m))).toBeNull();
    expect(logs).toHaveLength(1);
  });

  it('使用 ADMIN_USERNAME / ADMIN_PASSWORD，且不在 log 顯示密碼', async () => {
    const db = createTestDb();
    const logs: string[] = [];
    const admin = await ensureAdmin(db, { username: 'boss', password: 'env-password-1' }, (m) =>
      logs.push(m),
    );
    expect(admin!.username).toBe('boss');
    expect(await verifyPassword(admin!.passwordHash, 'env-password-1')).toBe(true);
    expect(logs.join()).not.toContain('env-password-1');
  });
});
