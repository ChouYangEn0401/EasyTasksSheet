import type { CSSProperties } from 'react';
import type { PresenceMember } from '../../../shared/presence.ts';
import type { PublicUser } from '../../../shared/users.ts';
import { colorForId } from '../../lib/colors.ts';
import { initialOf } from '../../lib/format.ts';

/** 頭像 + 右下角狀態圓點（綠 = 在線、黃 = 閒置、離線不顯示）；外觀同 ui Avatar */
export function PresenceAvatar({
  user,
  member,
  size = 'md',
}: {
  user: Pick<PublicUser, 'id' | 'displayName'>;
  member: Pick<PresenceMember, 'status'>;
  size?: 'xs' | 'sm' | 'md';
}) {
  const c = colorForId(user.id);
  const style = {
    '--avatar-bg': `var(--color-tag-${c}-soft)`,
    '--avatar-fg': `var(--color-tag-${c}-text)`,
  } as CSSProperties;
  return (
    <span className="pr-avatar" data-status={member.status} data-size={size}>
      <span className={`ui-avatar ui-avatar--${size}`} style={style} aria-hidden="true">
        {initialOf(user.displayName)}
      </span>
      {member.status !== 'offline' && <span className="pr-dot" data-status={member.status} />}
    </span>
  );
}
