import { createElement, Fragment } from 'preact';
import { colorForId } from '../lib/colors.js';
import { initialOf } from '../lib/format.js';
import { useUsersById } from '../lib/hooks.js';
import { Icon } from './Icon.js';
import { Tooltip } from './Tooltip.js';

const SIZE_PX = { xs: 20, sm: 24, md: 28, lg: 36 };

/**
 * 圓形頭像（無圖片，顯示首字）。底色由 user id 對調色盤取模。
 * user 與 userId 皆為空時顯示「未指派」（虛線圓 + 人形圖示）。
 */
export function Avatar({ user, userId, size = 'sm', tooltip = true }) {
  const byId = useUsersById();
  const u = user ?? (userId != null ? byId.get(userId) : undefined);
  const cls = `ui-avatar ui-avatar--${size}`;
  if (!u) {
    const node = createElement(
      'span',
      { className: `${cls} ui-avatar--empty`, role: 'img', 'aria-label': '未指派' },
      createElement(Icon, { name: 'user', size: Math.round(SIZE_PX[size] * 0.55) }),
    );
    return tooltip ? createElement(Tooltip, { content: '未指派' }, node) : node;
  }
  const c = colorForId(u.id);
  const style = {
    '--avatar-bg': `var(--color-tag-${c}-soft)`,
    '--avatar-fg': `var(--color-tag-${c}-text)`,
  };
  const node = createElement(
    'span',
    { className: cls, style: style, role: 'img', 'aria-label': u.displayName },
    initialOf(u.displayName),
  );
  return tooltip ? createElement(Tooltip, { content: u.displayName }, node) : node;
}

/** 重疊頭像群組：超過 max 個顯示 +N */
export function AvatarGroup({ users, max = 3, size = 'sm' }) {
  const shown = users.slice(0, max);
  const rest = users.length - shown.length;
  return createElement(
    'span',
    { className: 'ui-avatar-group' },
    shown.map((u) => createElement(Avatar, { key: u.id, user: u, size: size })),
    rest > 0 &&
      createElement(
        Tooltip,
        {
          content: users
            .slice(max)
            .map((u) => u.displayName)
            .join('、'),
        },
        createElement(
          'span',
          { className: `ui-avatar ui-avatar--${size}`, 'aria-label': `另外 ${rest} 人` },
          '+',
          rest,
        ),
      ),
  );
}
