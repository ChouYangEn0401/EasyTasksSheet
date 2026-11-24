import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Task } from '../../../shared/tasks.ts';
import { emptyFilters } from '../../lib/filters.ts';
import { useProjectsById, useStatusesById, useTasks } from '../../lib/hooks.ts';
import { openTask } from '../../lib/openTask.ts';
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
} from '../../ui/index.ts';
import { usePins } from './api.ts';
import { assignedRows, dueLabel, isDoneTask } from './model.ts';
import { PinButton } from './PinButton.tsx';

/** 區塊卡片：標題列（標題 + 計數 + 右側控制項）＋ 內容 */
export function SectionCard({
  id,
  title,
  count,
  controls,
  className = '',
  children,
}: {
  id: string;
  title: string;
  count: number | null;
  controls?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`pl-card ${className}`} aria-labelledby={id}>
      <div className="pl-card-head">
        <h2 id={id} className="pl-card-title" tabIndex={-1}>
          {title}
        </h2>
        {count != null && (
          <Badge count className="pl-card-count">
            {count}
          </Badge>
        )}
        <span className="pl-card-controls">{controls}</span>
      </div>
      {children}
    </section>
  );
}

export function SkeletonRows({ n = 3 }: { n?: number }) {
  return (
    <div className="pl-skeleton" aria-busy="true" aria-label="載入中">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="pl-skeleton-row">
          <Skeleton width={56} height={20} />
          <Skeleton width={`${60 - i * 12}%`} />
          <Skeleton width={48} />
        </div>
      ))}
    </div>
  );
}

/** ↑ ↓ 在同一區的列之間移動（selector 為列內可聚焦的主體） */
function moveRowFocus(e: KeyboardEvent<HTMLElement>, selector: string) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
  const current = (e.target as HTMLElement).closest<HTMLElement>(selector);
  if (!current) return false;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)];
  const next = all[all.indexOf(current) + (e.key === 'ArrowDown' ? 1 : -1)];
  e.preventDefault();
  next?.focus();
  return true;
}

function TaskRow({ task, showAssignee }: { task: Task; showAssignee: boolean }) {
  const statuses = useStatusesById();
  const projects = useProjectsById();
  const project = projects.get(task.projectId);
  const done = isDoneTask(task, statuses);
  const due = dueLabel(task.dueDate, done);
  const ref = useRef<HTMLDivElement>(null);

  // UpdatedAt 預設可聚焦；列內 Tab 順序只留列本體 → PinButton
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>('time[tabindex="0"]').forEach((el) => (el.tabIndex = -1));
  });

  return (
    <li className={`pl-task-row${done ? ' is-done' : ''}`} data-task-id={task.id}>
      <div
        ref={ref}
        className="pl-task-main"
        role="button"
        tabIndex={0}
        aria-label={`開啟任務：${task.title}`}
        onClick={() => openTask(task.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget) {
            e.preventDefault();
            openTask(task.id);
          }
        }}
      >
        <StatusBadge statusId={task.statusId} />
        <span className="pl-task-title">{task.title}</span>
        {showAssignee && (
          <span className="pl-task-assignee">
            <Avatar userId={task.assigneeId} size="xs" />
          </span>
        )}
        <span className="pl-task-project">
          <Tooltip content={project?.name}>
            <ColorDot color={project?.color} />
          </Tooltip>
          <span className="pl-task-project-name">{project?.name ?? '—'}</span>
        </span>
        <span className={`pl-task-due${due.overdue ? ' is-overdue' : ''}`}>{due.text}</span>
        <span className="pl-task-updated">
          <UpdatedAt at={task.updatedAt} by={task.updatedBy} />
        </span>
      </div>
      <span className="pl-task-pin">
        <PinButton taskId={task.id} size="sm" />
      </span>
    </li>
  );
}

function TaskList({ tasks, showAssignee, label }: { tasks: Task[]; showAssignee: boolean; label: string }) {
  return (
    <ul className="pl-task-list" aria-label={label} onKeyDown={(e) => moveRowFocus(e, '.pl-task-main')}>
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} showAssignee={showAssignee} />
      ))}
    </ul>
  );
}

type SectionText = { title: string; empty: string; emptyDesc?: string };

/** 指派給（該成員）的任務 */
export function AssignedSection({ userId, text }: { userId: number; text: SectionText }) {
  const [showDone, setShowDone] = useState(false);
  const filters = useMemo(() => ({ ...emptyFilters(), assignee: [userId] }), [userId]);
  const q = useTasks(filters);
  const statuses = useStatusesById();
  const ready = q.data != null && statuses.size > 0;
  const rows = useMemo(
    () => (ready ? assignedRows(q.data, statuses, showDone) : []),
    [ready, q.data, statuses, showDone],
  );

  let body: ReactNode;
  if (!ready && q.isError) body = <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  else if (!ready) body = <SkeletonRows />;
  else if (rows.length === 0) body = <EmptyState icon="listCheck" title={text.empty} />;
  else body = <TaskList tasks={rows} showAssignee={false} label={text.title} />;

  return (
    <SectionCard
      id="pl-assigned-title"
      title={text.title}
      count={ready ? rows.length : null}
      controls={
        <Checkbox label="顯示已完成" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
      }
    >
      {body}
    </SectionCard>
  );
}

/** （該成員）標記的任務 */
export function PinnedSection({ userId, text }: { userId: number; text: SectionText }) {
  const q = usePins(userId);
  const rows = useMemo(() => q.data?.map((p) => p.task), [q.data]);

  let body: ReactNode;
  if (!rows && q.isError) body = <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  else if (!rows) body = <SkeletonRows />;
  else if (rows.length === 0)
    body = <EmptyState icon="inbox" title={text.empty} description={text.emptyDesc} />;
  else body = <TaskList tasks={rows} showAssignee label={text.title} />;

  return (
    <SectionCard id="pl-pinned-title" title={text.title} count={rows ? rows.length : null}>
      {body}
    </SectionCard>
  );
}
