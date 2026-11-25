import type { PresenceMember } from '../../../shared/presence.ts';
import type { PublicUser } from '../../../shared/users.ts';
import { openTask } from '../../lib/openTask.ts';
import { describeMember, STATUS_LABEL } from '../../lib/presence.ts';
import { PresenceAvatar } from './PresenceAvatar.tsx';

/**
 * hover / focus 時的小卡片：「晴恩 · 正在看「甘特圖」 · 剛剛」。
 * 有任務時任務名稱可點擊開啟；閒置時另顯示「最後打開：…」。
 */
export function PresenceCard({
  user,
  member,
  now,
  onDone,
}: {
  user: Pick<PublicUser, 'id' | 'displayName'>;
  member: PresenceMember;
  now: number;
  onDone?: () => void;
}) {
  const text = describeMember(member, now);
  const e = member.status !== 'offline' ? member.entity : null;
  return (
    <div className="pr-card" role="group" aria-label={`${user.displayName} 的動態`}>
      <div className="pr-card-head">
        <PresenceAvatar user={user} member={member} size="md" />
        <div className="pr-card-who">
          <span className="pr-card-name">{user.displayName}</span>
          <span className="pr-card-status" data-status={member.status}>
            {STATUS_LABEL[member.status]}
            {text.when && ` · ${text.when}`}
          </span>
        </div>
      </div>
      <PresenceLine member={member} text={text.doing} onOpen={onDone} />
      {text.lastOpened && <p className="pr-card-sub">{text.lastOpened}</p>}
      {e && member.view && member.status === 'online' && (
        <p className="pr-card-sub">在「{member.view}」頁面</p>
      )}
    </div>
  );
}

/** 動態主句；有任務時為可點擊的連結樣式按鈕（開啟該任務） */
export function PresenceLine({
  member,
  text,
  onOpen,
}: {
  member: PresenceMember;
  text: string;
  onOpen?: () => void;
}) {
  const e = member.status !== 'offline' ? member.entity : null;
  if (!e) return <p className="pr-line">{text}</p>;
  return (
    <p className="pr-line">
      <button
        type="button"
        className="pr-task-link"
        data-mode={e.mode}
        onClick={() => {
          onOpen?.();
          openTask(e.id);
        }}
      >
        {e.mode === 'editing' && <span className="pr-pencil" aria-hidden="true" />}
        {text}
      </button>
    </p>
  );
}
