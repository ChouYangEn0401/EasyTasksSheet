// 權限（capability）名稱：與 server/app/permissions.py 的 CAPABILITIES 一致（pytest 會比對）。
// 前端只依 /api/auth/me 回傳的 capabilities 決定顯示 / 隱藏；實際權限一律由後端強制。
// 對照表見 docs/permissions.md。
import type { UserRole } from './users.ts';

export const CAPABILITIES = {
  // user：一般協作（全員）
  'tasks.edit': 'user',
  'feedback.edit': 'user',
  'personal.edit': 'user',
  'eng.edit': 'user',
  'projects.create': 'user',
  'properties.edit': 'user',
  'profile.edit': 'user',
  // manager（danger-command）
  'members.manage': 'manager',
  'statuses.manage': 'manager',
  'projects.manage': 'manager',
  'github.manage': 'manager',
  'data.export_json': 'manager',
  'data.import_merge': 'manager',
  // root（damageable-command）
  'data.backup_db': 'root',
  'data.import_replace': 'root',
  'roles.assign_root': 'root',
} as const satisfies Record<string, UserRole>;

export type Capability = keyof typeof CAPABILITIES;
