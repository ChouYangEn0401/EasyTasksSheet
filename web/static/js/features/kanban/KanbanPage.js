import { createElement, Fragment } from 'preact';
import { useMemo } from 'preact/compat';
import { hasActiveFilters } from '../../lib/filters.js';
import { useProjects, useStatuses, useTasks } from '../../lib/hooks.js';
import { useTaskFilters } from '../../lib/useTaskFilters.js';
import { NoFilterResults } from '../../shell/FilterBar.js';
import { ErrorState } from '../../ui/index.js';
import { ViewTabsActions } from '../../shell/ViewTabs.js';
import { DependencyMarksToggle } from '../delay-link/DependencyBadge.js';
import { KanbanBoard } from './KanbanBoard.js';
import { KanbanSkeleton } from './KanbanColumn.js';
import { visibleStatuses } from './kanbanModel.js';

/** Kanban 檢視（/tasks/kanban）：欄 = 狀態，拖曳改狀態 / 順序（docs/design/task-kanban.md） */
export function KanbanPage() {
  const { filters, clearFilters } = useTaskFilters();
  const tasksQ = useTasks(filters);
  const statusesQ = useStatuses();
  const projectsQ = useProjects();

  const statuses = useMemo(() => visibleStatuses(statusesQ.data ?? [], filters), [statusesQ.data, filters]);

  let body;
  if ((tasksQ.isError && !tasksQ.data) || (statusesQ.isError && !statusesQ.data)) {
    body = createElement(ErrorState, {
      error: tasksQ.error ?? statusesQ.error,
      onRetry: () => {
        void tasksQ.refetch();
        void statusesQ.refetch();
      },
    });
  } else if (!tasksQ.data || !statusesQ.data) {
    body = createElement(KanbanSkeleton, null);
  } else if (hasActiveFilters(filters) && tasksQ.data.length === 0) {
    body = createElement(NoFilterResults, null);
  } else {
    body = createElement(KanbanBoard, {
      tasks: tasksQ.data,
      statuses: statuses,
      filters: filters,
      projects: projectsQ.data ?? [],
      onClearFilters: clearFilters,
    });
  }

  return createElement(
    'section',
    { className: 'kanban', 'aria-label': '任務看板' },
    createElement(ViewTabsActions, null, createElement(DependencyMarksToggle, null)),
    body,
  );
}
