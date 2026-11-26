import { useSyncExternalStore } from 'preact/compat';

/*
 * 狀態 / 專案管理對話框的開關（清單、看板、FilterBar、欄位編輯器都可開啟；對話框只掛一份在 TaskAreaLayout）。
 * 入口本身依 useCan('statuses.manage' / 'projects.create' / 'projects.manage') 顯示，後端仍會強制。
 */

/** 每次開啟遞增；對話框以此為 key 重新掛載，狀態自然回到預設 */
let seq = 0;
let snapshot = { dialog: null, seq };
const listeners = new Set();

export function openAdminDialog(next) {
  seq += 1;
  snapshot = { dialog: next, seq };
  listeners.forEach((l) => l());
}

export function closeAdminDialog() {
  snapshot = { dialog: null, seq };
  listeners.forEach((l) => l());
}

export function useAdminDialog() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}
