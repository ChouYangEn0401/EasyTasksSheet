import { createElement, Fragment } from 'preact';
import { performUndo, useUndoState } from '../../lib/undo.js';
import { Button, Tooltip } from '../../ui/index.js';
import { UndoConflictDialog } from './UndoConflictDialog.js';

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** 快捷鍵提示文字（Mac 顯示 ⌘） */
function undoShortcutText(kind) {
  if (isMac()) return kind === 'undo' ? '⌘Z' : '⇧⌘Z';
  return kind === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z';
}

/** aria-keyshortcuts：依平台（Mac 為 Meta，其他為 Control） */
function undoKeyShortcuts(kind, mac = isMac()) {
  const mod = mac ? 'Meta' : 'Control';
  return kind === 'undo' ? `${mod}+Z` : `${mod}+Shift+Z`;
}

/**
 * 頂欄的「復原」「重做」圖示按鈕（docs/design/undo.md）：無項目時停用；Tooltip 顯示下一步內容與快捷鍵。
 * 同時掛載復原衝突對話框。
 */
export function UndoButtons() {
  const { canUndo, canRedo, nextUndoLabel, nextRedoLabel, busy } = useUndoState();
  const item = (kind, enabled, label) => {
    const verb = kind === 'undo' ? '復原' : '重做';
    const text = label ? `${verb}：${label}` : `沒有可${verb}的動作`;
    return createElement(
      Tooltip,
      { content: `${text}（${undoShortcutText(kind)}）`, placement: 'bottom', disabled: !enabled },
      createElement(Button, {
        variant: 'ghost',
        iconOnly: true,
        icon: kind,
        'aria-label': text,
        'aria-keyshortcuts': undoKeyShortcuts(kind),
        disabled: !enabled || busy,
        'data-undo-button': kind,
        onClick: () => void performUndo(kind),
      }),
    );
  };
  return createElement(
    'div',
    { className: 'undo-buttons', role: 'group', 'aria-label': '復原與重做' },
    item('undo', canUndo, nextUndoLabel),
    item('redo', canRedo, nextRedoLabel),
    createElement(UndoConflictDialog, null),
  );
}
