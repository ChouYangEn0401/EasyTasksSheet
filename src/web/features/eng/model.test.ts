import { describe, expect, it } from 'vitest';
import type { Repo, WorktreeRow } from '../../../shared/eng.ts';
import {
  abnormalCount,
  cleanupCommand,
  countStates,
  filterRows,
  middleTruncate,
  readEngParams,
  writeEngParams,
} from './model.ts';

const repo = (id: number): Repo => ({
  id,
  name: `r${id}`,
  localPath: null,
  remoteSlug: null,
  createdAt: 0,
  updatedAt: 0,
});

const row = (status: WorktreeRow['status'], flags: WorktreeRow['flags'] = []): WorktreeRow => ({
  key: `${status}-${flags.join()}`,
  status,
  flags,
  branch: 'feat/x',
  path: '/srv/wt x',
  plan: null,
  snapshot: null,
});

describe('URL 參數', () => {
  it('預設 issues 分頁與第一個 repo；不合法的篩選忽略', () => {
    const repos = [repo(3), repo(5)];
    expect(readEngParams(new URLSearchParams(''), repos)).toEqual({ tab: 'issues', repoId: 3, wt: null });
    expect(readEngParams(new URLSearchParams('tab=worktrees&repo=5&wt=dirty'), repos)).toEqual({
      tab: 'worktrees',
      repoId: 5,
      wt: 'dirty',
    });
    expect(readEngParams(new URLSearchParams('repo=9&wt=bogus'), repos)).toMatchObject({
      repoId: 3,
      wt: null,
    });
    expect(readEngParams(new URLSearchParams(''), [])).toMatchObject({ repoId: null });
  });

  it('寫回時預設值移除', () => {
    const sp = writeEngParams(new URLSearchParams('tab=worktrees&wt=stale&task=1'), {
      tab: 'issues',
      wt: null,
    });
    expect(sp.toString()).toBe('task=1');
    expect(writeEngParams(new URLSearchParams(), { repoId: 2, tab: 'worktrees' }).toString()).toBe(
      'tab=worktrees&repo=2',
    );
  });
});

describe('worktree 計數與篩選', () => {
  const rows = [
    row('missing'),
    row('unplanned'),
    row('ok', ['dirty', 'stale']),
    row('ok', ['dirty']),
    row('ok'),
  ];
  it('主狀態與旗標分別計數；異常數只算前三種主狀態', () => {
    expect(countStates(rows)).toEqual({ missing: 1, unplanned: 1, merged: 0, ok: 3, dirty: 2, stale: 1 });
    expect(abnormalCount(rows)).toBe(2);
    expect(filterRows(rows, 'dirty')).toHaveLength(2);
    expect(filterRows(rows, null)).toHaveLength(5);
  });
});

describe('顯示工具', () => {
  it('從中間截斷', () => {
    expect(middleTruncate('abcdefghij', 20)).toBe('abcdefghij');
    const t = middleTruncate('C:/Users/me/Desktop/TasksSheets-eng-tracking', 20);
    expect(t).toHaveLength(20);
    expect(t.startsWith('C:/Users/')).toBe(true);
    expect(t.endsWith('tracking')).toBe(true);
    expect(t).toContain('…');
  });

  it('清理指令：路徑含空白時加引號', () => {
    expect(cleanupCommand(row('merged'))).toBe('git worktree remove "/srv/wt x"\ngit branch -d feat/x');
  });
});
