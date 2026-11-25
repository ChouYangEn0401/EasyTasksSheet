/**
 * 未排程任務拖到時間軸排程（docs/design/gantt-overview.md §A7）的拖曳狀態：dnd-kit 感應器與事件、aria-live 播報文字。
 * 落點（日期 + 分組列）由 Gantt 依指標座標或鍵盤計算後回報（onScheduleTarget），不使用 dnd-kit 的 droppable。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { getEventCoordinates } from '@dnd-kit/utilities';
import type { Task } from '../../../shared/tasks.ts';
import { suspendGlobalShortcuts } from '../../lib/shortcuts.ts';
import { truncate } from '../../lib/toast.ts';
import type { GanttHandle, ScheduleDrag } from './Gantt.tsx';
import { announceSchedule, type KeyboardMove, type ScheduleTarget } from './scheduleDrop.ts';

const KEY_CODES = { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] };
const ARROWS: string[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

/** 拖曳排程的狀態與事件（GanttPage 取得 drag / onScheduleTarget 傳給 Gantt，其餘交給 <ScheduleDnd>） */
export function useScheduleDnd({
  ganttRef,
  onDrop,
}: {
  ganttRef: RefObject<GanttHandle | null>;
  onDrop: (task: Task, target: ScheduleTarget, keyboard: boolean) => void;
}) {
  const [drag, setDrag] = useState<ScheduleDrag | null>(null);
  const dragRef = useRef<ScheduleDrag | null>(null);
  const targetRef = useRef<ScheduleTarget | null>(null);
  const [hasTarget, setHasTarget] = useState(false);
  const [message, setMessage] = useState('');
  /** 鍵盤拿起時的說明，與第一個落點一起播報 */
  const pickupRef = useRef<string | null>(null);

  const onScheduleTarget = useCallback((t: ScheduleTarget | null) => {
    const d = dragRef.current;
    if (!d) return;
    targetRef.current = t;
    setHasTarget(!!t);
    const text = t ? announceSchedule.target(t) : d.keyboard ? '' : announceSchedule.outside;
    const pickup = pickupRef.current;
    pickupRef.current = null;
    setMessage(pickup ? `${pickup}。${text}` : text);
  }, []);

  // 拖曳中：停用全域快捷鍵；Esc 只用於取消拖曳（不讓抽屜關閉）；禁止選取文字
  const dragging = drag != null;
  const pointerMode = drag != null && !drag.keyboard;
  useEffect(() => {
    if (!dragging) return;
    const release = suspendGlobalShortcuts();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    document.body.dataset.ganttScheduling = 'true';
    return () => {
      release();
      window.removeEventListener('keydown', onKey, true);
      delete document.body.dataset.ganttScheduling;
    };
  }, [dragging]);

  // 指標拖曳：把指標座標交給甘特圖計算落點
  useEffect(() => {
    if (!pointerMode) return;
    const onPointer = (e: PointerEvent) => ganttRef.current?.schedulePointer(e.clientX, e.clientY);
    const onTouch = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) ganttRef.current?.schedulePointer(t.clientX, t.clientY);
    };
    window.addEventListener('pointermove', onPointer, true);
    window.addEventListener('touchmove', onTouch, true);
    return () => {
      window.removeEventListener('pointermove', onPointer, true);
      window.removeEventListener('touchmove', onTouch, true);
    };
  }, [pointerMode, ganttRef]);

  /** 鍵盤拖曳：方向鍵交給甘特圖移動落點（座標不動，落點不靠碰撞偵測） */
  const coordinateGetter = useCallback<KeyboardCoordinateGetter>(
    (event) => {
      if (!dragRef.current || !ARROWS.includes(event.code)) return undefined;
      event.preventDefault();
      ganttRef.current?.scheduleKey(event.code as KeyboardMove, event.shiftKey);
      return undefined;
    },
    [ganttRef],
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter, keyboardCodes: KEY_CODES }),
  );

  const finish = () => {
    dragRef.current = null;
    targetRef.current = null;
    pickupRef.current = null;
    setDrag(null);
    setHasTarget(false);
  };

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const task = (active.data.current as { task?: Task } | undefined)?.task;
    if (!task) return;
    const keyboard = activatorEvent instanceof globalThis.KeyboardEvent;
    const d = { task, keyboard };
    dragRef.current = d;
    targetRef.current = null;
    setDrag(d);
    setHasTarget(false);
    const title = truncate(task.title);
    pickupRef.current = keyboard ? announceSchedule.pickup(title) : null;
    if (!keyboard) setMessage(`已拿起『${title}』，拖到時間軸上排程`);
    ganttRef.current?.scheduleBegin(task, keyboard);
    if (!keyboard) {
      const c = getEventCoordinates(activatorEvent);
      if (c) ganttRef.current?.schedulePointer(c.x, c.y);
    }
  };

  const onDragCancel = () => {
    const d = dragRef.current;
    finish();
    if (d) setMessage(announceSchedule.cancel(truncate(d.task.title)));
  };

  const onDragEnd = (_e: DragEndEvent) => {
    const d = dragRef.current;
    const t = targetRef.current;
    if (!d) return;
    if (!t) return onDragCancel();
    finish();
    setMessage(announceSchedule.drop(truncate(d.task.title), t.start, t.end));
    onDrop(d.task, t, d.keyboard);
  };

  return { drag, hasTarget, message, onScheduleTarget, sensors, onDragStart, onDragEnd, onDragCancel };
}

export type ScheduleDndState = ReturnType<typeof useScheduleDnd>;
