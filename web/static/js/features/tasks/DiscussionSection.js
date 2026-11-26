import { createElement, Fragment } from 'preact';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/compat';
import { errorMessage } from '../../lib/api.js';
import { useCurrentUser } from '../../lib/auth.js';
import { useUsers } from '../../lib/hooks.js';
import { prefersReducedMotion } from '../../lib/motion.js';
import { useCan } from '../../lib/permissions.js';
import { isEditableTarget } from '../../lib/shortcuts.js';
import { notifySuccess } from '../../lib/toast.js';
import { Button, Dialog, ErrorState, Icon, Skeleton, Tooltip } from '../../ui/index.js';
import { useCommentMutations, useThreads } from './discussionApi.js';
import { DiscussionComposer } from './DiscussionComposer.js';
import { filterThreads, firstUnreadId, isNearBottom, orderThreads, scrollEdges } from './discussionModel.js';
import { PendingList, Thread, layoutThreads } from './DiscussionThread.js';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '未解決' },
  { key: 'mine', label: '與我有關' },
];

let pendingSeq = 0;

const COLLAPSED_KEY = 'tasksheets.discussion.collapsed';
/** 視窗高度 ≤ 此值且使用者沒設定過時，討論區預設收合（內容區才有足夠空間） */
const SHORT_VIEWPORT_PX = 480;

function readCollapsed() {
  try {
    const v = window.localStorage.getItem(COLLAPSED_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

function writeCollapsed(collapsed) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // 無法儲存（隱私模式等）：只影響下次開啟的預設值
  }
}

function initialMode() {
  if (typeof window === 'undefined') return 'normal';
  const stored = readCollapsed();
  if (stored != null) return stored ? 'collapsed' : 'normal';
  return window.innerHeight <= SHORT_VIEWPORT_PX ? 'collapsed' : 'normal';
}

/**
 * 任務抽屜最下方的討論區（docs/design/task-discussion.md）：
 * 固定高度的獨立捲動區（clamp(240px, 42vh, 460px)），輸入框固定在底部；可切換聚焦（全高）或收合。
 */
export function DiscussionSection({ task }) {
  const taskId = task.id;
  const me = useCurrentUser();
  const meId = me?.id ?? null;
  const canWrite = useCan('comments.write');
  const canModerate = useCan('comments.moderate');
  const usersQuery = useUsers();
  const users = useMemo(() => usersQuery.data ?? [], [usersQuery.data]);
  const query = useThreads(taskId);
  const { create, update, remove, resolve, markRead } = useCommentMutations(taskId);

  const [mode, setModeState] = useState(initialMode);
  // 收合 / 展開（不含聚焦模式）記在 localStorage，下次開抽屜沿用
  const setMode = useCallback((next) => {
    setModeState(next);
    if (next !== 'focus') writeCollapsed(next === 'collapsed');
  }, []);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState(() => new Set());
  const [replyTo, setReplyTo] = useState(null);
  const [pending, setPending] = useState([]);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const [newBelow, setNewBelow] = useState(false);
  const scrollRef = useRef(null);
  const composerRef = useRef(null);
  const sectionId = useId();

  const pages = query.data?.pages;
  const threads = useMemo(() => orderThreads(pages ?? []), [pages]);
  const visibleThreads = useMemo(() => filterThreads(threads, filter, meId), [threads, filter, meId]);
  const total = task.commentCount ?? threads.reduce((n, t) => n + 1 + t.replyCount, 0);

  // 未讀分隔線：固定為「進入時」的已讀位置（之後標記已讀也不移動）
  const [enteredReadId, setEnteredReadId] = useState(undefined);
  const serverReadId = pages?.[0]?.lastReadCommentId;
  if (enteredReadId === undefined && pages) setEnteredReadId(serverReadId ?? null);
  const flat = useMemo(() => threads.flatMap((t) => [t, ...t.replies]), [threads]);
  const unreadId = useMemo(
    () => (enteredReadId === undefined ? null : firstUnreadId(flat, enteredReadId, meId)),
    [flat, enteredReadId, meId],
  );
  // 日期分隔線與同作者連續訊息折疊（ui-refresh-2026-11-26 §8）
  const layout = useMemo(
    () => layoutThreads(visibleThreads, { unreadId }),
    [visibleThreads, unreadId],
  );
  // 未讀在收合的回覆中：自動展開該串
  const [autoExpanded, setAutoExpanded] = useState(false);
  if (!autoExpanded && unreadId != null) {
    const owner = threads.find((t) => t.replies.some((r) => r.id === unreadId));
    setAutoExpanded(true);
    if (owner && !expanded.has(owner.id)) setExpanded(new Set(expanded).add(owner.id));
  }

  // ── 捲動 ──
  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setEdges(scrollEdges(el));
    if (isNearBottom(el)) setNewBelow(false);
  }, []);
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
    setNewBelow(false);
  }, []);
  const wasNearBottom = useRef(true);
  const lastMaxId = useRef(null);
  const initialScrolled = useRef(false);

  // 進入時捲到第一則未讀（有分隔線）或最新
  useLayoutEffect(() => {
    if (initialScrolled.current || !pages || enteredReadId === undefined) return;
    const el = scrollRef.current;
    if (!el) return;
    initialScrolled.current = true;
    const target = unreadId != null ? el.querySelector('.disc-unread') : null;
    if (target) el.scrollTop = Math.max(0, target.offsetTop - 8);
    else el.scrollTop = el.scrollHeight;
    wasNearBottom.current = isNearBottom(el);
    updateEdges();
  }, [pages, enteredReadId, unreadId, updateEdges]);

  // 新訊息到達：原本在底部就跟著捲，否則顯示「有新訊息」
  const maxId = flat.reduce((m, c) => Math.max(m, c.id), 0);
  useLayoutEffect(() => {
    const prev = lastMaxId.current;
    lastMaxId.current = maxId;
    if (prev == null || maxId <= prev || !initialScrolled.current) return;
    const newest = flat.find((c) => c.id === maxId);
    const mine = newest?.authorId === meId;
    if (wasNearBottom.current || mine) scrollToBottom();
    else setNewBelow(true);
  }, [maxId, flat, meId, scrollToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (wasNearBottom.current && initialScrolled.current) el.scrollTop = el.scrollHeight;
      updateEdges();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateEdges, query.isPending]);

  // ── 已讀：開啟討論區且有他人新訊息時標記（視窗在前景才算） ──
  const markedUpTo = useRef(0);
  const othersMax = flat.reduce(
    (m, c) => (c.authorId !== meId && c.deletedAt == null ? Math.max(m, c.id) : m),
    0,
  );
  const mutateRead = markRead.mutate;
  useEffect(() => {
    if (!pages) return;
    const known = Math.max(markedUpTo.current, serverReadId ?? 0);
    if (othersMax <= known && !(task.unreadComments ?? 0)) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const t = window.setTimeout(() => {
      markedUpTo.current = Math.max(markedUpTo.current, othersMax);
      mutateRead();
    }, 600);
    return () => window.clearTimeout(t);
  }, [pages, othersMax, serverReadId, task.unreadComments, mutateRead]);

  // ── 聚焦模式：Esc 還原（抽屜的 Esc 關閉之前） ──
  useEffect(() => {
    if (mode !== 'focus') return;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isEditableTarget(e.target) && e.target.closest('.disc-composer, .disc-edit')) {
        // 輸入框內的 Esc 先交給輸入框（取消回覆 / 關閉選單）；沒有用到時才還原
        return;
      }
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      e.stopPropagation();
      setMode('normal');
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [mode, setMode]);

  // ── 動作 ──
  const send = (body, parentId, replyToId, key) => {
    const k = key ?? `p${++pendingSeq}`;
    setPending((list) => [
      ...list.filter((p) => p.key !== k),
      { key: k, body, parentId, replyToId, status: 'sending' },
    ]);
    if (parentId) setExpanded((s) => new Set(s).add(parentId));
    wasNearBottom.current = !parentId || wasNearBottom.current;
    requestAnimationFrame(() => {
      if (!parentId) scrollToBottom();
    });
    // mutateAsync：快速連送多則時每一則的成功 / 失敗都會處理（mutate 的呼叫層回呼只保留最後一次）
    create.mutateAsync({ body, parentId, replyToId }).then(
      () => setPending((list) => list.filter((p) => p.key !== k)),
      (e) =>
        setPending((list) =>
          list.map((p) => (p.key === k ? { ...p, status: 'failed', error: errorMessage(e) } : p)),
        ),
    );
  };

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const env = useMemo(() => {
    const byUsername = new Map(users.map((u) => [u.username.toLowerCase(), u]));
    return {
      taskId,
      meId,
      assigneeId: task.assigneeId,
      canWrite,
      canModerate,
      usersById,
      byUsername,
      usernames: new Set(byUsername.keys()),
      unreadId,
      onReply: (root, target) => {
        setReplyTo({ root, target });
        if (mode === 'collapsed') setMode('normal');
        requestAnimationFrame(() => composerRef.current?.focus());
      },
      onEdit: (id, body) => update.mutateAsync({ id, body }),
      onDelete: (c) => setConfirmDelete(c),
      onResolve: (root, resolved) => {
        setActionError(null);
        resolve.mutateAsync({ id: root.id, resolved }).catch((e) => setActionError(errorMessage(e)));
        if (resolved) setExpanded((s) => new Set([...s].filter((x) => x !== root.id)));
      },
    };
  }, [
    taskId,
    meId,
    task.assigneeId,
    canWrite,
    canModerate,
    users,
    usersById,
    unreadId,
    mode,
    setMode,
    update,
    resolve,
  ]);

  const retry = (p) => send(p.body, p.parentId, p.replyToId, p.key);
  const discard = (p) => setPending((list) => list.filter((x) => x.key !== p.key));
  const rootPending = pending.filter((p) => p.parentId == null);
  const replyLabel = replyTo
    ? `@${usersById.get(replyTo.target.authorId ?? -1)?.displayName ?? '其他成員'}`
    : null;

  let content;
  if (query.isPending)
    content = createElement(
      'div',
      { className: 'disc-loading', 'aria-busy': 'true', 'aria-label': '載入討論中' },
      [0, 1, 2].map((i) =>
        createElement(
          'div',
          { key: i, className: 'disc-skel' },
          createElement(Skeleton, { height: 24, width: 24 }),
          createElement(
            'div',
            { className: 'flex flex-1 flex-col gap-2' },
            createElement(Skeleton, { height: 12, width: '30%' }),
            createElement(Skeleton, { height: 12, width: `${60 + i * 10}%` }),
          ),
        ),
      ),
    );
  else if (query.isError && !pages)
    content = createElement(ErrorState, { error: query.error, onRetry: () => void query.refetch() });
  else if (threads.length === 0 && rootPending.length === 0)
    content = createElement(
      'div',
      { className: 'disc-empty' },
      createElement(
        'span',
        { className: 'disc-empty-icon', 'aria-hidden': 'true' },
        createElement(Icon, { name: 'chat', size: 20 }),
      ),
      createElement('p', { className: 'disc-empty-title' }, '還沒有討論'),
      createElement('p', { className: 'disc-empty-desc' }, '有想法、疑問或筆記，都可以寫在這裡。'),
    );
  else
    content = createElement(
      Fragment,
      null,
      query.hasNextPage &&
        createElement(
          'div',
          { className: 'disc-load-older' },
          createElement(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              loading: query.isFetchingNextPage,
              onClick: () => {
                const el = scrollRef.current;
                const before = el ? el.scrollHeight - el.scrollTop : 0;
                void query.fetchNextPage().then(() =>
                  requestAnimationFrame(() => {
                    if (el) el.scrollTop = el.scrollHeight - before;
                  }),
                );
              },
            },
            '載入更早的討論',
          ),
        ),
      visibleThreads.length === 0 &&
        createElement(
          'p',
          { className: 'disc-filter-empty' },
          filter === 'open' ? '目前沒有未解決的討論。' : '目前沒有與你有關的討論。',
        ),
      visibleThreads.map((t) =>
        createElement(Thread, {
          key: t.id,
          thread: t,
          env: env,
          day: layout.get(t.id)?.day ?? null,
          cont: layout.get(t.id)?.cont ?? false,
          expanded: expanded.has(t.id),
          onToggle: (open) =>
            setExpanded((s) => {
              const n = new Set(s);
              if (open) n.add(t.id);
              else n.delete(t.id);
              return n;
            }),
          pending: pending.filter((p) => p.parentId === t.id),
          onRetry: retry,
          onDiscard: discard,
        }),
      ),
      createElement(PendingList, { items: rootPending, onRetry: retry, onDiscard: discard }),
    );

  return createElement(
    'section',
    {
      className: 'disc',
      'data-mode': mode,
      'data-empty': (!!pages && threads.length === 0 && pending.length === 0) || undefined,
      'aria-labelledby': `${sectionId}-title`,
    },
    createElement(
      'header',
      { className: 'disc-head' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'disc-title',
          id: `${sectionId}-title`,
          'aria-expanded': mode !== 'collapsed',
          onClick: () => setMode(mode === 'collapsed' ? 'normal' : 'collapsed'),
        },
        createElement(Icon, { name: 'chevronDown', size: 14, className: 'disc-title-caret' }),
        createElement('span', null, '討論'),
        total > 0 && createElement('span', { className: 'disc-count' }, total),
      ),
      mode !== 'collapsed' &&
        createElement(
          'div',
          { className: 'disc-filters', role: 'group', 'aria-label': '篩選討論' },
          FILTERS.map((f) =>
            createElement(
              'button',
              {
                key: f.key,
                type: 'button',
                className: 'disc-filter',
                'aria-pressed': filter === f.key,
                onClick: () => setFilter(f.key),
              },
              f.label,
            ),
          ),
        ),
      createElement(
        Tooltip,
        { content: mode === 'focus' ? '還原（Esc）' : '展開討論區', placement: 'bottom' },
        createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          iconOnly: true,
          icon: mode === 'focus' ? createElement(CollapseIcon, null) : createElement(ExpandIcon, null),
          'aria-label': mode === 'focus' ? '還原討論區大小' : '展開討論區',
          'aria-pressed': mode === 'focus',
          onClick: () => setMode(mode === 'focus' ? 'normal' : 'focus'),
        }),
      ),
    ),
    mode !== 'collapsed' &&
      createElement(
        Fragment,
        null,
        createElement(
          'div',
          {
            className: 'disc-scroll-wrap',
            'data-shadow-top': edges.top || undefined,
            'data-shadow-bottom': edges.bottom || undefined,
          },
          createElement(
            'div',
            {
              ref: scrollRef,
              className: 'disc-scroll scroll-soft',
              role: 'log',
              'aria-label': '討論訊息',
              tabIndex: 0,
              onScroll: () => {
                const el = scrollRef.current;
                if (!el) return;
                wasNearBottom.current = isNearBottom(el);
                updateEdges();
              },
            },
            content,
          ),
          newBelow &&
            createElement(
              'button',
              { type: 'button', className: 'disc-new-below', onClick: () => scrollToBottom(true) },
              createElement(Icon, { name: 'chevronDown', size: 14 }),
              '有新訊息',
            ),
        ),
        actionError &&
          createElement(
            'div',
            { className: 'disc-action-error', role: 'alert' },
            actionError,
            createElement(Button, {
              variant: 'ghost',
              size: 'sm',
              iconOnly: true,
              icon: 'x',
              'aria-label': '關閉',
              onClick: () => setActionError(null),
            }),
          ),
        canWrite
          ? createElement(DiscussionComposer, {
              ref: composerRef,
              taskId: taskId,
              users: users,
              replyLabel: replyLabel,
              onCancelReply: () => setReplyTo(null),
              onSend: (body) => {
                const r = replyTo;
                setReplyTo(null);
                send(body, r?.root.id ?? null, r && r.target.id !== r.root.id ? r.target.id : null);
              },
            })
          : createElement(
              'div',
              { className: 'disc-readonly' },
              createElement(Icon, { name: 'info', size: 14 }),
              '你目前可以閱讀討論，但沒有留言的權限；需要的話請洽管理者。',
            ),
      ),
    createElement(
      Dialog,
      {
        open: confirmDelete != null,
        onClose: () => setConfirmDelete(null),
        role: 'alertdialog',
        title: '刪除這則訊息？',
        actions: createElement(
          Fragment,
          null,
          createElement(
            Button,
            { variant: 'secondary', onClick: () => setConfirmDelete(null), 'data-autofocus': true },
            '取消',
          ),
          createElement(
            Button,
            {
              variant: 'danger',
              loading: remove.isPending,
              onClick: () =>
                confirmDelete &&
                remove.mutate(confirmDelete.id, {
                  onSuccess: () => {
                    setConfirmDelete(null);
                    notifySuccess('已刪除訊息');
                  },
                }),
            },
            '刪除',
          ),
        ),
      },
      createElement('p', { className: 'm-0' }, '刪除後會顯示「此訊息已刪除」，討論串中的其他回覆會保留。'),
    ),
  );
}

function ExpandIcon() {
  return createElement(
    'svg',
    { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    createElement('path', {
      d: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7',
      stroke: 'currentColor',
      strokeWidth: '1.5',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
}

function CollapseIcon() {
  return createElement(
    'svg',
    { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    createElement('path', {
      d: 'M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7',
      stroke: 'currentColor',
      strokeWidth: '1.5',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
}
