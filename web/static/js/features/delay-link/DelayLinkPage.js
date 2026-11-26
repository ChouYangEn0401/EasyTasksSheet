import { createElement, Fragment } from 'preact';
import { useId, useMemo, useRef, useState } from 'preact/compat';
import { statusStyle, statusTone } from '../../lib/colors.js';
import { hasActiveFilters } from '../../lib/filters.js';
import { useStatusesById, useUsersById } from '../../lib/hooks.js';
import { openTask } from '../../lib/openTask.js';
import { readStorage, useMediaQuery, writeStorage } from '../../lib/storage.js';
import { useTaskFilters } from '../../lib/useTaskFilters.js';
import { NoFilterResults } from '../../shell/FilterBar.js';
import { ViewTabsActions } from '../../shell/ViewTabs.js';
import { Avatar, Checkbox, EmptyState, ErrorState, Icon, Skeleton } from '../../ui/index.js';
import { useDelayChains } from './api.js';
import { DEFAULT_LAYOUT, layoutChain, navTarget, relatives, stackedOrder } from './delayLinkLayout.js';
import { chainCaption, chainsSummary, lagLabel, nodeBadge, shortDate } from './depText.js';

const INCLUDE_DONE_KEY = 'ts.delayLink.includeDone';
const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

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

  const controls = createElement(
    ViewTabsActions,
    null,
    createElement(Checkbox, {
      label: '顯示已完成的前置任務',
      checked: includeDone,
      onChange: (e) => {
        setIncludeDone(e.target.checked);
        writeStorage(INCLUDE_DONE_KEY, e.target.checked ? '1' : null);
      },
    }),
  );

  let body;
  if (q.isPending) {
    body = createElement(
      'div',
      { className: 'dl-list', 'aria-busy': 'true', 'aria-label': '載入延遲鏈中' },
      [0, 1].map((i) =>
        createElement(
          'div',
          { key: i, className: 'dl-chain' },
          createElement(Skeleton, { height: 16, width: '40%' }),
          createElement(
            'div',
            { className: 'mt-3 flex gap-6' },
            [0, 1, 2].map((j) => createElement(Skeleton, { key: j, height: 96, width: 200 })),
          ),
        ),
      ),
    );
  } else if (q.isError && !q.data) {
    body = createElement(ErrorState, { error: q.error, onRetry: () => void q.refetch() });
  } else {
    const chains = q.data?.chains ?? [];
    const today = q.data?.today ?? '';
    if (chains.length === 0) {
      body = hasActiveFilters(filters)
        ? createElement(NoFilterResults, null)
        : createElement(EmptyState, {
            icon: 'link',
            title: '目前沒有依賴關係',
            description: '在任務詳情的「依賴」加入前置任務，就能在這裡看到整條鏈',
          });
    } else {
      body = createElement(
        Fragment,
        null,
        createElement(
          'p',
          { className: 'dl-summary', 'aria-live': 'polite', 'data-testid': 'dl-summary' },
          chainsSummary(chains),
        ),
        createElement(
          'div',
          { className: 'dl-list' },
          chains.map((c) => createElement(ChainCard, { key: c.id, chain: c, today: today, narrow: narrow })),
        ),
      );
    }
  }

  return createElement('section', { className: 'dl-page', 'aria-label': '延遲鏈' }, controls, body);
}

function ChainCard({ chain, today, narrow }) {
  const layout = useMemo(() => layoutChain(chain.nodes, chain.edges), [chain.nodes, chain.edges]);
  const byId = useMemo(() => new Map(chain.nodes.map((n) => [n.id, n])), [chain.nodes]);
  const [hover, setHover] = useState(null);
  const [focusId, setFocusId] = useState(() => chain.summary.criticalPath[0] ?? chain.nodes[0].id);
  const refs = useRef(new Map());
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

  const tabbable = byId.has(focusId) ? focusId : chain.nodes[0].id;

  const onKeyDown = (e, id) => {
    if (!NAV_KEYS.has(e.key)) return;
    e.preventDefault();
    let next;
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
    } else next = navTarget(layout, chain.edges, id, e.key);
    if (next != null) {
      setFocusId(next);
      setHover(next);
      refs.current.get(next)?.focus();
    }
  };

  const nodeProps = (n) => ({
    node: n,
    today,
    isStart: starts.has(n.id),
    dim: related != null && !related.has(n.id),
    highlighted: hover === n.id,
    tabIndex: n.id === tabbable ? 0 : -1,
    blockerTitles: n.blockerIds.map((b) => byId.get(b)?.title ?? `#${b}`),
    nodeRef: (el) => {
      if (el) refs.current.set(n.id, el);
      else refs.current.delete(n.id);
    },
    onHover: (on) => setHover(on ? n.id : null),
    onFocusNode: () => {
      setFocusId(n.id);
      setHover(n.id);
    },
    onKeyDown: (e) => onKeyDown(e, n.id),
  });

  const firstTitle = byId.get(s.criticalPath[0] ?? chain.nodes[0].id)?.title ?? '';
  return createElement(
    'article',
    { className: 'dl-chain', 'aria-labelledby': titleId, 'data-testid': 'dl-chain' },
    createElement(
      'header',
      { className: 'dl-chain-head' },
      createElement('h3', { id: titleId, className: 'dl-chain-title' }, `從「${firstTitle}」開始的依賴鏈`),
      createElement('span', { className: 'dl-chain-caption' }, chainCaption(s, today)),
    ),
    hasCritical &&
      createElement(
        'p',
        { className: 'dl-legend' },
        createElement('span', { className: 'dl-legend-line', 'aria-hidden': 'true' }),
        '強調的路徑決定了最終完成日',
      ),
    narrow
      ? createElement(
          'ol',
          { className: 'dl-stack', 'aria-label': '依賴鏈（由上而下）' },
          stackedOrder(layout).map(({ id, indent }) => {
            const n = byId.get(id);
            return createElement(
              'li',
              {
                key: id,
                className: `dl-stack-item${indent === 0 ? ' is-root' : ''}`,
                style: { '--dl-indent': indent },
              },
              createElement(NodeCard, { ...nodeProps(n), stacked: true }),
            );
          }),
        )
      : createElement(
          'div',
          { className: 'dl-canvas-scroll', onMouseLeave: () => setHover(null) },
          createElement(
            'div',
            { className: 'dl-canvas', style: { width: layout.width, height: layout.height } },
            createElement(
              'svg',
              {
                className: 'dl-edges',
                width: layout.width,
                height: layout.height,
                'aria-hidden': 'true',
                focusable: 'false',
              },
              createElement(
                'defs',
                null,
                createElement(
                  'marker',
                  {
                    id: `${markerId}-arrow`,
                    viewBox: '0 0 10 10',
                    refX: '9',
                    refY: '5',
                    markerWidth: '7',
                    markerHeight: '7',
                    orient: 'auto-start-reverse',
                  },
                  createElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', className: 'dl-arrowhead' }),
                ),
                createElement(
                  'marker',
                  {
                    id: `${markerId}-arrow-crit`,
                    viewBox: '0 0 10 10',
                    refX: '9',
                    refY: '5',
                    markerWidth: '7',
                    markerHeight: '7',
                    orient: 'auto-start-reverse',
                  },
                  createElement('path', {
                    d: 'M 0 0 L 10 5 L 0 10 z',
                    className: 'dl-arrowhead dl-arrowhead--crit',
                  }),
                ),
              ),
              layout.edges.map((e) => {
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
                return createElement(
                  'g',
                  { key: `${e.from}-${e.to}`, className: cls, 'data-edge': `${e.from}-${e.to}` },
                  createElement('path', {
                    d: e.path,
                    markerEnd: `url(#${markerId}-arrow${e.critical ? '-crit' : ''})`,
                  }),
                  e.lagDays > 0 &&
                    createElement(
                      'g',
                      { className: 'dl-lag', transform: `translate(${e.labelX} ${e.labelY})` },
                      createElement('rect', { x: -22, y: -9, width: 44, height: 18, rx: 9 }),
                      createElement(
                        'text',
                        { textAnchor: 'middle', dominantBaseline: 'central' },
                        lagLabel(e.lagDays),
                      ),
                    ),
                );
              }),
            ),
            layout.nodes.map((p) => {
              const n = byId.get(p.id);
              return createElement(
                'div',
                {
                  key: p.id,
                  className: 'dl-node-pos',
                  style: {
                    left: p.x,
                    top: p.y,
                    width: DEFAULT_LAYOUT.nodeWidth,
                    height: DEFAULT_LAYOUT.nodeHeight,
                  },
                },
                createElement(NodeCard, { ...nodeProps(n) }),
              );
            }),
          ),
        ),
  );
}

function NodeCard(props) {
  const { node: n, today, isStart, dim, highlighted, tabIndex, blockerTitles, stacked, nodeRef } = props;
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

  return createElement(
    'button',
    {
      ref: nodeRef,
      type: 'button',
      className: [
        'dl-node',
        n.criticalDelay && 'is-critical',
        n.isDone && 'is-done',
        n.isBlocked && 'is-blocked',
        dim && 'is-dim',
        highlighted && 'is-hl',
        stacked && 'is-stacked',
      ]
        .filter(Boolean)
        .join(' '),
      tabIndex: tabIndex,
      'aria-label': label,
      'data-node-id': n.id,
      onClick: () => openTask(n.id),
      onMouseEnter: () => props.onHover(true),
      onMouseLeave: () => props.onHover(false),
      onFocus: props.onFocusNode,
      onKeyDown: props.onKeyDown,
    },
    createElement(
      'span',
      { className: 'dl-node-top' },
      createElement('span', { className: 'dl-node-title' }, n.title),
    ),
    createElement(
      'span',
      { className: 'dl-node-meta' },
      createElement(Avatar, { userId: n.assigneeId, size: 'xs', tooltip: false }),
      createElement(
        'span',
        { className: 'dl-node-status', style: statusStyle(status ? statusTone(status) : 'todo') },
        createElement('span', { className: 'ui-dot' }),
        status?.name ?? '—',
      ),
      n.isBlocked && createElement(Icon, { name: 'lock', size: 12, className: 'dl-node-lock' }),
      isStart && createElement('span', { className: 'dl-start-tag' }, '可立即開始'),
    ),
    createElement(
      'span',
      { className: 'dl-node-dates' },
      createElement(
        'span',
        null,
        '原定 ',
        planned,
        projected && createElement(Fragment, null, ' → 預計 ', projected),
      ),
      createElement(
        'span',
        { className: `dl-badge dl-badge--${badge.tone}`, title: badge.label },
        badge.text,
      ),
    ),
    stacked &&
      blockerTitles.length > 0 &&
      createElement('span', { className: 'dl-node-wait' }, '等待：', blockerTitles.join('、')),
  );
}
