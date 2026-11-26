import { createElement } from 'preact';
import { useMemo } from 'preact/compat';
import { statusStyle, statusTone } from '../../lib/colors.js';
import { emptyFilters } from '../../lib/filters.js';
import { todayString } from '../../lib/format.js';
import { useProjectsById, useStatusesById, useTasks } from '../../lib/hooks.js';
import { openTask } from '../../lib/openTask.js';
import { Link } from '../../lib/router.js';
import { Button, ErrorState } from '../../ui/index.js';
import { formatRangeLabel, formatReportDate } from './reportFormat.js';
import { isoWeek, localDate, weekBuckets, weekDueLabel } from './reportTemplates.js';
import { SkeletonRows } from './TaskSections.js';

const MAX_ROWS = 5;

const COLUMNS = [
  { kind: 'doing', label: '進行中', empty: '這週還沒有進行中的任務' },
  { kind: 'due', label: '本週到期', empty: '本週沒有到期的任務' },
  { kind: 'done', label: '本週完成', empty: '本週還沒有完成紀錄' },
];

function WeekItem({ task, kind, today, statuses, projects }) {
  const st = statuses.get(task.statusId);
  const project = projects.get(task.projectId);
  const due = weekDueLabel(task.dueDate, today);
  const doneDate = kind === 'done' ? localDate(task.completedAt ?? task.updatedAt) : null;
  const timeText = doneDate ? formatReportDate(doneDate, Number(today.slice(0, 4))) : kind === 'done' ? '—' : due.text;
  return createElement(
    'li',
    { className: 'pl-week-item', 'data-due': kind === 'done' ? undefined : due.kind, 'data-task-id': task.id },
    createElement('span', {
      className: 'pl-week-dot',
      'aria-hidden': 'true',
      style: st ? statusStyle(statusTone(st)) : undefined,
    }),
    createElement(
      'button',
      {
        type: 'button',
        className: 'pl-week-title',
        title: project ? `${task.title}（${project.name}）` : task.title,
        onClick: () => openTask(task.id),
      },
      task.title,
    ),
    project && createElement('span', { className: 'pl-week-project' }, project.name),
    kind === 'doing' &&
      typeof task.progress === 'number' &&
      task.progress > 0 &&
      createElement('span', { className: 'pl-week-pct' }, `${task.progress}%`),
    createElement('time', { className: 'pl-week-due', dateTime: doneDate ?? task.dueDate ?? undefined }, timeText),
  );
}

/**
 * 個人頁最上面「本週」卡（§6.1、R1）：進行中／本週到期／本週完成，數字＋前五筆。
 * 只用既有的 GET /api/tasks（與「指派給我的任務」同一個查詢鍵，共用快取）。
 */
export function WeekCard({ userId, onReport }) {
  const filters = useMemo(() => ({ ...emptyFilters(), assignee: [userId] }), [userId]);
  const q = useTasks(filters);
  const statuses = useStatusesById();
  const projects = useProjectsById();
  const today = todayString();
  const ready = q.data != null && statuses.size > 0;
  const buckets = useMemo(
    () => (ready ? weekBuckets(q.data, statuses, today) : null),
    [ready, q.data, statuses, today],
  );
  const range = buckets ?? { from: today, to: today };
  const doingStatusIds = [...statuses.values()].filter((s) => s.category === 'doing').map((s) => s.id);

  let body;
  if (!ready && q.isError) body = createElement(ErrorState, { error: q.error, onRetry: () => void q.refetch() });
  else if (!ready) body = createElement(SkeletonRows, { n: 3 });
  else
    body = createElement(
      'div',
      { className: 'pl-week-grid' },
      COLUMNS.map((c) => {
        const list = buckets[c.kind];
        const more = list.length - MAX_ROWS;
        const href =
          c.kind === 'doing' && doingStatusIds.length
            ? `/tasks/list?assignee=${userId}&status=${doingStatusIds.join(',')}`
            : `/tasks/list?assignee=${userId}`;
        return createElement(
          'div',
          { key: c.kind, className: 'pl-week-col', 'data-kind': c.kind },
          createElement(
            'div',
            { className: 'pl-week-col-head' },
            createElement('span', { className: 'pl-week-col-label', id: `pl-week-${c.kind}` }, c.label),
            createElement(
              'b',
              {
                className: 'pl-week-num',
                'data-testid': `week-count-${c.kind}`,
                'data-has-overdue': c.kind === 'due' && buckets.overdue > 0 ? 'true' : undefined,
              },
              list.length,
            ),
          ),
          list.length === 0
            ? createElement('p', { className: 'pl-week-empty' }, c.empty)
            : createElement(
                'ul',
                { className: 'pl-week-list', 'aria-labelledby': `pl-week-${c.kind}` },
                list
                  .slice(0, MAX_ROWS)
                  .map((t) =>
                    createElement(WeekItem, { key: t.id, task: t, kind: c.kind, today, statuses, projects }),
                  ),
              ),
          more > 0 && createElement(Link, { to: href, className: 'pl-week-more' }, `還有 ${more} 項 →`),
        );
      }),
    );

  return createElement(
    'section',
    { className: 'pl-card pl-week', 'aria-labelledby': 'pl-week-title' },
    createElement(
      'div',
      { className: 'pl-card-head' },
      createElement('h2', { id: 'pl-week-title', className: 'pl-card-title', tabIndex: -1 }, '本週'),
      createElement(
        'span',
        { className: 'pl-week-range' },
        `${formatRangeLabel(range.from, range.to)} · 第 ${isoWeek(today)} 週`,
      ),
      createElement(
        'span',
        { className: 'pl-card-controls pl-week-actions' },
        createElement(
          Button,
          {
            variant: 'primary',
            size: 'sm',
            title: '用「個人週報」模版產生本週匯報',
            onClick: () => onReport('weekly', 'week'),
          },
          '匯報',
        ),
        createElement(
          Button,
          {
            variant: 'secondary',
            size: 'sm',
            title: '用「工作日誌」模版產生今天的日誌（每日 PPT）',
            onClick: () => onReport('worklog', 'today'),
          },
          '今日',
        ),
      ),
    ),
    body,
  );
}
