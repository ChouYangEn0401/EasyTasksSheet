import { createElement, Fragment } from 'preact';
import { useCurrentUser } from '../../lib/auth.js';
import { formatDateTime } from '../../lib/format.js';
import { useUsersById } from '../../lib/hooks.js';
import { useCan } from '../../lib/permissions.js';
import { quote } from '../../lib/taskUndoModel.js';
import { notifySuccess } from '../../lib/toast.js';
import { Button, Icon, Tooltip } from '../../ui/index.js';
import { useOptimisticUpdate } from './data.js';

/*
 * 描述鎖定（docs/design/task-discussion.md §鎖定）：PM 派發任務後可鎖定描述，避免誤改；
 * 成員的補充與筆記寫在下方討論區。鎖定不是不信任，語氣保持中性、親切。
 */

/** 描述區標題列右側的鎖頭按鈕（有 tasks.lock 才可切換；其他人鎖定時只顯示狀態圖示） */
export function DescriptionLockButton({ task }) {
  const canLock = useCan('tasks.lock');
  const update = useOptimisticUpdate();
  const me = useCurrentUser();
  const locked = !!task.descriptionLocked;
  if (!canLock) {
    if (!locked) return null;
    return createElement(
      Tooltip,
      { content: '描述已鎖定；有補充請寫在下方討論區' },
      createElement(
        'span',
        { className: 'lock-toggle', role: 'img', 'aria-label': '已鎖定', tabIndex: 0 },
        createElement(Icon, { name: 'lock', size: 14 }),
      ),
    );
  }
  return createElement(
    Tooltip,
    { content: locked ? '解除鎖定，讓成員也能修改描述' : '鎖定後，成員無法修改描述，只能在討論區留言' },
    createElement(Button, {
      variant: 'ghost',
      size: 'sm',
      iconOnly: true,
      icon: 'lock',
      className: 'lock-btn',
      'aria-pressed': locked,
      'aria-label': locked ? '解除鎖定' : '鎖定（避免誤改）',
      onClick: () =>
        void update
          .mutateAsync({
            id: task.id,
            patch: { descriptionLocked: !locked },
            userId: me?.id,
            undo: { label: `${locked ? '解除鎖定' : '鎖定'}${quote(task.title)}的描述` },
          })
          .then(() => notifySuccess(locked ? '已解除描述鎖定' : '已鎖定描述'))
          .catch(() => undefined),
    }),
  );
}

/** 鎖定時顯示在描述上方的淡色提示條 */
export function DescriptionLockBanner({ task }) {
  const byId = useUsersById();
  const canLock = useCan('tasks.lock');
  if (!task.descriptionLocked) return null;
  const who = task.lockedBy != null ? (byId.get(task.lockedBy)?.displayName ?? '管理者') : '管理者';
  const when = task.lockedAt != null ? ` 於 ${formatDateTime(task.lockedAt)}` : '';
  return createElement(
    'div',
    { className: 'lock-banner', role: 'note' },
    createElement(Icon, { name: 'lock', size: 14 }),
    createElement(
      'span',
      null,
      createElement('strong', null, '描述已鎖定'),
      '（由 ',
      who,
      when,
      '）。',
      canLock ? '你仍可以修改；成員的補充會寫在下方討論區。' : '有補充或筆記，歡迎寫在下方討論區。',
    ),
  );
}
