// 工程追蹤簡化版（手動輸入優先；Python 後端 server/app/features/eng.py）。

// ── 問題 ─────────────────────────────────────────────────────

export const ISSUE_STATUSES = ['open', 'doing', 'closed'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: '未處理',
  doing: '處理中',
  closed: '已結案',
};

export type ManualIssue = {
  id: number;
  title: string;
  description: string;
  /** 所屬專案或 repo 名稱（自由文字） */
  project: string;
  status: IssueStatus;
  assigneeId: number | null;
  url: string | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: number;
  updatedAt: number;
};

/** POST /api/eng/issues（title 必填）；PATCH 只送改動欄位 */
export type ManualIssueInput = {
  title?: string;
  description?: string;
  project?: string;
  status?: IssueStatus;
  assigneeId?: number | null;
  url?: string | null;
};

// ── Worktree 紀錄 ────────────────────────────────────────────

export const WORKTREE_RECORD_STATUSES = ['active', 'idle', 'merged', 'lost', 'cleaned'] as const;
export type WorktreeRecordStatus = (typeof WORKTREE_RECORD_STATUSES)[number];
export const WORKTREE_RECORD_STATUS_LABELS: Record<WorktreeRecordStatus, string> = {
  active: '使用中',
  idle: '閒置',
  merged: '已合併待清理',
  lost: '已遺失',
  cleaned: '已清理',
};

export type WorktreeRecord = {
  id: number;
  /** 電腦名稱（被追蹤的專案位於各人自己的電腦） */
  machine: string;
  path: string;
  branch: string;
  ownerId: number | null;
  purpose: string;
  status: WorktreeRecordStatus;
  note: string;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: number;
  updatedAt: number;
};

/** POST /api/eng/worktree-records（machine、path 必填）；PATCH 只送改動欄位 */
export type WorktreeRecordInput = {
  machine?: string;
  path?: string;
  branch?: string;
  ownerId?: number | null;
  purpose?: string;
  status?: WorktreeRecordStatus;
  note?: string;
};

/** 各電腦以 scripts/report-worktrees.mjs 回報的快照（僅供參考） */
export type WorktreeReport = {
  id: number;
  machine: string;
  repo: string;
  path: string;
  branch: string | null;
  headSha: string | null;
  isDirty: boolean;
  ahead: number | null;
  behind: number | null;
  lastCommitAt: number | null;
  isPrunable: boolean;
  isMerged: boolean;
  reportedAt: number;
};

export type MachineGroup = {
  machine: string;
  /** 最近一次回報時間（從未回報為 null） */
  reportedAt: number | null;
  /** hint = missing：該電腦有回報，但回報中沒有此路徑（可能遺失） */
  records: (WorktreeRecord & { hint: 'missing' | null })[];
  /** registered = false：回報有、但沒有對應紀錄（未登記） */
  reports: (WorktreeReport & { registered: boolean })[];
};

/** GET /api/eng/worktrees */
export type WorktreesOverview = {
  /** 伺服器是否設定了 WORKTREE_REPORT_TOKEN */
  reportEnabled: boolean;
  machines: MachineGroup[];
};
