import { createElement, Fragment } from 'preact';
import { useId, useState } from 'preact/compat';
import { statusStyle, statusTone } from '../../lib/colors.js';
import { openTask } from '../../lib/openTask.js';
import { Icon, Tooltip } from '../../ui/index.js';
import {
  barHeights,
  countsText,
  describeWeek,
  hoursText,
  shortDay,
  sumWeeks,
  weekLabel,
} from './activity.js';
import { formatWeekRange } from './useOverview.js';

/** 三個小直條（由舊到新；本週深一階；沒有紀錄畫淡灰虛線） */
export function MiniBars({ weeks, meta, max }) {
  const heights = barHeights(
    weeks.map((w) => w.involved),
    max,
  );
  return createElement(
    'span',
    { className: 'ov-bars', 'aria-hidden': 'true' },
    heights.map((h, i) =>
      createElement('span', {
        key: meta[i]?.start ?? i,
        className: `ov-bar${meta[i]?.current ? ' is-current' : ''}${h === 0 ? ' is-empty' : ''}`,
        style: h > 0 ? { height: `${h}%` } : undefined,
      }),
    ),
  );
}

/** 成員卡片內的「近三週」：迷你直條 + 小字；點擊在卡片下方展開各週任務清單 */
export function MemberWeeks({ name, weeks, meta, max, statuses }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(weeks.length - 1);
  const panelId = useId();
  const labels = weeks.map((_, i) => weekLabel(i, weeks.length));
  const lines = weeks.map((w, i) => describeWeek(labels[i], w));

  return createElement(
    'div',
    { className: 'ov-weeks' },
    createElement(
      Tooltip,
      {
        content: createElement(
          'span',
          { className: 'ov-weeks-tip' },
          lines.map((l) => createElement('span', { key: l }, l)),
        ),
      },
      createElement(
        'button',
        {
          type: 'button',
          className: 'ov-weeks-toggle',
          'aria-expanded': open,
          'aria-controls': panelId,
          'aria-label': `近三週：${lines.join('；')}。${open ? '收合' : '展開'}詳情`,
          onClick: () => setOpen((v) => !v),
        },
        createElement('span', { className: 'ov-weeks-label' }, '近三週'),
        createElement(MiniBars, { weeks: weeks, meta: meta, max: max }),
        createElement('span', { className: 'ov-weeks-text' }, countsText(sumWeeks(weeks))),
        createElement(Icon, {
          name: open ? 'chevronDown' : 'chevronRight',
          size: 14,
          className: 'ov-weeks-chevron',
        }),
      ),
    ),
    open &&
      createElement(
        'div',
        { className: 'ov-weeks-panel', id: panelId, role: 'region', 'aria-label': `${name} 近三週的任務` },
        createElement(
          'div',
          { className: 'ov-weeks-seg', role: 'group', 'aria-label': '選擇週' },
          weeks.map((_, i) =>
            createElement(
              'button',
              {
                key: meta[i]?.start ?? i,
                type: 'button',
                className: 'ov-weeks-seg-btn',
                'aria-pressed': sel === i,
                onClick: () => setSel(i),
              },
              labels[i],
            ),
          ),
        ),
        createElement(WeekDetail, { week: weeks[sel], meta: meta[sel], statuses: statuses }),
      ),
  );
}

function WeekDetail({ week, meta, statuses }) {
  const statusById = new Map(statuses.map((s) => [s.statusId, s]));
  const hours = hoursText(week);
  const rest = week.itemsTotal - week.items.length;
  return createElement(
    'div',
    { className: 'ov-week-detail' },
    createElement(
      'p',
      { className: 'ov-week-meta' },
      meta && createElement('span', null, formatWeekRange(meta)),
      week.involved > 0 &&
        createElement('span', null, '完成 ', week.completed, ' 件・處理 ', week.touched, ' 件'),
    ),
    hours && createElement('p', { className: 'ov-week-hours' }, hours),
    week.items.length === 0
      ? createElement('p', { className: 'ov-week-empty' }, '這週沒有紀錄')
      : createElement(
          'ul',
          { className: 'ov-week-items' },
          week.items.map((t) => {
            const s = statusById.get(t.statusId);
            return createElement(
              'li',
              { key: t.id, className: 'ov-week-item' },
              createElement('span', {
                className: 'ui-dot ui-dot--md ov-doing-dot',
                style: statusStyle(s ? statusTone(s) : 'todo'),
                title: s?.name,
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
              createElement('span', { className: 'ov-week-tag' }, t.completed ? '完成' : '處理'),
              createElement('span', { className: 'ov-week-date' }, shortDay(t.at)),
            );
          }),
        ),
    rest > 0 && createElement('p', { className: 'ov-week-note' }, '另有 ', rest, ' 件未列出'),
    meta?.touchedPartial &&
      createElement('p', { className: 'ov-week-note' }, '較早的處理紀錄已不保留，件數可能偏少'),
  );
}

/** 統計列下方的全隊合計（中性呈現，不分人） */
export function TeamWeeks({ data }) {
  const { weeks, teamWeeks } = data;
  const max = Math.max(0, ...teamWeeks.map((w) => w.involved));
  return createElement(
    'section',
    { className: 'ov-team-weeks', 'aria-labelledby': 'ov-team-weeks-title', 'data-testid': 'team-weeks' },
    createElement(
      'div',
      { className: 'ov-team-weeks-head' },
      createElement('h2', { className: 'ov-team-weeks-title', id: 'ov-team-weeks-title' }, '近三週團隊進展'),
      createElement('span', { className: 'ov-stat-hint' }, '大約的數字，方便了解大家在忙什麼'),
    ),
    createElement(
      'div',
      { className: 'ov-team-weeks-body' },
      createElement(MiniBars, { weeks: teamWeeks, meta: weeks, max: max }),
      createElement(
        'ul',
        { className: 'ov-team-weeks-list' },
        teamWeeks.map((w, i) => {
          const meta = weeks[i];
          const hours = hoursText(w);
          return createElement(
            'li',
            { key: meta.start, className: 'ov-team-week' },
            createElement(
              'span',
              { className: 'ov-team-week-label' },
              weekLabel(i, teamWeeks.length),
              createElement('span', { className: 'ov-stat-hint' }, ' ', formatWeekRange(meta)),
            ),
            createElement(
              'span',
              { className: 'ov-team-week-value' },
              w.involved === 0 ? '沒有紀錄' : `完成 ${w.completed} 件・處理 ${w.touched} 件`,
            ),
            hours && createElement('span', { className: 'ov-stat-hint' }, hours),
          );
        }),
      ),
    ),
  );
}
