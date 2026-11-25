/**
 * E2E 固定帳號（由 server/e2e_setup.py 在每次 E2E 開始前建立於全新 DB）。
 * 鍵名 / 帳號沿用舊名，角色依三層權限（docs/permissions.md）：
 * - admin：root（超級管理員，E2E 中唯一的 root，admin-users spec 依賴此前提）
 * - member：user（成員）
 * - manager：manager（管理者，roles spec 用；請勿修改其角色）
 * - newbie：首次登入需強制改密碼（core-shell 冒煙測試用，其他 spec 請勿使用）
 * - bootstrap：模擬首次啟動的預設管理員（E2E 伺服器設 ADMIN_USERNAME=bootstrap），
 *   首次登入須重設帳號＋密碼（core-shell 專用，其他 spec 請勿使用）。
 *   角色為 user，避免影響 admin-users spec 的「唯一 root」前提。
 */
export const E2E_USERS = {
  admin: { username: 'admin', password: 'e2e-admin-pass', displayName: '管理員' },
  member: { username: 'member', password: 'e2e-member-pass', displayName: '一般成員' },
  manager: { username: 'manager', password: 'e2e-manager-pass', displayName: '管理者' },
  newbie: { username: 'newbie', password: 'e2e-newbie-pass', displayName: '新成員' },
  bootstrap: { username: 'bootstrap', password: 'password', displayName: '首次啟動' },
  /** 多人在線感知（presence spec）的第三位使用者 */
  peer: { username: 'peer', password: 'e2e-peer-pass', displayName: '晴恩' },
} as const;
