import { createElement, Fragment } from 'preact';
import { Icon, Tooltip } from '../../ui/index.js';

/**
 * 清單列與看板卡片標題旁的小徽章：描述鎖定（鎖頭）、討論留言數（有未讀時加強調色小圓點）。
 * 不擠壓標題（flex: none、字級 11px）；沒有內容時不輸出任何節點。
 */
export function TaskBadges({ task, part }) {
  const count = part === 'lock' ? 0 : (task.commentCount ?? 0);
  const unread = task.unreadComments ?? 0;
  const locked = part === 'comments' ? false : !!task.descriptionLocked;
  if (!count && !locked) return null;
  return createElement(
    'span',
    { className: 'task-badges' },
    locked &&
      createElement(
        Tooltip,
        { content: '描述已鎖定' },
        createElement(
          'span',
          { className: 'task-badge task-badge--lock', role: 'img', 'aria-label': '描述已鎖定' },
          createElement(Icon, { name: 'lock', size: 12 }),
        ),
      ),
    count > 0 &&
      createElement(
        Tooltip,
        { content: unread > 0 ? `${count} 則討論，${unread} 則未讀` : `${count} 則討論` },
        createElement(
          'span',
          {
            className: 'task-badge task-badge--comments',
            'data-unread': unread > 0 || undefined,
            role: 'img',
            'aria-label': unread > 0 ? `${count} 則討論，${unread} 則未讀` : `${count} 則討論`,
          },
          createElement(Icon, { name: 'chat', size: 12 }),
          count,
          unread > 0 && createElement('span', { className: 'task-badge-dot', 'aria-hidden': 'true' }),
        ),
      ),
  );
}
