import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DAY = 86_400_000;

/** 在暫存目錄建立 git repo（main）與數個 worktree，供偵測邏輯測試使用 */
export function createGitFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'eng-git-')));
  const repo = join(root, 'repo');
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (cwd: string, args: string[], extraEnv: Record<string, string> = {}) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
      cwd,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      windowsHide: true,
    });
  const commit = (cwd: string, file: string, at?: number) => {
    writeFileSync(join(cwd, file), `${file} ${Math.random()}\n`);
    git(cwd, ['add', file]);
    const stamp = at ? `@${Math.floor(at / 1000)} +0000` : null;
    const date: Record<string, string> = stamp ? { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } : {};
    git(cwd, ['commit', '-q', '-m', `add ${file}`], date);
  };

  git(root, ['init', '-q', '-b', 'main', repo]);
  commit(repo, 'README.md');

  /** 新增 worktree（相對於 root 的資料夾名） */
  const addWorktree = (dir: string, branch: string) => {
    const path = join(root, dir);
    git(repo, ['worktree', 'add', '-q', '-b', branch, path]);
    return path;
  };

  return {
    root,
    repo,
    git,
    commit,
    addWorktree,
    /** 建立測試情境：ok / dirty / merged / stale / missing / unplanned */
    scenario(now = Date.now()) {
      const ok = addWorktree('wt-ok', 'feat/ok');
      commit(ok, 'ok.txt');
      const dirty = addWorktree('wt-dirty', 'feat/dirty');
      commit(dirty, 'dirty.txt');
      writeFileSync(join(dirty, 'untracked.txt'), 'x');
      // 剛建立、尚未提交（ahead 0，但不是已合併）
      const fresh = addWorktree('wt-fresh', 'feat/fresh');
      const merged = addWorktree('wt-merged', 'feat/merged');
      commit(merged, 'merged.txt');
      git(repo, ['merge', '-q', '--ff-only', 'feat/merged']);
      commit(repo, 'after-merge.txt');
      const stale = addWorktree('wt-stale', 'feat/stale');
      commit(stale, 'stale.txt', now - 10 * DAY);
      const gone = addWorktree('wt-gone', 'feat/gone');
      commit(gone, 'gone.txt');
      rmSync(gone, { recursive: true, force: true });
      const extra = addWorktree('wt-extra', 'tmp/spike');
      commit(extra, 'spike.txt');
      return { ok, dirty, fresh, merged, stale, gone, extra };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
