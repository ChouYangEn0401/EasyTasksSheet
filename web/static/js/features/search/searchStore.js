/**
 * Ctrl+K 浮層的開關狀態（模組層級的小 store）。
 * 快捷鍵（shell/useGlobalShortcuts）、頂欄按鈕、浮層本身都透過這裡溝通，彼此不互相 import。
 * 開啟那一刻記住焦點所在，關閉後由浮層把焦點送回去。
 */
import { useSyncExternalStore } from 'preact/compat';

let open = false;
/** 每次要求開啟都 +1：已開著時再按 Ctrl+K，浮層據此把焦點拉回輸入框並全選 */
let nonce = 0;
let returnTo = null;
const subs = new Set();

const emit = () => subs.forEach((fn) => fn());

export function openSearch() {
  if (!open) {
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    returnTo = a instanceof HTMLElement && a !== document.body ? a : null;
  }
  open = true;
  nonce += 1;
  emit();
}

export function closeSearch() {
  if (!open) return;
  open = false;
  emit();
}

/** 取出（並清掉）開啟前的焦點元素 */
export function takeReturnFocus() {
  const el = returnTo;
  returnTo = null;
  return el;
}

export const isSearchOpen = () => open;

function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

let snap = { open, nonce };
function getSnapshot() {
  if (snap.open !== open || snap.nonce !== nonce) snap = { open, nonce };
  return snap;
}

/** { open, nonce } */
export function useSearchState() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
