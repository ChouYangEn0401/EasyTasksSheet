import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useProjects } from '../../lib/hooks.ts';
import { Badge } from '../../ui/index.ts';
import { useIssues, useWorktrees } from './api.ts';
import { IssuesTab } from './IssuesTab.tsx';
import {
  hintCount,
  knownNames,
  openIssueCount,
  readEngTab,
  recordCount,
  writeEngTab,
  type EngTab,
} from './model.ts';
import { WorktreesTab } from './WorktreesTab.tsx';
import './eng.css';

/**
 * 工程追蹤（簡化版，docs/design/eng-tracking.md）：紀錄工具，手動輸入優先。
 * 兩個分頁「問題」「Worktree」，由 URL ?tab= 驅動。
 */
export function EngPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = readEngTab(searchParams);
  const issues = useIssues();
  const worktrees = useWorktrees();
  const projects = useProjects();

  // 專案 / repo 名稱建議：既有問題的專案欄、任務專案、回報的 repo 名稱
  const names = useMemo(
    () =>
      knownNames(
        (issues.data ?? []).map((i) => i.project),
        (projects.data ?? []).filter((p) => !p.isArchived).map((p) => p.name),
        (worktrees.data?.machines ?? []).flatMap((m) => m.reports.map((r) => r.repo)),
      ),
    [issues.data, projects.data, worktrees.data],
  );

  const hints = worktrees.data ? hintCount(worktrees.data.machines) : 0;
  const tabLink = (key: EngTab, label: string, count: number | undefined, extra?: ReactNode) => (
    <a
      href={`?${writeEngTab(searchParams, key).toString()}`}
      className="view-tab"
      aria-current={tab === key ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault();
        setSearchParams(writeEngTab(searchParams, key), { replace: true });
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
          {tabLink('issues', '問題', issues.data ? openIssueCount(issues.data) : undefined)}
          {tabLink(
            'worktrees',
            'Worktree',
            worktrees.data ? recordCount(worktrees.data.machines) : undefined,
            hints > 0 && (
              <span aria-label={`${hints} 個提示`}>
                <Badge tone="warning" count>
                  {hints}
                </Badge>
              </span>
            ),
          )}
        </nav>
      </div>
      {tab === 'issues' ? <IssuesTab query={issues} names={names} /> : <WorktreesTab query={worktrees} />}
    </div>
  );
}
