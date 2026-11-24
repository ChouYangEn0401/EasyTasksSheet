import {
  WORKTREE_STATES,
  type Repo,
  type WorktreeFlag,
  type WorktreePlan,
  type WorktreeRow,
  type WorktreeState,
  type WorktreeStatus,
} from '../../../shared/eng.ts';
import type { BadgeTone } from '../../ui/index.ts';

export type EngTab = 'issues' | 'worktrees';

export type EngParams = { tab: EngTab; repoId: number | null; wt: WorktreeState | null };

/** 由 URL 讀出分頁、repo 與 worktree 篩選；repo 不存在時退回第一個 */
export function readEngParams(sp: URLSearchParams, repos: Repo[]): EngParams {
  const tab: EngTab = sp.get('tab') === 'worktrees' ? 'worktrees' : 'issues';
  const raw = Number(sp.get('repo'));
  const repoId = repos.find((r) => r.id === raw)?.id ?? repos[0]?.id ?? null;
  const w = sp.get('wt');
  const wt = (WORKTREE_STATES as readonly string[]).includes(w ?? '') ? (w as WorktreeState) : null;
  return { tab, repoId, wt };
}

/** 寫回 URL（null 移除該參數；預設值不寫入） */
export function writeEngParams(sp: URLSearchParams, patch: Partial<EngParams>): URLSearchParams {
  const next = new URLSearchParams(sp);
  const set = (key: string, value: string | null) =>
    value == null ? next.delete(key) : next.set(key, value);
  if (patch.tab !== undefined) set('tab', patch.tab === 'issues' ? null : patch.tab);
  if (patch.repoId !== undefined) set('repo', patch.repoId == null ? null : String(patch.repoId));
  if (patch.wt !== undefined) set('wt', patch.wt);
  return next;
}

export const STATUS_TONE: Record<WorktreeStatus, BadgeTone> = {
  missing: 'danger',
  unplanned: 'warning',
  merged: 'accent',
  ok: 'success',
};

export const ABNORMAL: readonly WorktreeStatus[] = ['missing', 'unplanned', 'merged'];

export const isFlag = (s: WorktreeState): s is WorktreeFlag => s === 'dirty' || s === 'stale';

export function matchesState(row: WorktreeRow, state: WorktreeState): boolean {
  return isFlag(state) ? row.flags.includes(state) : row.status === state;
}

export function countStates(rows: WorktreeRow[]): Record<WorktreeState, number> {
  const counts = Object.fromEntries(WORKTREE_STATES.map((s) => [s, 0])) as Record<WorktreeState, number>;
  for (const r of rows) for (const s of WORKTREE_STATES) if (matchesState(r, s)) counts[s] += 1;
  return counts;
}

export const filterRows = (rows: WorktreeRow[], state: WorktreeState | null) =>
  state ? rows.filter((r) => matchesState(r, state)) : rows;

export const abnormalCount = (rows: WorktreeRow[]) => rows.filter((r) => ABNORMAL.includes(r.status)).length;

/** 從中間截斷：保留頭尾，中間以 … 取代 */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

export const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : '');

/** 只產生字串供複製；畫面不執行任何 git 寫入 */
export function cleanupCommand(row: WorktreeRow): string {
  const quote = (s: string) => (/[\s"'$`]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s);
  const lines = [`git worktree remove ${quote(row.path)}`];
  if (row.branch) lines.push(`git branch -d ${quote(row.branch)}`);
  return lines.join('\n');
}

/** 安排對話框的表單內容 */
export type PlanDraft = {
  id?: number;
  repoId: number;
  branch: string;
  path: string;
  ownerId: number | null;
  taskId: number | null;
  purpose: string;
};

export const draftFromPlan = (p: WorktreePlan): PlanDraft => ({
  id: p.id,
  repoId: p.repoId,
  branch: p.branch,
  path: p.path,
  ownerId: p.ownerId,
  taskId: p.taskId,
  purpose: p.purpose,
});
