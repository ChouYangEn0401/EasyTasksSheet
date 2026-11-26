import { createElement, Fragment } from 'preact';
import { useCallback, useMemo, useRef, useState } from 'preact/compat';
import { useSearchParams } from '../../lib/router.js';
import { hasActiveFilters } from '../../lib/filters.js';
import {
  useProjectsById,
  useProperties,
  useStatuses,
  useStatusesById,
  useTasks,
  useUsersById,
} from '../../lib/hooks.js';
import { readTaskParam } from '../../lib/openTask.js';
import { readStorage, writeStorage } from '../../lib/storage.js';
import { useTaskFilters } from '../../lib/useTaskFilters.js';
import { NoFilterResults } from '../../shell/FilterBar.js';
import { ViewTabsActions } from '../../shell/ViewTabs.js';
import { EmptyState, ErrorState, Skeleton } from '../../ui/index.js';
import { ListDnd } from './ListDnd.js';
import { ListTable } from './ListTable.js';
import { ListToolbar } from './ListToolbar.js';
import {
  allColumns,
  groupTasks,
  parseGroup,
  parseHidden,
  parseSort,
  sortTasks,
  visibleColumns,
} from './model.js';
import { DeletePropertyDialog } from './PropertyPanel.js';
import { QuickAdd } from './QuickAdd.js';
import { useDrawerInset } from './useDrawerInset.js';

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
  const [hidden, setHidden] = useState(() => parseHidden(readStorage(COLUMNS_KEY)));
  const [announce, setAnnounce] = useState('');
  const [deleting, setDeleting] = useState(null);
  const scrollRef = useRef(null);
  const selectedId = readTaskParam(sp);

  const columns = useMemo(() => allColumns(properties ?? []), [properties]);
  const shown = useMemo(() => visibleColumns(columns, hidden), [columns, hidden]);
  const lookups = useMemo(
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
    (patch) =>
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

  const saveHidden = (next) => {
    setHidden(next);
    writeStorage(COLUMNS_KEY, JSON.stringify(next));
  };
  const toggleColumn = (key, visible) =>
    saveHidden(visible ? hidden.filter((k) => k !== key) : [...new Set([...hidden, key])]);

  const onPropertyCreated = (p) => {
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
  const onSaved = useCallback((r) => {
    if (!r.ok) setAnnounce('儲存失敗');
    else if (!('skipped' in r)) setAnnounce('已儲存');
  }, []);

  const scopeProjectId = filters.project.length === 1 ? filters.project[0] : null;
  const count = tasks.data?.length ?? 0;
  const showTable = !tasks.isPending && !(tasks.isError && !tasks.data) && count > 0;
  useDrawerInset(scrollRef, showTable && selectedId != null);

  let body;
  if (tasks.isPending) body = createElement(ListSkeleton, null);
  else if (tasks.isError && !tasks.data)
    body = createElement(
      'div',
      { className: 'tl-block' },
      createElement(ErrorState, { error: tasks.error, onRetry: () => void tasks.refetch() }),
    );
  else if (count === 0 && hasActiveFilters(filters)) body = createElement(NoFilterResults, null);
  else if (count === 0)
    body = createElement(
      'div',
      { className: 'tl-block' },
      createElement(EmptyState, {
        title: '還沒有任務',
        description: createElement(
          Fragment,
          null,
          '按 ',
          createElement('kbd', { className: 'ui-kbd' }, 'N'),
          ' 或在下方輸入標題開始新增',
        ),
      }),
      createElement(
        'div',
        { className: 'tl-empty-insert' },
        createElement(QuickAdd, { fullWidth: true, bare: true, label: '新增任務' }),
      ),
    );
  else
    body = createElement(ListDnd, { groups: groups, mode: group, sort: sort, scrollRef: scrollRef }, (view) =>
      createElement(
        'div',
        { className: 'tl-block' },
        createElement(ListTable, {
          groups: view,
          mode: group,
          columns: shown,
          allTasks: tasks.data ?? [],
          sort: sort,
          onSort: (key, dir) => setParam({ sort: dir ? key : null, dir }),
          onHide: (key) => toggleColumn(key, false),
          onDeleteProperty: setDeleting,
          onPropertyCreated: onPropertyCreated,
          scopeProjectId: scopeProjectId,
          selectedId: selectedId,
          onSaved: onSaved,
          scrollRef: scrollRef,
        }),
      ),
    );

  return createElement(
    'div',
    { className: 'tl-page', 'data-drawer': selectedId != null || undefined },
    createElement(
      ViewTabsActions,
      null,
      createElement(ListToolbar, {
        group: group,
        onGroup: (g) => setParam({ group: g === 'status' ? null : g }),
        columns: columns,
        hidden: hidden,
        onToggleColumn: toggleColumn,
        scopeProjectId: scopeProjectId,
        onPropertyCreated: onPropertyCreated,
      }),
    ),
    body,
    createElement('div', { className: 'tl-sr-only', 'aria-live': 'polite', role: 'status' }, announce),
    createElement(DeletePropertyDialog, { property: deleting, onClose: () => setDeleting(null) }),
  );
}

function ListSkeleton() {
  return createElement(
    'div',
    { className: 'tl-block', 'aria-busy': 'true', 'aria-label': '載入中' },
    createElement(
      'div',
      { className: 'tl-skel-row tl-skel-row--head' },
      [40, 20, 20, 20].map((w, i) => createElement(Skeleton, { key: i, width: `${w}%`, height: 10 })),
    ),
    Array.from({ length: 8 }, (_, i) =>
      createElement(
        'div',
        { key: i, className: 'tl-skel-row' },
        createElement(Skeleton, { width: 18, height: 18, style: { borderRadius: 'var(--radius-full)' } }),
        createElement(Skeleton, { width: '60%', height: 12 }),
        createElement(Skeleton, { width: 72, height: 12 }),
        createElement(Skeleton, { width: 96, height: 12 }),
        createElement(Skeleton, { width: 56, height: 12 }),
        createElement(Skeleton, { width: 56, height: 12 }),
      ),
    ),
  );
}
