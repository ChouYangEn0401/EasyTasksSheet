import { createElement, Fragment } from 'preact';
import { openTask } from '../../lib/openTask.js';
import { describeMember, STATUS_LABEL } from '../../lib/presence.js';
import { PresenceAvatar } from './PresenceAvatar.js';

/**
 * hover / focus 時的小卡片：「晴恩 · 正在看「甘特圖」 · 剛剛」。
 * 有任務時任務名稱可點擊開啟；閒置時另顯示「最後打開：…」。
 */
export function PresenceCard({ user, member, now, onDone }) {
  const text = describeMember(member, now);
  const e = member.status !== 'offline' ? member.entity : null;
  return createElement(
    'div',
    { className: 'pr-card', role: 'group', 'aria-label': `${user.displayName} 的動態` },
    createElement(
      'div',
      { className: 'pr-card-head' },
      createElement(PresenceAvatar, { user: user, member: member, size: 'md' }),
      createElement(
        'div',
        { className: 'pr-card-who' },
        createElement('span', { className: 'pr-card-name' }, user.displayName),
        createElement(
          'span',
          { className: 'pr-card-status', 'data-status': member.status },
          STATUS_LABEL[member.status],
          text.when && ` · ${text.when}`,
        ),
      ),
    ),
    createElement(PresenceLine, { member: member, text: text.doing, onOpen: onDone }),
    text.lastOpened && createElement('p', { className: 'pr-card-sub' }, text.lastOpened),
    e &&
      member.view &&
      member.status === 'online' &&
      createElement('p', { className: 'pr-card-sub' }, '在「', member.view, '」頁面'),
  );
}

/** 動態主句；有任務時為可點擊的連結樣式按鈕（開啟該任務） */
export function PresenceLine({ member, text, onOpen }) {
  const e = member.status !== 'offline' ? member.entity : null;
  if (!e) return createElement('p', { className: 'pr-line' }, text);
  return createElement(
    'p',
    { className: 'pr-line' },
    createElement(
      'button',
      {
        type: 'button',
        className: 'pr-task-link',
        'data-mode': e.mode,
        onClick: () => {
          onOpen?.();
          openTask(e.id);
        },
      },
      e.mode === 'editing' && createElement('span', { className: 'pr-pencil', 'aria-hidden': 'true' }),
      text,
    ),
  );
}
