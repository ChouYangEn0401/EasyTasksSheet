// 權限（capability）名稱：與 server/app/permissions.py 的 CAPABILITIES 一致（pytest 會比對）。
// 前端只依 /api/auth/me 回傳的 capabilities 決定顯示 / 隱藏；實際權限一律由後端強制。
// 對照表見 docs/permissions.md。

export const CAPABILITIES = {
  // user：一般協作（全員）
  'tasks.edit': 'user',
  'feedback.edit': 'user',
  'personal.edit': 'user',
  'eng.edit': 'user',
  'eng.status.manage': 'user',
  'projects.create': 'user',
  'properties.edit': 'user',
  'profile.edit': 'user',
  'audit.view_task_history': 'user',
  'comments.write': 'user',
  // manager（danger-command）
  'audit.view': 'manager',
  'audit.revert': 'manager',
  'members.manage': 'manager',
  'statuses.manage': 'manager',
  'projects.manage': 'manager',
  'github.manage': 'manager',
  'eng.scan': 'manager',
  'eng.trash.purge': 'manager',
  'data.export_json': 'manager',
  'data.import_merge': 'manager',
  'sync.manage': 'manager',
  'sync.resolve': 'manager',
  'comments.moderate': 'manager',
  'tasks.lock': 'manager',
  // root（damageable-command）
  'data.backup_db': 'root',
  'data.import_replace': 'root',
  'roles.assign_root': 'root',
  'permissions.configure': 'root',
};

// ── 權限設定（/api/admin/permissions，僅 root）──────────────

/** 可在權限設定中調整的角色（root 恆擁有全部權限） */
export const CONFIGURABLE_ROLES = ['manager', 'user'];
