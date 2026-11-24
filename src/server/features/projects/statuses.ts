import { asc } from 'drizzle-orm';
import { Hono } from 'hono';
import { statuses } from '../../db/schema.ts';
import type { AppEnv } from '../../lib/context.ts';

/** 掛載於 /api/statuses（唯讀，依 sort_order 排序） */
export const statusesRoutes = new Hono<AppEnv>().get('/', (c) =>
  c.json(c.var.db.select().from(statuses).orderBy(asc(statuses.sortOrder), asc(statuses.id)).all()),
);
