import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import {
  FILTER_SEARCH_ATTR,
  GLOBAL_QUICKADD_ATTR,
  isEditableTarget,
  resolveShortcut,
  shortcutsSuspended,
} from '../lib/shortcuts.ts';

const G_TIMEOUT_MS = 1200;

/** 掛載全域快捷鍵（N、/、G 序列、[） */
export function useGlobalShortcuts(toggleSidebar: () => void) {
  const navigate = useNavigate();
  const toggleRef = useRef(toggleSidebar);
  useEffect(() => {
    toggleRef.current = toggleSidebar;
  });

  useEffect(() => {
    let pendingG = false;
    let timer: number | undefined;
    const onKey = (e: KeyboardEvent) => {
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
          document.querySelector<HTMLElement>(`[${GLOBAL_QUICKADD_ATTR}]`)?.focus();
          break;
        case 'focus-search':
          document.querySelector<HTMLElement>(`[${FILTER_SEARCH_ATTR}]`)?.focus();
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
