import { useSyncExternalStore } from 'preact/compat';
import { readStorage, writeStorage } from '../../lib/storage.js';

/** 看板「顯示依賴標示」開關（預設開；記在 localStorage） */
export const SHOW_DEPS_KEY = 'ts.kanban.showDeps';

const listeners = new Set();
const read = () => readStorage(SHOW_DEPS_KEY) !== '0';

export function setShowDependencyMarks(on) {
  writeStorage(SHOW_DEPS_KEY, on ? null : '0');
  listeners.forEach((fn) => fn());
}

export function useShowDependencyMarks() {
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
