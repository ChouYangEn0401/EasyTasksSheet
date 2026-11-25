import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { readStorage, writeStorage } from '../lib/storage.ts';
import { AdminDialogs } from '../features/tasks/AdminDialogs.tsx';
import { FilterBar } from './FilterBar.tsx';
import { LAST_TASK_VIEW_KEY, TASK_VIEWS, type TaskView } from './nav.ts';
import { ViewTabs } from './ViewTabs.tsx';
import { ViewTabsActionsContext } from './viewTabsContext.ts';

/** 任務區（/tasks/*）共用版面：ViewTabs + FilterBar（黏在頂部）+ 檢視內容 */
export function TaskAreaLayout() {
  const { pathname } = useLocation();
  const [actionsEl, setActionsEl] = useState<HTMLDivElement | null>(null);
  const view = pathname.split('/')[2] as TaskView | undefined;

  useEffect(() => {
    if (view && (TASK_VIEWS as readonly string[]).includes(view)) writeStorage(LAST_TASK_VIEW_KEY, view);
  }, [view]);

  return (
    <ViewTabsActionsContext.Provider value={actionsEl}>
      <div className="task-bars">
        <ViewTabs actionsRef={setActionsEl} />
        <FilterBar />
      </div>
      <div className="page">
        <Outlet />
      </div>
      <AdminDialogs />
    </ViewTabsActionsContext.Provider>
  );
}

/** /tasks → 上次使用的檢視（預設 List），保留 query */
export function TaskIndexRedirect() {
  const { search } = useLocation();
  const v = readStorage(LAST_TASK_VIEW_KEY);
  const view = (TASK_VIEWS as readonly string[]).includes(v ?? '') ? v : 'list';
  return <Navigate to={{ pathname: `/tasks/${view}`, search }} replace />;
}
