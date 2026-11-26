
/** 三層角色：root（超級管理員）> manager（管理者）> user（成員）。docs/permissions.md */
export const USER_ROLES = ['root', 'manager', 'user'];

/** 角色顯示名稱（全站一致） */
export const ROLE_LABELS = {
  root: '超級管理員',
  manager: '管理者',
  user: '成員',
};

/** 階層：數字越大權限越高 */
export const ROLE_RANK = { user: 1, manager: 2, root: 3 };
