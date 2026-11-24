import { existsSync } from 'node:fs';
import { desc, eq } from 'drizzle-orm';
import type {
  GitIssue,
  IssuesResponse,
  Repo,
  WorktreePlan,
  WorktreeSnapshot,
  WorktreesResponse,
} from '../../../shared/eng.ts';
import type { Db, DbOrTx } from '../../db/client.ts';
import { gitIssuesCache, worktreePlans, worktreeSnapshots } from '../../db/schema.ts';
import { HttpError } from '../../lib/errors.ts';
import { classifyWorktrees } from './classify.ts';
import { normalizePath, pathKey, type DetectedWorktree } from './detect.ts';
import { engSettings, repoRuntime } from './settings.ts';

// ── Issues ───────────────────────────────────────────────────

function readIssueCache(db: DbOrTx, repoId: number) {
  return db
    .select()
    .from(gitIssuesCache)
    .where(eq(gitIssuesCache.repoId, repoId))
    .orderBy(desc(gitIssuesCache.issueUpdatedAt), desc(gitIssuesCache.number))
    .all();
}

/** 向來源同步一次（同一 repo 同時只會有一個同步在進行） */
function syncIssues(db: Db, repo: Repo, now: () => number): Promise<void> {
  const rt = repoRuntime(db, repo.id);
  if (rt.issuesInflight) return rt.issuesInflight;
  const run = (async () => {
    try {
      const items = await engSettings().issueSource.listOpenIssues(repo.remoteSlug!);
      const t = now();
      db.transaction((tx) => {
        tx.delete(gitIssuesCache).where(eq(gitIssuesCache.repoId, repo.id)).run();
        for (const i of items) {
          tx.insert(gitIssuesCache)
            .values({ repoId: repo.id, ...i, fetchedAt: t })
            .onConflictDoNothing()
            .run();
        }
      });
      rt.issuesSyncedAt = t;
      rt.issuesError = null;
    } catch (err) {
      rt.issuesError = { message: (err as Error).message || '同步失敗', at: now() };
    } finally {
      rt.issuesInflight = undefined;
    }
  })();
  rt.issuesInflight = run;
  return run;
}

/**
 * 取得 issue（快取優先）：快取超過 ISSUE_CACHE_MINUTES 或從未同步時才向來源同步；
 * 同步失敗後在同樣時間內不自動重試（手動重新整理 force=true 一律同步）。
 */
export async function getIssues(
  db: Db,
  repo: Repo,
  now: () => number,
  force = false,
): Promise<IssuesResponse> {
  const { issueSource, issueCacheMs } = engSettings();
  const rt = repoRuntime(db, repo.id);
  const configured = issueSource.isConfigured();
  const base = { repoId: repo.id, configured, remoteSlug: repo.remoteSlug };
  if (!configured || !repo.remoteSlug) {
    return { ...base, fetchedAt: null, error: null, issues: [] };
  }
  const fetchedAt = () => {
    const rows = readIssueCache(db, repo.id);
    const cached = rows.reduce<number | null>(
      (m, r) => (m == null || r.fetchedAt > m ? r.fetchedAt : m),
      null,
    );
    const synced = rt.issuesSyncedAt ?? null;
    return { rows, at: synced != null && (cached == null || synced > cached) ? synced : cached };
  };
  let state = fetchedAt();
  const t = now();
  const expired = state.at == null || t - state.at >= issueCacheMs;
  const recentlyFailed = rt.issuesError != null && t - rt.issuesError.at < issueCacheMs;
  if (force || (expired && !recentlyFailed)) {
    await syncIssues(db, repo, now);
    state = fetchedAt();
  }
  const issues: GitIssue[] = state.rows.map((r) => ({
    number: r.number,
    title: r.title,
    labels: r.labels,
    assignee: r.assignee,
    url: r.url,
    issueUpdatedAt: r.issueUpdatedAt,
  }));
  return { ...base, fetchedAt: state.at, error: rt.issuesError ?? null, issues };
}

// ── Worktrees ────────────────────────────────────────────────

const toSnapshot = (r: typeof worktreeSnapshots.$inferSelect): WorktreeSnapshot => ({
  repoId: r.repoId,
  path: r.path,
  branch: r.branch,
  headSha: r.headSha,
  isDirty: r.isDirty,
  ahead: r.ahead,
  behind: r.behind,
  lastCommitAt: r.lastCommitAt,
  isPrunable: r.isPrunable,
  isMerged: r.isMerged,
  reportedBy: r.reportedBy,
  reportedAt: r.reportedAt,
});

/**
 * 以一次偵測 / 回報的結果整批取代該 repo 的實際狀態（同路徑只留一筆）。
 * 「已併入」判定一併寫入 is_merged，server 重啟後仍能區分「剛建立未提交」與「已合併未清理」；
 * 偵測端無法判定（省略 isMerged）時存 false。
 */
export function replaceSnapshots(
  tx: DbOrTx,
  repoId: number,
  worktrees: DetectedWorktree[],
  reportedBy: string,
  at: number,
): number {
  tx.delete(worktreeSnapshots).where(eq(worktreeSnapshots.repoId, repoId)).run();
  const seen = new Set<string>();
  for (const w of worktrees) {
    const key = pathKey(w.path);
    if (seen.has(key)) continue;
    seen.add(key);
    tx.insert(worktreeSnapshots)
      .values({
        ...w,
        isMerged: w.isMerged ?? false,
        repoId,
        path: normalizePath(w.path),
        reportedBy,
        reportedAt: at,
      })
      .run();
  }
  return seen.size;
}

/** server 是否能直接偵測此 repo（模式 A：已登記的本機路徑存在於 server 上） */
export const canDetectLocally = (repo: Repo) => !!repo.localPath && existsSync(repo.localPath);

function detectLocal(db: Db, repo: Repo, now: () => number): Promise<void> {
  const rt = repoRuntime(db, repo.id);
  if (rt.detectInflight) return rt.detectInflight;
  const { detect, gitTimeoutMs } = engSettings();
  const run = (async () => {
    try {
      const result = await detect(repo.localPath!, { timeoutMs: gitTimeoutMs });
      const t = now();
      db.transaction((tx) => replaceSnapshots(tx, repo.id, result.worktrees, 'server', t));
      rt.detectedAt = t;
    } catch (err) {
      throw new HttpError(502, 'INTERNAL_ERROR', `worktree 偵測失敗：${(err as Error).message}`);
    } finally {
      rt.detectInflight = undefined;
    }
  })();
  rt.detectInflight = run;
  return run;
}

export function listPlans(db: DbOrTx, repoId: number): WorktreePlan[] {
  return db.select().from(worktreePlans).where(eq(worktreePlans.repoId, repoId)).all();
}

/** 安排 × 實際狀態；模式 A 時視需要重新偵測（refresh 強制） */
export async function getWorktrees(
  db: Db,
  repo: Repo,
  now: () => number,
  refresh = false,
): Promise<WorktreesResponse> {
  const { staleDays, detectCacheMs } = engSettings();
  const local = canDetectLocally(repo);
  if (local) {
    const rt = repoRuntime(db, repo.id);
    if (refresh || rt.detectedAt == null || now() - rt.detectedAt >= detectCacheMs) {
      await detectLocal(db, repo, now);
    }
  }
  const snapshots = db
    .select()
    .from(worktreeSnapshots)
    .where(eq(worktreeSnapshots.repoId, repo.id))
    .all()
    .map(toSnapshot);
  const plans = listPlans(db, repo.id);
  const detectedAt = snapshots.reduce<number | null>(
    (m, s) => (m == null || s.reportedAt > m ? s.reportedAt : m),
    local ? (repoRuntime(db, repo.id).detectedAt ?? null) : null,
  );
  return {
    repoId: repo.id,
    mode: local ? 'local' : snapshots.length ? 'report' : 'none',
    detectedAt,
    staleDays,
    rows: classifyWorktrees(plans, snapshots, { now: now(), staleDays, repoPath: repo.localPath }),
  };
}
