import { createElement, Fragment } from 'preact';
import { useMemo } from 'preact/compat';
import { useSearchParams } from '../../lib/router.js';
import { useProjects } from '../../lib/hooks.js';
import { Badge } from '../../ui/index.js';
import { useIssues, useWorktrees } from './api.js';
import { IssuesTab } from './IssuesTab.js';
import { hintCount, knownNames, openIssueCount, readEngTab, recordCount, writeEngTab } from './model.js';
import { WorktreesTab } from './WorktreesTab.js';
import { StatusAdminProvider } from './EngStatus.js';
import { useStatusList } from './statusHooks.js';

/**
 * 工程追蹤（簡化版，docs/design/eng-tracking.md）：紀錄工具，手動輸入優先。
 * 兩個分頁「問題」「工作樹」（git worktree），由 URL ?tab= 驅動。
 */
export function EngPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = readEngTab(searchParams);
  const issues = useIssues();
  const worktrees = useWorktrees();
  const projects = useProjects();
  const issueStatuses = useStatusList('issue');

  // 專案 / repo 名稱建議：既有問題的專案欄、任務專案、回報的 repo 名稱
  const names = useMemo(
    () =>
      knownNames(
        (issues.data?.issues ?? []).map((i) => i.project),
        (issues.data?.links ?? []).map((l) => l.project),
        (projects.data ?? []).filter((p) => !p.isArchived).map((p) => p.name),
        (worktrees.data?.machines ?? []).flatMap((m) => m.reports.map((r) => r.repo)),
      ),
    [issues.data, projects.data, worktrees.data],
  );

  const hints = worktrees.data ? hintCount(worktrees.data.machines) : 0;
  const tabLink = (key, label, count, extra) =>
    createElement(
      'a',
      {
        href: `?${writeEngTab(searchParams, key).toString()}`,
        className: 'view-tab',
        'aria-current': tab === key ? 'page' : undefined,
        onClick: (e) => {
          e.preventDefault();
          setSearchParams(writeEngTab(searchParams, key), { replace: true });
        },
      },
      label,
      count != null && createElement('span', { className: 'eng-tab-count tabular-nums' }, count),
      extra,
    );

  return createElement(
    'div',
    { className: 'eng-page' },
    createElement(
      'div',
      { className: 'eng-tabs' },
      createElement(
        'nav',
        { className: 'view-tabs-nav', 'aria-label': '工程追蹤' },
        tabLink(
          'issues',
          '問題',
          issues.data ? openIssueCount(issues.data.issues, issueStatuses) : undefined,
        ),
        tabLink(
          'worktrees',
          '工作樹',
          worktrees.data ? recordCount(worktrees.data.machines) : undefined,
          hints > 0 &&
            createElement(
              'span',
              { 'aria-label': `${hints} 個提示` },
              createElement(Badge, { tone: 'warning', count: true }, hints),
            ),
        ),
      ),
    ),
    createElement(
      StatusAdminProvider,
      null,
      tab === 'issues'
        ? createElement(IssuesTab, { query: issues, names: names })
        : createElement(WorktreesTab, { query: worktrees }),
    ),
  );
}
