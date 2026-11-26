import { createElement, Fragment } from 'preact';
import { useDraggable, useDroppable } from '../../lib/dnd.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/compat';
import { FEEDBACK_KIND_LABELS } from '../../shared/feedback.js';
import { formatDateTime, isOverdue, todayString } from '../../lib/format.js';
import { useStatusesById, useTasks, useUsersById } from '../../lib/hooks.js';
import { openTask } from '../../lib/openTask.js';
import { useMediaQuery } from '../../lib/storage.js';
import { Badge, Button, Checkbox, Skeleton, Tooltip, UpdatedAt } from '../../ui/index.js';
import { dayDropId, handleItemKey, kindTone, useFeedbackActions } from '../feedback/actions.js';
import { itemsByDate } from '../feedback/model.js';
import {
  addDaysKey,
  buildMonthGrid,
  dayLabel,
  fromDateKey,
  monthTitle,
  shiftMonth,
  toMonthKey,
  WEEKDAY_LABELS,
} from './dates.js';

/** 月曆 chip 的完整說明（tooltip）：標題 · 負責人 · 更新於 … */
function useChipTooltip(item) {
  const usersById = useUsersById();
  const assignee = item.assigneeId != null ? usersById.get(item.assigneeId)?.displayName : undefined;
  return `${item.title} · ${assignee ?? '未指派'} · 更新於 ${formatDateTime(item.updatedAt)}`;
}

/** 日格內的回饋項目 chip：可拖曳改期（已解決除外），點擊開啟編輯 */
function CalendarChip({ item, dragId }) {
  const actions = useFeedbackActions();
  const resolved = item.status === 'resolved';
  const data = { item, source: 'calendar' };
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: dragId,
    data,
    disabled: resolved,
  });
  const tooltip = useChipTooltip(item);
  const onKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.closest('[role="gridcell"]')?.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const scope = e.currentTarget.closest('.cal-more-panel, [role="gridcell"]');
      const chips = [...(scope?.querySelectorAll('[data-cal-chip]') ?? [])];
      chips[chips.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && handleItemKey(e.key, item, actions)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === ' ') e.stopPropagation();
    listeners?.onKeyDown?.(e);
  };
  return createElement(
    Tooltip,
    { content: tooltip },
    createElement(
      'div',
      {
        ref: (node) => {
          setNodeRef(node);
          setActivatorNodeRef(node);
        },
        ...attributes,
        ...listeners,
        role: 'button',
        tabIndex: -1,
        'data-cal-chip': '',
        'data-testid': `cal-chip-${item.id}`,
        'aria-roledescription': resolved ? '項目' : '可拖曳項目',
        'aria-disabled': undefined,
        'aria-label': `${FEEDBACK_KIND_LABELS[item.kind]}：${item.title}`,
        className: 'cal-chip',
        'data-kind': item.kind,
        'data-resolved': resolved || undefined,
        'data-dragging': isDragging || undefined,
        onKeyDown: onKeyDown,
        onClick: (e) => {
          e.stopPropagation();
          actions.edit(item);
        },
      },
      createElement('span', { className: 'cal-chip-text' }, item.title),
    ),
  );
}

/** 任務到期日 chip（唯讀，點擊開啟任務詳情；不可拖曳） */
function TaskChip({ task, done }) {
  const overdue = !done && isOverdue(task.dueDate);
  return createElement(
    'button',
    {
      type: 'button',
      tabIndex: -1,
      'data-cal-chip': '',
      className: 'cal-task-chip',
      'data-done': done || undefined,
      'data-overdue': overdue || undefined,
      'aria-label': `任務到期：${task.title}`,
      onClick: (e) => {
        e.stopPropagation();
        openTask(task.id);
      },
    },
    createElement(
      'svg',
      {
        width: '12',
        height: '12',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '2',
        'aria-hidden': 'true',
      },
      createElement('rect', { x: '4', y: '4', width: '16', height: '16', rx: '3' }),
      done && createElement('path', { d: 'M8 12l3 3 5-6' }),
    ),
    createElement('span', { className: 'cal-chip-text' }, task.title),
  );
}

/** 「+N 更多」Popover：列出該日全部回饋項目，項目同樣可拖出 */
function MorePopover({ date, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    ref.current?.querySelector('[data-cal-chip]')?.focus();
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);
  return createElement(
    'div',
    {
      ref: ref,
      className: 'ui-panel cal-more-panel',
      role: 'dialog',
      'aria-label': `${dayLabel(date)} 的全部項目`,
      onClick: (e) => e.stopPropagation(),
      onKeyDown: (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      },
    },
    items.map((item) =>
      createElement(
        'div',
        { key: item.id, className: 'cal-more-row' },
        createElement(Badge, { tone: kindTone(item.kind) }, FEEDBACK_KIND_LABELS[item.kind]),
        createElement(
          'div',
          { className: 'cal-more-chip' },
          createElement(CalendarChip, { item: item, dragId: `pop-${item.id}` }),
        ),
        createElement(UpdatedAt, { at: item.updatedAt, by: item.updatedBy }),
      ),
    ),
  );
}

function DayCell({
  day,
  items,
  tasks,
  doneStatusIds,
  maxChips,
  isToday,
  isCursor,
  loading,
  onKeyDown,
  onFocus,
}) {
  const data = { type: 'day', date: day.key };
  const { setNodeRef, isOver } = useDroppable({ id: dayDropId(day.key), data });
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const entries = [
    ...items.map((item) => ({ type: 'item', item })),
    ...tasks.map((task) => ({ type: 'task', task })),
  ];
  const overflow = entries.length > maxChips;
  const shown = overflow ? entries.slice(0, maxChips - 1) : entries;
  const hidden = entries.length - shown.length;
  const count = entries.length;

  return createElement(
    'div',
    {
      ref: setNodeRef,
      role: 'gridcell',
      tabIndex: isCursor ? 0 : -1,
      'data-date': day.key,
      'aria-label': `${dayLabel(day.key)}，${count} 個項目`,
      'aria-current': isToday ? 'date' : undefined,
      className: 'cal-cell',
      'data-outside': !day.inMonth || undefined,
      'data-weekend': day.weekend || undefined,
      'data-over': isOver || undefined,
      onKeyDown: onKeyDown,
      onFocus: (e) => {
        if (e.target === e.currentTarget) onFocus();
      },
    },
    createElement('span', { className: 'cal-date', 'data-today': isToday || undefined }, day.date.getDate()),
    createElement(
      'div',
      { className: 'cal-chips' },
      loading
        ? day.inMonth && day.date.getDate() % 6 === 2
          ? createElement(Skeleton, { height: 22 })
          : null
        : createElement(
            Fragment,
            null,
            shown.map((e) =>
              e.type === 'item'
                ? createElement(CalendarChip, {
                    key: `i${e.item.id}`,
                    item: e.item,
                    dragId: `chip-${e.item.id}`,
                  })
                : createElement(TaskChip, {
                    key: `t${e.task.id}`,
                    task: e.task,
                    done: doneStatusIds.has(e.task.statusId),
                  }),
            ),
            hidden > 0 &&
              createElement(
                'button',
                {
                  type: 'button',
                  tabIndex: -1,
                  'data-cal-chip': '',
                  className: 'cal-more',
                  'aria-expanded': moreOpen,
                  onClick: (e) => {
                    e.stopPropagation();
                    setMoreOpen(!moreOpen);
                  },
                },
                '+',
                hidden,
                ' 更多',
              ),
          ),
    ),
    moreOpen && createElement(MorePopover, { date: day.key, items: items, onClose: closeMore }),
  );
}

function ChevronLeft() {
  return createElement(
    'svg',
    {
      width: 16,
      height: 16,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    createElement('path', { d: 'M15 6l-6 6 6 6' }),
  );
}

/**
 * 月曆面板（週一起始）：標題列（‹ › 今天、顯示任務到期日）+ 月曆格。
 * 每一天都是 dnd-kit 放置區；回饋項目 chip 可在日期間拖曳改期。
 * 鍵盤：月曆格為單一 tab stop（roving tabindex），方向鍵移動、PageUp / PageDown 換月、T 回今天、Enter 進入 chip。
 */
export function MonthCalendar({
  month,
  onMonthChange,
  items,
  isLoading,
  showTasks,
  onShowTasksChange,
  hint,
}) {
  const wide = useMediaQuery('(min-width: 1280px)');
  const maxChips = wide ? 3 : 2;
  const today = todayString();
  const weeks = useMemo(() => buildMonthGrid(month), [month]);
  const byDate = useMemo(() => itemsByDate(items), [items]);
  const first = weeks[0][0].key;
  const last = weeks.at(-1).at(-1).key;

  const tasksQuery = useTasks(undefined, { enabled: showTasks });
  const statusesById = useStatusesById();
  const doneStatusIds = useMemo(
    () => new Set([...statusesById.values()].filter((s) => s.category === 'done').map((s) => s.id)),
    [statusesById],
  );
  const tasksByDate = useMemo(() => {
    const map = new Map();
    if (!showTasks) return map;
    for (const t of tasksQuery.data ?? []) {
      if (!t.dueDate || t.dueDate < first || t.dueDate > last) continue;
      map.set(t.dueDate, [...(map.get(t.dueDate) ?? []), t]);
    }
    return map;
  }, [tasksQuery.data, showTasks, first, last]);

  // 鍵盤游標（roving tabindex）：預設今天（若在本月）否則當月 1 日
  const monthKey = toMonthKey(month);
  const defaultCursor = today.startsWith(monthKey) ? today : `${monthKey}-01`;
  const [cursor, setCursor] = useState(defaultCursor);
  const cursorKey = cursor >= first && cursor <= last ? cursor : defaultCursor;
  const gridRef = useRef(null);
  // 待 focus 的目標日期。換月時 setCursor 與 onMonthChange（URL）未必在同一次 render 生效；
  // 若在月份尚未切換時就 focus（舊月曆格也可能含下月 1 日），切換後 .cal-body 以 monthKey
  // 重新掛載會讓焦點掉回 body。因此等目標日期所在月份真正顯示後才 focus。
  const pendingFocus = useRef(null);

  useEffect(() => {
    const target = pendingFocus.current;
    if (target == null || target.slice(0, 7) !== monthKey || target !== cursorKey) return;
    pendingFocus.current = null;
    gridRef.current?.querySelector(`[data-date="${cursorKey}"]`)?.focus();
  }, [cursorKey, monthKey]);

  const moveCursor = (key) => {
    pendingFocus.current = key;
    setCursor(key);
    const d = fromDateKey(key);
    if (toMonthKey(d) !== monthKey) onMonthChange(shiftMonth(d, 0));
  };
  const goMonth = (delta, focus = false) => {
    const next = shiftMonth(month, delta);
    const key = `${toMonthKey(next)}-01`;
    pendingFocus.current = focus ? key : null;
    setCursor(key);
    onMonthChange(next);
  };
  const goToday = (focus = false) => {
    pendingFocus.current = focus ? today : null;
    setCursor(today);
    onMonthChange(shiftMonth(fromDateKey(today), 0));
  };

  const onCellKeyDown = (day) => (e) => {
    if (e.target !== e.currentTarget) return;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (delta) {
      e.preventDefault();
      moveCursor(addDaysKey(day.key, delta));
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      goMonth(e.key === 'PageUp' ? -1 : 1, true);
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      goToday(true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.querySelector('[data-cal-chip]')?.focus();
    }
  };

  const isCurrentMonth = today.startsWith(monthKey);

  return createElement(
    'section',
    { className: 'fb-panel cal-panel', 'aria-label': '月曆' },
    createElement(
      'div',
      { className: 'cal-head' },
      createElement(Button, {
        variant: 'ghost',
        size: 'sm',
        iconOnly: true,
        icon: createElement(ChevronLeft, null),
        'aria-label': '上個月',
        onClick: () => goMonth(-1),
      }),
      createElement(Button, {
        variant: 'ghost',
        size: 'sm',
        iconOnly: true,
        icon: 'chevronRight',
        'aria-label': '下個月',
        onClick: () => goMonth(1),
      }),
      createElement('h2', { className: 'cal-title', 'aria-live': 'polite' }, monthTitle(month)),
      createElement(
        Button,
        { variant: 'secondary', size: 'sm', disabled: isCurrentMonth, onClick: () => goToday() },
        '今天',
      ),
      createElement('span', { className: 'cal-head-spacer' }),
      createElement(Checkbox, {
        checked: showTasks,
        onChange: (e) => onShowTasksChange(e.target.checked),
        'aria-label': '顯示任務到期日',
        label: createElement(
          'span',
          { className: 'cal-task-toggle' },
          wide ? '顯示任務到期日' : '任務到期日',
        ),
      }),
    ),
    createElement(
      'div',
      { className: 'cal-scroll' },
      createElement(
        'div',
        { className: 'cal-body', key: monthKey },
        createElement(
          'div',
          { className: 'cal-weekdays', 'aria-hidden': 'true' },
          WEEKDAY_LABELS.map((w) => createElement('div', { key: w }, w)),
        ),
        createElement(
          'div',
          {
            ref: gridRef,
            role: 'grid',
            'aria-label': monthTitle(month),
            className: 'cal-grid',
            style: { gridTemplateRows: `repeat(${weeks.length}, minmax(var(--cal-cell-min), 1fr))` },
          },
          weeks.map((week) =>
            createElement(
              'div',
              { role: 'row', key: week[0].key, className: 'cal-row' },
              week.map((day) =>
                createElement(DayCell, {
                  key: day.key,
                  day: day,
                  items: byDate.get(day.key) ?? [],
                  tasks: tasksByDate.get(day.key) ?? [],
                  doneStatusIds: doneStatusIds,
                  maxChips: maxChips,
                  isToday: day.key === today,
                  isCursor: day.key === cursorKey,
                  loading: isLoading,
                  onKeyDown: onCellKeyDown(day),
                  onFocus: () => setCursor(day.key),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
    hint && createElement('p', { className: 'cal-hint' }, hint),
  );
}
