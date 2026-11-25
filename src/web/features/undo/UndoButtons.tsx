import { performUndo, useUndoState, type UndoKind } from '../../lib/undo.ts';
import { Button, Tooltip } from '../../ui/index.ts';
import { UndoConflictDialog } from './UndoConflictDialog.tsx';
import './undo.css';

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** 快捷鍵提示文字（Mac 顯示 ⌘） */
function undoShortcutText(kind: UndoKind): string {
  if (isMac()) return kind === 'undo' ? '⌘Z' : '⇧⌘Z';
  return kind === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z';
}

/** aria-keyshortcuts：依平台（Mac 為 Meta，其他為 Control） */
function undoKeyShortcuts(kind: UndoKind, mac = isMac()): string {
  const mod = mac ? 'Meta' : 'Control';
  return kind === 'undo' ? `${mod}+Z` : `${mod}+Shift+Z`;
}

/**
 * 頂欄的「復原」「重做」圖示按鈕（docs/design/undo.md）：無項目時停用；Tooltip 顯示下一步內容與快捷鍵。
 * 同時掛載復原衝突對話框。
 */
export function UndoButtons() {
  const { canUndo, canRedo, nextUndoLabel, nextRedoLabel, busy } = useUndoState();
  const item = (kind: UndoKind, enabled: boolean, label: string | null) => {
    const verb = kind === 'undo' ? '復原' : '重做';
    const text = label ? `${verb}：${label}` : `沒有可${verb}的動作`;
    return (
      <Tooltip content={`${text}（${undoShortcutText(kind)}）`} placement="bottom" disabled={!enabled}>
        <Button
          variant="ghost"
          iconOnly
          icon={kind}
          aria-label={text}
          aria-keyshortcuts={undoKeyShortcuts(kind)}
          disabled={!enabled || busy}
          data-undo-button={kind}
          onClick={() => void performUndo(kind)}
        />
      </Tooltip>
    );
  };
  return (
    <div className="undo-buttons" role="group" aria-label="復原與重做">
      {item('undo', canUndo, nextUndoLabel)}
      {item('redo', canRedo, nextRedoLabel)}
      <UndoConflictDialog />
    </div>
  );
}
