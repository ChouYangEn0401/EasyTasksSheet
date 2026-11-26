import { createElement, Fragment } from 'preact';
/**
 * 未排程任務拖到時間軸排程（docs/design/gantt-overview.md §A7）。
 * - ScheduleDnd：包住甘特圖與未排程區，提供 DndContext（狀態見 useScheduleDnd.ts）、拖曳浮層與 aria-live 播報。
 * - UnscheduledRow：未排程區的一列；整列按住拖曳（移動 6px 才啟動，不影響「排入日期」與點標題開詳情），
 *   左側把手可聚焦後以鍵盤拖曳。
 */

import { DndContext, DragOverlay, useDraggable } from '../../lib/dnd.js';
import { statusStyle } from '../../lib/colors.js';
import { openTask } from '../../lib/openTask.js';
import { Avatar, Button, Icon, UpdatedAt } from '../../ui/index.js';

const SR_INSTRUCTIONS = {
  draggable: '按空白鍵拿起，左右方向鍵移動日期，上下方向鍵切換分組列，再按空白鍵放下，Esc 取消',
};
const NO_ANNOUNCEMENTS = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

const scheduleDragId = (taskId) => `gantt-sched:${taskId}`;

/** DndContext + 拖曳浮層 + aria-live（包住甘特圖與未排程區） */
export function ScheduleDnd({ dnd, children }) {
  const { drag, hasTarget, message } = dnd;
  return createElement(
    Fragment,
    null,
    createElement(
      DndContext,
      {
        sensors: dnd.sensors,
        autoScroll: false,
        accessibility: { announcements: NO_ANNOUNCEMENTS, screenReaderInstructions: SR_INSTRUCTIONS },
        onDragStart: dnd.onDragStart,
        onDragEnd: dnd.onDragEnd,
        onDragCancel: dnd.onDragCancel,
      },
      children,
      createElement(
        DragOverlay,
        { dropAnimation: null },
        drag && !drag.keyboard && !hasTarget
          ? createElement(
              'div',
              { className: 'gantt-sched-overlay', 'aria-hidden': 'true' },
              createElement(Icon, { name: 'grip', size: 14 }),
              createElement('span', { className: 'gantt-sched-overlay-title' }, drag.task.title),
              createElement('span', { className: 'gantt-sched-overlay-hint' }, '拖到時間軸上排程'),
            )
          : null,
      ),
    ),
    createElement(
      'div',
      {
        className: 'sr-only',
        'aria-live': 'assertive',
        'aria-atomic': 'true',
        'data-testid': 'gantt-sched-live',
      },
      message,
    ),
  );
}

/** 未排程區的一列（含拖曳把手） */
export function UnscheduledRow({ task, tone, statusName, assigneeName, flash, draggable, onRequestDates }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: scheduleDragId(task.id),
    data: { task },
    disabled: !draggable,
    attributes: { roleDescription: '可拖曳排程的任務' },
  });

  // 整列按住拖曳；「排入日期」鈕上按下不啟動拖曳
  const onMouseDown = (e) => {
    if (e.target.closest('.gantt-unscheduled-action')) return;
    listeners?.onMouseDown?.(e);
  };
  const onTouchStart = (e) => {
    if (e.target.closest('.gantt-unscheduled-action')) return;
    listeners?.onTouchStart?.(e);
  };
  const onHandleKeyDown = (e) => {
    listeners?.onKeyDown?.(e);
  };

  return createElement(
    'div',
    {
      ref: setNodeRef,
      className: [
        'gantt-unscheduled-row',
        flash && 'is-flash',
        draggable && 'is-draggable',
        isDragging && 'is-dragging',
      ]
        .filter(Boolean)
        .join(' '),
      'data-testid': `unscheduled-${task.id}`,
      'data-assignee': task.assigneeId ?? 'none',
      onMouseDown: draggable ? onMouseDown : undefined,
      onTouchStart: draggable ? onTouchStart : undefined,
    },
    createElement(
      'div',
      { className: 'gantt-unscheduled-main' },
      draggable &&
        createElement(
          'button',
          {
            type: 'button',
            ref: setActivatorNodeRef,
            className: 'gantt-sched-handle',
            ...attributes,
            'aria-label': `拖曳「${task.title}」到時間軸排程`,
            onKeyDown: onHandleKeyDown,
          },
          createElement(Icon, { name: 'grip', size: 14 }),
        ),
      createElement('span', { className: 'gantt-status-dot', style: statusStyle(tone), title: statusName }),
      createElement(
        'button',
        {
          type: 'button',
          className: 'gantt-unscheduled-title',
          onClick: () => openTask(task.id),
          title: task.title,
        },
        task.title,
      ),
    ),
    createElement(
      'div',
      { className: 'gantt-unscheduled-rest' },
      createElement(
        'span',
        { className: 'gantt-unscheduled-assignee' },
        createElement(Avatar, { userId: task.assigneeId, size: 'sm' }),
        createElement('span', { className: 'gantt-unscheduled-assignee-name' }, assigneeName),
      ),
      createElement(UpdatedAt, { at: task.updatedAt, by: task.updatedBy, prefix: '更新於' }),
      createElement(
        Button,
        {
          className: 'gantt-unscheduled-action',
          variant: 'secondary',
          size: 'sm',
          onClick: (e) => onRequestDates(e.currentTarget),
          'aria-haspopup': 'dialog',
        },
        '排入日期',
      ),
    ),
  );
}
