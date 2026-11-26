import { createElement, Fragment } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/compat';
import { useDroppable } from '../../lib/dnd.js';
import { SortableContext, verticalListSortingStrategy } from '../../lib/dnd.js';
import { statusStyle, statusTone } from '../../lib/colors.js';
import { Badge, Button, Skeleton } from '../../ui/index.js';
import { QuickAdd } from '../tasks/QuickAdd.js';
import {
  COLUMN_PAGE_SIZE,
  columnId,
  formatHours,
  matchesFilters,
  quickAddDefaults,
  sumHours,
} from './kanbanModel.js';

const NOTE_MS = 6_000;

/** 欄首 + 欄身（droppable、sortable 容器） */
export function KanbanColumnMain({
  status,
  tasks,
  index,
  expanded,
  dropTarget,
  onExpand,
  scrollToTaskId,
  children,
}) {
  const { setNodeRef } = useDroppable({ id: columnId(status.id) });
  const headingId = useId();
  const bodyRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);
  const isDone = status.category === 'done';
  const hours = sumHours(tasks);
  const visible = expanded ? tasks : tasks.slice(0, COLUMN_PAGE_SIZE);
  const rest = tasks.length - visible.length;

  const hasTarget = scrollToTaskId != null && tasks.some((t) => t.id === scrollToTaskId);
  useEffect(() => {
    const el = bodyRef.current;
    if (hasTarget && el) el.scrollTop = el.scrollHeight;
  }, [hasTarget]);

  return createElement(
    'div',
    {
      ref: setNodeRef,
      role: 'group',
      'aria-labelledby': headingId,
      'data-status-id': status.id,
      className: `kanban-col${dropTarget ? ' is-over' : ''}`,
      style: { gridColumn: index + 1, ...statusStyle(statusTone(status)) },
    },
    createElement(
      'div',
      { className: `kanban-col-head${scrolled ? ' is-scrolled' : ''}` },
      createElement('span', { className: 'kanban-col-dot', 'aria-hidden': 'true' }),
      createElement('span', { id: headingId, className: 'kanban-col-name truncate' }, status.name),
      createElement(
        Badge,
        { count: true },
        createElement('span', { 'aria-label': `${tasks.length} 張` }, tasks.length),
      ),
      !isDone &&
        hours > 0 &&
        createElement(
          'span',
          { className: 'kanban-col-sum', 'aria-label': `預估合計 ${formatHours(hours)}` },
          'Σ ',
          formatHours(hours),
        ),
    ),
    createElement(
      'div',
      {
        ref: bodyRef,
        className: 'kanban-col-body',
        role: 'list',
        'aria-labelledby': headingId,
        onScroll: (e) => setScrolled(e.currentTarget.scrollTop > 0),
      },
      createElement(
        SortableContext,
        { items: visible.map((t) => t.id), strategy: verticalListSortingStrategy },
        children(visible),
      ),
      tasks.length === 0 && createElement('div', { className: 'kanban-col-empty' }, '拖曳卡片到這裡'),
      rest > 0 &&
        createElement(
          Button,
          {
            variant: 'ghost',
            fullWidth: true,
            className: 'kanban-col-more',
            onClick: () => onExpand(status.id),
          },
          '顯示其餘 ',
          rest,
          ' 筆',
        ),
    ),
  );
}

/** 欄尾 QuickAdd（獨立一列，使 Tab 順序為「看板卡片 → 各欄 QuickAdd」） */
export function KanbanColumnFoot({ status, tasks, index, filters, dropTarget, onCreated, onClearFilters }) {
  const [note, setNote] = useState(0);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(0), NOTE_MS);
    return () => window.clearTimeout(t);
  }, [note]);
  const last = tasks[tasks.length - 1];

  return createElement(
    'div',
    {
      role: 'group',
      'aria-label': `新增任務到「${status.name}」`,
      'data-quickadd-status': status.id,
      className: `kanban-col-foot${dropTarget ? ' is-over' : ''}`,
      style: { gridColumn: index + 1 },
    },
    createElement(QuickAdd, {
      fullWidth: true,
      placeholder: '新增任務…',
      defaults: quickAddDefaults(status.id, filters, last ? last.sortOrder : null),
      onCreated: (task) => {
        const matched = matchesFilters(task, filters);
        if (!matched) setNote(Date.now());
        else setNote(0);
        onCreated(task, matched);
      },
    }),
    createElement(
      'div',
      { className: 'kanban-col-note', 'aria-live': 'polite' },
      note
        ? createElement(
            Fragment,
            null,
            '已建立，但不符合目前篩選',
            ' ',
            createElement(
              'button',
              {
                type: 'button',
                className: 'kanban-link',
                onClick: () => {
                  setNote(0);
                  onClearFilters();
                },
              },
              '清除篩選',
            ),
          )
        : null,
    ),
  );
}

/** 首次載入：4 個骨架欄，每欄 3 張骨架卡 */
export function KanbanSkeleton() {
  return createElement(
    'div',
    { className: 'kanban-board', 'aria-busy': 'true', 'aria-label': '載入中' },
    Array.from({ length: 4 }, (_, i) =>
      createElement(
        'div',
        { key: i, className: 'kanban-col', style: { gridColumn: i + 1 } },
        createElement(
          'div',
          { className: 'kanban-col-head' },
          createElement(Skeleton, { width: 80, height: 14 }),
        ),
        createElement(
          'div',
          { className: 'kanban-col-body' },
          Array.from({ length: 3 }, (_, j) =>
            createElement(Skeleton, {
              key: j,
              height: 84,
              style: { borderRadius: 'var(--radius-md)', display: 'block' },
            }),
          ),
        ),
      ),
    ),
  );
}
