/**
 * 未排程任務拖到時間軸排程（docs/design/gantt-overview.md §A7）。
 * - ScheduleDnd：包住甘特圖與未排程區，提供 DndContext（狀態見 useScheduleDnd.ts）、拖曳浮層與 aria-live 播報。
 * - UnscheduledRow：未排程區的一列；整列按住拖曳（移動 6px 才啟動，不影響「排入日期」與點標題開詳情），
 *   左側把手可聚焦後以鍵盤拖曳。
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { DndContext, DragOverlay, useDraggable } from '@dnd-kit/core';
import type { Task } from '../../../shared/tasks.ts';
import { statusStyle, type StatusTone } from '../../lib/colors.ts';
import { openTask } from '../../lib/openTask.ts';
import { Avatar, Button, Icon, UpdatedAt } from '../../ui/index.ts';
import type { ScheduleDndState } from './useScheduleDnd.ts';

const SR_INSTRUCTIONS = {
  draggable: '按空白鍵拿起，左右方向鍵移動日期，上下方向鍵切換分組列，再按空白鍵放下，Esc 取消',
};
const NO_ANNOUNCEMENTS = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

const scheduleDragId = (taskId: number) => `gantt-sched:${taskId}`;

/** DndContext + 拖曳浮層 + aria-live（包住甘特圖與未排程區） */
export function ScheduleDnd({ dnd, children }: { dnd: ScheduleDndState; children: ReactNode }) {
  const { drag, hasTarget, message } = dnd;
  return (
    <>
      <DndContext
        sensors={dnd.sensors}
        autoScroll={false}
        accessibility={{ announcements: NO_ANNOUNCEMENTS, screenReaderInstructions: SR_INSTRUCTIONS }}
        onDragStart={dnd.onDragStart}
        onDragEnd={dnd.onDragEnd}
        onDragCancel={dnd.onDragCancel}
      >
        {children}
        {/* 落點在時間軸上時改由預覽長條呈現，浮層隱藏；放下不播放回彈動畫 */}
        <DragOverlay dropAnimation={null}>
          {drag && !drag.keyboard && !hasTarget ? (
            <div className="gantt-sched-overlay" aria-hidden="true">
              <Icon name="grip" size={14} />
              <span className="gantt-sched-overlay-title">{drag.task.title}</span>
              <span className="gantt-sched-overlay-hint">拖到時間軸上排程</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <div className="sr-only" aria-live="assertive" aria-atomic="true" data-testid="gantt-sched-live">
        {message}
      </div>
    </>
  );
}

/** 未排程區的一列（含拖曳把手） */
export function UnscheduledRow({
  task,
  tone,
  statusName,
  assigneeName,
  flash,
  draggable,
  onRequestDates,
}: {
  task: Task;
  tone: StatusTone;
  statusName?: string;
  assigneeName: string;
  flash: boolean;
  /** 有 tasks.edit 且甘特圖可放置時才可拖曳（否則不顯示把手） */
  draggable: boolean;
  onRequestDates: (anchor: HTMLElement) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: scheduleDragId(task.id),
    data: { task },
    disabled: !draggable,
    attributes: { roleDescription: '可拖曳排程的任務' },
  });

  // 整列按住拖曳；「排入日期」鈕上按下不啟動拖曳
  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.gantt-unscheduled-action')) return;
    listeners?.onMouseDown?.(e);
  };
  const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.gantt-unscheduled-action')) return;
    listeners?.onTouchStart?.(e);
  };
  const onHandleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    listeners?.onKeyDown?.(e);
  };

  return (
    <div
      ref={setNodeRef}
      className={[
        'gantt-unscheduled-row',
        flash && 'is-flash',
        draggable && 'is-draggable',
        isDragging && 'is-dragging',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={`unscheduled-${task.id}`}
      data-assignee={task.assigneeId ?? 'none'}
      onMouseDown={draggable ? onMouseDown : undefined}
      onTouchStart={draggable ? onTouchStart : undefined}
    >
      <div className="gantt-unscheduled-main">
        {draggable && (
          <button
            type="button"
            ref={setActivatorNodeRef}
            className="gantt-sched-handle"
            {...attributes}
            aria-label={`拖曳「${task.title}」到時間軸排程`}
            onKeyDown={onHandleKeyDown}
          >
            <Icon name="grip" size={14} />
          </button>
        )}
        <span className="gantt-status-dot" style={statusStyle(tone)} title={statusName} />
        <button
          type="button"
          className="gantt-unscheduled-title"
          onClick={() => openTask(task.id)}
          title={task.title}
        >
          {task.title}
        </button>
      </div>
      <div className="gantt-unscheduled-rest">
        <span className="gantt-unscheduled-assignee">
          <Avatar userId={task.assigneeId} size="sm" />
          <span className="gantt-unscheduled-assignee-name">{assigneeName}</span>
        </span>
        <UpdatedAt at={task.updatedAt} by={task.updatedBy} prefix="更新於" />
        <Button
          className="gantt-unscheduled-action"
          variant="secondary"
          size="sm"
          onClick={(e) => onRequestDates(e.currentTarget)}
          aria-haspopup="dialog"
        >
          排入日期
        </Button>
      </div>
    </div>
  );
}
