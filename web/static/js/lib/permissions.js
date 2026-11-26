import { useMe } from './auth.js';

export { ROLE_LABELS, ROLE_RANK } from '../shared/users.js';

/** 角色標籤顏色（成員管理列表、使用者選單） */
export const ROLE_BADGE_TONES = {
  root: 'accent',
  manager: 'purple',
  user: 'neutral',
};

/** 登入者具備的權限（取自 /api/auth/me；未登入為空集合）。後端仍會逐一強制。docs/permissions.md */
export function useCapabilities() {
  const caps = useMe().data?.capabilities;
  return new Set(caps ?? []);
}

/** 是否具備某權限（依 capability 顯示 / 隱藏功能，不再以角色字串判斷） */
export function useCan(capability) {
  return useMe().data?.capabilities.includes(capability) ?? false;
}
