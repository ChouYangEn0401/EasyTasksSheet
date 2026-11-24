import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from './config.ts';
import { createApp } from './app.ts';
import { createDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { runSeed } from './db/seed.ts';

process.env.TZ = config.TZ;

const db = createDb(config.DATABASE_PATH);
runMigrations(db);
runSeed(db);

const app = createApp({ db });

// 正式模式：同一行程提供前端靜態檔，非 /api 路徑回退到 index.html（SPA）
if (config.isProduction) {
  app.use('/*', serveStatic({ root: config.STATIC_DIR }));
  const indexHtml = readFileSync(join(config.STATIC_DIR, 'index.html'), 'utf8');
  app.get('*', (c) => c.html(indexHtml));
}

serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
  console.log(`[server] http://localhost:${info.port}（${config.NODE_ENV}，DB: ${config.DATABASE_PATH}）`);
});
