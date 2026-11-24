import { randomInt } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { isLastActiveAdmin, LAST_ADMIN_MESSAGE, type AdminUser } from '../../../shared/admin.ts';
import type { Db, DbOrTx } from '../../db/client.ts';
import { loginAttempts, sessions, users } from '../../db/schema.ts';
import type { UserRow } from '../../lib/context.ts';
import { conflict } from '../../lib/errors.ts';
import { loginBlockedFor } from '../../lib/rateLimit.ts';
import type { AuthSettings } from '../../lib/settings.ts';
import { toPublicUser } from '../users/service.ts';

/** 臨時密碼字元集：去除易混淆的 0 O 1 l I */
const TEMP_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 產生臨時密碼：3 組 4 碼，以 - 連接（如 k7Qm-2xRt-9vLp），約 70 bits 熵 */
export function generateTempPassword(): string {
  const group = () =>
    Array.from({ length: 4 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

/**
 * 該帳號的登入鎖定到期時間（未鎖定為 null）。只看「同帳號」鎖定，
 * 以不存在的 IP 呼叫 loginBlockedFor，讓 IP 條件永遠不成立。
 */
const NO_IP = '\u0000admin-lock-check';
export function lockedUntil(db: Db, settings: AuthSettings, username: string, t: number): number | null {
  const wait = loginBlockedFor(db, settings, username, NO_IP, t);
  return wait > 0 ? t + wait : null;
}

export function toAdminUser(db: Db, settings: AuthSettings, u: UserRow, t: number): AdminUser {
  return { ...toPublicUser(u), lockedUntil: lockedUntil(db, settings, u.username, t) };
}

/** 解除同帳號的登入鎖定：刪除該帳號的失敗紀錄 */
export function clearLoginFailures(db: DbOrTx, username: string): void {
  db.delete(loginAttempts)
    .where(and(eq(loginAttempts.username, username), eq(loginAttempts.success, false)))
    .run();
}

/** 讓某成員的 session 全部失效（停用、重設密碼）；keepId 為要保留的 session（重設自己時） */
export function revokeSessions(db: DbOrTx, userId: number, keepId?: string): void {
  db.delete(sessions)
    .where(and(eq(sessions.userId, userId), keepId ? ne(sessions.id, keepId) : undefined))
    .run();
}

/** 停用或降級前檢查：不可使系統沒有啟用中的管理員 */
export function assertKeepsAdmin(
  db: DbOrTx,
  target: UserRow,
  next: { role?: UserRow['role']; isActive?: boolean },
): void {
  const demoting = next.role !== undefined && next.role !== 'admin';
  const disabling = next.isActive === false;
  if (!demoting && !disabling) return;
  const all = db.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users).all();
  if (isLastActiveAdmin(target, all)) throw conflict(LAST_ADMIN_MESSAGE);
}
