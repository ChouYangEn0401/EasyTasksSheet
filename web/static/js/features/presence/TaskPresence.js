import { createElement, Fragment } from 'preact';
import { useCurrentUser } from '../../lib/auth.js';
import { useUsersById } from '../../lib/hooks.js';
import { taskHintText } from '../../lib/presence.js';
import { PresenceAvatar } from './PresenceAvatar.js';
import { useOthersOnTask } from './usePresence.js';

/** TaskDrawer 內的小提示條：其他人也在看 / 正在編輯同一個任務時出現 */
export function TaskPresenceHint({ taskId }) {
  const me = useCurrentUser();
  const others = useOthersOnTask(taskId, me?.id ?? null);
  const usersById = useUsersById();
  const known = others.filter((m) => usersById.has(m.userId));
  if (!known.length) return null;
  const editing = known.some((m) => m.entity?.mode === 'editing');
  const text = taskHintText(known, (id) => usersById.get(id).displayName);
  return createElement(
    'div',
    { className: 'pr-hint', 'data-editing': editing || undefined, role: 'status' },
    createElement(
      'span',
      { className: 'pr-hint-avatars' },
      known
        .slice(0, 3)
        .map((m) =>
          createElement(PresenceAvatar, {
            key: m.userId,
            user: usersById.get(m.userId),
            member: m,
            size: 'xs',
          }),
        ),
    ),
    createElement('span', { className: 'pr-hint-text' }, text),
  );
}

/** 清單列與看板卡片上的小頭像：有他人 viewing / editing 時顯示（最多 2 個 + 數字），編輯中微脈動 */
export function TaskPresenceDots({ taskId }) {
  const me = useCurrentUser();
  const others = useOthersOnTask(taskId, me?.id ?? null);
  const usersById = useUsersById();
  const known = others.filter((m) => usersById.has(m.userId));
  if (!known.length) return null;
  const label = taskHintText(known, (id) => usersById.get(id).displayName);
  const shown = known.slice(0, 2);
  return createElement(
    'span',
    { className: 'pr-dots', role: 'img', 'aria-label': label, title: label },
    shown.map((m) =>
      createElement(
        'span',
        { key: m.userId, className: 'pr-mini', 'data-mode': m.entity?.mode },
        createElement(PresenceAvatar, {
          user: usersById.get(m.userId),
          member: { status: 'offline' },
          size: 'xs',
        }),
      ),
    ),
    known.length > shown.length &&
      createElement('span', { className: 'pr-mini-more' }, '+', known.length - shown.length),
  );
}
