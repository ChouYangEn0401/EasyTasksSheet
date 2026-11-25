import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { DelayChain, DelayChainNode } from '../../../shared/dependencies.ts';
import { statusStyle, statusTone } from '../../lib/colors.ts';
import { hasActiveFilters } from '../../lib/filters.ts';
import { useStatusesById, useUsersById } from '../../lib/hooks.ts';
import { openTask } from '../../lib/openTask.ts';
import { readStorage, useMediaQuery, writeStorage } from '../../lib/storage.ts';
import { useTaskFilters } from '../../lib/useTaskFilters.ts';
import { NoFilterResults } from '../../shell/FilterBar.tsx';
import { ViewTabsActions } from '../../shell/ViewTabs.tsx';
import { Avatar, Checkbox, EmptyState, ErrorState, Icon, Skeleton } from '../../ui/index.ts';
import { useDelayChains } from './api.ts';
import {
  DEFAULT_LAYOUT,
  layoutChain,
  navTarget,
  relatives,
  stackedOrder,
  type NavKey,
} from './delayLinkLayout.ts';
import { chainCaption, chainsSummary, lagLabel, nodeBadge, shortDate } from './depText.ts';
import './delayLink.css';

const INCLUDE_DONE_KEY = 'ts.delayLink.includeDone';
const NAV_KEYS = new Set<string>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/**
 * 延遲鏈（/tasks/delay-link）：誰在等誰完成的整條鏈（docs/design/delay-link.md）。
 * 每條鏈一張卡片，由左到右依層數分欄，箭頭從前置任務指向等待中的任務；最長延遲路徑以強調色標示。
 * 目的是讓大家看見依賴與安排，不是追究誰：用中性語氣與琥珀色，不用紅色。
 */
export function DelayLinkPage() {
  const { filters } = useTaskFilters();
  const [includeDone, setIncludeDone] = useState(() => readStorage(INCLUDE_DONE_KEY) === '1');
  const q = useDelayChains(filters, includeDone);
  const narrow = useMediaQuery('(max-width: 768px)');

  const controls = (
    <ViewTabsActions>
      <Checkbox
        label="顯示已完成的前置任務"
        checked={includeDone}
        onChange={(e) => {
          setIncludeDone(e.target.checked);
          writeStorage(INCLUDE_DONE_KEY, e.target.checked ? '1' : null);
        }}
      />
    </ViewTabsActions>
  );

  let body;
  if (q.isPending) {
    body = (
      <div className="dl-list" aria-busy="true" aria-label="載入延遲鏈中">
        {[0, 1].map((i) => (
          <div key={i} className="dl-chain">
            <Skeleton height={16} width="40%" />
            <div className="mt-3 flex gap-6">
              {[0, 1, 2].map((j) => (
                <Skeleton key={j} height={96} width={200} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  } else if (q.isError && !q.data) {
    body = <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  } else {
    const chains = q.data?.chains ?? [];
    const today = q.data?.today ?? '';
    if (chains.length === 0) {
      body = hasActiveFilters(filters) ? (
        <NoFilterResults />
      ) : (
        <EmptyState
          icon="link"
          title="目前沒有依賴關係"
          description="在任務詳情的「依賴」加入前置任務，就能在這裡看到整條鏈"
        />
      );
    } else {
      body = (
        <>
          <p className="dl-summary" aria-live="polite" data-testid="dl-summary">
            {chainsSummary(chains)}
          </p>
          <div className="dl-list">
            {chains.map((c) => (
              <ChainCard key={c.id} chain={c} today={today} narrow={narrow} />
            ))}
          </div>
        </>
      );
    }
  }

  return (
    <section className="dl-page" aria-label="延遲鏈">
      {controls}
      {body}
    </section>
  );
}

function ChainCard({ chain, today, narrow }: { chain: DelayChain; today: string; narrow: boolean }) {
  const layout = useMemo(() => layoutChain(chain.nodes, chain.edges), [chain.nodes, chain.edges]);
  const byId = useMemo(() => new Map(chain.nodes.map((n) => [n.id, n])), [chain.nodes]);
  const [hover, setHover] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number>(() => chain.summary.criticalPath[0] ?? chain.nodes[0]!.id);
  const refs = useRef(new Map<number, HTMLButtonElement>());
  const markerId = useId().replace(/:/g, '');
  const titleId = `${markerId}-title`;
  const s = chain.summary;
  const starts = new Set(s.startNodes);
  const hasCritical = s.criticalPath.length > 1;

  const related = useMemo(() => {
    if (hover == null) return null;
    const r = relatives(hover, chain.edges);
    return new Set([hover, ...r.up, ...r.down]);
  }, [hover, chain.edges]);

  const tabbable = byId.has(focusId) ? focusId : chain.nodes[0]!.id;

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: number) => {
    if (!NAV_KEYS.has(e.key)) return;
    e.preventDefault();
    let next: number | null;
    if (narrow) {
      const order = stackedOrder(layout).map((x) => x.id);
      const i = order.indexOf(id);
      next =
        e.key === 'ArrowDown' || e.key === 'ArrowRight'
          ? (order[i + 1] ?? null)
          : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
            ? (order[i - 1] ?? null)
            : e.key === 'Home'
              ? (order[0] ?? null)
              : (order[order.length - 1] ?? null);
    } else next = navTarget(layout, chain.edges, id, e.key as NavKey);
    if (next != null) {
      setFocusId(next);
      setHover(next);
      refs.current.get(next)?.focus();
    }
  };

  const nodeProps = (n: DelayChainNode) => ({
    node: n,
    today,
    isStart: starts.has(n.id),
    dim: related != null && !related.has(n.id),
    highlighted: hover === n.id,
    tabIndex: n.id === tabbable ? 0 : -1,
    blockerTitles: n.blockerIds.map((b) => byId.get(b)?.title ?? `#${b}`),
    ref: (el: HTMLButtonElement | null) => {
      if (el) refs.current.set(n.id, el);
      else refs.current.delete(n.id);
    },
    onHover: (on: boolean) => setHover(on ? n.id : null),
    onFocusNode: () => {
      setFocusId(n.id);
      setHover(n.id);
    },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => onKeyDown(e, n.id),
  });

  const firstTitle = byId.get(s.criticalPath[0] ?? chain.nodes[0]!.id)?.title ?? '';
  return (
    <article className="dl-chain" aria-labelledby={titleId} data-testid="dl-chain">
      <header className="dl-chain-head">
        <h3 id={titleId} className="dl-chain-title">
          {`從「${firstTitle}」開始的依賴鏈`}
        </h3>
        <span className="dl-chain-caption">{chainCaption(s, today)}</span>
      </header>
      {hasCritical && (
        <p className="dl-legend">
          <span className="dl-legend-line" aria-hidden="true" />
          強調的路徑決定了最終完成日
        </p>
      )}
      {narrow ? (
        <ol className="dl-stack" aria-label="依賴鏈（由上而下）">
          {stackedOrder(layout).map(({ id, indent }) => {
            const n = byId.get(id)!;
            return (
              <li
                key={id}
                className={`dl-stack-item${indent === 0 ? ' is-root' : ''}`}
                style={{ '--dl-indent': indent } as CSSProperties}
              >
                <NodeCard {...nodeProps(n)} stacked />
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="dl-canvas-scroll" onMouseLeave={() => setHover(null)}>
          <div className="dl-canvas" style={{ width: layout.width, height: layout.height }}>
            <svg
              className="dl-edges"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
              focusable="false"
            >
              <defs>
                <marker
                  id={`${markerId}-arrow`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="dl-arrowhead" />
                </marker>
                <marker
                  id={`${markerId}-arrow-crit`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="dl-arrowhead dl-arrowhead--crit" />
                </marker>
              </defs>
              {layout.edges.map((e) => {
                const hl = related != null && related.has(e.from) && related.has(e.to);
                const cls = [
                  'dl-edge',
                  e.critical && 'is-critical',
                  !e.active && 'is-inactive',
                  hl && 'is-hl',
                  related != null && !hl && 'is-dim',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <g key={`${e.from}-${e.to}`} className={cls} data-edge={`${e.from}-${e.to}`}>
                    <path d={e.path} markerEnd={`url(#${markerId}-arrow${e.critical ? '-crit' : ''})`} />
                    {e.lagDays > 0 && (
                      <g className="dl-lag" transform={`translate(${e.labelX} ${e.labelY})`}>
                        <rect x={-22} y={-9} width={44} height={18} rx={9} />
                        <text textAnchor="middle" dominantBaseline="central">
                          {lagLabel(e.lagDays)}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
            {layout.nodes.map((p) => {
              const n = byId.get(p.id)!;
              return (
                <div
                  key={p.id}
                  className="dl-node-pos"
                  style={{
                    left: p.x,
                    top: p.y,
                    width: DEFAULT_LAYOUT.nodeWidth,
                    height: DEFAULT_LAYOUT.nodeHeight,
                  }}
                >
                  <NodeCard {...nodeProps(n)} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}

type NodeCardProps = {
  node: DelayChainNode;
  today: string;
  isStart: boolean;
  dim: boolean;
  highlighted: boolean;
  tabIndex: number;
  blockerTitles: string[];
  stacked?: boolean;
  ref: (el: HTMLButtonElement | null) => void;
  onHover: (on: boolean) => void;
  onFocusNode: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
};

function NodeCard(props: NodeCardProps) {
  const { node: n, today, isStart, dim, highlighted, tabIndex, blockerTitles, stacked, ref } = props;
  const statuses = useStatusesById();
  const users = useUsersById();
  const status = statuses.get(n.statusId);
  const badge = nodeBadge(n, today);
  const assignee = n.assigneeId != null ? users.get(n.assigneeId)?.displayName : undefined;
  const planned = n.dueDate ? shortDate(n.dueDate, today) : '未定';
  // 沒有到期日時，預計日已顯示在徽章上，不再重複
  const projected =
    !n.isDone && n.dueDate && n.projectedEnd && n.projectedEnd !== n.dueDate
      ? shortDate(n.projectedEnd, today)
      : null;

  const label = [
    n.title,
    `狀態 ${status?.name ?? '—'}`,
    assignee ? `負責人 ${assignee}` : '未指派',
    `原定 ${planned}`,
    projected ? `預計 ${projected}` : null,
    badge.label,
    isStart ? '目前可立即開始' : null,
    n.criticalDelay ? '在決定最終完成日的路徑上' : null,
    blockerTitles.length ? `等待：${blockerTitles.join('、')}` : null,
  ]
    .filter(Boolean)
    .join('，');

  return (
    <button
      ref={ref}
      type="button"
      className={[
        'dl-node',
        n.criticalDelay && 'is-critical',
        n.isDone && 'is-done',
        n.isBlocked && 'is-blocked',
        dim && 'is-dim',
        highlighted && 'is-hl',
        stacked && 'is-stacked',
      ]
        .filter(Boolean)
        .join(' ')}
      tabIndex={tabIndex}
      aria-label={label}
      data-node-id={n.id}
      onClick={() => openTask(n.id)}
      onMouseEnter={() => props.onHover(true)}
      onMouseLeave={() => props.onHover(false)}
      onFocus={props.onFocusNode}
      onKeyDown={props.onKeyDown}
    >
      <span className="dl-node-top">
        <span className="dl-node-title">{n.title}</span>
      </span>
      <span className="dl-node-meta">
        <Avatar userId={n.assigneeId} size="xs" tooltip={false} />
        <span className="dl-node-status" style={statusStyle(status ? statusTone(status) : 'todo')}>
          <span className="ui-dot" />
          {status?.name ?? '—'}
        </span>
        {n.isBlocked && <Icon name="lock" size={12} className="dl-node-lock" />}
        {isStart && <span className="dl-start-tag">可立即開始</span>}
      </span>
      <span className="dl-node-dates">
        <span>
          原定 {planned}
          {projected && <> → 預計 {projected}</>}
        </span>
        <span className={`dl-badge dl-badge--${badge.tone}`} title={badge.label}>
          {badge.text}
        </span>
      </span>
      {stacked && blockerTitles.length > 0 && (
        <span className="dl-node-wait">等待：{blockerTitles.join('、')}</span>
      )}
    </button>
  );
}
