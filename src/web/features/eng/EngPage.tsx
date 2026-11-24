import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { WorktreeRow } from '../../../shared/eng.ts';
import { useCurrentUser } from '../../lib/auth.ts';
import { useTasks } from '../../lib/hooks.ts';
import { isEditableTarget } from '../../lib/shortcuts.ts';
import { Badge, Button, EmptyState, ErrorState, Select, Skeleton } from '../../ui/index.ts';
import { useDeletePlan, useIssues, useRedetect, useRefreshIssues, useRepos, useWorktrees } from './api.ts';
import { IssuesTab } from './IssuesTab.tsx';
import {
  abnormalCount,
  draftFromPlan,
  readEngParams,
  writeEngParams,
  type EngParams,
  type EngTab,
  type PlanDraft,
} from './model.ts';
import { DeletePlanDialog, PlanDialog } from './PlanDialog.tsx';
import { RepoDialog } from './RepoDialog.tsx';
import { WorktreesTab, type WorktreeActions } from './WorktreesTab.tsx';
import './eng.css';

/** 工程追蹤：git issue + worktree（docs/design/eng-tracking.md）；分頁 / repo / 篩選皆由 URL 驅動 */
export function EngPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const me = useCurrentUser();
  const isAdmin = me?.role === 'admin';
  const reposQuery = useRepos();
  const repos = useMemo(() => reposQuery.data ?? [], [reposQuery.data]);
  const { tab, repoId, wt } = readEngParams(searchParams, repos);

  const issues = useIssues(repoId);
  const worktrees = useWorktrees(repoId);
  const refreshIssues = useRefreshIssues();
  const redetect = useRedetect();
  const deletePlan = useDeletePlan();
  const tasksQuery = useTasks();
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null);
  const [deleting, setDeleting] = useState<WorktreeRow | null>(null);
  const [manageRepos, setManageRepos] = useState(false);
  const [announce, setAnnounce] = useState('');

  const update = (patch: Partial<EngParams>) =>
    setSearchParams(writeEngParams(searchParams, patch), { replace: true });

  const doRefresh = () => {
    if (repoId == null) return;
    if (tab === 'issues') {
      if (refreshIssues.isPending) return;
      refreshIssues.mutate(repoId, {
        onSuccess: (d) =>
          setAnnounce(d.error ? `同步失敗：${d.error.message}` : `已更新，共 ${d.issues.length} 筆`),
      });
    } else {
      if (redetect.isPending) return;
      redetect.mutate(repoId, {
        onSuccess: (d) => setAnnounce(`已更新，共 ${d.rows.length} 筆`),
        onError: () => void worktrees.refetch(),
      });
    }
  };

  // R：重新整理目前分頁（focus 在輸入框或有對話框開啟時不觸發）
  const refreshRef = useRef(doRefresh);
  useEffect(() => {
    refreshRef.current = doRefresh;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'r' && e.key !== 'R') return;
      if (isEditableTarget(e.target) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      refreshRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const actions: WorktreeActions = {
    create: () => {
      if (repoId != null)
        setPlanDraft({ repoId, branch: '', path: '', ownerId: null, taskId: null, purpose: '' });
    },
    register: (row) =>
      setPlanDraft({
        repoId: row.snapshot?.repoId ?? repoId ?? 0,
        branch: row.branch ?? '',
        path: row.path,
        ownerId: null,
        taskId: null,
        purpose: '',
      }),
    edit: (row) => {
      if (row.plan) setPlanDraft(draftFromPlan(row.plan));
    },
    remove: (row) => {
      deletePlan.reset();
      setDeleting(row);
    },
  };

  const dialogs = (
    <>
      {manageRepos && <RepoDialog repos={repos} onClose={() => setManageRepos(false)} />}
      {planDraft && (
        <PlanDialog draft={planDraft} repos={repos} tasks={tasks} onClose={() => setPlanDraft(null)} />
      )}
      {deleting?.plan && (
        <DeletePlanDialog
          pending={deletePlan.isPending}
          error={deletePlan.error}
          onClose={() => setDeleting(null)}
          onConfirm={() => deletePlan.mutate(deleting.plan!.id, { onSuccess: () => setDeleting(null) })}
        />
      )}
    </>
  );

  if (reposQuery.isPending) {
    return (
      <div className="eng-page" aria-busy="true">
        <Skeleton width={240} height={32} />
        <Skeleton height={240} />
      </div>
    );
  }
  if (reposQuery.error && !reposQuery.data) {
    return <ErrorState error={reposQuery.error} onRetry={() => void reposQuery.refetch()} />;
  }
  if (repos.length === 0) {
    return (
      <div className="eng-page">
        <EmptyState
          icon="branch"
          title="尚未登記任何 repo"
          description={isAdmin ? undefined : '請管理員新增要追蹤的 repo'}
          action={
            isAdmin ? (
              <Button variant="primary" icon="tool" onClick={() => setManageRepos(true)}>
                管理 repo
              </Button>
            ) : undefined
          }
        />
        {dialogs}
      </div>
    );
  }

  const wtRows = worktrees.data?.rows ?? [];
  const warn = abnormalCount(wtRows);
  const tabLink = (key: EngTab, label: string, count: number | undefined, extra?: ReactNode) => (
    <a
      href={`?${writeEngParams(searchParams, { tab: key }).toString()}`}
      className="view-tab"
      aria-current={tab === key ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        update({ tab: key });
      }}
    >
      {label}
      {count != null && <span className="eng-tab-count tabular-nums">{count}</span>}
      {extra}
    </a>
  );

  return (
    <div className="eng-page">
      <div className="eng-tabs">
        <nav className="view-tabs-nav" aria-label="工程追蹤">
          {tabLink('issues', 'Issues', issues.data?.configured ? issues.data.issues.length : undefined)}
          {tabLink(
            'worktrees',
            'Worktrees',
            worktrees.data ? wtRows.length : undefined,
            warn > 0 && (
              <span aria-label={`${warn} 個異常`}>
                <Badge tone="warning" count>
                  {warn}
                </Badge>
              </span>
            ),
          )}
        </nav>
        <div className="eng-tabs-actions">
          <span className="eng-repo-select">
            <Select
              options={repos.map((r) => ({
                value: r.id,
                label: r.remoteSlug ? `${r.name}（${r.remoteSlug}）` : r.name,
              }))}
              value={repoId}
              onChange={(id) => update({ repoId: id, wt: null })}
              disabled={repos.length === 1}
              aria-label="Repo"
              align="end"
              renderValue={(o) => (
                <span className="ui-select-label eng-repo-value">
                  Repo：{repos.find((r) => r.id === o?.value)?.name ?? ''}
                </span>
              )}
            />
          </span>
          {isAdmin && (
            <Button variant="secondary" icon="tool" onClick={() => setManageRepos(true)}>
              管理 repo
            </Button>
          )}
        </div>
      </div>

      {tab === 'issues' ? (
        <IssuesTab query={issues} refreshing={refreshIssues.isPending} onRefresh={doRefresh} />
      ) : (
        <WorktreesTab
          query={worktrees}
          filter={wt}
          onFilter={(s) => update({ wt: s })}
          actions={actions}
          tasksById={tasksById}
          detecting={redetect.isPending}
          onRedetect={doRefresh}
        />
      )}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {dialogs}
    </div>
  );
}
