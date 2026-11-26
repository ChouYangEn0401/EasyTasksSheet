import { createElement, Fragment } from 'preact';
import { useCallback, useEffect, useState } from 'preact/compat';
import { Outlet, useLocation, useMatches } from '../lib/router.js';
import { TaskDrawer } from '../features/tasks/TaskDrawer.js';
import { GlobalOverlays } from '../lib/GlobalOverlays.js';
import { readStorage, useMediaQuery, writeStorage } from '../lib/storage.js';
import { useApiOnline } from '../lib/useOnline.js';
import { Alert } from '../ui/index.js';
import { Header } from './Header.js';
import { SIDEBAR_PREF_KEY } from './nav.js';
import { Sidebar } from './Sidebar.js';
import { useGlobalShortcuts } from './useGlobalShortcuts.js';

/** 由路由 handle.title 取得頁面標題 */
function usePageTitle() {
  const matches = useMatches();
  for (let i = matches.length - 1; i >= 0; i--) {
    const title = matches[i].handle?.title;
    if (title) return title;
  }
  return '';
}

/**
 * 已登入後的外框：Sidebar + Header + 內容區，並全域掛載 TaskDrawer 與 GlobalOverlays（T9 用）。
 * 側欄：≥1280 預設展開、1024–1279 預設收合（手動切換存 localStorage）；
 * 768–1023 固定收合、展開為覆蓋式；<768 隱藏，由 Header 漢堡鈕開啟覆蓋式選單。
 */
export function AppShell() {
  const title = usePageTitle();
  const location = useLocation();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isWide = useMediaQuery('(min-width: 1280px)');
  const [pref, setPref] = useState(() => readStorage(SIDEBAR_PREF_KEY));
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const online = useApiOnline();

  const desktopCollapsed = pref ? pref === 'collapsed' : !isWide;
  const collapsed = isDesktop ? desktopCollapsed : !overlayOpen;
  const overlay = !isDesktop && overlayOpen;

  const toggleSidebar = useCallback(() => {
    if (isDesktop) {
      const next = desktopCollapsed ? 'expanded' : 'collapsed';
      writeStorage(SIDEBAR_PREF_KEY, next);
      setPref(next);
    } else setOverlayOpen((v) => !v);
  }, [isDesktop, desktopCollapsed]);

  useGlobalShortcuts(toggleSidebar);

  // 覆蓋式側欄：換頁後自動收回；Esc 關閉
  const [lastPath, setLastPath] = useState(location.pathname);
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname);
    if (overlayOpen) setOverlayOpen(false);
  }
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setOverlayOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay]);

  useEffect(() => {
    document.title = title ? `${title} — TasksSheets` : 'TasksSheets';
  }, [title]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  return createElement(
    'div',
    { className: 'shell', 'data-collapsed': collapsed || undefined, 'data-overlay': overlay || undefined },
    createElement('a', { href: '#main', className: 'skip-link sr-only-focusable' }, '跳至主要內容'),
    createElement(
      'div',
      { className: 'shell-sidebar-slot' },
      createElement(Sidebar, {
        collapsed: collapsed,
        onToggle: toggleSidebar,
        toggleLabel: collapsed ? '展開側欄' : '收合側欄',
      }),
    ),
    overlay &&
      createElement('div', {
        className: 'sidebar-backdrop',
        onClick: () => setOverlayOpen(false),
        'aria-hidden': 'true',
      }),
    createElement(
      'div',
      { className: 'shell-main' },
      createElement(Header, {
        title: title,
        onOpenMenu: () => setOverlayOpen(true),
        onPasswordChanged: () => setNotice('密碼已更新'),
      }),
      createElement(
        'main',
        { id: 'main', className: 'shell-content', tabIndex: -1 },
        (!online || notice) &&
          createElement(
            'div',
            { className: 'shell-banner flex flex-col gap-2' },
            !online && createElement(Alert, { tone: 'warning' }, '連線中斷，正在重試…'),
            notice && createElement(Alert, { tone: 'success', onClose: () => setNotice(null) }, notice),
          ),
        createElement(Outlet, null),
      ),
    ),
    createElement(TaskDrawer, null),
    createElement(GlobalOverlays, null),
  );
}

/** 一般頁面的內容容器（內距 24px） */
export function PageLayout() {
  return createElement('div', { className: 'page' }, createElement(Outlet, null));
}
