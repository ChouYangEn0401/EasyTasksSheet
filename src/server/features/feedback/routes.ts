import { and, desc, eq, gte, inArray, lte, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { idParam } from '../../../shared/common.ts';
import {
  deriveFeedbackStatus,
  feedbackCreateInput,
  feedbackListQuery,
  feedbackUpdateInput,
  type FeedbackUpdateInput,
} from '../../../shared/feedback.ts';
import type { DbOrTx } from '../../db/client.ts';
import { feedbackItems, projects, users } from '../../db/schema.ts';
import type { AppEnv } from '../../lib/context.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { recordChange } from '../../lib/recordChange.ts';
import { readJson, readQuery } from '../../lib/validate.ts';

const NOT_FOUND = '此項目不存在或已被刪除';

/** 外鍵欄位需指向存在的資料，否則回 400 */
function checkRefs(db: DbOrTx, input: FeedbackUpdateInput) {
  if (input.projectId != null && !db.select().from(projects).where(eq(projects.id, input.projectId)).get()) {
    throw badRequest('專案不存在');
  }
  if (input.assigneeId != null && !db.select().from(users).where(eq(users.id, input.assigneeId)).get()) {
    throw badRequest('負責人不存在');
  }
}

const findItem = (db: DbOrTx, id: number) =>
  db.select().from(feedbackItems).where(eq(feedbackItems.id, id)).get();

/**
 * 掛載於 /api/feedback；所有成員可讀寫。
 * status 由後端推導：排入日期即 scheduled、清空即 open、resolved 保留排程日（重新開啟時依排程日回復）。
 */
export const feedbackRoutes = new Hono<AppEnv>()
  .get('/', (c) => {
    const query = readQuery(c, feedbackListQuery);
    const conds: (SQL | undefined)[] = [];
    if (query.kind?.length) conds.push(inArray(feedbackItems.kind, query.kind));
    if (query.status?.length) conds.push(inArray(feedbackItems.status, query.status));
    if (query.from) conds.push(gte(feedbackItems.scheduledDate, query.from));
    if (query.to) conds.push(lte(feedbackItems.scheduledDate, query.to));
    const rows = c.var.db
      .select()
      .from(feedbackItems)
      .where(and(...conds))
      .orderBy(desc(feedbackItems.createdAt), desc(feedbackItems.id))
      .all();
    return c.json(rows);
  })
  .post('/', async (c) => {
    const { db, now, user } = c.var;
    const input = await readJson(c, feedbackCreateInput);
    const row = db.transaction((tx) => {
      checkRefs(tx, input);
      const t = now();
      const scheduledDate = input.scheduledDate ?? null;
      const created = tx
        .insert(feedbackItems)
        .values({
          ...input,
          scheduledDate,
          status: deriveFeedbackStatus(false, scheduledDate),
          reporterId: user.id,
          updatedBy: user.id,
          createdAt: t,
          updatedAt: t,
        })
        .returning()
        .get();
      recordChange(tx, { entityType: 'feedback', entityId: created.id, action: 'create', actorId: user.id });
      return created;
    });
    return c.json(row, 201);
  })
  .get('/:id', (c) => {
    const item = findItem(c.var.db, idParam.parse(c.req.param('id')));
    if (!item) throw notFound(NOT_FOUND);
    return c.json(item);
  })
  .patch('/:id', async (c) => {
    const { db, now, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    const input = await readJson(c, feedbackUpdateInput);
    const row = db.transaction((tx) => {
      const current = findItem(tx, id);
      if (!current) throw notFound(NOT_FOUND);
      checkRefs(tx, input);
      const { resolved, ...fields } = input;
      const scheduledDate = fields.scheduledDate !== undefined ? fields.scheduledDate : current.scheduledDate;
      const isResolved = resolved ?? current.status === 'resolved';
      const updated = tx
        .update(feedbackItems)
        .set({
          ...fields,
          status: deriveFeedbackStatus(isResolved, scheduledDate),
          updatedBy: user.id,
          updatedAt: now(),
        })
        .where(eq(feedbackItems.id, id))
        .returning()
        .get();
      recordChange(tx, { entityType: 'feedback', entityId: id, action: 'update', actorId: user.id });
      return updated;
    });
    return c.json(row);
  })
  .delete('/:id', (c) => {
    const { db, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    db.transaction((tx) => {
      if (!findItem(tx, id)) throw notFound(NOT_FOUND);
      tx.delete(feedbackItems).where(eq(feedbackItems.id, id)).run();
      recordChange(tx, { entityType: 'feedback', entityId: id, action: 'delete', actorId: user.id });
    });
    return c.json({ ok: true as const });
  });
