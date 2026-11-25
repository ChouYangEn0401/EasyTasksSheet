import type {
  GithubLink,
  IssueStatus,
  MachineGroup,
  ManualIssue,
  WorktreeRecordStatus,
  WorktreeReport,
} from '../../../shared/engManual.ts';
import type { BadgeTone } from '../../ui/index.ts';

export type EngTab = 'issues' | 'worktrees';

/** 分頁由 URL 驅動（?tab=worktrees；預設為問題） */
export const readEngTab = (sp: URLSearchParams): EngTab =>
  sp.get('tab') === 'worktrees' ? 'worktrees' : 'issues';

export function writeEngTab(sp: URLSearchParams, tab: EngTab): URLSearchParams {
  const next = new URLSearchParams(sp);
  if (tab === 'issues') next.delete('tab');
  else next.set('tab', tab);
  return next;
}

export const ISSUE_TONE: Record<IssueStatus, BadgeTone> = {
  open: 'warning',
  doing: 'accent',
  closed: 'success',
};

export const RECORD_TONE: Record<WorktreeRecordStatus, BadgeTone> = {
  active: 'success',
  idle: 'neutral',
  merged: 'accent',
  lost: 'danger',
  cleaned: 'neutral',
};

/** 問題清單：預設隱藏已結案 */
export const visibleIssues = (issues: ManualIssue[], showClosed: boolean) =>
  showClosed ? issues : issues.filter((i) => i.status !== 'closed');

export const openIssueCount = (issues: ManualIssue[]) => issues.filter((i) => i.status !== 'closed').length;

// ── GitHub 連動 ──

/** 是否需要自動同步：有連結 GitHub 的問題，且其中最舊的同步時間（未同步視為最舊）已超過 syncMinutes */
export function needsGithubSync(
  issues: ManualIssue[],
  syncMinutes: number,
  now: number = Date.now(),
): boolean {
  const linked = issues.filter((i) => i.githubNumber != null);
  if (linked.length === 0) return false;
  const oldest = Math.min(...linked.map((i) => i.syncedAt ?? 0));
  return now - oldest > syncMinutes * 60_000;
}

/** 問題所屬專案連動的 GitHub repo（名稱不分大小寫、去除前後空白） */
export function linkedRepo(links: GithubLink[], project: string): string | undefined {
  const k = project.trim().toLowerCase();
  if (!k) return undefined;
  return links.find((l) => l.project.trim().toLowerCase() === k)?.githubRepo;
}

/** 已知的專案 / repo 名稱（供輸入框下拉建議），去重排序 */
export function knownNames(...lists: (string | null | undefined)[][]): string[] {
  const set = new Set<string>();
  for (const list of lists) for (const n of list) if (n && n.trim()) set.add(n.trim());
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

/** 路徑比對鍵（同後端 path_key）：正斜線、去除結尾斜線；Windows 路徑不分大小寫 */
export function pathKey(p: string): string {
  let s = p.trim().replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/') && !/^[a-zA-Z]:\/$/.test(s)) s = s.slice(0, -1);
  if (/^[a-zA-Z]:\//.test(s) || s.startsWith('//')) s = s.toLowerCase();
  return s;
}

/** 紀錄對應的回報（同電腦群組內、同路徑） */
export function reportFor(group: MachineGroup, path: string): WorktreeReport | undefined {
  const k = pathKey(path);
  return group.reports.find((r) => pathKey(r.path) === k);
}

/** 需要留意的提示數：可能遺失 + 未登記 */
export function hintCount(machines: MachineGroup[]): number {
  let n = 0;
  for (const g of machines) {
    n += g.records.filter((r) => r.hint === 'missing').length;
    n += g.reports.filter((r) => !r.registered).length;
  }
  return n;
}

export const recordCount = (machines: MachineGroup[]) => machines.reduce((n, g) => n + g.records.length, 0);

/** 回報快照的簡短描述，例如「未提交變更 · ↑2 ↓0 · 已併入 main」 */
export function reportSummary(r: WorktreeReport): string {
  const parts: string[] = [];
  if (r.isPrunable) parts.push('目錄已不存在');
  if (r.isDirty) parts.push('未提交變更');
  if (r.ahead != null && r.behind != null) parts.push(`↑${r.ahead} ↓${r.behind}`);
  if (r.isMerged) parts.push('已併入 main');
  return parts.join(' · ') || '無變更';
}

/** localStorage：記住上次填寫的電腦名稱（新增表單預設值） */
export const MACHINE_STORAGE_KEY = 'eng.machine';
