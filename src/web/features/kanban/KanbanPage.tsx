import { useMemo, type ReactNode } from 'react';
import { hasActiveFilters } from '../../lib/filters.ts';
import { useProjects, useStatuses, useTasks } from '../../lib/hooks.ts';
import { useTaskFilters } from '../../lib/useTaskFilters.ts';
import { NoFilterResults } from '../../shell/FilterBar.tsx';
import { ErrorState } from '../../ui/index.ts';
import { ViewTabsActions } from '../../shell/ViewTabs.tsx';
import { DependencyMarksToggle } from '../delay-link/DependencyBadge.tsx';
import { KanbanBoard } from './KanbanBoard.tsx';
import { KanbanSkeleton } from './KanbanColumn.tsx';
import { visibleStatuses } from './kanbanModel.ts';
import './kanban.css';

/** Kanban 檢視（/tasks/kanban）：欄 = 狀態，拖曳改狀態 / 順序（docs/design/task-kanban.md） */
export function KanbanPage() {
  const { filters, clearFilters } = useTaskFilters();
  const tasksQ = useTasks(filters);
  const statusesQ = useStatuses();
  const projectsQ = useProjects();

  const statuses = useMemo(() => visibleStatuses(statusesQ.data ?? [], filters), [statusesQ.data, filters]);

  let body: ReactNode;
  if ((tasksQ.isError && !tasksQ.data) || (statusesQ.isError && !statusesQ.data)) {
    body = (
      <ErrorState
        error={tasksQ.error ?? statusesQ.error}
        onRetry={() => {
          void tasksQ.refetch();
          void statusesQ.refetch();
        }}
      />
    );
  } else if (!tasksQ.data || !statusesQ.data) {
    body = <KanbanSkeleton />;
  } else if (hasActiveFilters(filters) && tasksQ.data.length === 0) {
    body = <NoFilterResults />;
  } else {
    body = (
      <KanbanBoard
        tasks={tasksQ.data}
        statuses={statuses}
        filters={filters}
        projects={projectsQ.data ?? []}
        onClearFilters={clearFilters}
      />
    );
  }

  return (
    <section className="kanban" aria-label="任務看板">
      <ViewTabsActions>
        <DependencyMarksToggle />
      </ViewTabsActions>
      {body}
    </section>
  );
}
