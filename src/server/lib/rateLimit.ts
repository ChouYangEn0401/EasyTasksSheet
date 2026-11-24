import { and, desc, eq, gt, lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { loginAttempts } from '../db/schema.ts';
import type { AuthSettings } from './settings.ts';

/**
 * 回傳仍需等待的毫秒數（0 = 可嘗試）。
 * - 同帳號：最近一次成功之後、在 window 內累積 maxFailsPerUser 次失敗 → 自最後一次失敗起鎖 lockMs。
 * - 同 IP：window 內失敗達 maxFailsPerIp 次 → 暫拒至最舊那筆滑出 window。
 */
export function loginBlockedFor(db: Db, s: AuthSettings, username: string, ip: string, t: number): number {
  // 帳號：取最近 N 筆嘗試（含成功），若全為失敗且落在 window 內即鎖定
  const recent = db
    .select()
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.username, username),
        gt(loginAttempts.createdAt, t - s.loginWindowMs - s.loginLockMs),
      ),
    )
    .orderBy(desc(loginAttempts.createdAt), desc(loginAttempts.id))
    .limit(s.loginMaxFailsPerUser)
    .all();
  if (recent.length === s.loginMaxFailsPerUser && recent.every((a) => !a.success)) {
    const newest = recent[0]!.createdAt;
    const oldest = recent.at(-1)!.createdAt;
    if (newest - oldest < s.loginWindowMs && t < newest + s.loginLockMs) return newest + s.loginLockMs - t;
  }

  const ipFails = db
    .select({ createdAt: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.ip, ip),
        eq(loginAttempts.success, false),
        gt(loginAttempts.createdAt, t - s.loginWindowMs),
      ),
    )
    .orderBy(desc(loginAttempts.createdAt))
    .limit(s.loginMaxFailsPerIp)
    .all();
  if (ipFails.length >= s.loginMaxFailsPerIp) return ipFails.at(-1)!.createdAt + s.loginWindowMs - t;
  return 0;
}

export function recordLoginAttempt(db: Db, username: string, ip: string, success: boolean, t: number): void {
  db.insert(loginAttempts).values({ username, ip, success, createdAt: t }).run();
  // 清除一天前的紀錄，避免表無限成長
  db.delete(loginAttempts)
    .where(lt(loginAttempts.createdAt, t - 86_400_000))
    .run();
}
