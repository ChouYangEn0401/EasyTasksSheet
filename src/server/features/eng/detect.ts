/**
 * Worktree 偵測（共用模組）：server 直接偵測（模式 A）與 scripts/report-worktrees.mjs（模式 B）共用。
 * 只依賴 Node 內建模組，以便腳本直接 import。
 *
 * 安全：git 一律以 execFile 傳參數陣列執行（不經 shell）、設定逾時；
 * 只對呼叫端給定的 repo 路徑與 git 自己列出的 worktree 路徑執行唯讀指令。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';

export type DetectedWorktree = {
  /** 絕對路徑，統一為正斜線 */
  path: string;
  branch: string | null;
  headSha: string | null;
  isDirty: boolean;
  /** 相對於基準分支（main / master）：分支上獨有的提交數 */
  ahead: number | null;
  /** 基準分支上、此分支沒有的提交數 */
  behind: number | null;
  /** 最後提交時間（unix ms） */
  lastCommitAt: number | null;
  /** worktree 目錄已不存在（git 標示 prunable 或磁碟上找不到） */
  isPrunable: boolean;
  /** 分支已併入基準分支（有自己的變動且 ahead = 0）；無法判定時省略 */
  isMerged?: boolean;
};

export type DetectResult = {
  /** 偵測時使用的基準分支；找不到 main / master 時為 null（ahead / behind 為 null） */
  baseBranch: string | null;
  worktrees: DetectedWorktree[];
};

export type DetectOptions = {
  timeoutMs?: number;
  /** 指定基準分支；未給時依序嘗試 main、master */
  baseBranch?: string;
  /** 可注入的 git 執行器（測試用） */
  git?: GitRunner;
};

export type GitRunner = (args: string[], timeoutMs: number) => Promise<string>;

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/** 預設執行器：execFile('git', args)，不經 shell、隱藏視窗、限制輸出大小 */
export const runGit: GitRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === 'ENOENT') return reject(new GitError('找不到 git 執行檔'));
          if (e.killed) return reject(new GitError(`git 執行逾時（${timeoutMs}ms）`));
          const msg = String(stderr || err.message)
            .trim()
            .split('\n')[0];
          return reject(new GitError(msg || 'git 執行失敗'));
        }
        resolve(stdout);
      },
    );
  });

// ── 路徑工具（與平台無關的字面處理，模式 B 的路徑可能來自另一種作業系統） ──

const isWinPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');

/** 統一為正斜線、移除結尾斜線並正規化 . 與 .. */
export function normalizePath(p: string): string {
  const s = p.trim().replace(/\\/g, '/');
  let n = posix.normalize(s);
  if (n.length > 1 && n.endsWith('/') && !/^[a-zA-Z]:\/$/.test(n)) n = n.slice(0, -1);
  return n;
}

export const isAbsolutePath = (p: string) => isWinPath(p) || p.trim().startsWith('/');

/** 安排的路徑可為相對（相對於 repo 路徑）或絕對路徑；回傳正規化後的絕對路徑（無 repo 路徑時原樣正規化） */
export function resolvePlanPath(repoPath: string | null, p: string): string {
  if (isAbsolutePath(p) || !repoPath) return normalizePath(p);
  return normalizePath(`${normalizePath(repoPath)}/${p.trim()}`);
}

/** 比對用鍵：Windows 路徑不分大小寫 */
export function pathKey(p: string): string {
  const n = normalizePath(p);
  return isWinPath(n) ? n.toLowerCase() : n;
}

// ── porcelain 解析 ──

export type PorcelainEntry = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
};

/** 解析 `git worktree list --porcelain`（區塊以空行分隔） */
export function parseWorktreePorcelain(text: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  let cur: PorcelainEntry | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) {
      if (cur) entries.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) entries.push(cur);
      cur = {
        path: normalizePath(value),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        prunable: false,
      };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value || null;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '') || null;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) entries.push(cur);
  return entries;
}

const SHA_RE = /^[0-9a-f]{7,64}$/;

async function resolveBaseBranch(git: GitRunner, repo: string, timeoutMs: number, preferred?: string) {
  const candidates = preferred ? [preferred] : ['main', 'master'];
  for (const name of candidates) {
    // 分支名稱只允許安全字元，避免被當成選項
    if (!/^[\w][\w./-]*$/.test(name)) continue;
    try {
      await git(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`], timeoutMs);
      return name;
    } catch {
      // 不存在，試下一個
    }
  }
  return null;
}

/**
 * 偵測 repo 的所有 worktree（不含主工作目錄本身與 bare 項目）。
 * repoPath 必須是已登記的 repo 路徑（由呼叫端保證）。
 */
export async function detectWorktrees(repoPath: string, options: DetectOptions = {}): Promise<DetectResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const git = options.git ?? runGit;
  if (!existsSync(repoPath)) throw new GitError(`找不到 repo 路徑：${repoPath}`);

  const listing = await git(['-C', repoPath, 'worktree', 'list', '--porcelain'], timeoutMs);
  const entries = parseWorktreePorcelain(listing);
  const baseBranch = await resolveBaseBranch(git, repoPath, timeoutMs, options.baseBranch);
  // 第一個項目為主工作目錄（或 bare repo），不列入追蹤
  const targets = entries.slice(1).filter((e) => !e.bare);

  const worktrees = await Promise.all(
    targets.map(async (e): Promise<DetectedWorktree> => {
      const head = e.head && SHA_RE.test(e.head) ? e.head : null;
      const isPrunable = e.prunable || !existsSync(e.path);
      const base: DetectedWorktree = {
        path: e.path,
        branch: e.branch,
        headSha: head,
        isDirty: false,
        ahead: null,
        behind: null,
        lastCommitAt: null,
        isPrunable,
      };
      if (!head) return base;
      const [dirty, lastCommitAt, counts] = await Promise.all([
        isPrunable
          ? Promise.resolve(false)
          : git(['-C', e.path, 'status', '--porcelain', '--untracked-files=normal'], timeoutMs).then(
              (out) => out.trim().length > 0,
            ),
        git(['-C', repoPath, 'log', '-1', '--format=%ct', head], timeoutMs).then((out) => {
          const s = Number(out.trim());
          return Number.isFinite(s) && s > 0 ? s * 1000 : null;
        }),
        baseBranch
          ? git(
              ['-C', repoPath, 'rev-list', '--left-right', '--count', `refs/heads/${baseBranch}...${head}`],
              timeoutMs,
            ).then((out) => {
              const [behind, ahead] = out.trim().split(/\s+/).map(Number);
              return Number.isFinite(ahead) && Number.isFinite(behind)
                ? { ahead: ahead!, behind: behind! }
                : null;
            })
          : Promise.resolve(null),
      ]);
      const result: DetectedWorktree = {
        ...base,
        isDirty: dirty,
        lastCommitAt,
        ahead: counts?.ahead ?? null,
        behind: counts?.behind ?? null,
      };
      if (e.branch && baseBranch && e.branch !== baseBranch && counts) {
        result.isMerged = counts.ahead === 0 && (await hasOwnHistory(git, repoPath, e.branch, timeoutMs));
      }
      return result;
    }),
  );
  return { baseBranch, worktrees };
}

/**
 * 分支是否曾有自己的變動（reflog 中有「建立分支」以外的紀錄）。
 * 用來區分「已併入 main」與「剛建立、尚未提交」：兩者 ahead 皆為 0。
 * 沒有 reflog 可查時視為有（退回 `git branch --merged` 的判定）。
 */
async function hasOwnHistory(git: GitRunner, repo: string, branch: string, timeoutMs: number) {
  try {
    const out = await git(
      ['-C', repo, 'reflog', 'show', '--format=%gs', `refs/heads/${branch}`, '--'],
      timeoutMs,
    );
    const lines = out.split(/\r?\n/).filter(Boolean);
    return lines.length === 0 || lines.some((l) => !l.startsWith('branch: Created from'));
  } catch {
    return true;
  }
}
