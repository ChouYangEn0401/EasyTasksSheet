import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, type AuditEntry } from '../../../shared/audit.ts';
import { ApiError } from '../../lib/api.ts';
import { useCurrentUser } from '../../lib/auth.ts';
import { formatDateTime, formatRelative } from '../../lib/format.ts';
import { useUsers } from '../../lib/hooks.ts';
import { openTask } from '../../lib/openTask.ts';
import { useCan } from '../../lib/permissions.ts';
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
} from '../../ui/index.ts';
import { NoPermission } from '../admin/AdminUsersPage.tsx';
import { useAuditList } from './api.ts';
import { ChangeTable } from './ChangeTable.tsx';
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
  type AuditFilters,
} from './model.ts';
import { RevertDialog } from './RevertDialog.tsx';
import '../admin/admin.css';
import './audit.css';

/** 稽核紀錄（/admin/audit，需 audit.view）。用來回溯原因與還原失誤，而非評比個人。docs/design/audit-log.md */
export function AuditPage() {
  const me = useCurrentUser();
  const allowed = useCan('audit.view');
  if (!me) return null;
  if (!allowed) return <NoPermission />;
  return <AuditView />;
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
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set(focus != null ? [focus] : []));
  const [reverting, setReverting] = useState<AuditEntry | null>(null);

  const setFilters = (next: AuditFilters) => setSp(writeFilters(next), { replace: true });
  const showEntry = (id: number) => {
    setExpanded(new Set([id]));
    setSp({ focus: String(id) });
  };

  if (query.error instanceof ApiError && query.error.status === 403) return <NoPermission />;
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  let body;
  if (query.isPending) body = <ListSkeleton />;
  else if (query.isError && items.length === 0)
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (items.length === 0)
    body = (
      <EmptyState
        icon="inbox"
        title="這段期間沒有紀錄"
        description={hasActiveFilters(filters) ? '可以調整篩選條件或時間範圍再看看。' : undefined}
        action={
          hasActiveFilters(filters) ? (
            <Button variant="secondary" onClick={() => setFilters(DEFAULT_FILTERS)}>
              清除篩選
            </Button>
          ) : undefined
        }
      />
    );
  else
    body = (
      <>
        <ol className="aud-list adm-card" aria-label="稽核紀錄">
          {items.map((e) => (
            <AuditRow
              key={e.id}
              entry={e}
              open={expanded.has(e.id)}
              onToggle={() => toggle(e.id)}
              canRevert={canRevert}
              onRevert={() => setReverting(e)}
              onShow={showEntry}
            />
          ))}
        </ol>
        <LoadMore query={query} />
      </>
    );

  return (
    <div className="adm-page aud-page">
      <p className="aud-intro">
        <Icon name="info" size={16} />
        <span>列出重要的改動與前後內容，用來回溯與還原，而非評比。</span>
      </p>
      {focus != null ? (
        <div className="aud-focus" role="status">
          <span>正在檢視紀錄 #{focus}（以及更早的紀錄）</span>
          <Button variant="secondary" size="sm" onClick={() => setSp(new URLSearchParams())}>
            回到全部紀錄
          </Button>
        </div>
      ) : (
        <FilterBar filters={filters} onChange={setFilters} />
      )}
      {body}
      {reverting && <RevertDialog entry={reverting} onClose={() => setReverting(null)} />}
    </div>
  );
}

// ── 篩選列 ───────────────────────────────────────────────

function FilterBar({ filters, onChange }: { filters: AuditFilters; onChange: (f: AuditFilters) => void }) {
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

  const set = (patch: Partial<AuditFilters>) => onChange({ ...filters, ...patch });
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

  return (
    <div className="aud-filters" role="search" aria-label="篩選稽核紀錄">
      <div className="aud-range" role="group" aria-label="時間範圍">
        {RANGE_PRESETS.map((r) => (
          <button
            key={r}
            type="button"
            className="aud-chip"
            aria-pressed={filters.range === r}
            onClick={() => set({ range: r })}
          >
            {RANGE_LABELS[r]}
          </button>
        ))}
        {hasActiveFilters(filters) && (
          <Button
            variant="ghost"
            size="sm"
            className="aud-clear"
            onClick={() => {
              setQ('');
              setTaskId('');
              onChange(DEFAULT_FILTERS);
            }}
          >
            清除篩選
          </Button>
        )}
      </div>
      {filters.range === 'custom' && (
        <div className="aud-dates">
          <label htmlFor={fromId} className="aud-date-label">
            從
          </label>
          <Input
            id={fromId}
            type="date"
            size="sm"
            value={filters.fromDate}
            onChange={(e) => set({ fromDate: e.target.value })}
          />
          <label htmlFor={toId} className="aud-date-label">
            到
          </label>
          <Input
            id={toId}
            type="date"
            size="sm"
            value={filters.toDate}
            onChange={(e) => set({ toDate: e.target.value })}
          />
        </div>
      )}
      <div className="aud-filter-row">
        <Select
          className="aud-select"
          aria-label="操作者"
          options={actorOptions}
          value={filters.actor ?? 0}
          onChange={(v) => set({ actor: v || null })}
          active={filters.actor != null}
        />
        <Select
          className="aud-select"
          aria-label="類型"
          options={typeOptions}
          value={filters.entityType ?? ''}
          onChange={(v) => set({ entityType: (v || null) as AuditFilters['entityType'] })}
          active={filters.entityType != null}
        />
        <Select
          className="aud-select"
          aria-label="動作"
          options={actionOptions}
          value={filters.action ?? ''}
          onChange={(v) => set({ action: (v || null) as AuditFilters['action'] })}
          active={filters.action != null}
        />
        <Select
          className="aud-select"
          aria-label="可否還原"
          options={revertOptions}
          value={filters.revertable}
          onChange={(v) => set({ revertable: v as AuditFilters['revertable'] })}
          active={filters.revertable !== 'any'}
        />
        <Input
          wrapperClassName="aud-search"
          icon="search"
          size="md"
          placeholder="搜尋摘要或名稱"
          aria-label="搜尋摘要或名稱"
          value={q}
          maxLength={200}
          onChange={(e) => setQ(e.target.value)}
        />
        <Input
          wrapperClassName="aud-taskid"
          size="md"
          inputMode="numeric"
          placeholder="任務 ID"
          aria-label="任務 ID"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value.replace(/[^\d]/g, ''))}
        />
      </div>
    </div>
  );
}

// ── 時間線列 ─────────────────────────────────────────────

function AuditRow({
  entry: e,
  open,
  onToggle,
  canRevert,
  onRevert,
  onShow,
}: {
  entry: AuditEntry;
  open: boolean;
  onToggle: () => void;
  canRevert: boolean;
  onRevert: () => void;
  onShow: (id: number) => void;
}) {
  const panelId = useId();
  const state = entryState(e);
  const actor = { id: e.actorId ?? 0, displayName: e.actorName ?? '系統' };
  return (
    <li className="aud-row" data-state={state} data-open={open || undefined} data-entry-id={e.id}>
      <div className="aud-row-main">
        <button
          type="button"
          className="aud-row-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <Icon name="chevronRight" className="aud-chevron" />
          <span className="aud-who">
            <span className="aud-time">
              <Tooltip content={formatRelative(e.ts)}>
                <time dateTime={new Date(e.ts).toISOString()}>{formatDateTime(e.ts)}</time>
              </Tooltip>
            </span>
            <span className="aud-actor">
              <Avatar user={actor} size="xs" tooltip={false} />
              <span className="aud-actor-name">{actor.displayName}</span>
            </span>
          </span>
          <span className="aud-summary">
            <span className="aud-summary-text">{e.summary}</span>
            <span className="aud-tags">
              <Badge tone="neutral">{ENTITY_LABELS[e.entityType] ?? e.entityType}</Badge>
              {e.source !== 'web' && <Badge tone="teal">{SOURCE_LABELS[e.source] ?? e.source}</Badge>}
            </span>
          </span>
        </button>
        <span className="aud-state">
          <Badge tone={STATE_TONES[state]}>{STATE_LABELS[state]}</Badge>
        </span>
        <span className="aud-action">
          {canShowRevert(e, canRevert) && (
            <Button size="sm" variant="secondary" icon="refresh" onClick={onRevert}>
              還原
            </Button>
          )}
        </span>
      </div>
      {open && (
        <div id={panelId} className="aud-panel">
          <ChangeTable changes={e.changes} />
          <div className="aud-meta">
            {state === 'reverted' && (
              <span>
                已還原（由 {e.revertedByName ?? '其他成員'} 於 {formatDateTime(e.revertedAt!)}）
                {e.revertEntryId != null && (
                  <>
                    {' · '}
                    <button type="button" className="aud-link" onClick={() => onShow(e.revertEntryId!)}>
                      查看還原紀錄
                    </button>
                  </>
                )}
              </span>
            )}
            {state === 'locked' && e.note && <span>不可還原：{e.note}</span>}
            {state === 'revertable' && e.note && <span>{e.note}</span>}
            {e.revertOf != null && (
              <span>
                這是還原操作 ·{' '}
                <button type="button" className="aud-link" onClick={() => onShow(e.revertOf!)}>
                  查看原本的紀錄
                </button>
              </span>
            )}
            {e.taskId != null && e.entityType === 'task' && (
              <button type="button" className="aud-link" onClick={() => openTask(e.taskId!)}>
                開啟任務 #{e.taskId}
              </button>
            )}
            {e.actorUsername && <span className="aud-muted">帳號：{e.actorUsername}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

// ── 載入更多（捲到底自動載入） ─────────────────────────────

function LoadMore({ query }: { query: ReturnType<typeof useAuditList> }) {
  const ref = useRef<HTMLDivElement>(null);
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
  if (!hasNextPage) return <p className="aud-end">已經是最早的紀錄</p>;
  return (
    <div ref={ref} className="aud-more">
      {isFetchingNextPage ? (
        <Spinner size={16} />
      ) : (
        <Button variant="secondary" onClick={() => void fetchNextPage()}>
          載入更多
        </Button>
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="adm-card adm-skeleton" aria-busy="true" aria-label="載入中">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="adm-skeleton-row">
          <Skeleton width={96} height={12} />
          <Skeleton width={20} height={20} className="adm-skeleton-avatar" />
          <div className="adm-skeleton-text">
            <Skeleton width={260} height={12} />
            <Skeleton width={80} height={10} />
          </div>
        </div>
      ))}
    </div>
  );
}
