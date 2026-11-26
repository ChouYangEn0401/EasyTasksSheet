import { createElement, Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/compat';
import { emptyFilters } from '../../lib/filters.js';
import { useProjectsById, useStatusesById, useTasks } from '../../lib/hooks.js';
import { openTask } from '../../lib/openTask.js';
import {
  Avatar,
  Badge,
  Checkbox,
  ColorDot,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusBadge,
  Tooltip,
  UpdatedAt,
} from '../../ui/index.js';
import { usePins } from './api.js';
import { assignedRows, dueLabel, isDoneTask } from './model.js';
import { PinButton } from './PinButton.js';

/** 區塊卡片：標題列（標題 + 計數 + 右側控制項）＋ 內容 */
export function SectionCard({ id, title, count, controls, className = '', children }) {
  return createElement(
    'section',
    { className: `pl-card ${className}`, 'aria-labelledby': id },
    createElement(
      'div',
      { className: 'pl-card-head' },
      createElement('h2', { id: id, className: 'pl-card-title', tabIndex: -1 }, title),
      count != null && createElement(Badge, { count: true, className: 'pl-card-count' }, count),
      createElement('span', { className: 'pl-card-controls' }, controls),
    ),
    children,
  );
}

export function SkeletonRows({ n = 3 }) {
  return createElement(
    'div',
    { className: 'pl-skeleton', 'aria-busy': 'true', 'aria-label': '載入中' },
    Array.from({ length: n }, (_, i) =>
      createElement(
        'div',
        { key: i, className: 'pl-skeleton-row' },
        createElement(Skeleton, { width: 56, height: 20 }),
        createElement(Skeleton, { width: `${60 - i * 12}%` }),
        createElement(Skeleton, { width: 48 }),
      ),
    ),
  );
}

/** ↑ ↓ 在同一區的列之間移動（selector 為列內可聚焦的主體） */
function moveRowFocus(e, selector) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
  const current = e.target.closest(selector);
  if (!current) return false;
  const all = [...e.currentTarget.querySelectorAll(selector)];
  const next = all[all.indexOf(current) + (e.key === 'ArrowDown' ? 1 : -1)];
  e.preventDefault();
  next?.focus();
  return true;
}

function TaskRow({ task, showAssignee }) {
  const statuses = useStatusesById();
  const projects = useProjectsById();
  const project = projects.get(task.projectId);
  const done = isDoneTask(task, statuses);
  const due = dueLabel(task.dueDate, done);
  const ref = useRef(null);

  // UpdatedAt 預設可聚焦；列內 Tab 順序只留列本體 → PinButton
  useEffect(() => {
    ref.current?.querySelectorAll('time[tabindex="0"]').forEach((el) => (el.tabIndex = -1));
  });

  return createElement(
    'li',
    { className: `pl-task-row${done ? ' is-done' : ''}`, 'data-task-id': task.id },
    createElement(
      'div',
      {
        ref: ref,
        className: 'pl-task-main',
        role: 'button',
        tabIndex: 0,
        'aria-label': `開啟任務：${task.title}`,
        onClick: () => openTask(task.id),
        onKeyDown: (e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget) {
            e.preventDefault();
            openTask(task.id);
          }
        },
      },
      createElement(StatusBadge, { statusId: task.statusId }),
      createElement('span', { className: 'pl-task-title' }, task.title),
      showAssignee &&
        createElement(
          'span',
          { className: 'pl-task-assignee' },
          createElement(Avatar, { userId: task.assigneeId, size: 'xs' }),
        ),
      createElement(
        'span',
        { className: 'pl-task-project' },
        createElement(
          Tooltip,
          { content: project?.name },
          createElement(ColorDot, { color: project?.color }),
        ),
        createElement('span', { className: 'pl-task-project-name' }, project?.name ?? '—'),
      ),
      createElement('span', { className: `pl-task-due${due.overdue ? ' is-overdue' : ''}` }, due.text),
      createElement(
        'span',
        { className: 'pl-task-updated' },
        createElement(UpdatedAt, { at: task.updatedAt, by: task.updatedBy }),
      ),
    ),
    createElement(
      'span',
      { className: 'pl-task-pin' },
      createElement(PinButton, { taskId: task.id, size: 'sm' }),
    ),
  );
}

function TaskList({ tasks, showAssignee, label }) {
  return createElement(
    'ul',
    { className: 'pl-task-list', 'aria-label': label, onKeyDown: (e) => moveRowFocus(e, '.pl-task-main') },
    tasks.map((t) => createElement(TaskRow, { key: t.id, task: t, showAssignee: showAssignee })),
  );
}

/** 指派給（該成員）的任務 */
export function AssignedSection({ userId, text }) {
  const [showDone, setShowDone] = useState(false);
  const filters = useMemo(() => ({ ...emptyFilters(), assignee: [userId] }), [userId]);
  const q = useTasks(filters);
  const statuses = useStatusesById();
  const ready = q.data != null && statuses.size > 0;
  const rows = useMemo(
    () => (ready ? assignedRows(q.data, statuses, showDone) : []),
    [ready, q.data, statuses, showDone],
  );

  let body;
  if (!ready && q.isError)
    body = createElement(ErrorState, { error: q.error, onRetry: () => void q.refetch() });
  else if (!ready) body = createElement(SkeletonRows, null);
  else if (rows.length === 0) body = createElement(EmptyState, { icon: 'listCheck', title: text.empty });
  else body = createElement(TaskList, { tasks: rows, showAssignee: false, label: text.title });

  return createElement(
    SectionCard,
    {
      id: 'pl-assigned-title',
      title: text.title,
      count: ready ? rows.length : null,
      controls: createElement(Checkbox, {
        label: '顯示已完成',
        checked: showDone,
        onChange: (e) => setShowDone(e.target.checked),
      }),
    },
    body,
  );
}

/** （該成員）標記的任務 */
export function PinnedSection({ userId, text }) {
  const q = usePins(userId);
  const rows = useMemo(() => q.data?.map((p) => p.task), [q.data]);

  let body;
  if (!rows && q.isError)
    body = createElement(ErrorState, { error: q.error, onRetry: () => void q.refetch() });
  else if (!rows) body = createElement(SkeletonRows, null);
  else if (rows.length === 0)
    body = createElement(EmptyState, { icon: 'inbox', title: text.empty, description: text.emptyDesc });
  else body = createElement(TaskList, { tasks: rows, showAssignee: true, label: text.title });

  return createElement(
    SectionCard,
    { id: 'pl-pinned-title', title: text.title, count: rows ? rows.length : null },
    body,
  );
}
