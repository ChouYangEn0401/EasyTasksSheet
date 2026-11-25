import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = env.PORT || '3000';
  // 子路徑部署（例如 nginx 的 /easytasks/）：BASE_PATH 決定建置後資源與 API 的網址前綴。
  // 改了 BASE_PATH 必須重新 npm run build；後端 .env 也要設同一個值。
  const basePath = (env.BASE_PATH ?? '').trim().replace(/^\/+|\/+$/g, '');
  const base = basePath ? `/${basePath}/` : '/';
  return {
    base,
    plugins: [react(), tailwindcss()],
    build: { outDir: 'dist/web', emptyOutDir: true },
    server: {
      port: Number(env.WEB_PORT || 5173),
      strictPort: true,
      // 開發時 Vite 代為轉發 API；有 BASE_PATH 時去掉前綴再交給後端（與 nginx 的做法相同）
      proxy: {
        [`${base}api`]: {
          target: `http://localhost:${apiPort}`,
          changeOrigin: false,
          rewrite: (p: string) => (basePath ? p.slice(basePath.length + 1) : p),
        },
      },
    },
    test: {
      include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
      exclude: ['tests/e2e/**', 'node_modules/**'],
      environment: 'node',
    },
  };
});
