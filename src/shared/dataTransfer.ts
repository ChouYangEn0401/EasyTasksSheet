// 資料管理（feat/data-export）：/api/admin/data/* 的輸入與回應格式（後端見 server/app/data_transfer.py）

export const IMPORT_STRATEGIES = ['keep_newer', 'keep_local', 'use_import'] as const;
/** 衝突的全域處理策略：以 updatedAt 較新者為準（預設）/ 保留本機 / 使用匯入檔 */
export type ImportStrategy = (typeof IMPORT_STRATEGIES)[number];
/** 單筆衝突的處理（逐筆覆寫） */
export type ConflictResolution = 'keep_local' | 'use_import';
/** 匯入檔中的成員在本機不存在時：略過指派 / 自動建立（一般成員、臨時密碼） */
export type MissingUsersPolicy = 'skip' | 'create';
export type ImportMode = 'merge' | 'replace';

/** 取代模式需輸入的確認字樣（與後端 REPLACE_CONFIRM 一致） */
export const REPLACE_CONFIRM_TEXT = '取代全部資料';

export type ImportCategoryStat = {
  key: string;
  label: string;
  /** 匯入檔中的筆數 */
  total: number;
  /** 本機目前筆數 */
  local: number;
  new: number;
  same: number;
  conflict: number;
};

export type ImportConflictField = { name: string; label: string; local: unknown; import: unknown };

export type ImportConflict = {
  /** 逐筆覆寫用的鍵（類別:uid） */
  key: string;
  category: string;
  categoryLabel: string;
  title: string;
  localUpdatedAt: number | null;
  importUpdatedAt: number | null;
  newer: 'local' | 'import' | 'same';
  fields: ImportConflictField[];
};

export type MissingUser = { username: string; displayName: string; references: number };

export type ImportPreview = {
  token: string;
  expiresAt: number;
  file: { schemaVersion: number; exportedAt: number };
  categories: ImportCategoryStat[];
  users: { total: number; existing: number; missing: number };
  conflicts: ImportConflict[];
  missingUsers: MissingUser[];
};

export type ImportApplyInput = {
  token: string;
  mode?: ImportMode;
  strategy?: ImportStrategy;
  overrides?: Record<string, ConflictResolution>;
  missingUsers?: MissingUsersPolicy;
  confirm?: string;
};

export type ImportResultCategory = {
  key: string;
  label: string;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  deleted: number;
};

export type ImportResult = {
  mode: ImportMode;
  strategy: ImportStrategy;
  categories: ImportResultCategory[];
  /** 自動建立的成員：tempPassword 只在此回傳一次 */
  createdUsers: { username: string; displayName: string; tempPassword: string }[];
  missingUsersSkipped: string[];
  /** 套用前自動備份的檔名（位於伺服器 BACKUP_DIR） */
  backupFile: string | null;
};
