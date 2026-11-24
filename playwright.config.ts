import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3999);

// E2E 一律對「正式模式」的單一行程測試（API + 已 build 的前端），使用獨立 DB 檔。
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: 'npm run build && npm run db:setup && npm start',
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_PATH: 'data/e2e.db',
      COOKIE_SECURE: 'false',
      APP_ORIGIN: `http://localhost:${port}`,
    },
  },
});
