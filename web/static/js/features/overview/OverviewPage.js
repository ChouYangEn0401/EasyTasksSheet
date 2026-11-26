import { createElement, Fragment } from 'preact';
import { useMemo, useState } from 'preact/compat';
import { Link } from '../../lib/router.js';
import { statusStyle, statusTone } from '../../lib/colors.js';
import { todayString } from '../../lib/format.js';
import { useStatusesById, useTasks } from '../../lib/hooks.js';
import { Alert, EmptyState, ErrorState, Skeleton } from '../../ui/index.js';
import { Gantt } from '../gantt/Gantt.js';
import { isScheduled } from '../gantt/timeline.js';
import { MemberCard, UnassignedCard } from './MemberCard.js';
import { teamMax } from './activity.js';
import { formatWeekRange, useOverview, useOverviewActivity } from './useOverview.js';
import { TeamWeeks } from './WeeksActivity.js';

const IDLE_SECTION_ID = 'overview-idle';

/** 總覽主畫面（/）：統計列、成員卡片（目前無任務者在前）、精簡甘特圖 */
export function OverviewPage() {
  const overview = useOverview();

  return createElement(
    'div',
    { className: 'ov-page' },
    overview.isPending
      ? createElement(OverviewSkeleton, null)
      : overview.isError && !overview.data
        ? createElement(ErrorState, { error: overview.error, onRetry: () => overview.refetch() })
        : createElement(OverviewBody, { data: overview.data }),
    createElement(CompactGantt, { members: overview.data?.members }),
  );
}

function OverviewBody({ data }) {
  const { totals, members, unassigned, today } = data;
  const idle = members.filter((m) => m.idle);
  const busy = members.filter((m) => !m.idle);
  const totalTasks = totals.byStatus.reduce((n, s) => n + s.count, 0);
  const activity = useOverviewActivity().data;
  const activityMax = teamMax(activity);
  const activityOf = (userId) => {
    const weeks = activity?.members.find((m) => m.userId === userId)?.weeks;
    return activity && weeks ? { weeks, meta: activity.weeks, max: activityMax } : undefined;
  };

  return createElement(
    Fragment,
    null,
    createElement(StatsRow, { data: data }),
    activity && createElement(TeamWeeks, { data: activity }),
    totalTasks === 0
      ? createElement(EmptyState, { title: '還沒有任務', description: '按 N 快速新增任務' })
      : members.length === 0
        ? createElement(
            Fragment,
            null,
            createElement(EmptyState, {
              title: '還沒有列入統計的成員',
              description: '可在成員管理開啟「列入總覽統計」',
            }),
            unassigned.openCount > 0 &&
              createElement(
                'div',
                { className: 'ov-grid' },
                createElement(UnassignedCard, { data: unassigned }),
              ),
          )
        : createElement(
            Fragment,
            null,
            createElement(
              'section',
              {
                className: 'ov-section',
                id: IDLE_SECTION_ID,
                'aria-labelledby': 'ov-idle-title',
                tabIndex: -1,
              },
              idle.length > 0
                ? createElement(
                    Fragment,
                    null,
                    createElement(
                      'h2',
                      { className: 'ov-section-title', id: 'ov-idle-title' },
                      '目前無任務',
                      createElement('span', { className: 'ov-section-count' }, '（', idle.length, '）'),
                    ),
                    createElement(
                      'div',
                      { className: 'ov-grid' },
                      idle.map((m) =>
                        createElement(MemberCard, {
                          key: m.user.id,
                          member: m,
                          statuses: totals.byStatus,
                          today: today,
                          activity: activityOf(m.user.id),
                        }),
                      ),
                    ),
                  )
                : createElement(
                    Fragment,
                    null,
                    createElement('h2', { className: 'sr-only', id: 'ov-idle-title' }, '目前無任務'),
                    createElement(Alert, { tone: 'success' }, '所有成員都有進行中的任務'),
                  ),
            ),
            createElement(
              'section',
              { className: 'ov-section', 'aria-labelledby': 'ov-busy-title' },
              createElement(
                'h2',
                { className: 'ov-section-title', id: 'ov-busy-title' },
                '進行中',
                createElement('span', { className: 'ov-section-count' }, '（', busy.length, '）'),
              ),
              createElement(
                'div',
                { className: 'ov-grid' },
                busy.map((m) =>
                  createElement(MemberCard, {
                    key: m.user.id,
                    member: m,
                    statuses: totals.byStatus,
                    today: today,
                    activity: activityOf(m.user.id),
                  }),
                ),
                unassigned.openCount > 0 && createElement(UnassignedCard, { data: unassigned }),
              ),
            ),
          ),
  );
}

function StatsRow({ data }) {
  const { totals, weekRange } = data;
  const total = totals.byStatus.reduce((n, s) => n + s.count, 0);
  const idleCount = totals.idleMembers;

  return createElement(
    'div',
    { className: 'ov-stats' },
    createElement(
      'button',
      {
        type: 'button',
        className: `ov-stat ov-stat--button${idleCount > 0 ? ' ov-stat--warning' : ''}`,
        'data-testid': 'stat-idle',
        onClick: () => {
          const el = document.getElementById(IDLE_SECTION_ID);
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el?.focus({ preventScroll: true });
        },
      },
      createElement('span', { className: 'ov-stat-label' }, '目前無任務'),
      createElement('span', { className: 'ov-stat-value' }, idleCount, ' 人'),
      createElement('span', { className: 'ov-stat-hint' }, '共 ', totals.activeMembers, ' 位成員'),
    ),
    createElement(
      'div',
      { className: 'ov-stat', 'data-testid': 'stat-overdue' },
      createElement('span', { className: 'ov-stat-label' }, '逾期'),
      createElement(
        'span',
        { className: `ov-stat-value${totals.overdue > 0 ? ' is-danger' : ''}` },
        totals.overdue,
        ' 筆',
      ),
      createElement(Link, { to: '/tasks/list', className: 'ov-stat-hint ov-link' }, '查看 →'),
    ),
    createElement(
      'div',
      { className: 'ov-stat', 'data-testid': 'stat-done-week' },
      createElement('span', { className: 'ov-stat-label' }, '本週完成'),
      createElement('span', { className: 'ov-stat-value' }, totals.doneThisWeek, ' 筆'),
      createElement('span', { className: 'ov-stat-hint' }, formatWeekRange(weekRange)),
    ),
    createElement(
      'div',
      { className: 'ov-stat ov-stat--wide', 'data-testid': 'stat-status' },
      createElement('span', { className: 'ov-stat-label' }, '狀態分佈'),
      createElement(
        'div',
        {
          className: 'ov-dist',
          role: 'img',
          'aria-label': totals.byStatus.map((s) => `${s.name} ${s.count}`).join('、'),
        },
        total === 0
          ? createElement('span', { className: 'ov-dist-empty' })
          : totals.byStatus
              .filter((s) => s.count > 0)
              .map((s) =>
                createElement('span', {
                  key: s.statusId,
                  className: 'ov-dist-seg',
                  style: { flexGrow: s.count, ...statusStyle(statusTone(s)) },
                }),
              ),
      ),
      createElement(
        'div',
        { className: 'ov-legend' },
        totals.byStatus.map((s) =>
          createElement(
            Link,
            { key: s.statusId, to: `/tasks/list?status=${s.statusId}`, className: 'ov-legend-item' },
            createElement('span', {
              className: 'ui-dot ui-dot--md ov-doing-dot',
              style: statusStyle(statusTone(s)),
            }),
            s.name,
            ' ',
            createElement('strong', null, s.count),
          ),
        ),
      ),
    ),
  );
}

/** 精簡版甘特圖：負責人分組、週刻度、唯讀，只顯示未完成且已排程的任務 */
function CompactGantt({ members }) {
  const tasks = useTasks();
  const statusesById = useStatusesById();
  const [today] = useState(() => todayString());
  const open = useMemo(
    () =>
      (tasks.data ?? []).filter((t) => isScheduled(t) && statusesById.get(t.statusId)?.category !== 'done'),
    [tasks.data, statusesById],
  );
  const order = useMemo(
    () => (members ?? []).map((m) => ({ id: m.user.id, displayName: m.user.displayName })),
    [members],
  );

  return createElement(
    'section',
    { className: 'ov-section', 'aria-labelledby': 'ov-gantt-title' },
    createElement(
      'div',
      { className: 'ov-section-head' },
      createElement('h2', { className: 'ov-section-title', id: 'ov-gantt-title' }, '甘特圖進度'),
      createElement(Link, { to: '/tasks/gantt?group=assignee', className: 'ov-link' }, '開啟完整甘特圖 →'),
    ),
    tasks.isPending || !members
      ? createElement(
          'div',
          { className: 'ov-gantt-skeleton' },
          Array.from({ length: 5 }, (_, i) =>
            createElement(Skeleton, { key: i, height: 14, width: `${40 + ((i * 23) % 50)}%` }),
          ),
        )
      : tasks.isError && !tasks.data
        ? createElement(ErrorState, { error: tasks.error, onRetry: () => tasks.refetch() })
        : createElement(Gantt, {
            compact: true,
            tasks: open,
            groupBy: 'assignee',
            scale: 'week',
            today: today,
            members: order,
            ariaLabel: '甘特圖進度（精簡）',
          }),
  );
}

function OverviewSkeleton() {
  return createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className: 'ov-stats', 'aria-busy': 'true', 'aria-label': '載入中' },
      [0, 1, 2, 3].map((i) =>
        createElement(
          'div',
          { key: i, className: `ov-stat${i === 3 ? ' ov-stat--wide' : ''}` },
          createElement(Skeleton, { width: 64 }),
          createElement(Skeleton, { width: 48, height: 24 }),
          createElement(Skeleton, { width: 80 }),
        ),
      ),
    ),
    createElement(
      'div',
      { className: 'ov-grid' },
      Array.from({ length: 6 }, (_, i) =>
        createElement(
          'div',
          { key: i, className: 'ov-card' },
          createElement(Skeleton, { width: '50%', height: 16 }),
          createElement(Skeleton, { width: '90%' }),
          createElement(Skeleton, { width: '70%' }),
          createElement(Skeleton, { width: '60%' }),
        ),
      ),
    ),
  );
}
