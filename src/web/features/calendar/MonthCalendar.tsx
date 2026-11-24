import { useDraggable, useDroppable } from '@dnd-kit/core';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FEEDBACK_KIND_LABELS, type FeedbackItem } from '../../../shared/feedback.ts';
import type { Task } from '../../../shared/tasks.ts';
import { formatDateTime, isOverdue, todayString } from '../../lib/format.ts';
import { useStatusesById, useTasks, useUsersById } from '../../lib/hooks.ts';
import { openTask } from '../../lib/openTask.ts';
import { useMediaQuery } from '../../lib/storage.ts';
import { Badge, Button, Checkbox, Skeleton, Tooltip, UpdatedAt } from '../../ui/index.ts';
import {
  dayDropId,
  handleItemKey,
  kindTone,
  useFeedbackActions,
  type DragData,
  type DropData,
} from '../feedback/actions.ts';
import { itemsByDate } from '../feedback/model.ts';
import {
  addDaysKey,
  buildMonthGrid,
  dayLabel,
  fromDateKey,
  monthTitle,
  shiftMonth,
  toMonthKey,
  WEEKDAY_LABELS,
  type CalendarDay,
} from './dates.ts';

/** 月曆 chip 的完整說明（tooltip）：標題 · 負責人 · 更新於 … */
function useChipTooltip(item: FeedbackItem) {
  const usersById = useUsersById();
  const assignee = item.assigneeId != null ? usersById.get(item.assigneeId)?.displayName : undefined;
  return `${item.title} · ${assignee ?? '未指派'} · 更新於 ${formatDateTime(item.updatedAt)}`;
}

/** 日格內的回饋項目 chip：可拖曳改期（已解決除外），點擊開啟編輯 */
function CalendarChip({ item, dragId }: { item: FeedbackItem; dragId: string }) {
  const actions = useFeedbackActions();
  const resolved = item.status === 'resolved';
  const data: DragData = { item, source: 'calendar' };
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: dragId,
    data,
    disabled: resolved,
  });
  const tooltip = useChipTooltip(item);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget.closest('[role="gridcell"]') as HTMLElement | null)?.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const scope = e.currentTarget.closest('.cal-more-panel, [role="gridcell"]');
      const chips = [...(scope?.querySelectorAll<HTMLElement>('[data-cal-chip]') ?? [])];
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
  return (
    <Tooltip content={tooltip}>
      <div
        ref={(node) => {
          setNodeRef(node);
          setActivatorNodeRef(node);
        }}
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={-1}
        data-cal-chip=""
        data-testid={`cal-chip-${item.id}`}
        aria-roledescription={resolved ? '項目' : '可拖曳項目'}
        // 已解決只是不可拖曳，仍可點擊編輯（不沿用 dnd-kit 的 aria-disabled）
        aria-disabled={undefined}
        aria-label={`${FEEDBACK_KIND_LABELS[item.kind]}：${item.title}`}
        className="cal-chip"
        data-kind={item.kind}
        data-resolved={resolved || undefined}
        data-dragging={isDragging || undefined}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          e.stopPropagation();
          actions.edit(item);
        }}
      >
        <span className="cal-chip-text">{item.title}</span>
      </div>
    </Tooltip>
  );
}

/** 任務到期日 chip（唯讀，點擊開啟任務詳情；不可拖曳） */
function TaskChip({ task, done }: { task: Task; done: boolean }) {
  const overdue = !done && isOverdue(task.dueDate);
  return (
    <button
      type="button"
      tabIndex={-1}
      data-cal-chip=""
      className="cal-task-chip"
      data-done={done || undefined}
      data-overdue={overdue || undefined}
      aria-label={`任務到期：${task.title}`}
      onClick={(e) => {
        e.stopPropagation();
        openTask(task.id);
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <rect x="4" y="4" width="16" height="16" rx="3" />
        {done && <path d="M8 12l3 3 5-6" />}
      </svg>
      <span className="cal-chip-text">{task.title}</span>
    </button>
  );
}

/** 「+N 更多」Popover：列出該日全部回饋項目，項目同樣可拖出 */
function MorePopover({ date, items, onClose }: { date: string; items: FeedbackItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    ref.current?.querySelector<HTMLElement>('[data-cal-chip]')?.focus();
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="ui-panel cal-more-panel"
      role="dialog"
      aria-label={`${dayLabel(date)} 的全部項目`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {items.map((item) => (
        <div key={item.id} className="cal-more-row">
          <Badge tone={kindTone(item.kind)}>{FEEDBACK_KIND_LABELS[item.kind]}</Badge>
          <div className="cal-more-chip">
            <CalendarChip item={item} dragId={`pop-${item.id}`} />
          </div>
          <UpdatedAt at={item.updatedAt} by={item.updatedBy} />
        </div>
      ))}
    </div>
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
}: {
  day: CalendarDay;
  items: FeedbackItem[];
  tasks: Task[];
  doneStatusIds: Set<number>;
  maxChips: number;
  isToday: boolean;
  isCursor: boolean;
  loading: boolean;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
}) {
  const data: DropData = { type: 'day', date: day.key };
  const { setNodeRef, isOver } = useDroppable({ id: dayDropId(day.key), data });
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const entries = [
    ...items.map((item) => ({ type: 'item' as const, item })),
    ...tasks.map((task) => ({ type: 'task' as const, task })),
  ];
  const overflow = entries.length > maxChips;
  const shown = overflow ? entries.slice(0, maxChips - 1) : entries;
  const hidden = entries.length - shown.length;
  const count = entries.length;

  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      tabIndex={isCursor ? 0 : -1}
      data-date={day.key}
      aria-label={`${dayLabel(day.key)}，${count} 個項目`}
      aria-current={isToday ? 'date' : undefined}
      className="cal-cell"
      data-outside={!day.inMonth || undefined}
      data-weekend={day.weekend || undefined}
      data-over={isOver || undefined}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocus();
      }}
    >
      <span className="cal-date" data-today={isToday || undefined}>
        {day.date.getDate()}
      </span>
      <div className="cal-chips">
        {loading ? (
          day.inMonth && day.date.getDate() % 6 === 2 ? (
            <Skeleton height={22} />
          ) : null
        ) : (
          <>
            {shown.map((e) =>
              e.type === 'item' ? (
                <CalendarChip key={`i${e.item.id}`} item={e.item} dragId={`chip-${e.item.id}`} />
              ) : (
                <TaskChip key={`t${e.task.id}`} task={e.task} done={doneStatusIds.has(e.task.statusId)} />
              ),
            )}
            {hidden > 0 && (
              <button
                type="button"
                tabIndex={-1}
                data-cal-chip=""
                className="cal-more"
                aria-expanded={moreOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setMoreOpen(!moreOpen);
                }}
              >
                +{hidden} 更多
              </button>
            )}
          </>
        )}
      </div>
      {moreOpen && <MorePopover date={day.key} items={items} onClose={closeMore} />}
    </div>
  );
}

function ChevronLeft() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 6l-6 6 6 6" />
    </svg>
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
}: {
  month: Date;
  onMonthChange: (month: Date) => void;
  items: FeedbackItem[];
  isLoading: boolean;
  showTasks: boolean;
  onShowTasksChange: (v: boolean) => void;
  hint?: string;
}) {
  const wide = useMediaQuery('(min-width: 1280px)');
  const maxChips = wide ? 3 : 2;
  const today = todayString();
  const weeks = useMemo(() => buildMonthGrid(month), [month]);
  const byDate = useMemo(() => itemsByDate(items), [items]);
  const first = weeks[0]![0]!.key;
  const last = weeks.at(-1)!.at(-1)!.key;

  const tasksQuery = useTasks(undefined, { enabled: showTasks });
  const statusesById = useStatusesById();
  const doneStatusIds = useMemo(
    () => new Set([...statusesById.values()].filter((s) => s.category === 'done').map((s) => s.id)),
    [statusesById],
  );
  const tasksByDate = useMemo(() => {
    const map = new Map<string, Task[]>();
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
  const gridRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${cursorKey}"]`)?.focus();
  }, [cursorKey, monthKey]);

  const moveCursor = (key: string) => {
    pendingFocus.current = true;
    setCursor(key);
    const d = fromDateKey(key);
    if (toMonthKey(d) !== monthKey) onMonthChange(shiftMonth(d, 0));
  };
  const goMonth = (delta: number, focus = false) => {
    const next = shiftMonth(month, delta);
    pendingFocus.current = focus;
    setCursor(`${toMonthKey(next)}-01`);
    onMonthChange(next);
  };
  const goToday = (focus = false) => {
    pendingFocus.current = focus;
    setCursor(today);
    onMonthChange(shiftMonth(fromDateKey(today), 0));
  };

  const onCellKeyDown = (day: CalendarDay) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const delta = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[
      e.key
    ];
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
      e.currentTarget.querySelector<HTMLElement>('[data-cal-chip]')?.focus();
    }
  };

  const isCurrentMonth = today.startsWith(monthKey);

  return (
    <section className="fb-panel cal-panel" aria-label="月曆">
      <div className="cal-head">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon={<ChevronLeft />}
          aria-label="上個月"
          onClick={() => goMonth(-1)}
        />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="chevronRight"
          aria-label="下個月"
          onClick={() => goMonth(1)}
        />
        <h2 className="cal-title" aria-live="polite">
          {monthTitle(month)}
        </h2>
        <Button variant="secondary" size="sm" disabled={isCurrentMonth} onClick={() => goToday()}>
          今天
        </Button>
        <span className="cal-head-spacer" />
        <Checkbox
          checked={showTasks}
          onChange={(e) => onShowTasksChange(e.target.checked)}
          aria-label="顯示任務到期日"
          label={<span className="cal-task-toggle">{wide ? '顯示任務到期日' : '任務到期日'}</span>}
        />
      </div>
      <div className="cal-scroll">
        <div className="cal-body" key={monthKey}>
          <div className="cal-weekdays" aria-hidden="true">
            {WEEKDAY_LABELS.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
          <div
            ref={gridRef}
            role="grid"
            aria-label={monthTitle(month)}
            className="cal-grid"
            style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(var(--cal-cell-min), 1fr))` }}
          >
            {weeks.map((week) => (
              <div role="row" key={week[0]!.key} className="cal-row">
                {week.map((day) => (
                  <DayCell
                    key={day.key}
                    day={day}
                    items={byDate.get(day.key) ?? []}
                    tasks={tasksByDate.get(day.key) ?? []}
                    doneStatusIds={doneStatusIds}
                    maxChips={maxChips}
                    isToday={day.key === today}
                    isCursor={day.key === cursorKey}
                    loading={isLoading}
                    onKeyDown={onCellKeyDown(day)}
                    onFocus={() => setCursor(day.key)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      {hint && <p className="cal-hint">{hint}</p>}
    </section>
  );
}
