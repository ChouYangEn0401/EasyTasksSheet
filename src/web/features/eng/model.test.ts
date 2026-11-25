import { describe, expect, it } from 'vitest';
import type { EngStatus, MachineGroup, ManualIssue, WorktreeReport } from '../../../shared/engManual.ts';
import {
  ago,
  firstInCategory,
  isClosedIssue,
  rememberPath,
  selectableStatuses,
  statusesOf,
  statusView,
  hintCount,
  knownNames,
  linkedRepo,
  needsGithubSync,
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
  githubRepo: null,
  githubNumber: null,
  githubState: null,
  syncedAt: null,
  createdBy: null,
  updatedBy: null,
  createdAt: 0,
  updatedAt: 0,
});

const report = (path: string, patch: Partial<WorktreeReport> = {}): WorktreeReport => ({
  id: 1,
  machine: 'PC',
  machineId: null,
  missingSince: null,
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

const status = (key: string, category: EngStatus['category'], patch: Partial<EngStatus> = {}): EngStatus => ({
  id: key.length,
  kind: category === 'open' || category === 'closed' ? 'issue' : 'worktree',
  key,
  label: key.toUpperCase(),
  color: 'blue',
  category,
  sortOrder: 0,
  isBuiltin: false,
  isArchived: false,
  updatedAt: 0,
  updatedBy: null,
  ...patch,
});

describe('問題', () => {
  const list = [issue(1, 'open'), issue(2, 'doing'), issue(3, 'closed')];
  it('預設隱藏已結案；未結案計數（狀態清單未載入時以內建值判斷）', () => {
    expect(visibleIssues(list, false).map((i) => i.id)).toEqual([1, 2]);
    expect(visibleIssues(list, true)).toHaveLength(3);
    expect(openIssueCount(list)).toBe(2);
  });
  it('依狀態類別判斷已結案（自訂狀態）', () => {
    const statuses = [status('open', 'open'), status('wontfix', 'closed'), status('c_x', 'closed')];
    const l = [issue(1, 'open'), issue(2, 'wontfix'), issue(3, 'c_x')];
    expect(visibleIssues(l, false, statuses).map((i) => i.id)).toEqual([1]);
    expect(openIssueCount(l, statuses)).toBe(1);
    expect(isClosedIssue(statuses, 'c_x')).toBe(true);
  });
  it('狀態顯示：找不到定義時以 key 顯示；選單只列未封存（目前值例外）', () => {
    const statuses = [status('a', 'open'), status('b', 'open', { isArchived: true })];
    expect(statusView(statuses, 'issue', 'a').label).toBe('A');
    expect(statusView(statuses, 'issue', 'zzz')).toMatchObject({
      label: 'zzz',
      color: 'gray',
      category: null,
    });
    expect(statusView([], 'worktree', 'cleaned')).toMatchObject({ label: '已清理', category: 'done' });
    expect(selectableStatuses(statuses).map((s) => s.key)).toEqual(['a']);
    expect(selectableStatuses(statuses, 'b').map((s) => s.key)).toEqual(['a', 'b']);
    expect(firstInCategory(statuses, 'open', 'b')).toBe('a');
    expect(firstInCategory(statuses, 'closed')).toBeUndefined();
    const sorted = statusesOf(
      [status('z', 'open', { sortOrder: 2 }), status('y', 'open', { sortOrder: 1 })],
      'issue',
    );
    expect(sorted.map((s) => s.key)).toEqual(['y', 'z']);
  });
  it('最近掃描路徑與相對時間', () => {
    expect(rememberPath(['a', 'b'], ' b ')).toEqual(['b', 'a']);
    expect(rememberPath(['1', '2', '3', '4', '5'], '6')).toEqual(['6', '1', '2', '3', '4']);
    expect(ago(0, 30_000)).toBe('剛剛');
    expect(ago(0, 3 * 86_400_000)).toBe('3 天前');
    expect(ago(0, 5 * 3_600_000)).toBe('5 小時前');
  });
  it('已知名稱去重排序、略過空白', () => {
    expect(knownNames(['b', ' a ', ''], [null, 'b', undefined])).toEqual(['a', 'b']);
  });
});

describe('GitHub 連動', () => {
  const MIN = 60_000;
  it('有連結 GitHub 的問題中最舊的同步時間超過設定才自動同步', () => {
    const plain = issue(1, 'open');
    const gh = (syncedAt: number | null): ManualIssue => ({ ...issue(2, 'open'), githubNumber: 3, syncedAt });
    expect(needsGithubSync([plain], 5, 100 * MIN)).toBe(false);
    expect(needsGithubSync([plain, gh(null)], 5, 100 * MIN)).toBe(true);
    expect(needsGithubSync([gh(96 * MIN)], 5, 100 * MIN)).toBe(false);
    expect(needsGithubSync([gh(96 * MIN), gh(90 * MIN)], 5, 100 * MIN)).toBe(true);
  });
  it('專案連動的 repo 不分大小寫', () => {
    const links = [{ project: 'Widgets', githubRepo: 'acme/widgets' }];
    expect(linkedRepo(links, ' widgets ')).toBe('acme/widgets');
    expect(linkedRepo(links, 'other')).toBeUndefined();
    expect(linkedRepo(links, '')).toBeUndefined();
  });
});

describe('worktree 比對', () => {
  it('路徑鍵：Windows 不分大小寫與斜線方向，POSIX 保留大小寫', () => {
    expect(pathKey('C:\\Work\\Repo\\')).toBe('c:/work/repo');
    expect(pathKey('/home/A/wt/')).toBe('/home/A/wt');
  });

  it('紀錄找對應回報、計算提示數', () => {
    const group: MachineGroup = {
      key: 'name:pc',
      machine: 'PC',
      machineId: null,
      reportedAt: 1,
      stale: false,
      repos: [
        {
          sourceId: 1,
          repo: 'r',
          reportedAt: 1,
          appliedAt: 1,
          pending: { reason: 'empty', count: 0, previous: 3, at: 1 },
        },
      ],
      records: [
        {
          id: 1,
          machine: 'PC',
          machineId: null,
          path: 'c:/work/a',
          branch: 'a',
          ownerId: null,
          purpose: '',
          status: 'active',
          note: '',
          source: 'manual',
          repo: '',
          headSha: null,
          deletedAt: null,
          deletedBy: null,
          createdBy: null,
          updatedBy: null,
          createdAt: 0,
          updatedAt: 0,
          hint: 'missing',
          lastSeenAt: null,
          moveTo: null,
        },
      ],
      reports: [
        { ...report('C:\\work\\b'), registered: false, movedFrom: null },
        { ...report('C:/work/c'), registered: true, movedFrom: null },
        // 不再出現在回報中、或為搬動候選的未登記項目不另計
        { ...report('C:/work/d', { missingSince: 5 }), registered: false, movedFrom: null },
        { ...report('C:/work/e'), registered: false, movedFrom: 1 },
      ],
    };
    expect(reportFor(group, 'c:\\WORK\\b\\')?.path).toBe('C:\\work\\b');
    expect(reportFor(group, 'c:/work/a')).toBeUndefined();
    // 紀錄提示 1 + 未登記 1 + 待確認回報 1
    expect(hintCount([group])).toBe(3);
    expect(recordCount([group])).toBe(1);
  });

  it('快照摘要', () => {
    expect(reportSummary(report('/x'))).toBe('無變更');
    expect(reportSummary(report('/x', { isDirty: true, ahead: 2, behind: 0, isMerged: true }))).toBe(
      '未提交變更 · ↑2 ↓0 · 已併入 main',
    );
  });
});
