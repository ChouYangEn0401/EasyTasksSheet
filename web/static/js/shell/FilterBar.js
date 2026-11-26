import { createElement, Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/compat';
import { ColorDot } from '../ui/Badge.js';
import { hasActiveFilters } from '../lib/filters.js';
import { openAdminDialog } from '../features/tasks/adminUi.js';
import { useProjects, useStatuses, useTasks, useUsers } from '../lib/hooks.js';
import { useCan } from '../lib/permissions.js';
import { statusStyle, statusTone } from '../lib/colors.js';
import { FILTER_SEARCH_ATTR } from '../lib/shortcuts.js';
import { useTaskFilters } from '../lib/useTaskFilters.js';
import { Avatar, Button, EmptyState, Icon, Input, MultiSelect, Skeleton } from '../ui/index.js';

const SEARCH_DEBOUNCE_MS = 300;

/** 篩選後無結果時各檢視顯示的空狀態（含「清除篩選」） */
export function NoFilterResults() {
  const { clearFilters } = useTaskFilters();
  return createElement(EmptyState, {
    icon: 'search',
    title: '沒有符合條件的任務',
    action: createElement(Button, { variant: 'secondary', onClick: clearFilters }, '清除篩選'),
  });
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
  const canCreateProject = useCan('projects.create');
  const canManageProjects = useCan('projects.manage');
  const [showArchived, setShowArchived] = useState(false);

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

  const projectOptions = useMemo(
    () =>
      (projects.data ?? [])
        .filter((p) => showArchived || !p.isArchived || filters.project.includes(p.id))
        .map((p) => ({
          value: p.id,
          label: p.isArchived ? `${p.name}（已封存）` : p.name,
          leading: createElement(ColorDot, { color: p.color, size: 'md' }),
        })),
    [projects.data, filters.project, showArchived],
  );
  const assigneeOptions = useMemo(
    () => [
      {
        value: 'none',
        label: '未指派',
        leading: createElement(Avatar, { user: null, size: 'xs', tooltip: false }),
      },
      ...(users.data ?? [])
        .filter((u) => u.isActive || filters.assignee.includes(u.id))
        .map((u) => ({
          value: u.id,
          label: u.displayName,
          leading: createElement(Avatar, { user: u, size: 'xs', tooltip: false }),
        })),
    ],
    [users.data, filters.assignee],
  );
  const statusOptions = useMemo(
    () =>
      (statuses.data ?? []).map((s) => ({
        value: s.id,
        label: s.name,
        leading: createElement('span', {
          className: 'ui-dot ui-dot--md',
          style: { color: 'var(--status-dot)', ...statusStyle(statusTone(s)) },
        }),
      })),
    [statuses.data],
  );

  const hasArchived = (projects.data ?? []).some((p) => p.isArchived);
  const onlyDefaultProject = !!projects.data && projects.data.filter((p) => !p.isArchived).length <= 1;
  const active = hasActiveFilters(filters);
  return createElement(
    'div',
    { className: 'filter-bar', role: 'search', 'aria-label': '篩選任務' },
    createElement(Input, {
      wrapperClassName: 'filter-search',
      icon: 'search',
      placeholder: '搜尋任務…',
      'aria-label': '搜尋任務',
      value: q,
      onChange: (e) => setQ(e.target.value),
      onKeyDown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (q) setQ('');
          else e.currentTarget.blur();
        }
      },
      end: q
        ? createElement(Button, {
            variant: 'ghost',
            size: 'sm',
            iconOnly: true,
            icon: 'x',
            'aria-label': '清除搜尋',
            onClick: () => setQ(''),
          })
        : null,
      [FILTER_SEARCH_ATTR]: '',
    }),
    createElement(MultiSelect, {
      label: '專案',
      options: projectOptions,
      value: filters.project,
      onChange: (project) => setFilters({ project }),
      footer:
        canCreateProject || canManageProjects || hasArchived
          ? (close) =>
              createElement(
                Fragment,
                null,
                canCreateProject &&
                  createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'ui-option',
                      onClick: () => {
                        close();
                        // 建立後自動套用成為目前的專案篩選
                        openAdminDialog({
                          kind: 'add-project',
                          onCreated: (p) => {
                            setShowArchived(false);
                            setFilters({ project: [p.id] });
                          },
                        });
                      },
                    },
                    createElement(Icon, { name: 'plus' }),
                    createElement('span', { className: 'ui-option-label' }, '新增專案'),
                  ),
                canManageProjects &&
                  createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'ui-option',
                      onClick: () => {
                        close();
                        openAdminDialog({ kind: 'manage-projects' });
                      },
                    },
                    createElement(Icon, { name: 'pencil' }),
                    createElement('span', { className: 'ui-option-label' }, '管理專案…'),
                  ),
                hasArchived &&
                  createElement(
                    'button',
                    { type: 'button', className: 'ui-option', onClick: () => setShowArchived((v) => !v) },
                    createElement(Icon, { name: showArchived ? 'eyeOff' : 'eye' }),
                    createElement(
                      'span',
                      { className: 'ui-option-label' },
                      showArchived ? '隱藏已封存' : '顯示已封存',
                    ),
                  ),
              )
          : undefined,
    }),
    canCreateProject &&
      onlyDefaultProject &&
      createElement('span', { className: 'adm-faint', 'data-testid': 'project-hint' }, '可以新增自己的專案'),
    createElement(MultiSelect, {
      label: '負責人',
      options: assigneeOptions,
      value: filters.assignee,
      onChange: (assignee) => setFilters({ assignee }),
    }),
    createElement(MultiSelect, {
      label: '狀態',
      options: statusOptions,
      value: filters.status,
      onChange: (status) => setFilters({ status }),
    }),
    active &&
      createElement(
        Button,
        {
          variant: 'ghost',
          onClick: () => {
            setQ('');
            clearFilters();
          },
        },
        '清除篩選',
      ),
    createElement(
      'span',
      { className: 'filter-count', 'aria-live': 'polite' },
      tasks.isPending
        ? createElement(Skeleton, { width: 48, height: 12 })
        : `共 ${tasks.data?.length ?? 0} 筆`,
    ),
  );
}
