import { createElement, Fragment } from 'preact';
import { useContext } from 'preact/compat';
import { createPortal } from 'preact/compat';
import { NavLink, useLocation } from '../lib/router.js';
import { Icon } from '../ui/index.js';
import { ViewTabsActionsContext } from './viewTabsContext.js';

const VIEWS = [
  { key: 'list', label: '清單', icon: 'list' },
  { key: 'kanban', label: '看板', icon: 'kanban' },
  { key: 'gantt', label: '甘特圖', icon: 'gantt' },
  { key: 'delay-link', label: '延遲鏈', icon: 'link' },
];

/**
 * 各任務檢視把自己的控制項（分組、時間刻度…）放進 ViewTabs 右側：
 *   <ViewTabsActions><Select … /></ViewTabsActions>
 */
export function ViewTabsActions({ children }) {
  const el = useContext(ViewTabsActionsContext);
  return el ? createPortal(children, el) : null;
}

/** 清單 / 看板 / 甘特圖切換；為路由連結，切換時保留目前 query string（篩選不重置） */
export function ViewTabs({ actionsRef }) {
  const { search } = useLocation();
  return createElement(
    'div',
    { className: 'view-tabs' },
    createElement(
      'nav',
      { className: 'view-tabs-nav', 'aria-label': '任務檢視' },
      VIEWS.map((v) =>
        createElement(
          NavLink,
          { key: v.key, to: { pathname: `/tasks/${v.key}`, search }, className: 'view-tab' },
          createElement(Icon, { name: v.icon }),
          v.label,
        ),
      ),
    ),
    createElement('div', { ref: actionsRef, className: 'view-tabs-actions' }),
  );
}
