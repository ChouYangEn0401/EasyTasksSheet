import { createElement, Fragment } from 'preact';
import { colorForId } from '../../lib/colors.js';
import { initialOf } from '../../lib/format.js';

/** 頭像 + 右下角狀態圓點（綠 = 在線、黃 = 閒置、離線不顯示）；外觀同 ui Avatar */
export function PresenceAvatar({ user, member, size = 'md' }) {
  const c = colorForId(user.id);
  const style = {
    '--avatar-bg': `var(--color-tag-${c}-soft)`,
    '--avatar-fg': `var(--color-tag-${c}-text)`,
  };
  return createElement(
    'span',
    { className: 'pr-avatar', 'data-status': member.status, 'data-size': size },
    createElement(
      'span',
      { className: `ui-avatar ui-avatar--${size}`, style: style, 'aria-hidden': 'true' },
      initialOf(user.displayName),
    ),
    member.status !== 'offline' &&
      createElement('span', { className: 'pr-dot', 'data-status': member.status }),
  );
}
