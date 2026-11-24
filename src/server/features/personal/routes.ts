import { and, asc, desc, eq, isNotNull, isNull, min } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { idParam } from '../../../shared/common.ts';
import {
  personalCreateInput,
  personalUpdateInput,
  personalUserQuery,
  type PinnedTask,
} from '../../../shared/personal.ts';
import type { DbOrTx } from '../../db/client.ts';
import { personalItems, tasks, users } from '../../db/schema.ts';
import type { AppEnv } from '../../lib/context.ts';
import { badRequest, forbidden, notFound } from '../../lib/errors.ts';
import { recordChange } from '../../lib/recordChange.ts';
import { readJson, readQuery } from '../../lib/validate.ts';

const NOT_FOUND = '此待辦不存在或已被刪除';
const FORBIDDEN = '只有本人可以修改自己的清單';

/** 讀取的目標成員：?user=<id>（他人須存在且未停用），省略即本人 */
function readTarget(c: Context<AppEnv>): number {
  const { user } = readQuery(c, personalUserQuery);
  const me = c.var.user.id;
  if (user == null || user === me) return me;
  const row = c.var.db.select().from(users).where(eq(users.id, user)).get();
  if (!row || !row.isActive) throw notFound('找不到這位成員');
  return user;
}

/** 寫入只能針對本人：?user= 指定他人即 403 */
function assertSelfWrite(c: Context<AppEnv>) {
  const { user } = readQuery(c, personalUserQuery);
  if (user != null && user !== c.var.user.id) throw forbidden(FORBIDDEN);
}

/** 取自己的自由待辦；他人的回 403、不存在或為標記列回 404 */
function findOwnTodo(db: DbOrTx, id: number, me: number) {
  const row = db.select().from(personalItems).where(eq(personalItems.id, id)).get();
  if (!row || row.taskId != null) throw notFound(NOT_FOUND);
  if (row.userId !== me) throw forbidden(FORBIDDEN);
  return row;
}

const findTask = (db: DbOrTx, id: number) =>
  db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
    .get();

const todosOf = (userId: number) => and(eq(personalItems.userId, userId), isNull(personalItems.taskId));

/**
 * 掛載於 /api/personal。所有成員可唯讀檢視他人清單；只有本人能改自己的清單。
 * - GET /           自由待辦（依 sortOrder）
 * - POST /          新增自由待辦（排在最上方）
 * - PATCH /:id      改標題 / 備註 / 完成 / 排序
 * - DELETE /done    清除已完成
 * - DELETE /:id     刪除
 * - GET /pins       標記的任務（依標記時間新→舊，排除已刪除任務）
 * - PUT|DELETE /pins/:taskId  標記 / 取消標記（冪等）
 */
export const personalRoutes = new Hono<AppEnv>()
  .get('/', (c) => {
    const userId = readTarget(c);
    const rows = c.var.db
      .select()
      .from(personalItems)
      .where(todosOf(userId))
      .orderBy(asc(personalItems.sortOrder), asc(personalItems.id))
      .all();
    return c.json(rows);
  })
  .post('/', async (c) => {
    assertSelfWrite(c);
    const { db, now, user } = c.var;
    const input = await readJson(c, personalCreateInput);
    const row = db.transaction((tx) => {
      const top = tx
        .select({ m: min(personalItems.sortOrder) })
        .from(personalItems)
        .where(todosOf(user.id))
        .get();
      const t = now();
      const created = tx
        .insert(personalItems)
        .values({
          userId: user.id,
          title: input.title,
          note: input.note ?? '',
          sortOrder: top?.m == null ? 0 : Number(top.m) - 1,
          createdAt: t,
          updatedAt: t,
        })
        .returning()
        .get();
      recordChange(tx, { entityType: 'personal', entityId: created.id, action: 'create', actorId: user.id });
      return created;
    });
    return c.json(row, 201);
  })
  .get('/pins', (c) => {
    const userId = readTarget(c);
    const rows: PinnedTask[] = c.var.db
      .select({ pin: personalItems, task: tasks })
      .from(personalItems)
      .innerJoin(tasks, eq(personalItems.taskId, tasks.id))
      .where(and(eq(personalItems.userId, userId), isNotNull(personalItems.taskId), isNull(tasks.deletedAt)))
      .orderBy(desc(personalItems.createdAt), desc(personalItems.id))
      .all();
    return c.json(rows);
  })
  .put('/pins/:taskId', (c) => {
    assertSelfWrite(c);
    const { db, now, user } = c.var;
    const taskId = idParam.parse(c.req.param('taskId'));
    const result = db.transaction((tx) => {
      const task = findTask(tx, taskId);
      if (!task) throw notFound('此任務不存在或已被刪除');
      const existing = tx
        .select()
        .from(personalItems)
        .where(and(eq(personalItems.userId, user.id), eq(personalItems.taskId, taskId)))
        .get();
      if (existing) return { pin: existing, created: false };
      const t = now();
      const pin = tx
        .insert(personalItems)
        .values({ userId: user.id, taskId, title: '', createdAt: t, updatedAt: t })
        .returning()
        .get();
      recordChange(tx, { entityType: 'personal', entityId: pin.id, action: 'create', actorId: user.id });
      return { pin, created: true };
    });
    return c.json(result.pin, result.created ? 201 : 200);
  })
  .delete('/pins/:taskId', (c) => {
    assertSelfWrite(c);
    const { db, user } = c.var;
    const taskId = idParam.parse(c.req.param('taskId'));
    db.transaction((tx) => {
      const existing = tx
        .select()
        .from(personalItems)
        .where(and(eq(personalItems.userId, user.id), eq(personalItems.taskId, taskId)))
        .get();
      if (!existing) return; // 冪等：本來就沒標記
      tx.delete(personalItems).where(eq(personalItems.id, existing.id)).run();
      recordChange(tx, { entityType: 'personal', entityId: existing.id, action: 'delete', actorId: user.id });
    });
    return c.json({ ok: true as const });
  })
  .delete('/done', (c) => {
    assertSelfWrite(c);
    const { db, user } = c.var;
    const deleted = db.transaction((tx) => {
      const rows = tx
        .delete(personalItems)
        .where(and(todosOf(user.id), eq(personalItems.isDone, true)))
        .returning({ id: personalItems.id })
        .all();
      for (const r of rows) {
        recordChange(tx, { entityType: 'personal', entityId: r.id, action: 'delete', actorId: user.id });
      }
      return rows.length;
    });
    return c.json({ ok: true as const, deleted });
  })
  .patch('/:id', async (c) => {
    assertSelfWrite(c);
    const { db, now, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    const input = await readJson(c, personalUpdateInput);
    if (Object.keys(input).length === 0) throw badRequest('沒有要修改的欄位');
    const row = db.transaction((tx) => {
      findOwnTodo(tx, id, user.id);
      const updated = tx
        .update(personalItems)
        .set({ ...input, updatedAt: now() })
        .where(eq(personalItems.id, id))
        .returning()
        .get();
      recordChange(tx, { entityType: 'personal', entityId: id, action: 'update', actorId: user.id });
      return updated;
    });
    return c.json(row);
  })
  .delete('/:id', (c) => {
    assertSelfWrite(c);
    const { db, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    db.transaction((tx) => {
      findOwnTodo(tx, id, user.id);
      tx.delete(personalItems).where(eq(personalItems.id, id)).run();
      recordChange(tx, { entityType: 'personal', entityId: id, action: 'delete', actorId: user.id });
    });
    return c.json({ ok: true as const });
  });
