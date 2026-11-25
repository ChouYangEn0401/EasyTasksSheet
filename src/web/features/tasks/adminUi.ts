import { useSyncExternalStore } from 'react';
import type { Project } from '../../../shared/projects.ts';

/*
 * 狀態 / 專案管理對話框的開關（清單、看板、FilterBar、欄位編輯器都可開啟；對話框只掛一份在 TaskAreaLayout）。
 * 入口本身依 useCan('statuses.manage' / 'projects.create' / 'projects.manage') 顯示，後端仍會強制。
 */
export type AdminDialog =
  | { kind: 'add-status' }
  | { kind: 'manage-statuses' }
  | { kind: 'add-project'; onCreated?: (project: Project) => void }
  | { kind: 'manage-projects' }
  | null;

type Snapshot = { dialog: AdminDialog; seq: number };
/** 每次開啟遞增；對話框以此為 key 重新掛載，狀態自然回到預設 */
let seq = 0;
let snapshot: Snapshot = { dialog: null, seq };
const listeners = new Set<() => void>();

export function openAdminDialog(next: NonNullable<AdminDialog>) {
  seq += 1;
  snapshot = { dialog: next, seq };
  listeners.forEach((l) => l());
}

export function closeAdminDialog() {
  snapshot = { dialog: null, seq };
  listeners.forEach((l) => l());
}

export function useAdminDialog(): Snapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}
