import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { changePasswordInput, loginInput, type MeResponse } from '../../../shared/auth.ts';
import { users } from '../../db/schema.ts';
import type { AppEnv } from '../../lib/context.ts';
import { badRequest, HttpError, unauthorized } from '../../lib/errors.ts';
import { hashPassword, verifyPassword } from '../../lib/password.ts';
import { loginBlockedFor, recordLoginAttempt } from '../../lib/rateLimit.ts';
import { recordChange } from '../../lib/recordChange.ts';
import { createSession, destroySession, revokeOtherSessions, sessionInfo } from '../../lib/session.ts';
import { readJson } from '../../lib/validate.ts';
import { toPublicUser } from '../users/service.ts';

const LOGIN_FAILED = '帳號或密碼不正確';

let dummy: Promise<string> | undefined;
/** 帳號不存在時用來比對的假雜湊，使回應時間與帳號存在時相近 */
const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString('hex')));

/** 用戶端 IP：反向代理（Caddy）會覆寫 X-Forwarded-For，取第一段；直連時取 socket 位址 */
function clientIp(c: Context<AppEnv>): string {
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (fwd) return fwd;
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

const me = (c: Context<AppEnv>): MeResponse => ({ user: toPublicUser(c.var.user), session: sessionInfo(c) });

/** 掛載於 /api/auth；login、logout 為公開路由，其餘經 session middleware */
export const authRoutes = new Hono<AppEnv>()
  .post('/login', async (c) => {
    const { db, now, settings } = c.var;
    const input = await readJson(c, loginInput);
    const ip = clientIp(c);
    const t = now();
    const waitMs = loginBlockedFor(db, settings, input.username, ip, t);
    if (waitMs > 0) {
      const retryAfterSeconds = Math.ceil(waitMs / 1000);
      c.header('Retry-After', String(retryAfterSeconds));
      throw new HttpError(429, 'TOO_MANY_REQUESTS', '嘗試次數過多，請稍後再試', { retryAfterSeconds });
    }
    const user = db.select().from(users).where(eq(users.username, input.username)).get();
    // 帳號不存在時仍做一次雜湊比對，避免以回應時間推測帳號是否存在
    const ok = await verifyPassword(user?.passwordHash ?? (await dummyHash()), input.password);
    const success = ok && !!user?.isActive;
    recordLoginAttempt(db, input.username, ip, success, t);
    if (!success || !user) throw unauthorized(LOGIN_FAILED);

    const session = createSession(c, user.id);
    c.set('user', user);
    c.set('session', session);
    return c.json(me(c));
  })
  .post('/logout', (c) => {
    destroySession(c);
    return c.json({ ok: true as const });
  })
  .get('/me', (c) => c.json(me(c)))
  .post('/heartbeat', (c) => c.json(sessionInfo(c)))
  .post('/password', async (c) => {
    const { db, now } = c.var;
    const input = await readJson(c, changePasswordInput);
    const user = c.var.user;
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) throw badRequest('目前密碼不正確');
    if (input.newPassword === input.currentPassword) throw badRequest('新密碼不可與目前密碼相同');
    const passwordHash = await hashPassword(input.newPassword);
    const updated = db.transaction((tx) => {
      const row = tx
        .update(users)
        .set({ passwordHash, mustChangePassword: false, updatedAt: now() })
        .where(eq(users.id, user.id))
        .returning()
        .get();
      revokeOtherSessions(tx, user.id, c.var.session.id);
      recordChange(tx, { entityType: 'user', entityId: user.id, action: 'update', actorId: user.id });
      return row;
    });
    c.set('user', updated);
    return c.json(me(c));
  });
