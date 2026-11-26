import { createElement, Fragment } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/compat';
import { useSearchParams } from '../../lib/router.js';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from '../../shared/audit.js';
import { ApiError } from '../../lib/api.js';
import { useCurrentUser } from '../../lib/auth.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useUsers } from '../../lib/hooks.js';
import { openTask } from '../../lib/openTask.js';
import { useCan } from '../../lib/permissions.js';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  Select,
  Skeleton,
  Spinner,
  Tooltip,
} from '../../ui/index.js';
import { NoPermission } from '../admin/AdminUsersPage.js';
import { useAuditList } from './api.js';
import { ChangeTable } from './ChangeTable.js';
import {
  ACTION_LABELS,
  canShowRevert,
  DEFAULT_FILTERS,
  ENTITY_LABELS,
  entryState,
  hasActiveFilters,
  RANGE_LABELS,
  RANGE_PRESETS,
  readFilters,
  SOURCE_LABELS,
  STATE_LABELS,
  STATE_TONES,
  writeFilters,
} from './model.js';
import { RevertDialog } from './RevertDialog.js';

/** 稽核紀錄（/admin/audit，需 audit.view）。用來回溯原因與還原失誤，而非評比個人。docs/design/audit-log.md */
export function AuditPage() {
  const me = useCurrentUser();
  const allowed = useCan('audit.view');
  if (!me) return null;
  if (!allowed) return createElement(NoPermission, null);
  return createElement(AuditView, null);
}

function AuditView() {
  const [sp, setSp] = useSearchParams();
  const filters = useMemo(() => readFilters(sp), [sp]);
  const focusRaw = Number(sp.get('focus'));
  const focus = Number.isInteger(focusRaw) && focusRaw > 0 ? focusRaw : null;
  const canRevert = useCan('audit.revert');
  // 「今天 / 7 天 / 30 天」以進入頁面的當天為準
  const [now] = useState(() => Date.now());
  const query = useAuditList(focus != null ? { ...DEFAULT_FILTERS, range: 'all' } : filters, now, focus);
  const [expanded, setExpanded] = useState(() => new Set(focus != null ? [focus] : []));
  const [reverting, setReverting] = useState(null);

  const setFilters = (next) => setSp(writeFilters(next), { replace: true });
  const showEntry = (id) => {
    setExpanded(new Set([id]));
    setSp({ focus: String(id) });
  };

  if (query.error instanceof ApiError && query.error.status === 403) return createElement(NoPermission, null);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  const toggle = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  let body;
  if (query.isPending) body = createElement(ListSkeleton, null);
  else if (query.isError && items.length === 0)
    body = createElement(ErrorState, { error: query.error, onRetry: () => void query.refetch() });
  else if (items.length === 0)
    body = createElement(EmptyState, {
      icon: 'inbox',
      title: '這段期間沒有紀錄',
      description: hasActiveFilters(filters) ? '可以調整篩選條件或時間範圍再看看。' : undefined,
      action: hasActiveFilters(filters)
        ? createElement(
            Button,
            { variant: 'secondary', onClick: () => setFilters(DEFAULT_FILTERS) },
            '清除篩選',
          )
        : undefined,
    });
  else
    body = createElement(
      Fragment,
      null,
      createElement(
        'ol',
        { className: 'aud-list adm-card', 'aria-label': '稽核紀錄' },
        items.map((e) =>
          createElement(AuditRow, {
            key: e.id,
            entry: e,
            open: expanded.has(e.id),
            onToggle: () => toggle(e.id),
            canRevert: canRevert,
            onRevert: () => setReverting(e),
            onShow: showEntry,
          }),
        ),
      ),
      createElement(LoadMore, { query: query }),
    );

  return createElement(
    'div',
    { className: 'adm-page aud-page' },
    createElement(
      'p',
      { className: 'aud-intro' },
      createElement(Icon, { name: 'info', size: 16 }),
      createElement('span', null, '列出重要的改動與前後內容，用來回溯與還原，而非評比。'),
    ),
    focus != null
      ? createElement(
          'div',
          { className: 'aud-focus', role: 'status' },
          createElement('span', null, '正在檢視紀錄 #', focus, '（以及更早的紀錄）'),
          createElement(
            Button,
            { variant: 'secondary', size: 'sm', onClick: () => setSp(new URLSearchParams()) },
            '回到全部紀錄',
          ),
        )
      : createElement(FilterBar, { filters: filters, onChange: setFilters }),
    body,
    reverting && createElement(RevertDialog, { entry: reverting, onClose: () => setReverting(null) }),
  );
}

// ── 篩選列 ───────────────────────────────────────────────

function FilterBar({ filters, onChange }) {
  const users = useUsers().data ?? [];
  const [q, setQ] = useState(filters.q);
  const [taskId, setTaskId] = useState(filters.taskId != null ? String(filters.taskId) : '');
  const fromId = useId();
  const toId = useId();
  const latest = useRef(filters);
  useEffect(() => {
    latest.current = filters;
  });

  // 搜尋與任務 ID：停止輸入 300ms 後套用
  useEffect(() => {
    const t = window.setTimeout(() => {
      const id = /^\d+$/.test(taskId.trim()) ? Number(taskId.trim()) : null;
      const cur = latest.current;
      if (q !== cur.q || id !== cur.taskId) onChange({ ...cur, q, taskId: id });
    }, 300);
    return () => window.clearTimeout(t);
  }, [q, taskId, onChange]);

  const set = (patch) => onChange({ ...filters, ...patch });
  const actorOptions = [
    { value: 0, label: '所有人' },
    ...users.map((u) => ({ value: u.id, label: u.displayName + (u.isActive ? '' : '（已停用）') })),
  ];
  const typeOptions = [
    { value: '', label: '所有類型' },
    ...AUDIT_ENTITY_TYPES.map((t) => ({ value: t, label: ENTITY_LABELS[t] })),
  ];
  const actionOptions = [
    { value: '', label: '所有動作' },
    ...AUDIT_ACTIONS.map((a) => ({ value: a, label: ACTION_LABELS[a] })),
  ];
  const revertOptions = [
    { value: 'any', label: '全部狀態' },
    { value: 'yes', label: '可還原' },
    { value: 'no', label: '不可還原 / 已還原' },
  ];

  return createElement(
    'div',
    { className: 'aud-filters', role: 'search', 'aria-label': '篩選稽核紀錄' },
    createElement(
      'div',
      { className: 'aud-range', role: 'group', 'aria-label': '時間範圍' },
      RANGE_PRESETS.map((r) =>
        createElement(
          'button',
          {
            key: r,
            type: 'button',
            className: 'aud-chip',
            'aria-pressed': filters.range === r,
            onClick: () => set({ range: r }),
          },
          RANGE_LABELS[r],
        ),
      ),
      hasActiveFilters(filters) &&
        createElement(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            className: 'aud-clear',
            onClick: () => {
              setQ('');
              setTaskId('');
              onChange(DEFAULT_FILTERS);
            },
          },
          '清除篩選',
        ),
    ),
    filters.range === 'custom' &&
      createElement(
        'div',
        { className: 'aud-dates' },
        createElement('label', { htmlFor: fromId, className: 'aud-date-label' }, '從'),
        createElement(Input, {
          id: fromId,
          type: 'date',
          size: 'sm',
          value: filters.fromDate,
          onChange: (e) => set({ fromDate: e.target.value }),
        }),
        createElement('label', { htmlFor: toId, className: 'aud-date-label' }, '到'),
        createElement(Input, {
          id: toId,
          type: 'date',
          size: 'sm',
          value: filters.toDate,
          onChange: (e) => set({ toDate: e.target.value }),
        }),
      ),
    createElement(
      'div',
      { className: 'aud-filter-row' },
      createElement(Select, {
        className: 'aud-select',
        'aria-label': '操作者',
        options: actorOptions,
        value: filters.actor ?? 0,
        onChange: (v) => set({ actor: v || null }),
        active: filters.actor != null,
      }),
      createElement(Select, {
        className: 'aud-select',
        'aria-label': '類型',
        options: typeOptions,
        value: filters.entityType ?? '',
        onChange: (v) => set({ entityType: v || null }),
        active: filters.entityType != null,
      }),
      createElement(Select, {
        className: 'aud-select',
        'aria-label': '動作',
        options: actionOptions,
        value: filters.action ?? '',
        onChange: (v) => set({ action: v || null }),
        active: filters.action != null,
      }),
      createElement(Select, {
        className: 'aud-select',
        'aria-label': '可否還原',
        options: revertOptions,
        value: filters.revertable,
        onChange: (v) => set({ revertable: v }),
        active: filters.revertable !== 'any',
      }),
      createElement(Input, {
        wrapperClassName: 'aud-search',
        icon: 'search',
        size: 'md',
        placeholder: '搜尋摘要或名稱',
        'aria-label': '搜尋摘要或名稱',
        value: q,
        maxLength: 200,
        onChange: (e) => setQ(e.target.value),
      }),
      createElement(Input, {
        wrapperClassName: 'aud-taskid',
        size: 'md',
        inputMode: 'numeric',
        placeholder: '任務 ID',
        'aria-label': '任務 ID',
        value: taskId,
        onChange: (e) => setTaskId(e.target.value.replace(/[^\d]/g, '')),
      }),
    ),
  );
}

// ── 時間線列 ─────────────────────────────────────────────

function AuditRow({ entry: e, open, onToggle, canRevert, onRevert, onShow }) {
  const panelId = useId();
  const state = entryState(e);
  const actor = { id: e.actorId ?? 0, displayName: e.actorName ?? '系統' };
  return createElement(
    'li',
    { className: 'aud-row', 'data-state': state, 'data-open': open || undefined, 'data-entry-id': e.id },
    createElement(
      'div',
      { className: 'aud-row-main' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'aud-row-toggle',
          'aria-expanded': open,
          'aria-controls': panelId,
          onClick: onToggle,
        },
        createElement(Icon, { name: 'chevronRight', className: 'aud-chevron' }),
        createElement(
          'span',
          { className: 'aud-who' },
          createElement(
            'span',
            { className: 'aud-time' },
            createElement(
              Tooltip,
              { content: formatRelative(e.ts) },
              createElement('time', { dateTime: new Date(e.ts).toISOString() }, formatDateTime(e.ts)),
            ),
          ),
          createElement(
            'span',
            { className: 'aud-actor' },
            createElement(Avatar, { user: actor, size: 'xs', tooltip: false }),
            createElement('span', { className: 'aud-actor-name' }, actor.displayName),
          ),
        ),
        createElement(
          'span',
          { className: 'aud-summary' },
          createElement('span', { className: 'aud-summary-text' }, e.summary),
          createElement(
            'span',
            { className: 'aud-tags' },
            createElement(Badge, { tone: 'neutral' }, ENTITY_LABELS[e.entityType] ?? e.entityType),
            e.source !== 'web' && createElement(Badge, { tone: 'teal' }, SOURCE_LABELS[e.source] ?? e.source),
          ),
        ),
      ),
      createElement(
        'span',
        { className: 'aud-state' },
        createElement(Badge, { tone: STATE_TONES[state] }, STATE_LABELS[state]),
      ),
      createElement(
        'span',
        { className: 'aud-action' },
        canShowRevert(e, canRevert) &&
          createElement(
            Button,
            { size: 'sm', variant: 'secondary', icon: 'refresh', onClick: onRevert },
            '還原',
          ),
      ),
    ),
    open &&
      createElement(
        'div',
        { id: panelId, className: 'aud-panel' },
        createElement(ChangeTable, { changes: e.changes }),
        createElement(
          'div',
          { className: 'aud-meta' },
          state === 'reverted' &&
            createElement(
              'span',
              null,
              '已還原（由 ',
              e.revertedByName ?? '其他成員',
              ' 於 ',
              formatDateTime(e.revertedAt),
              '）',
              e.revertEntryId != null &&
                createElement(
                  Fragment,
                  null,
                  ' · ',
                  createElement(
                    'button',
                    { type: 'button', className: 'aud-link', onClick: () => onShow(e.revertEntryId) },
                    '查看還原紀錄',
                  ),
                ),
            ),
          state === 'locked' && e.note && createElement('span', null, '不可還原：', e.note),
          state === 'revertable' && e.note && createElement('span', null, e.note),
          e.revertOf != null &&
            createElement(
              'span',
              null,
              '這是還原操作 ·',
              ' ',
              createElement(
                'button',
                { type: 'button', className: 'aud-link', onClick: () => onShow(e.revertOf) },
                '查看原本的紀錄',
              ),
            ),
          e.taskId != null &&
            e.entityType === 'task' &&
            createElement(
              'button',
              { type: 'button', className: 'aud-link', onClick: () => openTask(e.taskId) },
              '開啟任務 #',
              e.taskId,
            ),
          e.actorUsername && createElement('span', { className: 'aud-muted' }, '帳號：', e.actorUsername),
        ),
      ),
  );
}

// ── 載入更多（捲到底自動載入） ─────────────────────────────

function LoadMore({ query }) {
  const ref = useRef(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  if (!hasNextPage) return createElement('p', { className: 'aud-end' }, '已經是最早的紀錄');
  return createElement(
    'div',
    { ref: ref, className: 'aud-more' },
    isFetchingNextPage
      ? createElement(Spinner, { size: 16 })
      : createElement(Button, { variant: 'secondary', onClick: () => void fetchNextPage() }, '載入更多'),
  );
}

function ListSkeleton() {
  return createElement(
    'div',
    { className: 'adm-card adm-skeleton', 'aria-busy': 'true', 'aria-label': '載入中' },
    Array.from({ length: 6 }, (_, i) =>
      createElement(
        'div',
        { key: i, className: 'adm-skeleton-row' },
        createElement(Skeleton, { width: 96, height: 12 }),
        createElement(Skeleton, { width: 20, height: 20, className: 'adm-skeleton-avatar' }),
        createElement(
          'div',
          { className: 'adm-skeleton-text' },
          createElement(Skeleton, { width: 260, height: 12 }),
          createElement(Skeleton, { width: 80, height: 10 }),
        ),
      ),
    ),
  );
}
