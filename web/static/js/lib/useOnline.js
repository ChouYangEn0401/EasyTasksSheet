import { useSyncExternalStore } from 'preact/compat';
import { isOnline, onApiEvent } from './api.js';

/** API 連線狀態：最近一次請求為網路錯誤時為 false，任何請求成功即恢復 true */
export function useApiOnline() {
  return useSyncExternalStore((fn) => onApiEvent('online', fn), isOnline);
}
