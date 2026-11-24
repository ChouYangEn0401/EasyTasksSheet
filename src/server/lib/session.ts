import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { SessionInfo } from '../../shared/auth.ts';
import type { DbOrTx } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';
import type { AppEnv, SessionRow } from './context.ts';
import { forbidden, unauthorized } from './errors.ts';

export const SESSION_COOKIE = 'sid';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** 建立 session，回傳明文 token（只放 cookie，DB 只存其 SHA-256） */
export function createSession(c: Context<AppEnv>, userId: number): SessionRow {
  const { db, now, settings } = c.var;
  const t = now();
  // 順手清掉此人已過期的 session
  db.delete(sessions)
    .where(and(eq(sessions.userId, userId), lt(sessions.expiresAt, t)))
    .run();
  const token = randomBytes(32).toString('base64url');
  const row = db
    .insert(sessions)
    .values({
      id: hashToken(token),
      userId,
      createdAt: t,
      expiresAt: t + settings.sessionMaxMs,
      lastActiveAt: t,
    })
    .returning()
    .get();
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: settings.cookieSecure,
    maxAge: Math.floor(settings.sessionMaxMs / 1000),
  });
  return row;
}

/** 刪除目前請求的 session 並清 cookie（未登入亦可呼叫） */
export function destroySession(c: Context<AppEnv>): void {
  const token = getCookie(c, SESSION_COOKIE);
  if (token)
    c.var.db
      .delete(sessions)
      .where(eq(sessions.id, hashToken(token)))
      .run();
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: c.var.settings.cookieSecure });
}

/** 刪除某使用者除了 keepId 以外的所有 session（改密碼後使用） */
export function revokeOtherSessions(db: DbOrTx, userId: number, keepId: string): void {
  db.delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepId)))
    .run();
}

export function sessionInfo(c: Context<AppEnv>): SessionInfo {
  const s = c.var.session;
  return {
    expiresAt: s.expiresAt,
    lastActiveAt: s.lastActiveAt,
    idleTimeoutMs: c.var.settings.idleTimeoutMs,
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 需要有效 session。絕對期限（建立 + 9h，不續期）與閒置逾時皆在此判斷。
 * 只有非 GET 請求（寫入、heartbeat）會刷新 last_active_at；GET 輪詢與 SSE 不刷新。
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { db, now, settings } = c.var;
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw unauthorized();
  const id = hashToken(token);
  const session = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!session) throw unauthorized();
  const t = now();
  if (t >= session.expiresAt || t - session.lastActiveAt >= settings.idleTimeoutMs) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    throw unauthorized('登入已逾時，請重新登入');
  }
  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  if (!user || !user.isActive) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    throw unauthorized();
  }
  if (!SAFE_METHODS.has(c.req.method)) {
    db.update(sessions).set({ lastActiveAt: t }).where(eq(sessions.id, id)).run();
    session.lastActiveAt = t;
  }
  c.set('session', session);
  c.set('user', user);
  await next();
};

/**
 * CSRF 防護（搭配 SameSite=Lax cookie）：修改類請求若帶 Origin 必須同源，
 * 且 POST / PUT / PATCH 必須是 application/json（跨站表單無法送出 JSON 而不觸發 preflight）。
 */
export const csrfGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin && !isAllowedOrigin(origin, c)) throw forbidden('來源不被允許');
    if (
      c.req.method !== 'DELETE' &&
      !c.req.header('content-type')?.toLowerCase().startsWith('application/json')
    ) {
      throw forbidden('Content-Type 須為 application/json');
    }
  }
  await next();
};

function isAllowedOrigin(origin: string, c: Context<AppEnv>): boolean {
  const allowed = c.var.settings.appOrigin;
  if (allowed) return origin === allowed.replace(/\/$/, '');
  try {
    return new URL(origin).host === (c.req.header('host') ?? new URL(c.req.url).host);
  } catch {
    return false;
  }
}
