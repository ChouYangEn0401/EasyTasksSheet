import { isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { config } from '../../config.ts';
import { statuses, tasks, users } from '../../db/schema.ts';
import type { AppEnv } from '../../lib/context.ts';
import { computeOverview } from './compute.ts';

/** 掛載於 /api/overview：每人進行中任務、未完成預估工時、各狀態數量、逾期、未指派、本週完成（近似） */
export const overviewRoutes = new Hono<AppEnv>().get('/', (c) => {
  const { db, now } = c.var;
  const statusRows = db
    .select({
      id: statuses.id,
      name: statuses.name,
      color: statuses.color,
      category: statuses.category,
      sortOrder: statuses.sortOrder,
    })
    .from(statuses)
    .all();
  const userRows = db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      isActive: users.isActive,
    })
    .from(users)
    .all();
  const taskRows = db
    .select({
      id: tasks.id,
      title: tasks.title,
      statusId: tasks.statusId,
      assigneeId: tasks.assigneeId,
      dueDate: tasks.dueDate,
      estimateHours: tasks.estimateHours,
      updatedAt: tasks.updatedAt,
      updatedBy: tasks.updatedBy,
    })
    .from(tasks)
    .where(isNull(tasks.deletedAt))
    .all();
  return c.json(
    computeOverview({
      statuses: statusRows,
      users: userRows,
      tasks: taskRows,
      now: now(),
      timeZone: config.TZ,
    }),
  );
});
