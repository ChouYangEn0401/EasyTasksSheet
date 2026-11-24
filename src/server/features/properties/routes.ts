import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { idParam } from '../../../shared/common.ts';
import { propertyCreateInput, propertyUpdateInput, type SelectOption } from '../../../shared/properties.ts';
import { projects, propertyDefs } from '../../db/schema.ts';
import type { AppEnv } from '../../lib/context.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { recordChange } from '../../lib/recordChange.ts';
import { nextSortOrder } from '../../lib/sortOrder.ts';
import { readJson } from '../../lib/validate.ts';

function checkOptions(options: SelectOption[] | undefined) {
  if (options && new Set(options.map((o) => o.id)).size !== options.length)
    throw badRequest('選項 id 不可重複');
}

/** 掛載於 /api/properties：自訂 property 定義（projectId = null 為全域）。刪除定義不清任務資料，讀取時忽略未知 key */
export const propertiesRoutes = new Hono<AppEnv>()
  .get('/', (c) =>
    c.json(
      c.var.db.select().from(propertyDefs).orderBy(asc(propertyDefs.sortOrder), asc(propertyDefs.id)).all(),
    ),
  )
  .post('/', async (c) => {
    const { db, now, user } = c.var;
    const input = await readJson(c, propertyCreateInput);
    checkOptions(input.options);
    const row = db.transaction((tx) => {
      if (
        input.projectId != null &&
        !tx.select().from(projects).where(eq(projects.id, input.projectId)).get()
      ) {
        throw badRequest('專案不存在');
      }
      const t = now();
      const created = tx
        .insert(propertyDefs)
        .values({
          projectId: input.projectId ?? null,
          name: input.name,
          type: input.type,
          options: input.options ?? [],
          sortOrder: nextSortOrder(tx, propertyDefs, propertyDefs.sortOrder),
          createdAt: t,
          updatedAt: t,
        })
        .returning()
        .get();
      recordChange(tx, { entityType: 'property', entityId: created.id, action: 'create', actorId: user.id });
      return created;
    });
    return c.json(row, 201);
  })
  .patch('/:id', async (c) => {
    const { db, now, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    const input = await readJson(c, propertyUpdateInput);
    checkOptions(input.options);
    const row = db.transaction((tx) => {
      const updated = tx
        .update(propertyDefs)
        .set({ ...input, updatedAt: now() })
        .where(eq(propertyDefs.id, id))
        .returning()
        .get();
      if (!updated) throw notFound('找不到自訂欄位');
      recordChange(tx, { entityType: 'property', entityId: id, action: 'update', actorId: user.id });
      return updated;
    });
    return c.json(row);
  })
  .delete('/:id', (c) => {
    const { db, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    db.transaction((tx) => {
      const deleted = tx.delete(propertyDefs).where(eq(propertyDefs.id, id)).returning().get();
      if (!deleted) throw notFound('找不到自訂欄位');
      recordChange(tx, { entityType: 'property', entityId: id, action: 'delete', actorId: user.id });
    });
    return c.json({ ok: true as const });
  });
