import type {
  WorktreeFlag,
  WorktreePlan,
  WorktreeRow,
  WorktreeSnapshot,
  WorktreeStatus,
} from '../../../shared/eng.ts';
import { pathKey, resolvePlanPath } from './detect.ts';

const DAY = 86_400_000;
/** 視為基準分支本身的名稱（不判定為已合併） */
const BASE_BRANCHES = new Set(['main', 'master']);

export type ClassifyOptions = {
  now: number;
  staleDays: number;
  /** repo 的本機路徑，用來解析安排中的相對路徑 */
  repoPath: string | null;
};

/**
 * 已併入基準分支：優先採用偵測端的判定（ahead = 0 且分支曾有自己的變動，排除剛建立的分支）；
 * 未知時退回 ahead = 0（等同 `git branch --merged main`）。
 */
export function isMerged(s: WorktreeSnapshot): boolean {
  if (s.branch == null || BASE_BRANCHES.has(s.branch) || s.headSha == null) return false;
  return s.isMerged ?? s.ahead === 0;
}

export function statusOf(plan: WorktreePlan | null, snap: WorktreeSnapshot | null): WorktreeStatus {
  if (!snap || snap.isPrunable) return 'missing';
  if (!plan) return 'unplanned';
  if (isMerged(snap)) return 'merged';
  return 'ok';
}

export function flagsOf(snap: WorktreeSnapshot | null, status: WorktreeStatus, opts: ClassifyOptions) {
  const flags: WorktreeFlag[] = [];
  if (!snap || status === 'missing') return flags;
  if (snap.isDirty) flags.push('dirty');
  if (snap.lastCommitAt != null && opts.now - snap.lastCommitAt > opts.staleDays * DAY) flags.push('stale');
  return flags;
}

const ORDER: Record<WorktreeStatus, number> = { missing: 0, unplanned: 1, merged: 2, ok: 4 };
const rank = (r: WorktreeRow) => (r.status === 'ok' && r.flags.length ? 3 : ORDER[r.status]);

/** 排序：遺失 → 未登記 → 已合併未清理 → 帶旗標的正常 → 正常；同組依分支名稱 */
export function sortRows(rows: WorktreeRow[]): WorktreeRow[] {
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) || (a.branch ?? '').localeCompare(b.branch ?? '') || a.path.localeCompare(b.path),
  );
}

/**
 * 以「安排」對照「實際狀態」：先依路徑配對，未配對者再依分支名稱配對。
 */
export function classifyWorktrees(
  plans: WorktreePlan[],
  snapshots: WorktreeSnapshot[],
  opts: ClassifyOptions,
): WorktreeRow[] {
  const snapByKey = new Map(snapshots.map((s) => [pathKey(s.path), s]));
  const used = new Set<WorktreeSnapshot>();
  const pairs: { plan: WorktreePlan | null; snap: WorktreeSnapshot | null }[] = [];
  const unmatched: WorktreePlan[] = [];

  for (const plan of plans) {
    const snap = snapByKey.get(pathKey(resolvePlanPath(opts.repoPath, plan.path)));
    if (snap && !used.has(snap)) {
      used.add(snap);
      pairs.push({ plan, snap });
    } else unmatched.push(plan);
  }
  for (const plan of unmatched) {
    const snap = snapshots.find((s) => !used.has(s) && s.branch === plan.branch);
    if (snap) used.add(snap);
    pairs.push({ plan, snap: snap ?? null });
  }
  for (const snap of snapshots) if (!used.has(snap)) pairs.push({ plan: null, snap });

  const rows = pairs.map(({ plan, snap }): WorktreeRow => {
    const status = statusOf(plan, snap);
    return {
      key: plan ? `plan-${plan.id}` : `snap-${pathKey(snap!.path)}`,
      status,
      flags: flagsOf(snap, status, opts),
      branch: snap?.branch ?? plan?.branch ?? null,
      path: snap?.path ?? resolvePlanPath(opts.repoPath, plan!.path),
      plan,
      snapshot: snap,
    };
  });
  return sortRows(rows);
}
