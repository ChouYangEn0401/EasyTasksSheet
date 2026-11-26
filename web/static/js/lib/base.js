/**
 * 部署在子路徑時的網址前綴（例如 nginx 的 /easytasks/）。
 * 伺服器在回 index.html 時把 .env 的 BASE_PATH 代入 <meta name="ts-base">（server/app/app.py 的 _mount_spa），
 * 這裡讀出來：根目錄 → ""，子路徑 → "/easytasks"（不含結尾斜線）。改了 BASE_PATH 只要重啟。
 */
export const BASE_PATH = (
  (typeof document !== 'undefined' &&
    document.querySelector('meta[name="ts-base"]')?.getAttribute('content')) ||
  ''
).replace(/\/+$/, '');

/** 後端 API 網址：apiUrl('/tasks') → "/easytasks/api/tasks" */
export const apiUrl = (path) => `${BASE_PATH}/api${path}`;

/** 路由路徑 → 瀏覽器實際網址（加上前綴）：withBase('/login') → "/easytasks/login" */
export const withBase = (routePath) => `${BASE_PATH}${routePath}`;

/** 瀏覽器網址 → 路由路徑（去掉前綴）：stripBase('/easytasks/me') → "/me" */
export function stripBase(pathname) {
  if (!BASE_PATH) return pathname;
  if (pathname === BASE_PATH) return '/';
  return pathname.startsWith(`${BASE_PATH}/`) ? pathname.slice(BASE_PATH.length) : pathname;
}
