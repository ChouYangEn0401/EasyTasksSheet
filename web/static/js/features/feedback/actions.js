import { createContext, useContext } from 'preact/compat';

export const kindTone = (kind) => (kind === 'problem' ? 'orange' : 'blue');

/** 項目的 ⋯ 選單：編輯、排入日期…、取消排程、標記已解決 / 重新開啟、刪除 */
export function itemMenu(item, actions) {
  const resolved = item.status === 'resolved';
  const items = [{ key: 'edit', label: '編輯', onSelect: () => actions.edit(item) }];
  if (!resolved) items.push({ key: 'date', label: '排入日期…', onSelect: () => actions.pickDate(item) });
  if (!resolved && item.scheduledDate)
    items.push({ key: 'unschedule', label: '取消排程', onSelect: () => actions.unschedule(item) });
  items.push(
    {
      key: 'resolve',
      label: resolved ? '重新開啟' : '標記已解決',
      onSelect: () => actions.toggleResolved(item),
    },
    { key: 'sep', separator: true },
    { key: 'delete', label: '刪除', danger: true, onSelect: () => actions.remove(item) },
  );
  return items;
}

/** 卡片、月曆 chip、+N Popover 共用的項目動作（由 FeedbackPage 提供） */

export const FeedbackActionsContext = createContext(null);

export function useFeedbackActions() {
  const ctx = useContext(FeedbackActionsContext);
  if (!ctx) throw new Error('useFeedbackActions 必須在 FeedbackActionsContext 內使用');
  return ctx;
}

/** 拖曳資料：來源為清單卡片或月曆 chip（含 +N Popover） */

/** 放置目標：某一天或清單面板 */

export const LIST_DROP_ID = 'feedback-list';
export const dayDropId = (date) => `day-${date}`;

/**
 * 卡片 / chip 的單鍵操作（focus 在項目本身時）：
 * Enter 編輯、R 解決 / 重新開啟、S 排入日期、U 取消排程。回傳是否已處理。
 */
export function handleItemKey(key, item, actions) {
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case 'Enter':
      actions.edit(item);
      return true;
    case 'r':
      actions.toggleResolved(item);
      return true;
    case 's':
      if (item.status === 'resolved') return false;
      actions.pickDate(item);
      return true;
    case 'u':
      if (!item.scheduledDate || item.status === 'resolved') return false;
      actions.unschedule(item);
      return true;
    default:
      return false;
  }
}
