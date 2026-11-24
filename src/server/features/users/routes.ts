import { asc } from 'drizzle-orm';
import { Hono } from 'hono';
import { users } from '../../db/schema.ts';
import type { AppEnv } from '../../lib/context.ts';
import { toPublicUser } from './service.ts';

/** 掛載於 /api/users：成員列表（含停用者，由前端決定是否顯示） */
export const usersRoutes = new Hono<AppEnv>().get('/', (c) =>
  c.json(c.var.db.select().from(users).orderBy(asc(users.id)).all().map(toPublicUser)),
);
