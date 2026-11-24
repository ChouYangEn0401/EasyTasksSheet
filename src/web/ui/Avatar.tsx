import type { CSSProperties } from 'react';
import { colorForId } from '../lib/colors.ts';
import { initialOf } from '../lib/format.ts';
import { useUsersById } from '../lib/hooks.ts';
import { Icon } from './Icon.tsx';
import { Tooltip } from './Tooltip.tsx';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';
type UserLike = { id: number; displayName: string };

const SIZE_PX: Record<AvatarSize, number> = { xs: 20, sm: 24, md: 28, lg: 36 };

/**
 * 圓形頭像（無圖片，顯示首字）。底色由 user id 對調色盤取模。
 * user 與 userId 皆為空時顯示「未指派」（虛線圓 + 人形圖示）。
 */
export function Avatar({
  user,
  userId,
  size = 'sm',
  tooltip = true,
}: {
  user?: UserLike | null;
  userId?: number | null;
  size?: AvatarSize;
  tooltip?: boolean;
}) {
  const byId = useUsersById();
  const u = user ?? (userId != null ? byId.get(userId) : undefined);
  const cls = `ui-avatar ui-avatar--${size}`;
  if (!u) {
    const node = (
      <span className={`${cls} ui-avatar--empty`} role="img" aria-label="未指派">
        <Icon name="user" size={Math.round(SIZE_PX[size] * 0.55)} />
      </span>
    );
    return tooltip ? <Tooltip content="未指派">{node}</Tooltip> : node;
  }
  const c = colorForId(u.id);
  const style = {
    '--avatar-bg': `var(--color-tag-${c}-soft)`,
    '--avatar-fg': `var(--color-tag-${c}-text)`,
  } as CSSProperties;
  const node = (
    <span className={cls} style={style} role="img" aria-label={u.displayName}>
      {initialOf(u.displayName)}
    </span>
  );
  return tooltip ? <Tooltip content={u.displayName}>{node}</Tooltip> : node;
}

/** 重疊頭像群組：超過 max 個顯示 +N */
export function AvatarGroup({
  users,
  max = 3,
  size = 'sm',
}: {
  users: UserLike[];
  max?: number;
  size?: AvatarSize;
}) {
  const shown = users.slice(0, max);
  const rest = users.length - shown.length;
  return (
    <span className="ui-avatar-group">
      {shown.map((u) => (
        <Avatar key={u.id} user={u} size={size} />
      ))}
      {rest > 0 && (
        <Tooltip
          content={users
            .slice(max)
            .map((u) => u.displayName)
            .join('、')}
        >
          <span className={`ui-avatar ui-avatar--${size}`} aria-label={`另外 ${rest} 人`}>
            +{rest}
          </span>
        </Tooltip>
      )}
    </span>
  );
}
