import { createElement, Fragment } from 'preact';
import { useDraggable } from '../../lib/dnd.js';
import { FEEDBACK_KIND_LABELS } from '../../shared/feedback.js';
import { isOverdue } from '../../lib/format.js';
import { useUsersById } from '../../lib/hooks.js';
import { Avatar, Badge, Button, Icon, Menu, UpdatedAt } from '../../ui/index.js';
import { monthDay } from '../calendar/dates.js';
import { handleItemKey, itemMenu, kindTone, useFeedbackActions } from './actions.js';

/** ⋯ 圖示（core Icon 無此圖形，於本 feature 內自備） */
export function MoreIcon() {
  return createElement(
    'svg',
    {
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'currentColor',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    createElement('circle', { cx: '5', cy: '12', r: '1.6' }),
    createElement('circle', { cx: '12', cy: '12', r: '1.6' }),
    createElement('circle', { cx: '19', cy: '12', r: '1.6' }),
  );
}

/** 解決圈：一次點擊標記已解決 / 重新開啟 */
function ResolveToggle({ item }) {
  const actions = useFeedbackActions();
  const resolved = item.status === 'resolved';
  return createElement(
    'button',
    {
      type: 'button',
      className: 'fb-resolve',
      'data-resolved': resolved || undefined,
      'aria-label': resolved ? `重新開啟「${item.title}」` : `標記「${item.title}」為已解決`,
      'aria-pressed': resolved,
      onClick: (e) => {
        e.stopPropagation();
        actions.toggleResolved(item);
      },
      onPointerDown: (e) => e.stopPropagation(),
    },
    resolved && createElement(Icon, { name: 'check', size: 12, strokeWidth: 2.5 }),
  );
}

/** 卡片內容（清單卡片與拖曳浮層共用） */
export function FeedbackCardBody({ item, interactive = true }) {
  const actions = useFeedbackActions();
  const usersById = useUsersById();
  const assignee = item.assigneeId != null ? usersById.get(item.assigneeId) : undefined;
  const resolved = item.status === 'resolved';
  return createElement(
    Fragment,
    null,
    interactive
      ? createElement(ResolveToggle, { item: item })
      : createElement('span', { className: 'fb-resolve', 'aria-hidden': 'true' }),
    createElement(
      'div',
      { className: 'fb-card-main' },
      createElement(
        'div',
        { className: 'fb-card-title-row' },
        createElement(Badge, { tone: kindTone(item.kind) }, FEEDBACK_KIND_LABELS[item.kind]),
        createElement('span', { className: 'fb-card-title' }, item.title),
      ),
      createElement(
        'div',
        { className: 'fb-card-meta' },
        createElement(Avatar, { user: assignee, size: 'xs', tooltip: false }),
        createElement('span', { className: 'fb-card-assignee' }, assignee?.displayName ?? '未指派'),
        item.scheduledDate &&
          item.status !== 'open' &&
          createElement(
            Fragment,
            null,
            createElement('span', { 'aria-hidden': 'true' }, '·'),
            createElement(
              'span',
              {
                className: 'fb-card-date',
                'data-overdue': (!resolved && isOverdue(item.scheduledDate)) || undefined,
                'aria-label': `排程 ${item.scheduledDate}`,
              },
              monthDay(item.scheduledDate),
            ),
          ),
        createElement('span', { 'aria-hidden': 'true' }, '·'),
        interactive
          ? createElement(
              'span',
              { onClick: (e) => e.stopPropagation(), onPointerDown: (e) => e.stopPropagation() },
              createElement(UpdatedAt, { at: item.updatedAt, by: item.updatedBy }),
            )
          : createElement(UpdatedAt, { at: item.updatedAt, by: item.updatedBy }),
      ),
    ),
    interactive &&
      createElement(
        'span',
        {
          className: 'fb-card-more',
          onClick: (e) => e.stopPropagation(),
          onPointerDown: (e) => e.stopPropagation(),
          onKeyDown: (e) => e.stopPropagation(),
        },
        createElement(Menu, {
          align: 'end',
          label: '項目動作',
          items: itemMenu(item, actions),
          trigger: (props) =>
            createElement(Button, {
              ...props,
              variant: 'ghost',
              size: 'sm',
              iconOnly: true,
              icon: createElement(MoreIcon, null),
              'aria-label': `「${item.title}」的更多動作`,
            }),
        }),
      ),
  );
}

/** 清單項目卡：整張可拖曳（已解決除外），點擊開啟編輯 */
export function FeedbackCard({ item }) {
  const actions = useFeedbackActions();
  const resolved = item.status === 'resolved';
  const data = { item, source: 'list' };
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `card-${item.id}`,
    data,
    disabled: resolved,
  });
  const onKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cards = [...document.querySelectorAll('[data-fb-card]')];
      const i = cards.indexOf(e.currentTarget);
      cards[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && handleItemKey(e.key, item, actions)) {
      e.preventDefault();
      return;
    }
    listeners?.onKeyDown?.(e);
  };
  return createElement(
    'div',
    {
      ref: (node) => {
        setNodeRef(node);
        setActivatorNodeRef(node);
      },
      ...attributes,
      ...listeners,
      role: 'button',
      tabIndex: 0,
      'aria-roledescription': resolved ? '項目' : '可拖曳項目',
      'aria-disabled': undefined,
      'aria-label': `${FEEDBACK_KIND_LABELS[item.kind]}：${item.title}`,
      'data-fb-card': '',
      'data-testid': `fb-card-${item.id}`,
      className: 'fb-card',
      'data-resolved': resolved || undefined,
      'data-dragging': isDragging || undefined,
      onKeyDown: onKeyDown,
      onClick: () => actions.edit(item),
    },
    createElement(FeedbackCardBody, { item: item }),
  );
}
