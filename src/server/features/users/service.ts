import { randomBytes } from 'node:crypto';
import { count } from 'drizzle-orm';
import type { PublicUser, UserRole } from '../../../shared/users.ts';
import type { Db } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import type { UserRow } from '../../lib/context.ts';
import { hashPassword } from '../../lib/password.ts';
import { recordChange } from '../../lib/recordChange.ts';

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    isActive: u.isActive,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export const randomPassword = () => randomBytes(12).toString('base64url');

export type NewUser = {
  username: string;
  displayName?: string;
  password: string;
  role?: UserRole;
  mustChangePassword?: boolean;
  actorId?: number | null;
};

/** 建立帳號（雜湊密碼、記錄變更）；帳號重複時由 DB unique 約束拋錯 */
export async function createUser(db: Db, input: NewUser): Promise<UserRow> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction((tx) => {
    const row = tx
      .insert(users)
      .values({
        username: input.username,
        displayName: input.displayName ?? input.username,
        passwordHash,
        role: input.role ?? 'member',
        mustChangePassword: input.mustChangePassword ?? true,
      })
      .returning()
      .get();
    recordChange(tx, {
      entityType: 'user',
      entityId: row.id,
      action: 'create',
      actorId: input.actorId ?? null,
    });
    return row;
  });
}

/**
 * 首次啟動（尚無任何帳號）時建立管理員：帳密取自 ADMIN_USERNAME / ADMIN_PASSWORD；
 * 未設定密碼則產生隨機密碼並只在主控台顯示一次。首次登入強制改密碼。
 */
export async function ensureAdmin(
  db: Db,
  env: { username?: string; password?: string },
  log: (msg: string) => void = console.log,
): Promise<UserRow | null> {
  if (db.select({ n: count() }).from(users).get()!.n > 0) return null;
  const username = env.username || 'admin';
  const password = env.password || randomPassword();
  const user = await createUser(db, { username, displayName: '管理員', password, role: 'admin' });
  log(
    env.password
      ? `[auth] 已建立管理員帳號 ${username}（密碼取自 ADMIN_PASSWORD，首次登入需變更）`
      : `[auth] 已建立管理員帳號 ${username}，初始密碼：${password}（只顯示這一次，首次登入需變更）`,
  );
  return user;
}
