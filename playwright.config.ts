import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3999);

// E2E_BACKEND=py 時改以 Python（FastAPI + uvicorn）後端執行；未設定時維持 TS 後端
const usePy = process.env.E2E_BACKEND === 'py';
const venvPython = ['.venv/Scripts/python.exe', '.venv/bin/python'].find((p) => existsSync(p));
const python = venvPython ? `"${venvPython}"` : 'python';

// 每次重建 E2E 專用 DB 並建立固定測試帳號（tests/helpers/e2eUsers.ts）
const command = usePy
  ? `npm run build && ${python} -m server.e2e_setup && ${python} -m uvicorn server.app.main:app --port ${port}`
  : 'npm run build && node scripts/e2e-setup.ts && npm start';

// E2E 一律對「正式模式」的單一行程測試（API + 已 build 的前端），使用獨立 DB 檔。
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
      COOKIE_SECURE: 'false',
      APP_ORIGIN: `http://localhost:${port}`,
      PYTHONUTF8: '1',
    },
  },
});
