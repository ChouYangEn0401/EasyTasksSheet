import { createElement, useMemo } from 'react';
import { useUsers } from '../../lib/hooks.ts';
import { Avatar, type SelectOption } from '../../ui/index.ts';

/** Select 的「未指派」值 */
export const NONE = 0;

const avatar = (user: Parameters<typeof Avatar>[0]['user']) =>
  createElement(Avatar, { user, size: 'xs', tooltip: false });

/** 負責人選項：未指派 + 啟用中成員（目前值即使已停用也保留） */
export function useUserOptions(current: number | null | undefined): SelectOption<number>[] {
  const users = useUsers();
  return useMemo(
    () => [
      { value: NONE, label: '未指派', leading: avatar(null) },
      ...(users.data ?? [])
        .filter((u) => u.isActive || u.id === current)
        .map((u) => ({ value: u.id, label: u.displayName, leading: avatar(u) })),
    ],
    [users.data, current],
  );
}
