import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PublicUser } from '../../../shared/users.ts';
import { errorMessage } from '../../lib/api.ts';
import { formatDateTime, formatRelative } from '../../lib/format.ts';
import { Avatar, Button, Menu, Textarea, Tooltip } from '../../ui/index.ts';
import { fetchOlderReplies } from './discussionApi.ts';
import {
  BODY_MAX,
  REPLIES_SHOWN,
  mergeReplies,
  shouldCollapse,
  tokenizeBody,
  type CommentThread,
  type TaskComment,
} from './discussionModel.ts';

/** 討論區共用的環境（由 DiscussionSection 提供） */
export type DiscussionEnv = {
  taskId: number;
  meId: number | null;
  assigneeId: number | null;
  canWrite: boolean;
  canModerate: boolean;
  usersById: Map<number, PublicUser>;
  usernames: ReadonlySet<string>;
  byUsername: Map<string, PublicUser>;
  unreadId: number | null;
  onReply: (root: CommentThread, target: TaskComment) => void;
  onEdit: (id: number, body: string) => Promise<unknown>;
  onDelete: (c: TaskComment) => void;
  onResolve: (root: CommentThread, resolved: boolean) => void;
};

export type PendingMessage = {
  key: string;
  body: string;
  parentId: number | null;
  replyToId: number | null;
  status: 'sending' | 'failed';
  error?: string;
};

const nameOf = (env: DiscussionEnv, id: number | null) =>
  (id != null ? env.usersById.get(id)?.displayName : undefined) ?? '其他成員';

/** 相對時間；hover / focus 顯示絕對時間 */
function MsgTime({ at, edited }: { at: number; edited: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const full = formatDateTime(at) + (edited ? ` · 已於 ${formatDateTime(edited)} 編輯` : '');
  return (
    <Tooltip content={full}>
      <time className="disc-time" dateTime={new Date(at).toISOString()} tabIndex={0} aria-label={full}>
        {formatRelative(at, Math.max(now, at))}
      </time>
    </Tooltip>
  );
}

/** 純文字內容：@提及顯示為淡色晶片、網址自動連結（不渲染 HTML） */
export function MessageBody({ body, env }: { body: string; env: DiscussionEnv }) {
  const segments = useMemo(() => tokenizeBody(body, env.usernames), [body, env.usernames]);
  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === 'text') return <span key={i}>{s.text}</span>;
        if (s.kind === 'link')
          return (
            <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className="disc-link">
              {s.text}
            </a>
          );
        const u = env.byUsername.get(s.username);
        const isMe = u?.id === env.meId;
        return (
          <span
            key={i}
            className={`disc-mention${isMe ? ' disc-mention--me' : ''}`}
            title={u ? `${u.displayName}（${u.username}）` : undefined}
          >
            @{u?.displayName ?? s.username}
          </span>
        );
      })}
    </>
  );
}

function CollapsibleBody({ body, env }: { body: string; env: DiscussionEnv }) {
  const long = shouldCollapse(body);
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="disc-body" data-clamped={long && !open ? 'true' : undefined}>
        <MessageBody body={body} env={env} />
      </div>
      {long && (
        <button type="button" className="disc-textbtn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收合' : '展開全文'}
        </button>
      )}
    </>
  );
}

function EditBox({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (body: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);
  const trimmed = value.trim();
  const save = () => {
    if (!trimmed || trimmed.length > BODY_MAX || saving) return;
    if (trimmed === initial.trim()) return onCancel();
    setSaving(true);
    setError(null);
    onSave(trimmed).then(onCancel, (e: unknown) => {
      setSaving(false);
      setError(errorMessage(e));
    });
  };
  return (
    <div className="disc-edit">
      <Textarea
        ref={ref}
        value={value}
        rows={2}
        aria-label="編輯訊息"
        className="disc-edit-input"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="disc-edit-actions">
        {error && <span className="disc-error">{error}</span>}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" variant="primary" loading={saving} disabled={!trimmed} onClick={save}>
          儲存
        </Button>
      </div>
    </div>
  );
}

/** 單則訊息（根訊息或回覆） */
function Message({
  c,
  env,
  thread,
  isRoot,
  tools,
  actions,
}: {
  c: TaskComment;
  env: DiscussionEnv;
  thread: CommentThread;
  isRoot: boolean;
  /** 滑鼠移入 / 聚焦時出現在右上角的動作（回覆、標記已解決） */
  tools?: ReactNode;
  /** 訊息下方的列（例如「N 則回覆」） */
  actions?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const deleted = c.deletedAt != null;
  const mine = c.authorId != null && c.authorId === env.meId;
  const canDelete = !deleted && env.canWrite && (mine || env.canModerate);
  const canEdit = !deleted && mine && env.canWrite;
  const replyTo = c.replyToId != null && c.replyToId !== thread.id ? findComment(thread, c.replyToId) : null;
  const menuItems = [
    ...(canEdit ? [{ key: 'edit', label: '編輯', onSelect: () => setEditing(true) }] : []),
    ...(canDelete
      ? [
          {
            key: 'delete',
            label: mine ? '刪除' : '刪除（管理）',
            danger: true,
            onSelect: () => env.onDelete(c),
          },
        ]
      : []),
  ];
  return (
    <>
      {env.unreadId === c.id && (
        <div className="disc-unread" role="separator" aria-label="以下為未讀訊息">
          <span>未讀</span>
        </div>
      )}
      <div
        className={`disc-msg${isRoot ? ' disc-msg--root' : ' disc-msg--reply'}${deleted ? ' is-deleted' : ''}`}
        data-comment-id={c.id}
        id={`disc-msg-${c.id}`}
      >
        <span className="disc-avatar">
          {deleted ? (
            <span className="disc-avatar-ghost" aria-hidden="true" />
          ) : (
            <Avatar userId={c.authorId} size={isRoot ? 'sm' : 'xs'} tooltip={false} />
          )}
        </span>
        <div className="disc-msg-main">
          <div className="disc-meta">
            {!deleted && <span className="disc-author">{nameOf(env, c.authorId)}</span>}
            {!deleted && <MsgTime at={c.createdAt} edited={c.editedAt} />}
            {!deleted && c.editedAt != null && <span className="disc-edited">已編輯</span>}
            {!editing && (tools || menuItems.length > 0) && (
              <span className="disc-msg-tools">
                {tools}
                {menuItems.length > 0 && (
                  <Menu
                    align="end"
                    width={140}
                    label="訊息動作"
                    trigger={(p) => (
                      <Button {...p} variant="ghost" size="sm" iconOnly icon="more" aria-label="訊息動作" />
                    )}
                    items={menuItems}
                  />
                )}
              </span>
            )}
          </div>
          {replyTo && !deleted && (
            <div className="disc-replyto">
              回覆 <span className="disc-mention">@{nameOf(env, replyTo.authorId)}</span>
            </div>
          )}
          {deleted ? (
            <div className="disc-body disc-body--deleted">此訊息已刪除</div>
          ) : editing ? (
            <EditBox
              initial={c.body}
              onSave={(b) => env.onEdit(c.id, b)}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <CollapsibleBody body={c.body} env={env} />
          )}
          {actions}
        </div>
      </div>
    </>
  );
}

function findComment(t: CommentThread, id: number): TaskComment | null {
  if (t.id === id) return t;
  return t.replies.find((r) => r.id === id) ?? null;
}

function PendingRow({
  p,
  onRetry,
  onDiscard,
}: {
  p: PendingMessage;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className={`disc-msg disc-msg--pending${p.parentId ? ' disc-msg--reply' : ' disc-msg--root'}`}>
      <span className="disc-avatar">
        <span className="disc-avatar-ghost" aria-hidden="true" />
      </span>
      <div className="disc-msg-main">
        <div className="disc-body">{p.body}</div>
        <div className="disc-pending-state" aria-live="polite">
          {p.status === 'sending' ? (
            '傳送中…'
          ) : (
            <span className="disc-error">
              {p.error ?? '傳送失敗'} ·{' '}
              <button type="button" className="disc-textbtn" onClick={onRetry}>
                重試
              </button>{' '}
              ·{' '}
              <button type="button" className="disc-textbtn" onClick={onDiscard}>
                捨棄
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function PendingList({
  items,
  onRetry,
  onDiscard,
}: {
  items: PendingMessage[];
  onRetry: (p: PendingMessage) => void;
  onDiscard: (p: PendingMessage) => void;
}) {
  return (
    <>
      {items.map((p) => (
        <PendingRow key={p.key} p={p} onRetry={() => onRetry(p)} onDiscard={() => onDiscard(p)} />
      ))}
    </>
  );
}

/**
 * 討論串：根訊息 + 回覆（預設收合，只顯示「N 則回覆」）。展開後串內最多顯示最新 5 則，
 * 「顯示更早的回覆」先展開已載入的，再向後端載入更早的。已解決的串淡化並預設收合。
 */
export function Thread({
  thread,
  env,
  expanded,
  onToggle,
  pending,
  onRetry,
  onDiscard,
}: {
  thread: CommentThread;
  env: DiscussionEnv;
  expanded: boolean;
  onToggle: (open: boolean) => void;
  pending: PendingMessage[];
  onRetry: (p: PendingMessage) => void;
  onDiscard: (p: PendingMessage) => void;
}) {
  const resolved = thread.threadResolvedAt != null;
  const [showResolved, setShowResolved] = useState(false);
  const [older, setOlder] = useState<TaskComment[]>([]);
  const [shown, setShown] = useState(REPLIES_SHOWN);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const all = mergeReplies(older, thread.replies);
  const visible = all.slice(Math.max(0, all.length - shown));
  const hiddenLoaded = all.length - visible.length;
  // 尚未載入的較早回覆（回覆總數含已刪除，API 也會回傳已刪除的回覆）
  const remainingServer = Math.max(0, thread.replyCount - all.length);
  const hiddenCount = hiddenLoaded + remainingServer;
  const mine = thread.authorId != null && thread.authorId === env.meId;
  const canResolve =
    env.canWrite && (mine || env.canModerate || (env.assigneeId != null && env.assigneeId === env.meId));
  const collapsedResolved = resolved && !showResolved;

  const showOlder = () => {
    if (hiddenLoaded > 0) {
      setShown((n) => n + 10);
      return;
    }
    setLoading(true);
    setLoadError(null);
    fetchOlderReplies(env.taskId, thread.id, all[0]?.id).then(
      (res) => {
        setOlder((prev) => mergeReplies(res.replies, prev));
        setShown((n) => n + res.replies.length);
        setLoading(false);
      },
      (e: unknown) => {
        setLoading(false);
        setLoadError(errorMessage(e));
      },
    );
  };

  const latestReply = all[all.length - 1];
  // 回覆 / 標記已解決：滑鼠移入或聚焦時出現在訊息右上角，平常不佔版面
  const rootTools = (
    <>
      {env.canWrite && !collapsedResolved && (
        <button type="button" className="disc-tool" onClick={() => env.onReply(thread, thread)}>
          回覆
        </button>
      )}
      {canResolve && (
        <Tooltip content={resolved ? '重新開啟討論串' : '標記為已解決'}>
          <button
            type="button"
            className="disc-tool disc-tool--icon"
            aria-label={resolved ? '重新開啟' : '標記為已解決'}
            onClick={() => env.onResolve(thread, !resolved)}
          >
            {resolved ? <ReopenIcon /> : <CheckIcon />}
          </button>
        </Tooltip>
      )}
    </>
  );
  // 訊息下方只留「N 則回覆」
  const actions =
    thread.replyCount > 0 && !collapsedResolved ? (
      <div className="disc-thread-actions">
        <button
          type="button"
          className="disc-action disc-action--count"
          aria-expanded={expanded}
          onClick={() => onToggle(!expanded)}
        >
          {expanded ? '收合回覆' : `${thread.replyCount} 則回覆`}
          {!expanded && latestReply && (
            <span className="disc-action-sub"> · 最後回覆 {formatRelative(latestReply.createdAt)}</span>
          )}
        </button>
      </div>
    ) : null;

  return (
    <article
      className="disc-thread"
      data-resolved={resolved || undefined}
      data-collapsed-resolved={collapsedResolved || undefined}
      aria-label={`${nameOf(env, thread.authorId)} 的討論串${resolved ? '（已解決）' : ''}`}
    >
      {resolved && (
        <div className="disc-resolved-bar">
          <span className="disc-resolved-tag">
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path
                d="M20 6L9 17l-5-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            已解決
          </span>
          <span className="disc-resolved-by">
            {nameOf(env, thread.threadResolvedBy)} · {formatRelative(thread.threadResolvedAt ?? 0)}
          </span>
          <button
            type="button"
            className="disc-textbtn"
            aria-expanded={showResolved}
            onClick={() => setShowResolved(!showResolved)}
          >
            {showResolved ? '收合' : thread.replyCount > 0 ? `展開（${thread.replyCount} 則回覆）` : '展開'}
          </button>
        </div>
      )}
      <Message c={thread} env={env} thread={thread} isRoot tools={rootTools} actions={actions} />
      {expanded && !collapsedResolved && (all.length > 0 || pending.length > 0) && (
        <div className="disc-replies">
          {hiddenCount > 0 && (
            <button
              type="button"
              className="disc-textbtn disc-older-replies"
              onClick={showOlder}
              disabled={loading}
            >
              {loading ? '載入中…' : `顯示更早的回覆（${hiddenCount}）`}
            </button>
          )}
          {loadError && <div className="disc-error">{loadError}</div>}
          {visible.map((r) => (
            <Message
              key={r.id}
              c={r}
              env={env}
              thread={thread}
              isRoot={false}
              tools={
                env.canWrite && r.deletedAt == null ? (
                  <button type="button" className="disc-tool" onClick={() => env.onReply(thread, r)}>
                    回覆
                  </button>
                ) : null
              }
            />
          ))}
          <PendingList items={pending} onRetry={onRetry} onDiscard={onDiscard} />
        </div>
      )}
    </article>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4L12 14l-3-3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReopenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
