import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { Task } from '../../../shared/tasks.ts';
import { ApiError } from '../../lib/api.ts';
import { formatDateOnly, isOverdue } from '../../lib/format.ts';
import { useProjectsById, useStatusesById, useTask, useUsersById } from '../../lib/hooks.ts';
import { closeTask, readTaskParam } from '../../lib/openTask.ts';
import { isEditableTarget } from '../../lib/shortcuts.ts';
import {
  Avatar,
  Button,
  ColorDot,
  EmptyState,
  ErrorState,
  Skeleton,
  StatusBadge,
  UpdatedAt,
} from '../../ui/index.ts';
import { PinButton } from '../personal/PinButton.tsx';

/**
 * 插槽：任務詳情抽屜（core 最小版：唯讀，由 feat/task-list 升級為可編輯）。
 * 由網址 `?task=<id>` 驅動（以 openTask(id) 開啟）；由 AppShell 全域掛載，任何頁面皆可開啟。
 * 關閉：✕、Esc、移除 ?task 或瀏覽器上一頁。無遮罩（1024px 以下視為 modal 並加遮罩）。
 */
export function TaskDrawer() {
  const [sp] = useSearchParams();
  const id = readTaskParam(sp);
  if (id == null) return null;
  return <TaskDrawerPanel key={id} id={id} />;
}

function TaskDrawerPanel({ id }: { id: number }) {
  const query = useTask(id);
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isEditableTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      closeTask();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const notFound = query.error instanceof ApiError && query.error.status === 404;
  const task = query.data;

  let body: ReactNode;
  if (query.isPending) body = <DrawerSkeleton />;
  else if (notFound)
    body = (
      <EmptyState
        title="此任務不存在或已被刪除"
        action={
          <Button variant="secondary" onClick={closeTask}>
            關閉
          </Button>
        }
      />
    );
  else if (query.isError && !task)
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (task) body = <TaskDetail task={task} titleId={titleId} />;

  return (
    <>
      <div className="task-drawer-backdrop" onClick={closeTask} aria-hidden="true" />
      <aside
        ref={panelRef}
        className="task-drawer"
        role="dialog"
        aria-modal="false"
        aria-labelledby={task ? titleId : undefined}
        aria-label={task ? undefined : '任務詳情'}
        tabIndex={-1}
        style={{ outline: 'none' }}
      >
        <div className="task-drawer-head">
          <span className="task-drawer-id">#{id}</span>
          {task && <PinButton taskId={task.id} size="sm" />}
          <Button variant="ghost" size="sm" iconOnly icon="x" aria-label="關閉任務詳情" onClick={closeTask} />
        </div>
        <div className="task-drawer-body">{body}</div>
        {task && (
          <div className="task-drawer-foot">
            <UpdatedAt at={task.updatedAt} by={task.updatedBy} prefix="更新於" />
          </div>
        )}
      </aside>
    </>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="task-field">
      <span className="task-field-label">{label}</span>
      <span className="flex min-w-0 items-center gap-2">{children}</span>
    </div>
  );
}

const Empty = () => <span className="task-field-empty">—</span>;

function TaskDetail({ task, titleId }: { task: Task; titleId: string }) {
  const users = useUsersById();
  const projects = useProjectsById();
  const statuses = useStatusesById();
  const assignee = task.assigneeId != null ? users.get(task.assigneeId) : undefined;
  const project = projects.get(task.projectId);
  const status = statuses.get(task.statusId);
  const overdue = status?.category !== 'done' && isOverdue(task.dueDate);

  return (
    <>
      <h2 id={titleId} className="task-drawer-title">
        {task.title}
      </h2>
      <StatusBadge status={status} />
      <div className="task-drawer-section" style={{ marginTop: 16 }}>
        <FieldRow label="負責人">
          {task.assigneeId != null ? (
            <>
              <Avatar userId={task.assigneeId} size="sm" tooltip={false} />
              <span className="truncate">{assignee?.displayName ?? '—'}</span>
            </>
          ) : (
            <Empty />
          )}
        </FieldRow>
        <FieldRow label="專案">
          {project ? (
            <>
              <ColorDot color={project.color} size="md" />
              <span className="truncate">{project.name}</span>
            </>
          ) : (
            <Empty />
          )}
        </FieldRow>
        <FieldRow label="開始日">{task.startDate ? formatDateOnly(task.startDate) : <Empty />}</FieldRow>
        <FieldRow label="到期日">
          {task.dueDate ? (
            <span style={overdue ? { color: 'var(--color-status-overdue-text)' } : undefined}>
              {formatDateOnly(task.dueDate)}
              {overdue ? '（已逾期）' : ''}
            </span>
          ) : (
            <Empty />
          )}
        </FieldRow>
        <FieldRow label="預估工時">
          {task.estimateHours != null ? `${task.estimateHours} 小時` : <Empty />}
        </FieldRow>
        <FieldRow label="進度">
          <span
            className="progress"
            role="progressbar"
            aria-valuenow={task.progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${task.progress}%` }} />
          </span>
          <span className="tabular-nums text-secondary">{task.progress}%</span>
        </FieldRow>
      </div>
      <div className="task-drawer-section">
        <div className="mb-2 text-sm font-medium text-secondary">描述</div>
        {task.description ? (
          <p className="m-0 whitespace-pre-wrap text-base" style={{ overflowWrap: 'anywhere' }}>
            {task.description}
          </p>
        ) : (
          <Empty />
        )}
      </div>
    </>
  );
}

function DrawerSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="載入中">
      <Skeleton height={24} width="70%" />
      <Skeleton height={22} width={72} />
      <div className="mt-4 flex flex-col gap-4">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} height={14} width={`${50 + ((i * 13) % 40)}%`} />
        ))}
      </div>
    </div>
  );
}
