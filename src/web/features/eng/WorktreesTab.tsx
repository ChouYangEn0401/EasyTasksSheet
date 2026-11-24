import { useEffect, useMemo, useState } from 'react';
import {
  WORKTREE_STATE_LABELS,
  WORKTREE_STATES,
  type WorktreeRow,
  type WorktreeState,
  type WorktreesResponse,
} from '../../../shared/eng.ts';
import type { Task } from '../../../shared/tasks.ts';
import { errorMessage } from '../../lib/api.ts';
import { useUsersById } from '../../lib/hooks.ts';
import { openTask } from '../../lib/openTask.ts';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Menu,
  Tooltip,
  UpdatedAt,
  type MenuItem,
} from '../../ui/index.ts';
import { MoreIcon } from './bits.tsx';
import { SkeletonRows } from './IssuesTab.tsx';
import { useIsWide } from './media.ts';
import { cleanupCommand, countStates, filterRows, middleTruncate, shortSha, STATUS_TONE } from './model.ts';

export type WorktreeActions = {
  create: () => void;
  register: (row: WorktreeRow) => void;
  edit: (row: WorktreeRow) => void;
  remove: (row: WorktreeRow) => void;
};

function StateBadges({ row }: { row: WorktreeRow }) {
  return (
    <span className="eng-badges">
      <Badge tone={STATUS_TONE[row.status]} dot className={`eng-status eng-status--${row.status}`}>
        {WORKTREE_STATE_LABELS[row.status]}
      </Badge>
      {row.flags.map((f) => (
        <Badge key={f} dot className={`eng-flag eng-flag--${f}`}>
          {WORKTREE_STATE_LABELS[f]}
        </Badge>
      ))}
    </span>
  );
}

function BranchCell({ row }: { row: WorktreeRow }) {
  const purpose = row.plan?.purpose;
  return (
    <div className="eng-two-line">
      <span className="eng-branch">
        <span className="eng-mono">{row.branch ?? '（detached）'}</span>
        {purpose && (
          <Tooltip content={purpose}>
            <span className="eng-purpose" tabIndex={0} aria-label={`用途：${purpose}`}>
              <Icon name="info" size={14} />
            </span>
          </Tooltip>
        )}
      </span>
      <Tooltip content={row.path}>
        <span className="eng-path" tabIndex={0} aria-label={`路徑 ${row.path}`}>
          {middleTruncate(row.path, 34)}
        </span>
      </Tooltip>
    </div>
  );
}

function OwnerCell({ row }: { row: WorktreeRow }) {
  const byId = useUsersById();
  if (!row.plan) return <span className="eng-text-tertiary">—</span>;
  const user = row.plan.ownerId != null ? byId.get(row.plan.ownerId) : undefined;
  return (
    <span className="eng-owner">
      <Avatar user={user ?? null} size="sm" />
      <span className="eng-owner-name">{user?.displayName ?? '未指派'}</span>
    </span>
  );
}

function TaskCell({ taskId, task }: { taskId: number | null | undefined; task: Task | undefined }) {
  if (taskId == null) return <span className="eng-text-tertiary">—</span>;
  return (
    <button type="button" className="eng-task-link" onClick={() => openTask(taskId)}>
      <span className="eng-mono">#{taskId}</span> {task?.title ?? ''}
    </button>
  );
}

const Counts = ({ ahead, behind }: { ahead: number | null; behind: number | null }) =>
  ahead == null || behind == null ? null : (
    <span className="tabular-nums eng-counts" aria-label={`領先 ${ahead}，落後 ${behind}`}>
      <span className={ahead ? undefined : 'eng-text-tertiary'}>↑{ahead}</span>{' '}
      <span className={behind ? undefined : 'eng-text-tertiary'}>↓{behind}</span>
    </span>
  );

function ActualCell({ row }: { row: WorktreeRow }) {
  const s = row.snapshot;
  if (row.status === 'missing' || !s) {
    return <span className="eng-danger-text">找不到此 worktree</span>;
  }
  return (
    <div className="eng-two-line">
      <span className="eng-actual">
        <span className="eng-mono">{shortSha(s.headSha) || '—'}</span>
        <Counts ahead={s.ahead} behind={s.behind} />
        {row.status === 'merged' && <span className="eng-text-secondary">已併入 main</span>}
      </span>
      <span className="eng-sub">
        最後提交 {s.lastCommitAt != null ? <UpdatedAt at={s.lastCommitAt} /> : '—'}
      </span>
    </div>
  );
}

function UpdatedCell({ row }: { row: WorktreeRow }) {
  const s = row.snapshot;
  if (row.status === 'missing' && row.plan) return <UpdatedAt at={row.plan.updatedAt} />;
  if (s) return <UpdatedAt at={s.reportedAt} by={s.reportedBy} prefix="偵測於" />;
  if (row.plan) return <UpdatedAt at={row.plan.updatedAt} />;
  return null;
}

function RowActions({ row, actions, wide }: { row: WorktreeRow; actions: WorktreeActions; wide: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  if (!row.plan) {
    return (
      <Button size="sm" variant="secondary" onClick={() => actions.register(row)}>
        登記
      </Button>
    );
  }
  const plan = row.plan;
  const items: MenuItem[] = [];
  if (!wide && plan.taskId != null) {
    const taskId = plan.taskId;
    items.push({ key: 'task', label: '開啟關聯任務', onSelect: () => openTask(taskId) });
  }
  items.push({ key: 'edit', label: '編輯安排', onSelect: () => actions.edit(row) });
  if (row.status === 'merged') {
    items.push({
      key: 'copy',
      label: copied ? '已複製' : '複製清理指令',
      onSelect: () => {
        void navigator.clipboard?.writeText(cleanupCommand(row)).then(() => setCopied(true));
      },
    });
  }
  items.push({ key: 'sep', separator: true });
  items.push({ key: 'delete', label: '刪除安排', danger: true, onSelect: () => actions.remove(row) });
  return (
    <Menu
      align="end"
      label={`${row.branch ?? row.path} 的動作`}
      items={items}
      trigger={(p) => (
        <Button
          {...p}
          variant="ghost"
          size="sm"
          iconOnly
          icon={<MoreIcon />}
          aria-label={`${row.branch ?? row.path} 的動作`}
        />
      )}
    />
  );
}

/** Worktrees 分頁（design §3） */
export function WorktreesTab({
  query,
  filter,
  onFilter,
  actions,
  tasksById,
  detecting,
  onRedetect,
}: {
  query: { data?: WorktreesResponse; isPending: boolean; error: unknown; refetch: () => void };
  filter: WorktreeState | null;
  onFilter: (s: WorktreeState | null) => void;
  actions: WorktreeActions;
  tasksById: Map<number, Task>;
  detecting: boolean;
  onRedetect: () => void;
}) {
  const wide = useIsWide();
  const data = query.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const counts = useMemo(() => countStates(rows), [rows]);
  const visible = useMemo(() => filterRows(rows, filter), [rows, filter]);

  if (!data && query.error)
    return <ErrorState title="偵測失敗" error={query.error} onRetry={query.refetch} />;
  if (data && rows.length === 0) {
    return (
      <div className="eng-card">
        <EmptyState
          icon="branch"
          title="尚未安排任何 worktree"
          action={
            <Button variant="primary" icon="plus" onClick={actions.create}>
              新增安排
            </Button>
          }
        />
      </div>
    );
  }

  const chip = (key: WorktreeState | null, label: string, count: number) => (
    <Button
      key={key ?? 'all'}
      size="sm"
      variant="secondary"
      className="eng-chip"
      data-active={filter === key || undefined}
      aria-pressed={filter === key}
      disabled={count === 0 && filter !== key}
      onClick={() => onFilter(key)}
    >
      {label} <span className="tabular-nums">{count}</span>
    </Button>
  );

  return (
    <section className="eng-section" aria-label="Worktrees">
      <div className="eng-toolbar">
        <div className="eng-chips" role="group" aria-label="依狀態篩選">
          {chip(null, '全部', rows.length)}
          {WORKTREE_STATES.map((s) => chip(s, WORKTREE_STATE_LABELS[s], counts[s]))}
        </div>
        <span className="eng-toolbar-end">
          {data?.detectedAt != null && (
            <span className="eng-text-secondary eng-sync">
              {data.mode === 'report' ? '回報於' : '偵測於'} <UpdatedAt at={data.detectedAt} />
            </span>
          )}
          <Button size="sm" variant="secondary" icon="refresh" loading={detecting} onClick={onRedetect}>
            {detecting ? '偵測中…' : '重新偵測'}
          </Button>
          <Button size="sm" variant="primary" icon="plus" onClick={actions.create}>
            新增安排
          </Button>
        </span>
      </div>
      {query.error != null && data && (
        <Alert tone="warning">偵測失敗，目前顯示上次的結果（{errorMessage(query.error)}）</Alert>
      )}
      {data && visible.length === 0 ? (
        <div className="eng-card">
          <EmptyState
            icon="search"
            title="沒有符合此狀態的 worktree"
            action={
              <Button variant="secondary" onClick={() => onFilter(null)}>
                顯示全部
              </Button>
            }
          />
        </div>
      ) : (
        <div className="eng-card eng-scroll">
          <table className="eng-table eng-table--wt" data-wide={wide || undefined}>
            <thead>
              <tr>
                <th scope="col">狀態</th>
                <th scope="col">分支 / 路徑</th>
                <th scope="col">負責人</th>
                {wide && <th scope="col">關聯任務</th>}
                <th scope="col">實際狀態</th>
                <th scope="col">更新</th>
                <th scope="col" className="eng-col-action">
                  <span className="sr-only">動作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data ? (
                visible.map((row) => (
                  <tr
                    key={row.key}
                    className={`eng-wt-row eng-wt-row--${row.status}`}
                    data-status={row.status}
                  >
                    <td>
                      <StateBadges row={row} />
                    </td>
                    <td>
                      <BranchCell row={row} />
                    </td>
                    <td>
                      <OwnerCell row={row} />
                    </td>
                    {wide && (
                      <td className="eng-col-task">
                        <TaskCell
                          taskId={row.plan?.taskId}
                          task={row.plan?.taskId != null ? tasksById.get(row.plan.taskId) : undefined}
                        />
                      </td>
                    )}
                    <td>
                      <ActualCell row={row} />
                    </td>
                    <td>
                      <UpdatedCell row={row} />
                    </td>
                    <td className="eng-col-action">
                      <RowActions row={row} actions={actions} wide={wide} />
                    </td>
                  </tr>
                ))
              ) : (
                <SkeletonRows rows={5} cols={wide ? 7 : 6} />
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
