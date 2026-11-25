/**
 * 部署在子路徑時的網址前綴（例如 nginx 的 /easytasks/）。
 * 由 vite.config.ts 依 .env 的 BASE_PATH 設定 `base`，建置後 import.meta.env.BASE_URL 為 "/easytasks/"；
 * 掛在根目錄時為 "/"。這裡統一去掉結尾斜線：根目錄 → ""，子路徑 → "/easytasks"。
 */
export const BASE_PATH: string = (import.meta.env?.BASE_URL ?? '/').replace(/\/+$/, '');

/** 後端 API 網址：apiUrl('/tasks') → "/easytasks/api/tasks" */
export const apiUrl = (path: string): string => `${BASE_PATH}/api${path}`;

/** 路由路徑 → 瀏覽器實際網址（加上前綴）：withBase('/login') → "/easytasks/login" */
export const withBase = (routePath: string): string => `${BASE_PATH}${routePath}`;

/** 瀏覽器網址 → 路由路徑（去掉前綴）：stripBase('/easytasks/me') → "/me" */
export function stripBase(pathname: string): string {
  if (!BASE_PATH) return pathname;
  if (pathname === BASE_PATH) return '/';
  return pathname.startsWith(`${BASE_PATH}/`) ? pathname.slice(BASE_PATH.length) : pathname;
}
