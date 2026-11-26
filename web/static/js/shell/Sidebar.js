import { createElement, Fragment } from 'preact';
import { Link, NavLink, useLocation } from '../lib/router.js';
import { useCapabilities } from '../lib/permissions.js';
import { useAppInfo } from '../lib/appInfo.js';
import { readStorage } from '../lib/storage.js';
import { Button, Icon, Tooltip } from '../ui/index.js';
import { LAST_TASK_VIEW_KEY, NAV_ENTRIES, TASK_VIEWS } from './nav.js';

/** 任務群組標題：進入上次使用的檢視（預設 List） */
function lastTaskViewPath() {
  const v = readStorage(LAST_TASK_VIEW_KEY);
  return `/tasks/${TASK_VIEWS.includes(v ?? '') ? v : 'list'}`;
}

function NavItemLink({ entry, collapsed }) {
  const link = createElement(
    NavLink,
    { to: entry.to, end: entry.end ?? entry.to === '/', className: 'nav-item' },
    createElement(Icon, { name: entry.icon }),
    createElement('span', { className: 'nav-item-label' }, entry.label),
  );
  return collapsed ? createElement(Tooltip, { content: entry.label, placement: 'right' }, link) : link;
}

function TaskGroup({ entry, collapsed }) {
  const { pathname } = useLocation();
  const inGroup = pathname === '/tasks' || pathname.startsWith('/tasks/');
  return createElement(
    'div',
    { className: 'nav-group' },
    createElement(
      Link,
      {
        to: lastTaskViewPath(),
        className: 'nav-item',
        'data-group-active': inGroup || undefined,
        'aria-label': collapsed ? entry.label : undefined,
      },
      createElement(Icon, { name: entry.icon }),
      createElement('span', { className: 'nav-item-label' }, entry.label),
      createElement(Icon, {
        name: inGroup ? 'chevronDown' : 'chevronRight',
        size: 14,
        className: 'nav-chevron',
      }),
    ),
    inGroup &&
      entry.children?.map((c) =>
        createElement(
          NavLink,
          { key: c.key, to: c.to, className: 'nav-item nav-item--sub' },
          createElement('span', { className: 'nav-item-label' }, c.label),
        ),
      ),
    collapsed &&
      createElement(
        'div',
        { className: 'nav-flyout', role: 'group', 'aria-label': entry.label },
        createElement('div', { className: 'nav-flyout-title' }, entry.label),
        entry.children?.map((c) =>
          createElement(
            NavLink,
            { key: c.key, to: c.to, className: 'nav-item' },
            createElement('span', null, c.label),
          ),
        ),
      ),
  );
}

/** 側邊導覽（收合時只留圖示，文字以 tooltip 顯示；任務子項改為 hover 浮出選單） */
export function Sidebar({ collapsed, onToggle, toggleLabel }) {
  const info = useAppInfo();
  const caps = useCapabilities();
  const main = NAV_ENTRIES.filter((e) => !e.capability);
  const admin = NAV_ENTRIES.filter(
    (e) => e.capability && (e.anyOf ?? [e.capability]).some((c) => caps.has(c)),
  );
  return createElement(
    'aside',
    { className: 'sidebar', 'data-collapsed': collapsed || undefined },
    createElement(
      'div',
      { className: 'sidebar-brand' },
      createElement(Icon, { name: 'logo', className: 'sidebar-brand-mark' }),
      createElement('span', { className: 'sidebar-brand-text' }, 'TasksSheets'),
    ),
    createElement(
      'nav',
      { className: 'sidebar-nav', 'aria-label': '主要導覽' },
      main.map((e) =>
        e.children
          ? createElement(TaskGroup, { key: e.key, entry: e, collapsed: collapsed })
          : createElement(NavItemLink, { key: e.key, entry: e, collapsed: collapsed }),
      ),
      // 管理組：展開時顯示 11px 分組標題、細線隱藏；收合時反過來只留細線（ui-refresh §2.1）。第一組（工作）不顯示標題
      admin.length > 0 &&
        createElement(
          Fragment,
          null,
          createElement('div', { className: 'sidebar-sep', role: 'separator' }),
          createElement('div', { className: 'nav-section-label', 'aria-hidden': 'true' }, '管理'),
          admin.map((e) => createElement(NavItemLink, { key: e.key, entry: e, collapsed: collapsed })),
        ),
    ),
    createElement(
      'div',
      { className: 'sidebar-footer' },
      createElement(
        Tooltip,
        { content: collapsed ? toggleLabel : '', placement: 'right' },
        createElement(
          Button,
          {
            variant: 'ghost',
            icon: collapsed ? 'chevronsRight' : 'chevronsLeft',
            onClick: onToggle,
            'aria-label': toggleLabel,
            'aria-expanded': !collapsed,
          },
          createElement('span', { className: 'sidebar-footer-label' }, toggleLabel),
        ),
      ),
      info &&
        info.version &&
        createElement(
          'div',
          { className: 'sidebar-version', title: `${info.app} ${info.version}${info.author ? ` · ${info.author}` : ''}` },
          createElement('span', { className: 'sidebar-version-no' }, `v${info.version}`),
          info.author && createElement('span', { className: 'sidebar-version-author' }, info.author),
        ),
    ),
  );
}
