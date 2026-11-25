import type {
  EngStatus,
  EngStatusCategory,
  EngStatusKind,
  GithubLink,
  MachineGroup,
  ManualIssue,
  WorktreeReport,
} from '../../../shared/engManual.ts';
import type { TagColor } from '../../../shared/projects.ts';

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

// ── 可自訂狀態（eng_statuses） ──

/** 狀態清單尚未載入時的後備（內建值；與 migration 0011 一致） */
const FALLBACK: Record<string, { label: string; color: TagColor; category: EngStatusCategory }> = {
  'issue:open': { label: '未處理', color: 'yellow', category: 'open' },
  'issue:doing': { label: '處理中', color: 'blue', category: 'open' },
  'issue:closed': { label: '已結案', color: 'green', category: 'closed' },
  'worktree:active': { label: '使用中', color: 'green', category: 'active' },
  'worktree:idle': { label: '閒置', color: 'gray', category: 'idle' },
  'worktree:merged': { label: '已合併待清理', color: 'purple', category: 'attention' },
  'worktree:lost': { label: '已遺失', color: 'red', category: 'done' },
  'worktree:cleaned': { label: '已清理', color: 'gray', category: 'done' },
};

/** 某一類（問題 / 工作樹）的狀態，依排序 */
export function statusesOf(all: EngStatus[] | undefined, kind: EngStatusKind): EngStatus[] {
  return (all ?? []).filter((s) => s.kind === kind).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

export type StatusView = {
  key: string;
  label: string;
  color: TagColor;
  category: EngStatusCategory | null;
  archived: boolean;
};

/** 顯示用：找不到定義時（例如匯入的自訂值）以 key 為名稱、灰色 */
export function statusView(list: EngStatus[], kind: EngStatusKind, key: string): StatusView {
  const s = list.find((x) => x.key === key);
  if (s) return { key, label: s.label, color: s.color, category: s.category, archived: s.isArchived };
  const f = FALLBACK[`${kind}:${key}`];
  return f
    ? { key, ...f, archived: false }
    : { key, label: key, color: 'gray', category: null, archived: false };
}

/** 下拉選單：未封存者；目前值若已封存 / 不明仍列出（舊資料可顯示） */
export function selectableStatuses(list: EngStatus[], current?: string): EngStatus[] {
  return list.filter((s) => !s.isArchived || s.key === current);
}

/** 某類別第一個可用的狀態 key（prefer 優先，例如結案用 closed） */
export function firstInCategory(
  list: EngStatus[],
  category: EngStatusCategory,
  prefer?: string,
): string | undefined {
  const open = list.filter((s) => !s.isArchived && s.category === category);
  return (open.find((s) => s.key === prefer) ?? open[0])?.key;
}

export const isClosedIssue = (list: EngStatus[], key: string) =>
  statusView(list, 'issue', key).category === 'closed';
export const isDoneRecord = (list: EngStatus[], key: string) =>
  statusView(list, 'worktree', key).category === 'done';

/** 問題清單：預設隱藏已結案類（category = closed） */
export const visibleIssues = (issues: ManualIssue[], showClosed: boolean, list: EngStatus[] = []) =>
  showClosed ? issues : issues.filter((i) => !isClosedIssue(list, i.status));

export const openIssueCount = (issues: ManualIssue[], list: EngStatus[] = []) =>
  issues.filter((i) => !isClosedIssue(list, i.status)).length;

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

/** 未登記且仍在回報中的項目（搬動候選另外顯示在原紀錄上） */
export const unregisteredReports = (g: MachineGroup) =>
  g.reports.filter((r) => !r.registered && r.missingSince == null && r.movedFrom == null);

/** 需要留意的提示數：紀錄提示（可能遺失 / 回報中找不到 / 可能搬動）+ 未登記 + 待確認的可疑回報 */
export function hintCount(machines: MachineGroup[]): number {
  let n = 0;
  for (const g of machines) {
    n += g.records.filter((r) => r.hint != null).length;
    n += unregisteredReports(g).length;
    n += g.repos.filter((r) => r.pending != null).length;
  }
  return n;
}

export const recordCount = (machines: MachineGroup[]) => machines.reduce((n, g) => n + g.records.length, 0);

/** 回報快照的簡短描述，例如「未提交變更 · ↑2 ↓0 · 已併入 main」 */
export function reportSummary(
  r: Pick<WorktreeReport, 'isPrunable' | 'isDirty' | 'ahead' | 'behind' | 'isMerged'>,
): string {
  const parts: string[] = [];
  if (r.isPrunable) parts.push('目錄已不存在');
  if (r.isDirty) parts.push('未提交變更');
  if (r.ahead != null && r.behind != null) parts.push(`↑${r.ahead} ↓${r.behind}`);
  if (r.isMerged) parts.push('已併入 main');
  return parts.join(' · ') || '無變更';
}

/** localStorage：記住上次填寫的電腦名稱（新增表單預設值） */
export const MACHINE_STORAGE_KEY = 'eng.machine';
/** localStorage：最近掃描過的專案資料夾（最多 5 個，最新在前） */
export const SCAN_PATHS_KEY = 'eng.scanPaths';

export function rememberPath(list: string[], path: string, max = 5): string[] {
  const p = path.trim();
  if (!p) return list;
  return [p, ...list.filter((x) => x !== p)].slice(0, max);
}

/** 「3 天前」「5 小時前」「剛剛」 */
export function ago(at: number, now: number = Date.now()): string {
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  return `${Math.floor(h / 24)} 天前`;
}
