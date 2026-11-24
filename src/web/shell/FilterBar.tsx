import { useEffect, useMemo, useState } from 'react';
import { ColorDot } from '../ui/Badge.tsx';
import { hasActiveFilters, type AssigneeFilter } from '../lib/filters.ts';
import { useProjects, useStatuses, useTasks, useUsers } from '../lib/hooks.ts';
import { statusStyle, statusTone } from '../lib/colors.ts';
import { FILTER_SEARCH_ATTR } from '../lib/shortcuts.ts';
import { useTaskFilters } from '../lib/useTaskFilters.ts';
import { Avatar, Button, EmptyState, Input, MultiSelect, Skeleton, type SelectOption } from '../ui/index.ts';

const SEARCH_DEBOUNCE_MS = 300;

/** 篩選後無結果時各檢視顯示的空狀態（含「清除篩選」） */
export function NoFilterResults() {
  const { clearFilters } = useTaskFilters();
  return (
    <EmptyState
      icon="search"
      title="沒有符合條件的任務"
      action={
        <Button variant="secondary" onClick={clearFilters}>
          清除篩選
        </Button>
      }
    />
  );
}

/**
 * 任務篩選列：搜尋（debounce 300ms，replace 寫入 URL）+ 專案 / 負責人 / 狀態多選 + 清除篩選 + 結果數。
 * 狀態完全由 URL 驅動（useTaskFilters）。結果數與各檢視共用同一個 useTasks 查詢。
 */
export function FilterBar() {
  const { filters, setFilters, clearFilters } = useTaskFilters();
  const tasks = useTasks(filters);
  const projects = useProjects();
  const users = useUsers();
  const statuses = useStatuses();

  const [q, setQ] = useState(filters.q);
  const [urlQ, setUrlQ] = useState(filters.q);
  // URL 由外部改變（上一頁、清除篩選）時同步輸入框
  if (filters.q !== urlQ) {
    setUrlQ(filters.q);
    if (filters.q !== q.trim()) setQ(filters.q);
  }
  useEffect(() => {
    if (q.trim() === filters.q) return;
    const t = window.setTimeout(() => setFilters({ q }, { replace: true }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [q, filters.q, setFilters]);

  const projectOptions = useMemo<SelectOption<number>[]>(
    () =>
      (projects.data ?? [])
        .filter((p) => !p.isArchived || filters.project.includes(p.id))
        .map((p) => ({ value: p.id, label: p.name, leading: <ColorDot color={p.color} size="md" /> })),
    [projects.data, filters.project],
  );
  const assigneeOptions = useMemo<SelectOption<AssigneeFilter>[]>(
    () => [
      { value: 'none', label: '未指派', leading: <Avatar user={null} size="xs" tooltip={false} /> },
      ...(users.data ?? [])
        .filter((u) => u.isActive || filters.assignee.includes(u.id))
        .map((u) => ({
          value: u.id,
          label: u.displayName,
          leading: <Avatar user={u} size="xs" tooltip={false} />,
        })),
    ],
    [users.data, filters.assignee],
  );
  const statusOptions = useMemo<SelectOption<number>[]>(
    () =>
      (statuses.data ?? []).map((s) => ({
        value: s.id,
        label: s.name,
        leading: (
          <span
            className="ui-dot ui-dot--md"
            style={{ color: 'var(--status-dot)', ...statusStyle(statusTone(s)) }}
          />
        ),
      })),
    [statuses.data],
  );

  const active = hasActiveFilters(filters);
  return (
    <div className="filter-bar" role="search" aria-label="篩選任務">
      <Input
        wrapperClassName="filter-search"
        icon="search"
        placeholder="搜尋任務…"
        aria-label="搜尋任務"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (q) setQ('');
            else e.currentTarget.blur();
          }
        }}
        end={
          q ? (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="x"
              aria-label="清除搜尋"
              onClick={() => setQ('')}
            />
          ) : null
        }
        {...{ [FILTER_SEARCH_ATTR]: '' }}
      />
      <MultiSelect
        label="專案"
        options={projectOptions}
        value={filters.project}
        onChange={(project) => setFilters({ project })}
      />
      <MultiSelect
        label="負責人"
        options={assigneeOptions}
        value={filters.assignee}
        onChange={(assignee) => setFilters({ assignee })}
      />
      <MultiSelect
        label="狀態"
        options={statusOptions}
        value={filters.status}
        onChange={(status) => setFilters({ status })}
      />
      {active && (
        <Button
          variant="ghost"
          onClick={() => {
            setQ('');
            clearFilters();
          }}
        >
          清除篩選
        </Button>
      )}
      <span className="filter-count" aria-live="polite">
        {tasks.isPending ? <Skeleton width={48} height={12} /> : `共 ${tasks.data?.length ?? 0} 筆`}
      </span>
    </div>
  );
}
