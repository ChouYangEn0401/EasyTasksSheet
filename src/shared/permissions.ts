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
  'sync.manage': 'manager',
  'sync.resolve': 'manager',
  // root（damageable-command）
  'data.backup_db': 'root',
  'data.import_replace': 'root',
  'roles.assign_root': 'root',
  'permissions.configure': 'root',
} as const satisfies Record<string, UserRole>;

export type Capability = keyof typeof CAPABILITIES;

// ── 權限設定（/api/admin/permissions，僅 root）──────────────

/** 可在權限設定中調整的角色（root 恆擁有全部權限） */
export const CONFIGURABLE_ROLES = ['manager', 'user'] as const;
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

export type PermissionCapability = {
  key: string;
  label: string;
  description: string;
  group: string;
  /** 受保護：只允許 root，不可授予其他角色 */
  protected: boolean;
  defaults: Record<UserRole, boolean>;
  effective: Record<UserRole, boolean>;
  overridden: Record<ConfigurableRole, boolean>;
};

export type PermissionMatrix = {
  roles: { role: UserRole; label: string; configurable: boolean }[];
  groups: { key: string; label: string }[];
  capabilities: PermissionCapability[];
  lastUpdated: { at: number; userId: number | null; displayName: string | null } | null;
};

export type PermissionChange = { role: ConfigurableRole; capability: string; allowed: boolean };
