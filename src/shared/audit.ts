// 稽核紀錄（/api/admin/audit、/api/tasks/:id/history；server/app/audit.py）。docs/design/audit-log.md

export const AUDIT_ENTITY_TYPES = [
  'task',
  'project',
  'status',
  'property',
  'user',
  'permission',
  'import',
  'sync',
  'relation',
  'dependency',
  'checklist',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'restore',
  'reorder',
  'reset_password',
  'unlock',
  'apply',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditSource = 'web' | 'api' | 'import' | 'sync' | 'system' | 'revert';

/** 有變動的單一欄位（before / after 只含有變動者） */
export type AuditChange = {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
  /** null：該筆沒有「修改前」（建立）或沒有「修改後」（刪除） */
  beforeText: string | null;
  afterText: string | null;
  /** 長文字（描述、文字型自訂欄位）：以行內差異顯示 */
  long: boolean;
  /** 內容過長，只保存了部分 */
  truncated: boolean;
};

export type AuditEntry = {
  id: number;
  ts: number;
  actorId: number | null;
  actorName: string | null;
  actorUsername: string | null;
  source: AuditSource;
  entityType: AuditEntityType;
  entityId: number | null;
  entityLabel: string | null;
  taskId: number | null;
  action: AuditAction;
  summary: string;
  revertable: boolean;
  /** 不可還原的原因或補充說明 */
  note: string | null;
  revertOf: number | null;
  revertedAt: number | null;
  revertedBy: number | null;
  revertedByName: string | null;
  /** 還原這筆的那一筆稽核紀錄 id */
  revertEntryId: number | null;
  changes: AuditChange[];
};

export type AuditPage = { items: AuditEntry[]; nextBefore: number | null };

export type RevertField = {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
  current: unknown;
  beforeText: string;
  afterText: string;
  currentText: string;
  long: boolean;
  /** 目前值 ≠ 該次修改後的值：這次之後又被改過 */
  conflict: boolean;
};

export type RevertKind =
  | 'set_fields'
  | 'soft_delete'
  | 'undelete'
  | 'delete_row'
  | 'recreate_row'
  | 'delete_link'
  | 'recreate_link'
  | 'none';

export type RevertPreview = {
  kind: RevertKind;
  fields: RevertField[];
  blocked: string | null;
  hasConflict: boolean;
};

export type AuditDetail = AuditEntry & { revertPreview: RevertPreview };

export type RevertResult = {
  ok: true;
  revertId: number | null;
  summary: string;
  entityType: AuditEntityType;
  entityId: number | null;
  taskId: number | null;
};
