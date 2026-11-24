import { describe, expect, it } from 'vitest';
import type { MachineGroup, ManualIssue, WorktreeReport } from '../../../shared/engManual.ts';
import {
  hintCount,
  knownNames,
  openIssueCount,
  pathKey,
  readEngTab,
  recordCount,
  reportFor,
  reportSummary,
  visibleIssues,
  writeEngTab,
} from './model.ts';

const issue = (id: number, status: ManualIssue['status']): ManualIssue => ({
  id,
  title: `i${id}`,
  description: '',
  project: '',
  status,
  assigneeId: null,
  url: null,
  createdBy: null,
  updatedBy: null,
  createdAt: 0,
  updatedAt: 0,
});

const report = (path: string, patch: Partial<WorktreeReport> = {}): WorktreeReport => ({
  id: 1,
  machine: 'PC',
  repo: '',
  path,
  branch: 'feat/x',
  headSha: null,
  isDirty: false,
  ahead: null,
  behind: null,
  lastCommitAt: null,
  isPrunable: false,
  isMerged: false,
  reportedAt: 0,
  ...patch,
});

describe('分頁 URL', () => {
  it('預設為問題；寫回時預設值移除並保留其他參數', () => {
    expect(readEngTab(new URLSearchParams(''))).toBe('issues');
    expect(readEngTab(new URLSearchParams('tab=worktrees'))).toBe('worktrees');
    expect(readEngTab(new URLSearchParams('tab=bogus'))).toBe('issues');
    expect(writeEngTab(new URLSearchParams('tab=worktrees&task=1'), 'issues').toString()).toBe('task=1');
    expect(writeEngTab(new URLSearchParams(), 'worktrees').toString()).toBe('tab=worktrees');
  });
});

describe('問題', () => {
  const list = [issue(1, 'open'), issue(2, 'doing'), issue(3, 'closed')];
  it('預設隱藏已結案；未結案計數', () => {
    expect(visibleIssues(list, false).map((i) => i.id)).toEqual([1, 2]);
    expect(visibleIssues(list, true)).toHaveLength(3);
    expect(openIssueCount(list)).toBe(2);
  });
  it('已知名稱去重排序、略過空白', () => {
    expect(knownNames(['b', ' a ', ''], [null, 'b', undefined])).toEqual(['a', 'b']);
  });
});

describe('worktree 比對', () => {
  it('路徑鍵：Windows 不分大小寫與斜線方向，POSIX 保留大小寫', () => {
    expect(pathKey('C:\\Work\\Repo\\')).toBe('c:/work/repo');
    expect(pathKey('/home/A/wt/')).toBe('/home/A/wt');
  });

  it('紀錄找對應回報、計算提示數', () => {
    const group: MachineGroup = {
      machine: 'PC',
      reportedAt: 1,
      records: [
        {
          id: 1,
          machine: 'PC',
          path: 'c:/work/a',
          branch: 'a',
          ownerId: null,
          purpose: '',
          status: 'active',
          note: '',
          createdBy: null,
          updatedBy: null,
          createdAt: 0,
          updatedAt: 0,
          hint: 'missing',
        },
      ],
      reports: [
        { ...report('C:\\work\\b'), registered: false },
        { ...report('C:/work/c'), registered: true },
      ],
    };
    expect(reportFor(group, 'c:\\WORK\\b\\')?.path).toBe('C:\\work\\b');
    expect(reportFor(group, 'c:/work/a')).toBeUndefined();
    expect(hintCount([group])).toBe(2);
    expect(recordCount([group])).toBe(1);
  });

  it('快照摘要', () => {
    expect(reportSummary(report('/x'))).toBe('無變更');
    expect(reportSummary(report('/x', { isDirty: true, ahead: 2, behind: 0, isMerged: true }))).toBe(
      '未提交變更 · ↑2 ↓0 · 已併入 main',
    );
  });
});
