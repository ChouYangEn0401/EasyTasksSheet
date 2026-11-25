// 工程追蹤（手動輸入優先；Python 後端 server/app/features/eng.py、eng_status.py）。

import type { TagColor } from './projects.ts';

// ── 可自訂狀態（GET /api/eng/statuses） ─────────────────────

export type EngStatusKind = 'issue' | 'worktree';
export const ISSUE_CATEGORIES = ['open', 'closed'] as const;
export const WORKTREE_CATEGORIES = ['active', 'idle', 'attention', 'done'] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];
export type WorktreeCategory = (typeof WORKTREE_CATEGORIES)[number];
export type EngStatusCategory = IssueCategory | WorktreeCategory;
export const ENG_CATEGORY_LABELS: Record<EngStatusCategory, string> = {
  open: '未結案',
  closed: '已結案',
  active: '使用中',
  idle: '閒置',
  attention: '需處理',
  done: '已結束',
};

export type EngStatus = {
  id: number;
  kind: EngStatusKind;
  /** 穩定識別（資料中存的值）；內建沿用既有字串，自訂為 c_xxxxxxxx */
  key: string;
  label: string;
  color: TagColor;
  category: EngStatusCategory;
  sortOrder: number;
  isBuiltin: boolean;
  isArchived: boolean;
  updatedAt: number;
  updatedBy: number | null;
  /** 使用中的筆數（工作樹含回收區） */
  usage?: number;
};

export type EngStatusesResponse = {
  statuses: EngStatus[];
  categories: Record<EngStatusKind, EngStatusCategory[]>;
};

export type EngStatusInput = {
  kind?: EngStatusKind;
  label?: string;
  color?: TagColor;
  category?: EngStatusCategory;
  sortOrder?: number;
  isArchived?: boolean;
};

// ── 問題 ─────────────────────────────────────────────────────

/** eng_statuses（kind = issue）的 key */
export type IssueStatus = string;

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

/** eng_statuses（kind = worktree）的 key */
export type WorktreeRecordStatus = string;

export type WorktreeSource = 'manual' | 'report' | 'scan';

export type WorktreeRecord = {
  id: number;
  /** 電腦名稱（顯示用；被追蹤的專案位於各人自己的電腦） */
  machine: string;
  /** 電腦識別碼（由回報或掃描帶入；手動新增為 null，以名稱比對） */
  machineId: string | null;
  path: string;
  branch: string;
  ownerId: number | null;
  purpose: string;
  status: WorktreeRecordStatus;
  note: string;
  source: WorktreeSource;
  repo: string;
  headSha: string | null;
  /** 移到回收區的時間（未刪除為 null） */
  deletedAt: number | null;
  deletedBy: number | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: number;
  updatedAt: number;
};

/** POST /api/eng/worktree-records（machine、path 必填）；PATCH 只送改動欄位 */
export type WorktreeRecordInput = {
  machine?: string;
  machineId?: string | null;
  path?: string;
  branch?: string;
  ownerId?: number | null;
  purpose?: string;
  status?: WorktreeRecordStatus;
  note?: string;
  repo?: string;
  headSha?: string | null;
  source?: 'manual' | 'report';
};

/** 各電腦以 scripts/report-worktrees.mjs 回報的快照（僅供參考；不見的項目只標 missingSince，不刪除） */
export type WorktreeReport = {
  id: number;
  machine: string;
  machineId: string | null;
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
  /** 最後一次在回報中看到的時間 */
  reportedAt: number;
  /** 最新回報中找不到的起始時間（仍看得到為 null） */
  missingSince: number | null;
};

/** 被攔下待確認的可疑回報：empty = 空清單、drop = 筆數驟減 */
export type PendingReport = {
  reason: 'empty' | 'drop';
  count: number;
  previous: number;
  at: number;
};

export type MachineRepo = {
  sourceId: number;
  repo: string;
  reportedAt: number;
  appliedAt: number | null;
  pending: PendingReport | null;
};

/**
 * 紀錄的提示：
 * - missing：該電腦有回報，但回報中從未出現此路徑
 * - vanished：上次回報有看到、最新回報找不到（lastSeenAt）
 * - moved：路徑不同但分支與 HEAD 相同的未登記項目（moveTo）→ 可能是搬動 / 改名
 */
export type RecordHint = 'missing' | 'vanished' | 'moved';

export type MachineGroup = {
  /** 分組鍵：id:<machineId> 或 name:<名稱>（舊資料） */
  key: string;
  machine: string;
  machineId: string | null;
  /** 最近一次回報時間（從未回報為 null） */
  reportedAt: number | null;
  /** 超過 staleDays 天沒有回報 */
  stale: boolean;
  repos: MachineRepo[];
  records: (WorktreeRecord & {
    hint: RecordHint | null;
    lastSeenAt: number | null;
    moveTo: { path: string; reportId: number } | null;
  })[];
  /** registered = false：回報有、但沒有對應紀錄（未登記）；movedFrom：疑似由哪筆紀錄搬來 */
  reports: (WorktreeReport & { registered: boolean; movedFrom: number | null })[];
};

/** GET /api/eng/worktrees */
export type WorktreesOverview = {
  /** 伺服器是否設定了 WORKTREE_REPORT_TOKEN */
  reportEnabled: boolean;
  staleDays: number;
  /** 回收區筆數 */
  trashCount: number;
  /** 掃描本機專案：enabled = 伺服器設定了 WORKTREE_SCAN_ROOTS；roots / machine 只回給有 eng.scan 的人 */
  scan: { enabled: boolean; roots?: string[]; machine?: string };
  machines: MachineGroup[];
};

/** GET /api/eng/worktree-records/trash */
export type WorktreeTrash = {
  retentionDays: number;
  records: (WorktreeRecord & { expired: boolean })[];
};

export type ScanAction = 'new' | 'existing' | 'moved';

export type ScanItem = {
  path: string;
  branch: string | null;
  headSha: string | null;
  isDirty: boolean;
  ahead: number | null;
  behind: number | null;
  isMerged: boolean;
  lastCommitAt: number | null;
  isPrunable: boolean;
  isDetached: boolean;
  action: ScanAction;
  recordId: number | null;
  recordPath: string | null;
};

/** POST /api/eng/worktrees/scan（預覽，不寫入） */
export type ScanPreview = {
  repo: string;
  repoPath: string;
  base: string | null;
  machine: string;
  truncated: boolean;
  counts: Record<ScanAction, number>;
  items: ScanItem[];
};

/** POST /api/eng/worktrees/scan/apply */
export type ScanApplyResult = {
  ok: true;
  machine: string;
  repo: string;
  created: number;
  moved: number;
  updated: number;
};
