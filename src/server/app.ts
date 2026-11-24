import { Hono } from 'hono';
import type { Db } from './db/client.ts';
import type { AppEnv } from './lib/context.ts';
import { errorBody, handleError } from './lib/errors.ts';
import { authRoutes } from './features/auth/routes.ts';
import { usersRoutes } from './features/users/routes.ts';
import { projectsRoutes } from './features/projects/routes.ts';
import { statusesRoutes } from './features/projects/statuses.ts';
import { tasksRoutes } from './features/tasks/routes.ts';
import { propertiesRoutes } from './features/properties/routes.ts';
import { overviewRoutes } from './features/overview/routes.ts';
import { feedbackRoutes } from './features/feedback/routes.ts';
import { personalRoutes } from './features/personal/routes.ts';
import { engRoutes } from './features/eng/routes.ts';
import { adminRoutes } from './features/admin/routes.ts';
import { changesRoutes, eventsRoutes } from './features/sync/routes.ts';

export type AppDeps = {
  db: Db;
  now?: () => number;
};

/** 建立 API app（不含靜態檔）。所有 feature router 在此一次掛好 */
export function createApp({ db, now = Date.now }: AppDeps) {
  const api = new Hono<AppEnv>();

  api.use('*', async (c, next) => {
    c.set('db', db);
    c.set('now', now);
    await next();
  });

  api.get('/health', (c) => c.json({ ok: true as const, time: now() }));

  api.route('/auth', authRoutes);
  api.route('/users', usersRoutes);
  api.route('/projects', projectsRoutes);
  api.route('/statuses', statusesRoutes);
  api.route('/tasks', tasksRoutes);
  api.route('/properties', propertiesRoutes);
  api.route('/overview', overviewRoutes);
  api.route('/feedback', feedbackRoutes);
  api.route('/personal', personalRoutes);
  api.route('/eng', engRoutes);
  api.route('/admin', adminRoutes);
  api.route('/changes', changesRoutes);
  api.route('/events', eventsRoutes);

  // 未知的 /api/* 一律回 JSON 404（放最後，避免被正式模式的 SPA fallback 接走）
  api.all('*', (c) => c.json(errorBody('NOT_FOUND', '找不到 API'), 404));
  api.onError(handleError);

  const app = new Hono();
  app.route('/api', api);
  return app;
}

export type App = ReturnType<typeof createApp>;
