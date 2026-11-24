/**
 * E2E 固定帳號（由 scripts/e2e-setup.ts 在每次 E2E 開始前建立於全新 DB）。
 * - admin / member：可直接登入
 * - newbie：首次登入需強制改密碼（core-shell 冒煙測試用，其他 spec 請勿使用）
 */
export const E2E_USERS = {
  admin: { username: 'admin', password: 'e2e-admin-pass', displayName: '管理員' },
  member: { username: 'member', password: 'e2e-member-pass', displayName: '一般成員' },
  newbie: { username: 'newbie', password: 'e2e-newbie-pass', displayName: '新成員' },
} as const;
