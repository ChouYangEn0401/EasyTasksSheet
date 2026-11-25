import { useCurrentUser } from '../../lib/auth.ts';
import { useUsersById } from '../../lib/hooks.ts';
import { taskHintText } from '../../lib/presence.ts';
import { PresenceAvatar } from './PresenceAvatar.tsx';
import { useOthersOnTask } from './usePresence.ts';
import './presence.css';

/** TaskDrawer 內的小提示條：其他人也在看 / 正在編輯同一個任務時出現 */
export function TaskPresenceHint({ taskId }: { taskId: number }) {
  const me = useCurrentUser();
  const others = useOthersOnTask(taskId, me?.id ?? null);
  const usersById = useUsersById();
  const known = others.filter((m) => usersById.has(m.userId));
  if (!known.length) return null;
  const editing = known.some((m) => m.entity?.mode === 'editing');
  const text = taskHintText(known, (id) => usersById.get(id)!.displayName);
  return (
    <div className="pr-hint" data-editing={editing || undefined} role="status">
      <span className="pr-hint-avatars">
        {known.slice(0, 3).map((m) => (
          <PresenceAvatar key={m.userId} user={usersById.get(m.userId)!} member={m} size="xs" />
        ))}
      </span>
      <span className="pr-hint-text">{text}</span>
    </div>
  );
}

/** 清單列與看板卡片上的小頭像：有他人 viewing / editing 時顯示（最多 2 個 + 數字），編輯中微脈動 */
export function TaskPresenceDots({ taskId }: { taskId: number }) {
  const me = useCurrentUser();
  const others = useOthersOnTask(taskId, me?.id ?? null);
  const usersById = useUsersById();
  const known = others.filter((m) => usersById.has(m.userId));
  if (!known.length) return null;
  const label = taskHintText(known, (id) => usersById.get(id)!.displayName);
  const shown = known.slice(0, 2);
  return (
    <span className="pr-dots" role="img" aria-label={label} title={label}>
      {shown.map((m) => (
        <span key={m.userId} className="pr-mini" data-mode={m.entity?.mode}>
          <PresenceAvatar user={usersById.get(m.userId)!} member={{ status: 'offline' }} size="xs" />
        </span>
      ))}
      {known.length > shown.length && <span className="pr-mini-more">+{known.length - shown.length}</span>}
    </span>
  );
}
