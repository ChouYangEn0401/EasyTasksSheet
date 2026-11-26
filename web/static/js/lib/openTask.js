import { navigateTo } from './navigation.js';

/**
 * 任務詳情抽屜（TaskDrawer）以網址 `?task=<id>` 驅動。
 * openTask(id)：在目前頁面加上 ?task=<id>（push，可用瀏覽器上一頁關閉）
 * closeTask()：移除 ?task（replace）
 * 開啟時記住觸發元素，關閉後 focus 回到它。
 */

export const TASK_PARAM = 'task';

let returnFocusTo = null;

function withTask(id) {
  const url = new URL(window.location.href);
  if (id == null) url.searchParams.delete(TASK_PARAM);
  else url.searchParams.set(TASK_PARAM, String(id));
  return url.pathname + url.search;
}

export function openTask(id) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) returnFocusTo = active;
  const current = new URL(window.location.href).searchParams.get(TASK_PARAM);
  // 已開著其他任務時以 replace 切換，避免上一頁要按很多次
  navigateTo(withTask(id), { replace: current != null });
}

export function closeTask() {
  navigateTo(withTask(null), { replace: true });
  const el = returnFocusTo;
  returnFocusTo = null;
  if (el?.isConnected) requestAnimationFrame(() => el.focus());
}

/** 從 URLSearchParams 讀出目前開啟的任務 id */
export function readTaskParam(sp) {
  const raw = sp.get(TASK_PARAM);
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}
