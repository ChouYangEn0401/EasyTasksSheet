import { asc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  adminUserCreateInput,
  adminUserUpdateInput,
  USERNAME_TAKEN_MESSAGE,
  type AdminTempPasswordResponse,
} from '../../../shared/admin.ts';
import { idParam } from '../../../shared/common.ts';
import type { DbOrTx } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import type { AppEnv, UserRow } from '../../lib/context.ts';
import { conflict, forbidden, HttpError, notFound } from '../../lib/errors.ts';
import { hashPassword } from '../../lib/password.ts';
import { recordChange } from '../../lib/recordChange.ts';
import { readJson } from '../../lib/validate.ts';
import { createUser } from '../users/service.ts';
import {
  assertKeepsAdmin,
  clearLoginFailures,
  generateTempPassword,
  revokeSessions,
  toAdminUser,
} from './service.ts';

const NOT_FOUND = '找不到此成員';

const findUser = (db: DbOrTx, id: number) => db.select().from(users).where(eq(users.id, id)).get();

function loadTarget(c: Context<AppEnv>): UserRow {
  const id = idParam.parse(c.req.param('id'));
  const row = findUser(c.var.db, id);
  if (!row) throw notFound(NOT_FOUND);
  return row;
}

const present = (c: Context<AppEnv>, u: UserRow) => toAdminUser(c.var.db, c.var.settings, u, c.var.now());

const usernameTaken = () => new HttpError(409, 'CONFLICT', USERNAME_TAKEN_MESSAGE, { field: 'username' });

/**
 * 掛載於 /api/admin（已經 session middleware）；全部端點僅限 role=admin，其餘回 403。
 * 所有寫入皆呼叫 recordChange()（entity = user）。
 */
export const adminRoutes = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    if (c.var.user.role !== 'admin') throw forbidden('此功能僅限管理員使用');
    await next();
  })
  .get('/users', (c) => {
    const { db, settings, now } = c.var;
    const t = now();
    const rows = db.select().from(users).orderBy(asc(users.id)).all();
    return c.json(rows.map((u) => toAdminUser(db, settings, u, t)));
  })
  .post('/users', async (c) => {
    const { db, user } = c.var;
    const input = await readJson(c, adminUserCreateInput);
    if (db.select({ id: users.id }).from(users).where(eq(users.username, input.username)).get()) {
      throw usernameTaken();
    }
    const tempPassword = generateTempPassword();
    let row: UserRow;
    try {
      row = await createUser(db, {
        username: input.username,
        displayName: input.displayName,
        role: input.role,
        password: tempPassword,
        mustChangePassword: true,
        actorId: user.id,
      });
    } catch (err) {
      // 並行建立同帳號：由 DB unique 約束擋下
      if (String((err as { code?: string })?.code).startsWith('SQLITE_CONSTRAINT')) throw usernameTaken();
      throw err;
    }
    // 同名帳號先前的登入失敗紀錄不延續到新帳號
    clearLoginFailures(db, row.username);
    const body: AdminTempPasswordResponse = { user: present(c, row), tempPassword };
    return c.json(body, 201);
  })
  .patch('/users/:id', async (c) => {
    const { db, now, user } = c.var;
    const target = loadTarget(c);
    const input = await readJson(c, adminUserUpdateInput);
    const patch: Partial<Pick<UserRow, 'displayName' | 'role' | 'isActive'>> = {};
    if (input.displayName !== undefined && input.displayName !== target.displayName)
      patch.displayName = input.displayName;
    if (input.role !== undefined && input.role !== target.role) patch.role = input.role;
    if (input.isActive !== undefined && input.isActive !== target.isActive) patch.isActive = input.isActive;
    if (Object.keys(patch).length === 0) return c.json(present(c, target));

    const updated = db.transaction((tx) => {
      assertKeepsAdmin(tx, target, patch);
      const row = tx
        .update(users)
        .set({ ...patch, updatedAt: now() })
        .where(eq(users.id, target.id))
        .returning()
        .get();
      // 停用：既有 session 立即失效（含停用自己）
      if (patch.isActive === false) revokeSessions(tx, target.id);
      recordChange(tx, { entityType: 'user', entityId: target.id, action: 'update', actorId: user.id });
      return row;
    });
    return c.json(present(c, updated));
  })
  .post('/users/:id/reset-password', async (c) => {
    const { db, now, user, session } = c.var;
    const target = loadTarget(c);
    if (!target.isActive) throw conflict('已停用的成員無法重設密碼，請先啟用');
    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const updated = db.transaction((tx) => {
      const row = tx
        .update(users)
        .set({ passwordHash, mustChangePassword: true, updatedAt: now() })
        .where(eq(users.id, target.id))
        .returning()
        .get();
      // 原密碼立即失效：該成員其他裝置的登入一併登出（重設自己時保留目前這個 session）
      revokeSessions(tx, target.id, target.id === user.id ? session.id : undefined);
      clearLoginFailures(tx, target.username);
      recordChange(tx, { entityType: 'user', entityId: target.id, action: 'update', actorId: user.id });
      return row;
    });
    const body: AdminTempPasswordResponse = { user: present(c, updated), tempPassword };
    return c.json(body);
  })
  .post('/users/:id/unlock', (c) => {
    const { db, user } = c.var;
    const target = loadTarget(c);
    db.transaction((tx) => {
      clearLoginFailures(tx, target.username);
      recordChange(tx, { entityType: 'user', entityId: target.id, action: 'update', actorId: user.id });
    });
    return c.json(present(c, findUser(db, target.id)!));
  });
