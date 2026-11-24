import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { idParam } from '../../../shared/common.ts';
import {
  taskCreateInput,
  taskListQuery,
  taskUpdateInput,
  type TaskUpdateInput,
} from '../../../shared/tasks.ts';
import type { DbOrTx } from '../../db/client.ts';
import { projects, statuses, tasks, users } from '../../db/schema.ts';
import type { AppEnv } from '../../lib/context.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { recordChange } from '../../lib/recordChange.ts';
import { nextSortOrder } from '../../lib/sortOrder.ts';
import { readJson, readQuery } from '../../lib/validate.ts';
import { mergeCustomValues } from '../properties/custom.ts';

/** 外鍵欄位需指向存在的資料，否則回 400（而非 DB 約束錯誤的 500） */
function checkRefs(db: DbOrTx, input: TaskUpdateInput) {
  if (
    input.projectId !== undefined &&
    !db.select().from(projects).where(eq(projects.id, input.projectId)).get()
  ) {
    throw badRequest('專案不存在');
  }
  if (
    input.statusId !== undefined &&
    !db.select().from(statuses).where(eq(statuses.id, input.statusId)).get()
  ) {
    throw badRequest('狀態不存在');
  }
  if (input.assigneeId != null && !db.select().from(users).where(eq(users.id, input.assigneeId)).get()) {
    throw badRequest('負責人不存在');
  }
}

const findTask = (db: DbOrTx, id: number) =>
  db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), isNull(tasks.deletedAt)))
    .get();

/** 掛載於 /api/tasks；所有成員可讀寫所有任務，刪除為軟刪除 */
export const tasksRoutes = new Hono<AppEnv>()
  .get('/', (c) => {
    const query = readQuery(c, taskListQuery);
    const conds: (SQL | undefined)[] = [isNull(tasks.deletedAt)];
    if (query.project) conds.push(inArray(tasks.projectId, query.project));
    if (query.status) conds.push(inArray(tasks.statusId, query.status));
    if (query.assignee) {
      const { ids, none } = query.assignee;
      conds.push(
        or(
          ids.length ? inArray(tasks.assigneeId, ids) : undefined,
          none ? isNull(tasks.assigneeId) : undefined,
        ),
      );
    }
    if (query.q) conds.push(sql`instr(lower(${tasks.title}), lower(${query.q})) > 0`);
    const rows = c.var.db
      .select()
      .from(tasks)
      .where(and(...conds))
      .orderBy(asc(tasks.sortOrder), asc(tasks.id))
      .all();
    return c.json(rows);
  })
  .post('/', async (c) => {
    const { db, now, user } = c.var;
    const input = await readJson(c, taskCreateInput);
    const row = db.transaction((tx) => {
      checkRefs(tx, input);
      const projectId =
        input.projectId ??
        tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.isArchived, false))
          .orderBy(asc(projects.sortOrder), asc(projects.id))
          .get()?.id;
      const statusId =
        input.statusId ??
        tx.select({ id: statuses.id }).from(statuses).orderBy(asc(statuses.sortOrder), asc(statuses.id)).get()
          ?.id;
      if (projectId === undefined || statusId === undefined) throw badRequest('尚未建立專案或狀態');
      const t = now();
      const { custom, ...fields } = input;
      const created = tx
        .insert(tasks)
        .values({
          ...fields,
          projectId,
          statusId,
          sortOrder: input.sortOrder ?? nextSortOrder(tx, tasks, tasks.sortOrder),
          custom: custom ? mergeCustomValues(tx, projectId, {}, custom) : {},
          createdBy: user.id,
          updatedBy: user.id,
          createdAt: t,
          updatedAt: t,
        })
        .returning()
        .get();
      recordChange(tx, { entityType: 'task', entityId: created.id, action: 'create', actorId: user.id });
      return created;
    });
    return c.json(row, 201);
  })
  .get('/:id', (c) => {
    const task = findTask(c.var.db, idParam.parse(c.req.param('id')));
    if (!task) throw notFound('此任務不存在或已被刪除');
    return c.json(task);
  })
  .patch('/:id', async (c) => {
    const { db, now, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    const input = await readJson(c, taskUpdateInput);
    const row = db.transaction((tx) => {
      const current = findTask(tx, id);
      if (!current) throw notFound('此任務不存在或已被刪除');
      checkRefs(tx, input);
      // 只更新有送來的欄位（欄位層級後寫入者勝）；custom 逐鍵合併
      const { custom, ...fields } = input;
      const updated = tx
        .update(tasks)
        .set({
          ...fields,
          ...(custom && {
            custom: mergeCustomValues(tx, input.projectId ?? current.projectId, current.custom, custom),
          }),
          updatedBy: user.id,
          updatedAt: now(),
        })
        .where(eq(tasks.id, id))
        .returning()
        .get();
      recordChange(tx, { entityType: 'task', entityId: id, action: 'update', actorId: user.id });
      return updated;
    });
    return c.json(row);
  })
  .delete('/:id', (c) => {
    const { db, now, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    db.transaction((tx) => {
      if (!findTask(tx, id)) throw notFound('此任務不存在或已被刪除');
      const t = now();
      tx.update(tasks).set({ deletedAt: t, updatedBy: user.id, updatedAt: t }).where(eq(tasks.id, id)).run();
      recordChange(tx, { entityType: 'task', entityId: id, action: 'delete', actorId: user.id });
    });
    return c.json({ ok: true as const });
  });
