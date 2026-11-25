import type { Task } from '../../../shared/tasks.ts';
import { useCurrentUser } from '../../lib/auth.ts';
import { formatDateTime } from '../../lib/format.ts';
import { useUsersById } from '../../lib/hooks.ts';
import { useCan } from '../../lib/permissions.ts';
import { notifySuccess } from '../../lib/toast.ts';
import { Button, Icon, Tooltip } from '../../ui/index.ts';
import { useOptimisticUpdate } from './data.ts';
import './discussion.css';

/*
 * 描述鎖定（docs/design/task-discussion.md §鎖定）：PM 派發任務後可鎖定描述，避免誤改；
 * 成員的補充與筆記寫在下方討論區。鎖定不是不信任，語氣保持中性、親切。
 */

/** 描述區標題列右側的鎖頭按鈕（有 tasks.lock 才可切換；其他人鎖定時只顯示狀態圖示） */
export function DescriptionLockButton({ task }: { task: Task }) {
  const canLock = useCan('tasks.lock');
  const update = useOptimisticUpdate();
  const me = useCurrentUser();
  const locked = !!task.descriptionLocked;
  if (!canLock) {
    if (!locked) return null;
    return (
      <Tooltip content="描述已鎖定；有補充請寫在下方討論區">
        <span className="lock-toggle" role="img" aria-label="已鎖定" tabIndex={0}>
          <Icon name="lock" size={14} />
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={locked ? '解除鎖定，讓成員也能修改描述' : '鎖定後，成員無法修改描述，只能在討論區留言'}>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon="lock"
        className="lock-btn"
        aria-pressed={locked}
        aria-label={locked ? '解除鎖定' : '鎖定（避免誤改）'}
        onClick={() =>
          update.mutate(
            { id: task.id, patch: { descriptionLocked: !locked }, userId: me?.id },
            { onSuccess: () => notifySuccess(locked ? '已解除描述鎖定' : '已鎖定描述') },
          )
        }
      />
    </Tooltip>
  );
}

/** 鎖定時顯示在描述上方的淡色提示條 */
export function DescriptionLockBanner({ task }: { task: Task }) {
  const byId = useUsersById();
  const canLock = useCan('tasks.lock');
  if (!task.descriptionLocked) return null;
  const who = task.lockedBy != null ? (byId.get(task.lockedBy)?.displayName ?? '管理者') : '管理者';
  const when = task.lockedAt != null ? ` 於 ${formatDateTime(task.lockedAt)}` : '';
  return (
    <div className="lock-banner" role="note">
      <Icon name="lock" size={14} />
      <span>
        <strong>描述已鎖定</strong>（由 {who}
        {when}）。
        {canLock ? '你仍可以修改；成員的補充會寫在下方討論區。' : '有補充或筆記，歡迎寫在下方討論區。'}
      </span>
    </div>
  );
}
