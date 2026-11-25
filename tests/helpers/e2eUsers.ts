/**
 * E2E 固定帳號（由 server/e2e_setup.py 在每次 E2E 開始前建立於全新 DB）。
 * - admin / member：可直接登入
 * - newbie：首次登入需強制改密碼（core-shell 冒煙測試用，其他 spec 請勿使用）
 * - bootstrap：模擬首次啟動的預設管理員（E2E 伺服器設 ADMIN_USERNAME=bootstrap），
 *   首次登入須重設帳號＋密碼（core-shell 專用，其他 spec 請勿使用）。
 *   角色為 member，避免影響 admin-users spec 的「唯一管理員」前提。
 */
export const E2E_USERS = {
  admin: { username: 'admin', password: 'e2e-admin-pass', displayName: '管理員' },
  member: { username: 'member', password: 'e2e-member-pass', displayName: '一般成員' },
  newbie: { username: 'newbie', password: 'e2e-newbie-pass', displayName: '新成員' },
  bootstrap: { username: 'bootstrap', password: 'password', displayName: '首次啟動' },
} as const;
