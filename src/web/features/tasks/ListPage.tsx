import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { PropertyDef } from '../../../shared/properties.ts';
import { hasActiveFilters } from '../../lib/filters.ts';
import {
  useProjectsById,
  useProperties,
  useStatuses,
  useStatusesById,
  useTasks,
  useUsersById,
} from '../../lib/hooks.ts';
import { readTaskParam } from '../../lib/openTask.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
import { useTaskFilters } from '../../lib/useTaskFilters.ts';
import { NoFilterResults } from '../../shell/FilterBar.tsx';
import { ViewTabsActions } from '../../shell/ViewTabs.tsx';
import { EmptyState, ErrorState, Skeleton } from '../../ui/index.ts';
import { ListTable } from './ListTable.tsx';
import { ListToolbar } from './ListToolbar.tsx';
import {
  allColumns,
  groupTasks,
  parseGroup,
  parseHidden,
  parseSort,
  sortTasks,
  visibleColumns,
  type GroupMode,
  type Lookups,
} from './model.ts';
import { DeletePropertyDialog } from './PropertyPanel.tsx';
import { QuickAdd } from './QuickAdd.tsx';
import type { CommitResult } from './useFieldCommit.ts';
import './tasks.css';

const COLUMNS_KEY = 'tasks.list.columns';

/** /tasks/list：List 檢視（分組、排序、就地編輯、自訂欄位） */
export function ListPage() {
  const [sp, setSp] = useSearchParams();
  const { filters } = useTaskFilters();
  const tasks = useTasks(filters);
  const statusesQ = useStatuses();
  const properties = useProperties().data;
  const statusesById = useStatusesById();
  const users = useUsersById();
  const projects = useProjectsById();

  const group = parseGroup(sp);
  const sort = parseSort(sp);
  const [hidden, setHidden] = useState<string[]>(() => parseHidden(readStorage(COLUMNS_KEY)));
  const [announce, setAnnounce] = useState('');
  const [deleting, setDeleting] = useState<PropertyDef | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const selectedId = readTaskParam(sp);

  const columns = useMemo(() => allColumns(properties ?? []), [properties]);
  const shown = useMemo(() => visibleColumns(columns, hidden), [columns, hidden]);
  const lookups = useMemo<Lookups>(
    () => ({ statuses: statusesById, users, projects }),
    [statusesById, users, projects],
  );

  const groups = useMemo(() => {
    const sorted = sortTasks(tasks.data ?? [], sort, columns, lookups);
    const statusList = (statusesQ.data ?? []).filter(
      (s) => !filters.status.length || filters.status.includes(s.id),
    );
    return groupTasks(sorted, group, lookups, statusList);
  }, [tasks.data, sort, columns, lookups, group, statusesQ.data, filters.status]);

  const setParam = useCallback(
    (patch: Record<string, string | null>) =>
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v == null) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: true },
      ),
    [setSp],
  );

  const saveHidden = (next: string[]) => {
    setHidden(next);
    writeStorage(COLUMNS_KEY, JSON.stringify(next));
  };
  const toggleColumn = (key: string, visible: boolean) =>
    saveHidden(visible ? hidden.filter((k) => k !== key) : [...new Set([...hidden, key])]);

  const onPropertyCreated = (p: PropertyDef) => {
    saveHidden(hidden.filter((k) => k !== `p${p.id}`));
    // 新欄出現在最右：表格水平捲到該欄
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollLeft = el.scrollWidth;
      }),
    );
  };

  // 失敗由全域 toast 呈現（lib/queryClient.ts，已還原並可重試）；此處只做螢幕閱讀器播報
  const onSaved = useCallback((r: CommitResult) => {
    if (!r.ok) setAnnounce('儲存失敗');
    else if (!('skipped' in r)) setAnnounce('已儲存');
  }, []);

  const scopeProjectId = filters.project.length === 1 ? filters.project[0]! : null;
  const count = tasks.data?.length ?? 0;

  let body;
  if (tasks.isPending) body = <ListSkeleton />;
  else if (tasks.isError && !tasks.data)
    body = (
      <div className="tl-block">
        <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />
      </div>
    );
  else if (count === 0 && hasActiveFilters(filters)) body = <NoFilterResults />;
  else if (count === 0)
    body = (
      <div className="tl-block">
        <EmptyState
          title="還沒有任務"
          description={
            <>
              按 <kbd className="ui-kbd">N</kbd> 或在下方輸入標題開始新增
            </>
          }
        />
        <div className="tl-empty-insert">
          <QuickAdd fullWidth bare label="新增任務" />
        </div>
      </div>
    );
  else
    body = (
      <div className="tl-block">
        <ListTable
          groups={groups}
          mode={group}
          columns={shown}
          allTasks={tasks.data ?? []}
          sort={sort}
          onSort={(key, dir) => setParam({ sort: dir ? key : null, dir })}
          onHide={(key) => toggleColumn(key, false)}
          onDeleteProperty={setDeleting}
          onPropertyCreated={onPropertyCreated}
          scopeProjectId={scopeProjectId}
          selectedId={selectedId}
          onSaved={onSaved}
          scrollRef={scrollRef}
        />
      </div>
    );

  return (
    <div className="tl-page" data-drawer={selectedId != null || undefined}>
      <ViewTabsActions>
        <ListToolbar
          group={group}
          onGroup={(g: GroupMode) => setParam({ group: g === 'status' ? null : g })}
          columns={columns}
          hidden={hidden}
          onToggleColumn={toggleColumn}
          scopeProjectId={scopeProjectId}
          onPropertyCreated={onPropertyCreated}
        />
      </ViewTabsActions>
      {body}
      <div className="tl-sr-only" aria-live="polite" role="status">
        {announce}
      </div>
      <DeletePropertyDialog property={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="tl-block" aria-busy="true" aria-label="載入中">
      <div className="tl-skel-row tl-skel-row--head">
        {[40, 20, 20, 20].map((w, i) => (
          <Skeleton key={i} width={`${w}%`} height={10} />
        ))}
      </div>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="tl-skel-row">
          <Skeleton width={18} height={18} style={{ borderRadius: 'var(--radius-full)' }} />
          <Skeleton width="60%" height={12} />
          <Skeleton width={72} height={12} />
          <Skeleton width={96} height={12} />
          <Skeleton width={56} height={12} />
          <Skeleton width={56} height={12} />
        </div>
      ))}
    </div>
  );
}
