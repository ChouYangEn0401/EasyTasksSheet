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
  'comment',
];

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'restore',
  'reorder',
  'reset_password',
  'unlock',
  'apply',
];

/** 有變動的單一欄位（before / after 只含有變動者） */
