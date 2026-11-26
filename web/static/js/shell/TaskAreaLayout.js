import { createElement, Fragment } from 'preact';
import { useEffect, useState } from 'preact/compat';
import { Navigate, Outlet, useLocation } from '../lib/router.js';
import { readStorage, writeStorage } from '../lib/storage.js';
import { AdminDialogs } from '../features/tasks/AdminDialogs.js';
import { FilterBar } from './FilterBar.js';
import { LAST_TASK_VIEW_KEY, TASK_VIEWS } from './nav.js';
import { ViewTabs } from './ViewTabs.js';
import { ViewTabsActionsContext } from './viewTabsContext.js';

/** 任務區（/tasks/*）共用版面：ViewTabs + FilterBar（黏在頂部）+ 檢視內容 */
export function TaskAreaLayout() {
  const { pathname } = useLocation();
  const [actionsEl, setActionsEl] = useState(null);
  const view = pathname.split('/')[2];

  useEffect(() => {
    if (view && TASK_VIEWS.includes(view)) writeStorage(LAST_TASK_VIEW_KEY, view);
  }, [view]);

  return createElement(
    ViewTabsActionsContext.Provider,
    { value: actionsEl },
    createElement(
      'div',
      { className: 'task-bars' },
      createElement(ViewTabs, { actionsRef: setActionsEl }),
      createElement(FilterBar, null),
    ),
    createElement('div', { className: 'page' }, createElement(Outlet, null)),
    createElement(AdminDialogs, null),
  );
}

/** /tasks → 上次使用的檢視（預設 List），保留 query */
export function TaskIndexRedirect() {
  const { search } = useLocation();
  const v = readStorage(LAST_TASK_VIEW_KEY);
  const view = TASK_VIEWS.includes(v ?? '') ? v : 'list';
  return createElement(Navigate, { to: { pathname: `/tasks/${view}`, search }, replace: true });
}
