import { createElement, Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/compat';
import { errorMessage } from '../../lib/api.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { Avatar, Button, Menu, Textarea, Tooltip } from '../../ui/index.js';
import { fetchOlderReplies } from './discussionApi.js';
import { BODY_MAX, REPLIES_SHOWN, mergeReplies, shouldCollapse, tokenizeBody } from './discussionModel.js';

const nameOf = (env, id) => (id != null ? env.usersById.get(id)?.displayName : undefined) ?? '其他成員';

// ── 版面分組（ui-refresh-2026-11-26 §8）：日期分隔線、同作者 5 分鐘內連續訊息折疊 ──

/** 同一作者、這麼近的連續根訊息折成一組（第二則起不重複頭像與名字） */
export const CONT_WINDOW_MS = 5 * 60_000;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n) => String(n).padStart(2, '0');

function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** 日期分隔線的字：今天／昨天／11/24（一）；跨年加年份 */
export function dayLabel(at, now = Date.now()) {
  if (dayKey(at) === dayKey(now)) return '今天';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dayKey(at) === dayKey(y.getTime())) return '昨天';
  const d = new Date(at);
  const md = `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

/**
 * 依畫面順序（舊→新）算每個討論串的版面：day = 這一串前面要不要插日期分隔線（字）、
 * cont = 根訊息是否接在上一串後面（同作者、5 分鐘內、上一串沒有回覆、兩串都沒解決／沒刪除、不是未讀起點）。
 * 純函式；回傳 Map(threadId → { day, cont })。
 */
export function layoutThreads(threads, { now = Date.now(), unreadId = null } = {}) {
  const out = new Map();
  let prev = null;
  for (const t of threads) {
    const at = t.lastActivityAt ?? t.createdAt;
    const prevAt = prev ? (prev.lastActivityAt ?? prev.createdAt) : null;
    const newDay = prev == null || dayKey(at) !== dayKey(prevAt);
    const cont =
      !newDay &&
      prev != null &&
      t.authorId != null &&
      t.authorId === prev.authorId &&
      t.deletedAt == null &&
      prev.deletedAt == null &&
      t.threadResolvedAt == null &&
      prev.threadResolvedAt == null &&
      (prev.replyCount ?? 0) === 0 &&
      t.id !== unreadId &&
      t.createdAt >= prev.createdAt &&
      t.createdAt - prev.createdAt <= CONT_WINDOW_MS;
    out.set(t.id, { day: newDay ? dayLabel(at, now) : null, cont });
    prev = t;
  }
  return out;
}

/** 折疊訊息左側空位的小時間（14:32；hover／focus 才出現，完整時間在 tooltip） */
function ContTime({ at, edited }) {
  const d = new Date(at);
  const full = formatDateTime(at) + (edited ? ` · 已於 ${formatDateTime(edited)} 編輯` : '');
  return createElement(
    Tooltip,
    { content: full },
    createElement(
      'time',
      { className: 'disc-time disc-cont-time', dateTime: d.toISOString(), tabIndex: 0, 'aria-label': full },
      `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
    ),
  );
}

/** 相對時間；hover / focus 顯示絕對時間 */
function MsgTime({ at, edited }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const full = formatDateTime(at) + (edited ? ` · 已於 ${formatDateTime(edited)} 編輯` : '');
  return createElement(
    Tooltip,
    { content: full },
    createElement(
      'time',
      { className: 'disc-time', dateTime: new Date(at).toISOString(), tabIndex: 0, 'aria-label': full },
      formatRelative(at, Math.max(now, at)),
    ),
  );
}

/** 純文字內容：@提及顯示為淡色晶片、網址自動連結（不渲染 HTML） */
export function MessageBody({ body, env }) {
  const segments = useMemo(() => tokenizeBody(body, env.usernames), [body, env.usernames]);
  return createElement(
    Fragment,
    null,
    segments.map((s, i) => {
      if (s.kind === 'text') return createElement('span', { key: i }, s.text);
      if (s.kind === 'link')
        return createElement(
          'a',
          { key: i, href: s.href, target: '_blank', rel: 'noopener noreferrer', className: 'disc-link' },
          s.text,
        );
      const u = env.byUsername.get(s.username);
      const isMe = u?.id === env.meId;
      return createElement(
        'span',
        {
          key: i,
          className: `disc-mention${isMe ? ' disc-mention--me' : ''}`,
          title: u ? `${u.displayName}（${u.username}）` : undefined,
        },
        '@',
        u?.displayName ?? s.username,
      );
    }),
  );
}

function CollapsibleBody({ body, env }) {
  const long = shouldCollapse(body);
  const [open, setOpen] = useState(false);
  return createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className: 'disc-body', 'data-clamped': long && !open ? 'true' : undefined },
      createElement(MessageBody, { body: body, env: env }),
    ),
    long &&
      createElement(
        'button',
        { type: 'button', className: 'disc-textbtn', 'aria-expanded': open, onClick: () => setOpen(!open) },
        open ? '收合' : '展開全文',
      ),
  );
}

function EditBox({ initial, onSave, onCancel }) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const ref = useRef(null);
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
    onSave(trimmed).then(onCancel, (e) => {
      setSaving(false);
      setError(errorMessage(e));
    });
  };
  return createElement(
    'div',
    { className: 'disc-edit' },
    createElement(Textarea, {
      ref: ref,
      value: value,
      rows: 2,
      'aria-label': '編輯訊息',
      className: 'disc-edit-input',
      onChange: (e) => setValue(e.target.value),
      onKeyDown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          save();
        }
      },
    }),
    createElement(
      'div',
      { className: 'disc-edit-actions' },
      error && createElement('span', { className: 'disc-error' }, error),
      createElement(Button, { size: 'sm', variant: 'ghost', onClick: onCancel }, '取消'),
      createElement(
        Button,
        { size: 'sm', variant: 'primary', loading: saving, disabled: !trimmed, onClick: save },
        '儲存',
      ),
    ),
  );
}

/** 單則訊息（根訊息或回覆） */
function Message({ c, env, thread, isRoot, tools, actions, cont = false }) {
  const [editing, setEditing] = useState(false);
  const deleted = c.deletedAt != null;
  const mine = c.authorId != null && c.authorId === env.meId;
  // 別人訊息裡 @ 到我：整則加左邊框（ui-refresh §8）
  const mentionsMe =
    !deleted && !mine && env.meId != null && Array.isArray(c.mentions) && c.mentions.includes(env.meId);
  const folded = cont && !deleted;
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
  return createElement(
    Fragment,
    null,
    env.unreadId === c.id &&
      createElement(
        'div',
        { className: 'disc-unread', role: 'separator', 'aria-label': '以下為未讀訊息' },
        createElement('span', null, '未讀'),
      ),
    createElement(
      'div',
      {
        className: `disc-msg${isRoot ? ' disc-msg--root' : ' disc-msg--reply'}${deleted ? ' is-deleted' : ''}${folded ? ' disc-msg--cont' : ''}${mentionsMe ? ' disc-msg--mentions-me' : ''}`,
        'data-comment-id': c.id,
        id: `disc-msg-${c.id}`,
      },
      createElement(
        'span',
        { className: 'disc-avatar' },
        deleted
          ? createElement('span', { className: 'disc-avatar-ghost', 'aria-hidden': 'true' })
          : folded
            ? createElement(ContTime, { at: c.createdAt, edited: c.editedAt })
            : createElement(Avatar, { userId: c.authorId, size: isRoot ? 'sm' : 'xs', tooltip: false }),
      ),
      createElement(
        'div',
        { className: 'disc-msg-main' },
        createElement(
          'div',
          { className: `disc-meta${folded ? ' disc-meta--cont' : ''}` },
          // 折疊時名字留給螢幕閱讀器（視覺上隱藏），時間移到左側空位
          !deleted &&
            createElement('span', { className: `disc-author${folded ? ' sr-only' : ''}` }, nameOf(env, c.authorId)),
          !deleted && !folded && createElement(MsgTime, { at: c.createdAt, edited: c.editedAt }),
          !deleted && c.editedAt != null && createElement('span', { className: 'disc-edited' }, '已編輯'),
          !editing &&
            (tools || menuItems.length > 0) &&
            createElement(
              'span',
              { className: 'disc-msg-tools' },
              tools,
              menuItems.length > 0 &&
                createElement(Menu, {
                  align: 'end',
                  width: 140,
                  label: '訊息動作',
                  trigger: (p) =>
                    createElement(Button, {
                      ...p,
                      variant: 'ghost',
                      size: 'sm',
                      iconOnly: true,
                      icon: 'more',
                      'aria-label': '訊息動作',
                    }),
                  items: menuItems,
                }),
            ),
        ),
        replyTo &&
          !deleted &&
          createElement(
            'div',
            { className: 'disc-replyto' },
            '回覆 ',
            createElement('span', { className: 'disc-mention' }, '@', nameOf(env, replyTo.authorId)),
          ),
        deleted
          ? createElement('div', { className: 'disc-body disc-body--deleted' }, '此訊息已刪除')
          : editing
            ? createElement(EditBox, {
                initial: c.body,
                onSave: (b) => env.onEdit(c.id, b),
                onCancel: () => setEditing(false),
              })
            : createElement(CollapsibleBody, { body: c.body, env: env }),
        actions,
      ),
    ),
  );
}

function findComment(t, id) {
  if (t.id === id) return t;
  return t.replies.find((r) => r.id === id) ?? null;
}

function PendingRow({ p, onRetry, onDiscard }) {
  return createElement(
    'div',
    { className: `disc-msg disc-msg--pending${p.parentId ? ' disc-msg--reply' : ' disc-msg--root'}` },
    createElement(
      'span',
      { className: 'disc-avatar' },
      createElement('span', { className: 'disc-avatar-ghost', 'aria-hidden': 'true' }),
    ),
    createElement(
      'div',
      { className: 'disc-msg-main' },
      createElement('div', { className: 'disc-body' }, p.body),
      createElement(
        'div',
        { className: 'disc-pending-state', 'aria-live': 'polite' },
        p.status === 'sending'
          ? '傳送中…'
          : createElement(
              'span',
              { className: 'disc-error' },
              p.error ?? '傳送失敗',
              ' ·',
              ' ',
              createElement(
                'button',
                { type: 'button', className: 'disc-textbtn', onClick: onRetry },
                '重試',
              ),
              ' ',
              '·',
              ' ',
              createElement(
                'button',
                { type: 'button', className: 'disc-textbtn', onClick: onDiscard },
                '捨棄',
              ),
            ),
      ),
    ),
  );
}

export function PendingList({ items, onRetry, onDiscard }) {
  return createElement(
    Fragment,
    null,
    items.map((p) =>
      createElement(PendingRow, {
        key: p.key,
        p: p,
        onRetry: () => onRetry(p),
        onDiscard: () => onDiscard(p),
      }),
    ),
  );
}

/**
 * 討論串：根訊息 + 回覆（預設收合，只顯示「N 則回覆」）。展開後串內最多顯示最新 5 則，
 * 「顯示更早的回覆」先展開已載入的，再向後端載入更早的。已解決的串淡化並預設收合。
 */
export function Thread({ thread, env, expanded, onToggle, pending, onRetry, onDiscard, day = null, cont = false }) {
  const resolved = thread.threadResolvedAt != null;
  const [showResolved, setShowResolved] = useState(false);
  const [older, setOlder] = useState([]);
  const [shown, setShown] = useState(REPLIES_SHOWN);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
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
      (e) => {
        setLoading(false);
        setLoadError(errorMessage(e));
      },
    );
  };

  const latestReply = all[all.length - 1];
  // 回覆 / 標記已解決：滑鼠移入或聚焦時出現在訊息右上角，平常不佔版面
  const rootTools = createElement(
    Fragment,
    null,
    env.canWrite &&
      !collapsedResolved &&
      createElement(
        'button',
        { type: 'button', className: 'disc-tool', onClick: () => env.onReply(thread, thread) },
        '回覆',
      ),
    canResolve &&
      createElement(
        Tooltip,
        { content: resolved ? '重新開啟討論串' : '標記為已解決' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'disc-tool disc-tool--icon',
            'aria-label': resolved ? '重新開啟' : '標記為已解決',
            onClick: () => env.onResolve(thread, !resolved),
          },
          resolved ? createElement(ReopenIcon, null) : createElement(CheckIcon, null),
        ),
      ),
  );
  // 訊息下方只留「N 則回覆」
  const actions =
    thread.replyCount > 0 && !collapsedResolved
      ? createElement(
          'div',
          { className: 'disc-thread-actions' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'disc-action disc-action--count',
              'aria-expanded': expanded,
              onClick: () => onToggle(!expanded),
            },
            expanded ? '收合回覆' : `${thread.replyCount} 則回覆`,
            !expanded &&
              latestReply &&
              createElement(
                'span',
                { className: 'disc-action-sub' },
                ' · 最後回覆 ',
                formatRelative(latestReply.createdAt),
              ),
          ),
        )
      : null;

  const daySep =
    day &&
    createElement(
      'div',
      { className: 'disc-day', role: 'separator', 'aria-label': day },
      createElement('span', null, day),
    );
  return createElement(
    Fragment,
    null,
    daySep,
    createElement(
    'article',
    {
      className: 'disc-thread',
      'data-cont': cont || undefined,
      'data-resolved': resolved || undefined,
      'data-collapsed-resolved': collapsedResolved || undefined,
      'aria-label': `${nameOf(env, thread.authorId)} 的討論串${resolved ? '（已解決）' : ''}`,
    },
    resolved &&
      createElement(
        'div',
        { className: 'disc-resolved-bar' },
        createElement(
          'span',
          { className: 'disc-resolved-tag' },
          createElement(
            'svg',
            { viewBox: '0 0 24 24', width: '12', height: '12', 'aria-hidden': 'true' },
            createElement('path', {
              d: 'M20 6L9 17l-5-5',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: '2',
              strokeLinecap: 'round',
            }),
          ),
          '已解決',
        ),
        createElement(
          'span',
          { className: 'disc-resolved-by' },
          nameOf(env, thread.threadResolvedBy),
          ' · ',
          formatRelative(thread.threadResolvedAt ?? 0),
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: 'disc-textbtn',
            'aria-expanded': showResolved,
            onClick: () => setShowResolved(!showResolved),
          },
          showResolved ? '收合' : thread.replyCount > 0 ? `展開（${thread.replyCount} 則回覆）` : '展開',
        ),
      ),
    createElement(Message, {
      c: thread,
      env: env,
      thread: thread,
      isRoot: true,
      tools: rootTools,
      actions: actions,
      cont: cont,
    }),
    expanded &&
      !collapsedResolved &&
      (all.length > 0 || pending.length > 0) &&
      createElement(
        'div',
        { className: 'disc-replies' },
        hiddenCount > 0 &&
          createElement(
            'button',
            {
              type: 'button',
              className: 'disc-textbtn disc-older-replies',
              onClick: showOlder,
              disabled: loading,
            },
            loading ? '載入中…' : `顯示更早的回覆（${hiddenCount}）`,
          ),
        loadError && createElement('div', { className: 'disc-error' }, loadError),
        visible.map((r) =>
          createElement(Message, {
            key: r.id,
            c: r,
            env: env,
            thread: thread,
            isRoot: false,
            tools:
              env.canWrite && r.deletedAt == null
                ? createElement(
                    'button',
                    { type: 'button', className: 'disc-tool', onClick: () => env.onReply(thread, r) },
                    '回覆',
                  )
                : null,
          }),
        ),
        createElement(PendingList, { items: pending, onRetry: onRetry, onDiscard: onDiscard }),
      ),
    ),
  );
}

function CheckIcon() {
  return createElement(
    'svg',
    { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    createElement('path', {
      d: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4L12 14l-3-3',
      stroke: 'currentColor',
      strokeWidth: '1.7',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
}

function ReopenIcon() {
  return createElement(
    'svg',
    { width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    createElement('path', {
      d: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
      stroke: 'currentColor',
      strokeWidth: '1.7',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
}
