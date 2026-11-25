// 多台電腦同步（feat/sync-push）：/api/admin/sync/* 的回應格式（後端見 server/app/sync_push.py、
// server/app/features/sync_push.py；規格見 docs/design/sync.md）。

export type SyncTotals = {
  created: number;
  updated: number;
  unchanged: number;
  conflict: number;
  skipped: number;
  /** 中央較新而保留中央（不算衝突） */
  older: number;
};

export type SyncPushSummary = {
  pushId: string | null;
  machineName: string;
  sourceName: string;
  at: number;
  since: number | null;
  full: boolean;
  batches: number;
  batchTotal: number;
  totals: SyncTotals;
  pendingConflicts: number;
  missingUsers: string[];
};

export type SyncSource = {
  id: number;
  name: string;
  /** 金鑰末 4 碼（辨識用；金鑰本體只在建立 / 重新產生時顯示一次） */
  tokenHint: string;
  autoCreateUsers: boolean;
  isActive: boolean;
  createdBy: number | null;
  createdAt: number;
  updatedAt: number;
  lastPushAt: number | null;
  lastPushSummary: SyncPushSummary | null;
  pendingConflicts: number;
};

export type SyncSourceWithToken = { source: SyncSource; token: string };

export type SyncResolution = 'keep_local' | 'use_incoming' | 'merged';
export type SyncChoice = 'local' | 'incoming';

export type SyncConflictSummary = {
  id: number;
  category: string;
  categoryLabel: string;
  title: string;
  entityUid: string;
  sourceId: number | null;
  sourceName: string;
  localUpdatedAt: number | null;
  incomingUpdatedAt: number | null;
  diffMinutes: number;
  diffFields: { name: string; label: string }[];
  status: 'pending' | 'resolved';
  resolution: SyncResolution | null;
  resolvedBy: number | null;
  resolvedByName: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** merged 時的逐欄位選擇 */
  choices?: Record<string, SyncChoice> | null;
};

export type SyncConflictField = {
  name: string;
  label: string;
  local: unknown;
  incoming: unknown;
  /** 參照 / 成員欄位的可讀文字（其餘為 null，直接顯示原值） */
  localDisplay: unknown;
  incomingDisplay: unknown;
};

export type SyncConflictDetail = SyncConflictSummary & {
  centralExists: boolean;
  fields: SyncConflictField[];
};

export type SyncConflictList = {
  conflicts: SyncConflictSummary[];
  counts: { pending: number; resolved: number };
};

export type SyncResolveInput = {
  resolution: SyncResolution;
  choices?: Record<string, SyncChoice>;
};

export type SyncBulkInput = { ids: number[]; resolution: Exclude<SyncResolution, 'merged'> };
