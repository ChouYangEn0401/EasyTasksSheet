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
  /** 「連結」為 GitHub issue 網址時由後端解析（小寫 owner/name 與編號）；其他情況為 null */
  githubRepo: string | null;
  githubNumber: number | null;
  /** 上次同步時 GitHub 端的狀態（尚未同步為 null） */
  githubState: GithubState | null;
  /** 上次成功同步的時間 */
  syncedAt: number | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: number;
  updatedAt: number;
};

export type GithubState = 'open' | 'closed';

/** 專案連動：問題的「專案 / Repo」名稱（不分大小寫）→ GitHub owner/name */
export type GithubLink = { project: string; githubRepo: string };

/** GET /api/eng/issues */
export type IssuesResponse = {
  /** 伺服器是否設定了 GITHUB_TOKEN（token 本身絕不回傳） */
  githubEnabled: boolean;
  /** 距上次同步超過幾分鐘，前端載入時自動同步一次 */
  syncMinutes: number;
  links: GithubLink[];
  issues: ManualIssue[];
  /** 各問題的附件（鍵為問題 id 字串；沒有附件的問題不出現） */
  attachments?: Record<string, Attachment[]>;
  /** 各問題連結的網頁預覽（鍵為問題 id 字串） */
  previews?: Record<string, LinkPreview>;
  attachmentLimits?: AttachmentLimits;
  linkPreviewEnabled?: boolean;
};

// ── 附件與連結預覽 ─────────────────────────────────────────

export type AttachmentKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'archive' | 'document' | 'file';

export type Attachment = {
  id: number;
  entityType: string;
  entityId: number;
  /** 原始檔名（只供顯示） */
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  uploadedBy: number | null;
  createdAt: number;
  /** /api/attachments/:id（圖片 / 影片 / 音訊 / PDF inline，其他下載；?download=1 強制下載） */
  url: string;
  /** 只有圖片有縮圖 */
  thumbUrl: string | null;
};

export type AttachmentLimits = { maxBytes: number; videoMaxBytes: number; maxFiles: number };

/** 網頁 metadata 預覽（不含整頁截圖） */
export type LinkPreview = {
  url: string;
  status: 'ok' | 'error';
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  faviconUrl: string | null;
  siteName: string | null;
  summary: string | null;
  contentType: string | null;
  error: string | null;
  fetchedAt: number;
};

/** POST /api/eng/issues/sync（body：{} 或 { id }） */
export type SyncResult = {
  checked: number;
  updated: number[];
  failed: { id: number; message: string }[];
  syncedAt: number;
};

/** POST /api/eng/issues/import（body：{ project }） */
export type ImportResult = { repo: string; created: number; skipped: number };

/** PUT /api/eng/github-links（body：{ links }，整批取代）；POST /issues/:id/publish 則回傳 ManualIssue */
export type GithubLinksResponse = { links: GithubLink[] };

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
