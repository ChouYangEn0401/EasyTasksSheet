import { config } from '../../config.ts';
import type { Db } from '../../db/client.ts';
import { detectWorktrees, type DetectOptions, type DetectResult } from './detect.ts';
import { createGitHubIssueSource, type IssueSource } from './issueSource.ts';

const MINUTE = 60_000;

/** 工程追蹤的可替換依賴與設定（預設取自環境變數；測試以 configureEng() 覆寫） */
export type EngSettings = {
  issueSource: IssueSource;
  issueCacheMs: number;
  staleDays: number;
  gitTimeoutMs: number;
  /** 模式 B 回報用 token；未設定時回報端點一律拒絕 */
  reportToken: string | undefined;
  /** server 直接偵測（模式 A）的結果在此時間內重用，避免輪詢時重複執行 git */
  detectCacheMs: number;
  detect: (repoPath: string, options: DetectOptions) => Promise<DetectResult>;
};

function defaults(): EngSettings {
  return {
    issueSource: createGitHubIssueSource({ token: config.GITHUB_TOKEN, apiUrl: config.GITHUB_API_URL }),
    issueCacheMs: config.ISSUE_CACHE_MINUTES * MINUTE,
    staleDays: config.WORKTREE_STALE_DAYS,
    gitTimeoutMs: config.GIT_TIMEOUT_MS,
    reportToken: config.WORKTREE_REPORT_TOKEN,
    detectCacheMs: 10_000,
    detect: detectWorktrees,
  };
}

let current = defaults();

export const engSettings = (): EngSettings => current;

/** 覆寫設定（測試用）；不給參數即還原預設 */
export function configureEng(patch?: Partial<EngSettings>): void {
  current = patch ? { ...current, ...patch } : defaults();
}

// ── 記憶體內狀態（依 DB 實例區分，測試間互不影響） ──

export type RepoRuntime = {
  /** 上次成功同步 issue 的時間（快取為空時也能知道剛同步過） */
  issuesSyncedAt?: number;
  issuesError?: { message: string; at: number } | null;
  issuesInflight?: Promise<void>;
  detectedAt?: number;
  /** 偵測端的「已併入」判定（pathKey → boolean） */
  merged?: Map<string, boolean>;
  detectInflight?: Promise<void>;
};

const runtime = new WeakMap<Db, Map<number, RepoRuntime>>();

export function repoRuntime(db: Db, repoId: number): RepoRuntime {
  let byRepo = runtime.get(db);
  if (!byRepo) runtime.set(db, (byRepo = new Map()));
  let r = byRepo.get(repoId);
  if (!r) byRepo.set(repoId, (r = {}));
  return r;
}

export function clearRepoRuntime(db: Db, repoId: number): void {
  runtime.get(db)?.delete(repoId);
}
