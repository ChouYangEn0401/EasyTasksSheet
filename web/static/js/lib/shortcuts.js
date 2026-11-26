/**
 * 全域快捷鍵（docs/design/core-shell.md §8）：
 *   N 聚焦 Header 的 QuickAdd；/ 聚焦 FilterBar 搜尋框；G 然後 O/L/K/G/F/M/E 前往頁面；[ 收合 Sidebar
 *   Ctrl+Z 復原、Ctrl+Shift+Z / Ctrl+Y 重做（Mac 用 Cmd；docs/design/undo.md）
 * focus 在輸入框 / 可編輯區時不觸發（保留瀏覽器原生的文字復原）；開著對話框時不觸發；
 * suspendGlobalShortcuts() 可暫停（例如 Kanban 鍵盤拖曳中）。
 */

/** G 序列對應的路由 */
export const GOTO_KEYS = {
  o: '/',
  l: '/tasks/list',
  k: '/tasks/kanban',
  g: '/tasks/gantt',
  f: '/feedback',
  m: '/me',
  e: '/eng',
};

/** 標記用的 data 屬性：Header QuickAdd 與 FilterBar 搜尋框 */
export const GLOBAL_QUICKADD_ATTR = 'data-global-quickadd';
export const FILTER_SEARCH_ATTR = 'data-filter-search';

let suspendCount = 0;

/** 暫停全域快捷鍵，回傳恢復函式（可巢狀呼叫） */
export function suspendGlobalShortcuts() {
  suspendCount += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    suspendCount -= 1;
  };
}

export const shortcutsSuspended = () => suspendCount > 0;

/** 事件目標是否為可輸入的元素 */
export function isEditableTarget(target) {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = target.type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

/**
 * 依按鍵與「上一個按鍵是否為 G（且未逾時）」決定動作（純函式，方便測試）。
 * 回傳 { action, pendingG }：pendingG 表示這次按鍵開啟了 G 序列。
 */
export function resolveShortcut(key, pendingG) {
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (pendingG) {
    const path = GOTO_KEYS[k];
    return { action: path ? { type: 'goto', path } : null, pendingG: false };
  }
  switch (k) {
    case 'n':
      return { action: { type: 'focus-quickadd' }, pendingG: false };
    case '/':
      return { action: { type: 'focus-search' }, pendingG: false };
    case '[':
      return { action: { type: 'toggle-sidebar' }, pendingG: false };
    case 'g':
      return { action: null, pendingG: true };
    default:
      return { action: null, pendingG: false };
  }
}

/** 復原 / 重做快捷鍵用到的按鍵資訊（KeyboardEvent 的子集，方便測試） */

/**
 * 判斷是否為復原 / 重做快捷鍵（純函式）：Ctrl/Cmd+Z 復原；Ctrl/Cmd+Shift+Z、Ctrl/Cmd+Y 重做。
 * 焦點在可編輯元素（input / textarea / select / contenteditable）時回傳 null，讓瀏覽器處理原生文字復原。
 */
export function resolveUndoShortcut(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (isEditableTarget(e.target ?? null)) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && !e.shiftKey) return 'redo';
  return null;
}
