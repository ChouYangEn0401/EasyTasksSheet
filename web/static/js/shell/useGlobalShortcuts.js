import { useEffect, useRef } from 'preact/compat';
import { useNavigate } from '../lib/router.js';
import {
  FILTER_SEARCH_ATTR,
  GLOBAL_QUICKADD_ATTR,
  isEditableTarget,
  resolveShortcut,
  resolveUndoShortcut,
  shortcutsSuspended,
} from '../lib/shortcuts.js';
import { performUndo, undoManager } from '../lib/undo.js';

const G_TIMEOUT_MS = 1200;

/** 掛載全域快捷鍵（N、/、G 序列、[、Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y） */
export function useGlobalShortcuts(toggleSidebar) {
  const navigate = useNavigate();
  const toggleRef = useRef(toggleSidebar);
  useEffect(() => {
    toggleRef.current = toggleSidebar;
  });

  useEffect(() => {
    let pendingG = false;
    let timer;
    const onKey = (e) => {
      const undoKind = e.defaultPrevented || e.isComposing ? null : resolveUndoShortcut(e);
      if (undoKind) {
        if (shortcutsSuspended() || document.querySelector('dialog[open]')) return;
        const { canUndo, canRedo, busy } = undoManager.getSnapshot();
        // 沒有可復原 / 重做的項目時不攔截（不 preventDefault）
        if (!(undoKind === 'undo' ? canUndo : canRedo)) return;
        e.preventDefault();
        if (!busy) void performUndo(undoKind);
        return;
      }
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (shortcutsSuspended() || isEditableTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      const res = resolveShortcut(e.key, pendingG);
      pendingG = res.pendingG;
      window.clearTimeout(timer);
      if (pendingG) timer = window.setTimeout(() => (pendingG = false), G_TIMEOUT_MS);
      const action = res.action;
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case 'focus-quickadd':
          document.querySelector(`[${GLOBAL_QUICKADD_ATTR}]`)?.focus();
          break;
        case 'focus-search':
          document.querySelector(`[${FILTER_SEARCH_ATTR}]`)?.focus();
          break;
        case 'toggle-sidebar':
          toggleRef.current();
          break;
        case 'goto':
          navigate(action.path);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(timer);
    };
  }, [navigate]);
}
