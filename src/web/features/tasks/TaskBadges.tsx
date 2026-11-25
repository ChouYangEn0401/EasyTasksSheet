import type { Task } from '../../../shared/tasks.ts';
import { Icon, Tooltip } from '../../ui/index.ts';
import './discussion.css';

/**
 * 清單列與看板卡片標題旁的小徽章：描述鎖定（鎖頭）、討論留言數（有未讀時加強調色小圓點）。
 * 不擠壓標題（flex: none、字級 11px）；沒有內容時不輸出任何節點。
 */
export function TaskBadges({
  task,
}: {
  task: Pick<Task, 'commentCount' | 'unreadComments' | 'descriptionLocked'>;
}) {
  const count = task.commentCount ?? 0;
  const unread = task.unreadComments ?? 0;
  const locked = !!task.descriptionLocked;
  if (!count && !locked) return null;
  return (
    <span className="task-badges">
      {locked && (
        <Tooltip content="描述已鎖定">
          <span className="task-badge task-badge--lock" role="img" aria-label="描述已鎖定">
            <Icon name="lock" size={12} />
          </span>
        </Tooltip>
      )}
      {count > 0 && (
        <Tooltip content={unread > 0 ? `${count} 則討論，${unread} 則未讀` : `${count} 則討論`}>
          <span
            className="task-badge task-badge--comments"
            data-unread={unread > 0 || undefined}
            role="img"
            aria-label={unread > 0 ? `${count} 則討論，${unread} 則未讀` : `${count} 則討論`}
          >
            <Icon name="chat" size={12} />
            {count}
            {unread > 0 && <span className="task-badge-dot" aria-hidden="true" />}
          </span>
        </Tooltip>
      )}
    </span>
  );
}
