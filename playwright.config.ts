import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3999);

// 後端為 Python（FastAPI + uvicorn）；優先使用 .venv（npm run py:install 建立）
const venvPython = ['.venv/Scripts/python.exe', '.venv/bin/python'].find((p) => existsSync(p));
const python = venvPython ? `"${venvPython}"` : 'python';

// 每次重建 E2E 專用 DB 並建立固定測試帳號（tests/helpers/e2eUsers.ts）
const command = `npm run build && ${python} -m server.e2e_setup && ${python} -m uvicorn server.app.main:app --port ${port}`;

// E2E 一律跑正式模式（單一行程同時提供 API + 已 build 的前端），使用獨立 DB 檔
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_PATH: 'data/e2e.db',
      ATTACHMENTS_DIR: 'data/e2e-attachments',
      // 僅限 E2E：連結預覽測試要抓本機的測試頁（127.0.0.1）。正式環境預設為 false，請勿開啟
      LINK_PREVIEW_ALLOW_PRIVATE: 'true',
      COOKIE_SECURE: 'false',
      APP_ORIGIN: `http://localhost:${port}`,
      PYTHONUTF8: '1',
      // 預設管理員帳號改用 E2E 專用的 bootstrap（tests/helpers/e2eUsers.ts），不影響固定的 admin 帳號
      ADMIN_USERNAME: 'bootstrap',
    },
  },
});
