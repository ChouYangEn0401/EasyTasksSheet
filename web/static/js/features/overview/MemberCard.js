import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { Link } from '../../lib/router.js';
import { statusStyle, statusTone } from '../../lib/colors.js';
import { openTask } from '../../lib/openTask.js';
import { Avatar, Badge, Button, Tooltip, UpdatedAt } from '../../ui/index.js';
import { formatHours, shortDate } from './useOverview.js';
import { MemberWeeks } from './WeeksActivity.js';

const DOING_LIMIT = 3;
const CATEGORY_LABEL = { todo: '待辦', doing: '進行中', done: '完成' };

function listUrl(params) {
  const sp = new URLSearchParams();
  if (params.assignee) sp.set('assignee', params.assignee);
  if (params.status?.length) sp.set('status', params.status.join(','));
  const s = sp.toString();
  return `/tasks/list${s ? `?${s}` : ''}`;
}

function RemainingHours({ hours, unestimated }) {
  const text = createElement('span', { className: 'ov-card-hours' }, '未完成預估 ', formatHours(hours));
  return unestimated > 0
    ? createElement(
        Tooltip,
        { content: `${unestimated} 筆未填預估工時` },
        createElement('span', { tabIndex: 0 }, text),
      )
    : text;
}

/** 成員卡片（docs/design/gantt-overview.md §B3） */
export function MemberCard({ member, statuses, today, activity }) {
  const [expanded, setExpanded] = useState(false);
  const { user, doing, counts, overdue, idle } = member;
  const statusById = new Map(statuses.map((s) => [s.statusId, s]));
  const idsOf = (cat) => statuses.filter((s) => s.category === cat).map((s) => s.statusId);
  const shown = expanded ? doing : doing.slice(0, DOING_LIMIT);
  const rest = doing.length - shown.length;

  return createElement(
    'article',
    {
      className: `ov-card${idle ? ' ov-card--idle' : ''}`,
      'aria-label': `${user.displayName}${idle ? '（目前無任務）' : ''}`,
      'data-testid': `member-card-${user.id}`,
    },
    createElement(
      'header',
      { className: 'ov-card-head' },
      createElement(Avatar, { user: user, size: 'md', tooltip: false }),
      createElement(
        Link,
        { className: 'ov-card-name', to: listUrl({ assignee: String(user.id) }) },
        user.displayName,
      ),
      idle
        ? createElement(Badge, { tone: 'warning' }, '目前無任務')
        : overdue > 0
          ? createElement(Badge, { tone: 'danger' }, '逾期 ', overdue)
          : null,
    ),

    idle
      ? createElement('p', { className: 'ov-card-empty' }, '沒有進行中的任務')
      : createElement(
          'ul',
          { className: 'ov-card-doing' },
          shown.map((t) => {
            const s = statusById.get(t.statusId);
            const tone = s ? statusTone(s) : 'doing';
            const late = !!t.dueDate && t.dueDate < today;
            return createElement(
              'li',
              { key: t.id, className: 'ov-doing-row' },
              createElement('span', {
                className: 'ui-dot ui-dot--md ov-doing-dot',
                style: statusStyle(tone),
              }),
              createElement(
                'button',
                {
                  type: 'button',
                  className: 'ov-doing-title',
                  onClick: () => openTask(t.id),
                  title: t.title,
                },
                t.title,
              ),
              t.dueDate &&
                createElement(
                  'span',
                  { className: `ov-doing-due${late ? ' is-overdue' : ''}` },
                  shortDate(t.dueDate),
                ),
              createElement(UpdatedAt, { at: t.updatedAt, by: t.updatedBy }),
            );
          }),
          rest > 0 &&
            createElement(
              'li',
              null,
              createElement(
                Button,
                { variant: 'ghost', size: 'sm', onClick: () => setExpanded(true) },
                '+ 另外 ',
                rest,
                ' 筆',
              ),
            ),
        ),
    createElement(
      'p',
      { className: 'ov-card-counts' },
      ['todo', 'doing', 'done'].map((cat, i) =>
        createElement(
          'span',
          { key: cat },
          i > 0 && createElement('span', { className: 'ov-sep' }, ' · '),
          createElement(
            Link,
            { to: listUrl({ assignee: String(user.id), status: idsOf(cat) }) },
            CATEGORY_LABEL[cat],
            ' ',
            createElement('strong', null, counts[cat]),
          ),
        ),
      ),
    ),

    activity &&
      createElement(MemberWeeks, {
        name: user.displayName,
        weeks: activity.weeks,
        meta: activity.meta,
        max: activity.max,
        statuses: statuses,
      }),
    createElement(
      'footer',
      { className: 'ov-card-foot' },
      createElement(RemainingHours, { hours: member.remainingHours, unestimated: member.unestimatedCount }),
      member.lastUpdatedAt != null &&
        createElement(UpdatedAt, { at: member.lastUpdatedAt, prefix: '最近更新' }),
    ),
  );
}

/** 未指派卡（虛線邊、固定排最後） */
export function UnassignedCard({ data }) {
  return createElement(
    'article',
    {
      className: 'ov-card ov-card--unassigned',
      'aria-label': '未指派',
      'data-testid': 'member-card-unassigned',
    },
    createElement(
      'header',
      { className: 'ov-card-head' },
      createElement(Avatar, { user: null, size: 'md', tooltip: false }),
      createElement('span', { className: 'ov-card-name' }, '未指派'),
    ),
    createElement('p', { className: 'ov-card-empty' }, data.openCount, ' 筆未完成任務尚未指派'),
    createElement(
      'footer',
      { className: 'ov-card-foot' },
      createElement(RemainingHours, { hours: data.remainingHours, unestimated: data.unestimatedCount }),
      createElement(Link, { to: '/tasks/list?assignee=none', className: 'ov-link' }, '前往指派 →'),
    ),
  );
}
