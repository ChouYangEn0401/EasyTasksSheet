// 工程追蹤（feat/eng-tracking）：repo 設定、git issue 快取、worktree 安排與實際狀態
import { z } from 'zod';
import { timestamps } from './common.ts';

// ── Repo ─────────────────────────────────────────────────────

export const repo = z.object({
  id: z.number().int(),
  name: z.string(),
  localPath: z.string().nullable(),
  remoteSlug: z.string().nullable(),
  ...timestamps,
});
export type Repo = z.infer<typeof repo>;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** 遠端來源 owner/name */
export const REMOTE_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

export const repoInput = z.object({
  name: z.string().trim().min(1, '請輸入名稱').max(100),
  /** server 上的本機路徑（模式 A）；或開發機上的路徑（模式 B，供對照安排的相對路徑） */
  localPath: optionalText(500),
  remoteSlug: optionalText(200).refine((v) => v == null || REMOTE_SLUG_RE.test(v), {
    message: '格式須為 owner/name',
  }),
});
export type RepoInput = z.input<typeof repoInput>;
export const repoUpdateInput = repoInput.partial();
export type RepoUpdateInput = z.input<typeof repoUpdateInput>;

// ── Issues ───────────────────────────────────────────────────

export type GitIssue = {
  number: number;
  title: string;
  labels: string[];
  assignee: string | null;
  url: string;
  issueUpdatedAt: number | null;
};

export type IssuesResponse = {
  repoId: number;
  /** 伺服器是否設定了 issue 來源的存取 token */
  configured: boolean;
  remoteSlug: string | null;
  /** 上次成功同步時間（無快取為 null） */
  fetchedAt: number | null;
  /** 最近一次同步失敗（成功後清除） */
  error: { message: string; at: number } | null;
  issues: GitIssue[];
};

export const issuesQuery = z.object({ repo: z.coerce.number().int().positive() });
export const issuesRefreshInput = z.object({ repoId: z.number().int().positive() });

// ── Worktree ─────────────────────────────────────────────────

/** 主狀態（互斥，依此優先序判定） */
export const WORKTREE_STATUSES = ['missing', 'unplanned', 'merged', 'ok'] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];
/** 附加旗標 */
export const WORKTREE_FLAGS = ['dirty', 'stale'] as const;
export type WorktreeFlag = (typeof WORKTREE_FLAGS)[number];
/** 篩選 chip 的鍵（`?wt=`） */
export const WORKTREE_STATES = [...WORKTREE_STATUSES, ...WORKTREE_FLAGS] as const;
export const worktreeState = z.enum(WORKTREE_STATES);
export type WorktreeState = z.infer<typeof worktreeState>;

export const WORKTREE_STATE_LABELS: Record<WorktreeState, string> = {
  missing: '遺失',
  unplanned: '未登記',
  merged: '已合併未清理',
  ok: '正常',
  dirty: '未提交變更',
  stale: '久未更新',
};

export type WorktreePlan = {
  id: number;
  repoId: number;
  path: string;
  branch: string;
  ownerId: number | null;
  taskId: number | null;
  purpose: string;
  createdAt: number;
  updatedAt: number;
};

export type WorktreeSnapshot = {
  repoId: number;
  path: string;
  branch: string | null;
  headSha: string | null;
  isDirty: boolean;
  ahead: number | null;
  behind: number | null;
  lastCommitAt: number | null;
  isPrunable: boolean;
  /**
   * 偵測端判定的「已併入 main」（排除剛建立尚未提交的分支）；持久化於 worktree_snapshots.is_merged。
   * 偵測端無法判定時為 false
   */
  isMerged: boolean;
  reportedBy: string | null;
  reportedAt: number;
};

export type WorktreeRow = {
  /** 穩定鍵：plan-<id> 或 snap-<路徑> */
  key: string;
  status: WorktreeStatus;
  flags: WorktreeFlag[];
  /** 顯示用分支與路徑（優先取實際狀態） */
  branch: string | null;
  path: string;
  plan: WorktreePlan | null;
  snapshot: WorktreeSnapshot | null;
};

export type WorktreesResponse = {
  repoId: number;
  /** local：server 直接偵測（模式 A）；report：開發機回報（模式 B）；none：尚無資料 */
  mode: 'local' | 'report' | 'none';
  /** 實際狀態的時間（偵測或回報） */
  detectedAt: number | null;
  staleDays: number;
  rows: WorktreeRow[];
};

export const worktreesQuery = z.object({
  repo: z.coerce.number().int().positive(),
  refresh: z.enum(['0', '1']).optional(),
});

const nullableId = z.number().int().positive().nullish();

export const worktreePlanInput = z.object({
  repoId: z.number().int().positive(),
  branch: z.string().trim().min(1, '請輸入分支').max(200),
  path: z.string().trim().min(1, '請輸入路徑').max(500),
  ownerId: nullableId,
  taskId: nullableId,
  purpose: z.string().trim().max(200).optional(),
});
export type WorktreePlanInput = z.input<typeof worktreePlanInput>;
export const worktreePlanUpdateInput = worktreePlanInput.partial();
export type WorktreePlanUpdateInput = z.input<typeof worktreePlanUpdateInput>;
export const worktreePlansQuery = z.object({ repo: z.coerce.number().int().positive().optional() });

/** 偵測結果（server 偵測與回報腳本共用的格式） */
export const detectedWorktree = z.object({
  path: z.string().min(1).max(1000),
  branch: z.string().max(300).nullable(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable(),
  isDirty: z.boolean(),
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  lastCommitAt: z.number().int().nullable(),
  isPrunable: z.boolean(),
  isMerged: z.boolean().optional(),
});

export const worktreeReportInput = z
  .object({
    repoId: z.number().int().positive().optional(),
    /** 以名稱指定 repo（repoId 未給時） */
    repo: z.string().trim().min(1).max(100).optional(),
    reporter: z.string().trim().min(1).max(100).optional(),
    worktrees: z.array(detectedWorktree).max(500),
  })
  .refine((v) => v.repoId != null || v.repo != null, { message: '請指定 repoId 或 repo' });
export type WorktreeReportInput = z.infer<typeof worktreeReportInput>;
