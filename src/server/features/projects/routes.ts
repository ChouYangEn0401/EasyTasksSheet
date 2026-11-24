import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { idParam } from '../../../shared/common.ts';
import { projectCreateInput, projectUpdateInput } from '../../../shared/projects.ts';
import { projects } from '../../db/schema.ts';
import type { AppEnv } from '../../lib/context.ts';
import { notFound } from '../../lib/errors.ts';
import { recordChange } from '../../lib/recordChange.ts';
import { nextSortOrder } from '../../lib/sortOrder.ts';
import { readJson } from '../../lib/validate.ts';

/** 掛載於 /api/projects（含封存專案，由前端過濾） */
export const projectsRoutes = new Hono<AppEnv>()
  .get('/', (c) =>
    c.json(c.var.db.select().from(projects).orderBy(asc(projects.sortOrder), asc(projects.id)).all()),
  )
  .post('/', async (c) => {
    const { db, now, user } = c.var;
    const input = await readJson(c, projectCreateInput);
    const row = db.transaction((tx) => {
      const t = now();
      const created = tx
        .insert(projects)
        .values({
          name: input.name,
          color: input.color ?? 'blue',
          sortOrder: nextSortOrder(tx, projects, projects.sortOrder),
          createdAt: t,
          updatedAt: t,
        })
        .returning()
        .get();
      recordChange(tx, { entityType: 'project', entityId: created.id, action: 'create', actorId: user.id });
      return created;
    });
    return c.json(row, 201);
  })
  .patch('/:id', async (c) => {
    const { db, now, user } = c.var;
    const id = idParam.parse(c.req.param('id'));
    const input = await readJson(c, projectUpdateInput);
    const row = db.transaction((tx) => {
      const updated = tx
        .update(projects)
        .set({ ...input, updatedAt: now() })
        .where(eq(projects.id, id))
        .returning()
        .get();
      if (!updated) throw notFound('找不到專案');
      recordChange(tx, { entityType: 'project', entityId: id, action: 'update', actorId: user.id });
      return updated;
    });
    return c.json(row);
  });
