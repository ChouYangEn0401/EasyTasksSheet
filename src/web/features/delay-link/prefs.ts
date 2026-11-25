import { useSyncExternalStore } from 'react';
import { readStorage, writeStorage } from '../../lib/storage.ts';

/** 看板「顯示依賴標示」開關（預設開；記在 localStorage） */
export const SHOW_DEPS_KEY = 'ts.kanban.showDeps';

const listeners = new Set<() => void>();
const read = () => readStorage(SHOW_DEPS_KEY) !== '0';

export function setShowDependencyMarks(on: boolean) {
  writeStorage(SHOW_DEPS_KEY, on ? null : '0');
  listeners.forEach((fn) => fn());
}

export function useShowDependencyMarks(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    read,
    read,
  );
}
