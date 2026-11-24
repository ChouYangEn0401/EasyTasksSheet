import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorktreePlan, WorktreeSnapshot } from '../../../shared/eng.ts';
import { classifyWorktrees } from './classify.ts';
import {
  detectWorktrees,
  GitError,
  normalizePath,
  parseWorktreePorcelain,
  pathKey,
  resolvePlanPath,
  type GitRunner,
} from './detect.ts';
import { createGitFixture } from './gitFixture.ts';

const DAY = 86_400_000;

describe('parseWorktreePorcelain', () => {
  it('解析主工作目錄、分支、detached、prunable 與 bare', () => {
    const text = [
      'worktree C:/src/repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree C:/src/repo-feat',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feat/a',
      '',
      'worktree /tmp/detached',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
      'worktree /tmp/gone',
      'HEAD 4444444444444444444444444444444444444444',
      'branch refs/heads/feat/gone',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    const entries = parseWorktreePorcelain(text);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ path: 'C:/src/repo', branch: 'main', prunable: false });
    expect(entries[1]).toMatchObject({ path: 'C:/src/repo-feat', branch: 'feat/a' });
    expect(entries[2]).toMatchObject({ branch: null, detached: true });
    expect(entries[3]).toMatchObject({ branch: 'feat/gone', prunable: true });
  });
});

describe('路徑工具', () => {
  it('正規化斜線與 ..，相對路徑以 repo 路徑解析，Windows 路徑比對不分大小寫', () => {
    expect(normalizePath('C:\\src\\repo\\')).toBe('C:/src/repo');
    expect(resolvePlanPath('C:\\src\\repo', '../repo-feat')).toBe('C:/src/repo-feat');
    expect(resolvePlanPath('/srv/repo', '../wt')).toBe('/srv/wt');
    expect(resolvePlanPath('/srv/repo', '/abs/wt')).toBe('/abs/wt');
    expect(pathKey('C:/Src/Repo-Feat')).toBe(pathKey('c:\\src\\repo-feat'));
    expect(pathKey('/srv/A')).not.toBe(pathKey('/srv/a'));
  });
});

describe('detectWorktrees（暫存 git repo）', () => {
  const fx = createGitFixture();
  const now = Date.now();
  let paths: ReturnType<typeof fx.scenario>;
  beforeAll(() => {
    paths = fx.scenario(now);
  });
  afterAll(() => fx.cleanup());

  it('列出主目錄以外的 worktree 與 dirty / ahead / behind / 最後提交 / prunable', async () => {
    const { baseBranch, worktrees } = await detectWorktrees(fx.repo, { timeoutMs: 15_000 });
    expect(baseBranch).toBe('main');
    const byBranch = new Map(worktrees.map((w) => [w.branch, w]));
    expect([...byBranch.keys()].sort()).toEqual(
      ['feat/dirty', 'feat/fresh', 'feat/gone', 'feat/merged', 'feat/ok', 'feat/stale', 'tmp/spike'].sort(),
    );
    // 不含主工作目錄
    expect(worktrees.some((w) => pathKey(w.path) === pathKey(fx.repo))).toBe(false);

    const ok = byBranch.get('feat/ok')!;
    expect(pathKey(ok.path)).toBe(pathKey(paths.ok));
    expect(ok).toMatchObject({ isDirty: false, isPrunable: false, ahead: 1, behind: 2 });
    expect(ok.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(ok.lastCommitAt).toBeGreaterThan(now - 60 * 60_000);

    expect(byBranch.get('feat/dirty')).toMatchObject({ isDirty: true, ahead: 1 });
    expect(byBranch.get('feat/merged')).toMatchObject({
      ahead: 0,
      behind: 1,
      isDirty: false,
      isMerged: true,
    });
    // 剛建立的分支 ahead 也是 0，但不算已合併
    expect(byBranch.get('feat/fresh')).toMatchObject({ ahead: 0, behind: 2, isMerged: false });
    expect(byBranch.get('feat/ok')!.isMerged).toBe(false);
    expect(byBranch.get('feat/stale')!.lastCommitAt).toBeLessThan(now - 9 * DAY);
    expect(byBranch.get('feat/gone')).toMatchObject({ isPrunable: true, isDirty: false });
  });

  it('結合安排後判定六種標示', async () => {
    const { worktrees } = await detectWorktrees(fx.repo, { timeoutMs: 15_000 });
    const snaps: WorktreeSnapshot[] = worktrees.map((w) => ({
      ...w,
      isMerged: w.isMerged ?? false,
      repoId: 1,
      reportedBy: 'server',
      reportedAt: now,
    }));
    let id = 0;
    const plan = (branch: string, path: string): WorktreePlan => ({
      id: ++id,
      repoId: 1,
      branch,
      path,
      ownerId: null,
      taskId: null,
      purpose: '',
      createdAt: now,
      updatedAt: now,
    });
    const plans = [
      plan('feat/ok', '../wt-ok'),
      plan('feat/fresh', '../wt-fresh'),
      plan('feat/dirty', '../wt-dirty'),
      plan('feat/merged', paths.merged),
      plan('feat/stale', '../wt-stale'),
      plan('feat/gone', '../wt-gone'),
      plan('feat/never', '../wt-never'),
    ];
    const rows = classifyWorktrees(plans, snaps, { now, staleDays: 7, repoPath: fx.repo });
    const summary = rows.map((r) => [r.branch, r.status, r.flags.join(',')]);
    expect(summary).toEqual([
      ['feat/gone', 'missing', ''],
      ['feat/never', 'missing', ''],
      ['tmp/spike', 'unplanned', ''],
      ['feat/merged', 'merged', ''],
      ['feat/dirty', 'ok', 'dirty'],
      ['feat/stale', 'ok', 'stale'],
      ['feat/fresh', 'ok', ''],
      ['feat/ok', 'ok', ''],
    ]);
  });

  it('不存在的路徑丟 GitError；git 逾時或失敗訊息向上傳遞', async () => {
    await expect(detectWorktrees(`${fx.root}/nope`)).rejects.toBeInstanceOf(GitError);
    const failing: GitRunner = async () => {
      throw new GitError('git 執行逾時（5ms）');
    };
    await expect(detectWorktrees(fx.repo, { git: failing, timeoutMs: 5 })).rejects.toThrow('逾時');
  });

  it('git 一律以參數陣列呼叫，並帶入逾時', async () => {
    const calls: { args: string[]; timeout: number }[] = [];
    const fake: GitRunner = async (args, timeout) => {
      calls.push({ args, timeout });
      if (args.includes('worktree'))
        return `worktree ${fx.repo}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/main\n\n`;
      return '';
    };
    await detectWorktrees(fx.repo, { git: fake, timeoutMs: 1234 });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(Array.isArray(c.args)).toBe(true);
      expect(c.args[0]).toBe('-C');
      expect(c.timeout).toBe(1234);
    }
  });
});

describe('classifyWorktrees', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  const snap = (over: Partial<WorktreeSnapshot>): WorktreeSnapshot => ({
    repoId: 1,
    path: '/srv/wt',
    branch: 'feat/x',
    headSha: 'abcdef1',
    isDirty: false,
    ahead: 2,
    behind: 0,
    lastCommitAt: now,
    isPrunable: false,
    isMerged: false,
    reportedBy: 'dev',
    reportedAt: now,
    ...over,
  });
  const plan = (over: Partial<WorktreePlan>): WorktreePlan => ({
    id: 1,
    repoId: 1,
    path: '../wt',
    branch: 'feat/x',
    ownerId: null,
    taskId: null,
    purpose: '',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  const opts = { now, staleDays: 7, repoPath: '/srv/repo' };

  it('路徑不同但分支相同時以分支配對', () => {
    const rows = classifyWorktrees([plan({ path: '../elsewhere' })], [snap({})], opts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ok', key: 'plan-1' });
  });

  it('遺失列不顯示旗標；剛好 7 天不算久未更新', () => {
    const rows = classifyWorktrees(
      [plan({})],
      [snap({ isPrunable: true, isDirty: true, lastCommitAt: now - 30 * DAY })],
      opts,
    );
    expect(rows[0]).toMatchObject({ status: 'missing', flags: [] });
    const fresh = classifyWorktrees([plan({})], [snap({ lastCommitAt: now - 7 * DAY })], opts);
    expect(fresh[0]!.flags).toEqual([]);
  });

  it('main 分支本身不判定為已合併', () => {
    const rows = classifyWorktrees([plan({ branch: 'main' })], [snap({ branch: 'main', ahead: 0 })], opts);
    expect(rows[0]!.status).toBe('ok');
  });

  it('已合併：採用偵測端判定（剛建立未提交的分支 ahead = 0 也不算）', () => {
    const status = (over: Partial<WorktreeSnapshot>) =>
      classifyWorktrees([plan({})], [snap(over)], opts)[0]!.status;
    expect(status({ ahead: 0, isMerged: false })).toBe('ok');
    expect(status({ ahead: 0, isMerged: true })).toBe('merged');
    expect(status({ branch: null, isMerged: true })).toBe('ok');
    expect(status({ headSha: null, isMerged: true })).toBe('ok');
  });
});
