import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../../shared/tasks.ts';
import { Button, Field, Input } from '../../ui/index.ts';

export type DatePopoverState = { task: Task; anchor: DOMRect };

/**
 * 「排入日期」Popover：開始日、到期日；到期日早於開始日時顯示錯誤並停用儲存。
 * 兩個日期皆未設定時都預填今天，可直接按「儲存」。
 */
export function DatePopover({
  state,
  today,
  saving,
  onSave,
  onClose,
}: {
  state: DatePopoverState;
  today?: string;
  saving?: boolean;
  onSave: (patch: { startDate: string | null; dueDate: string | null }) => void;
  onClose: () => void;
}) {
  const { task, anchor } = state;
  const blank = !task.startDate && !task.dueDate;
  const [start, setStart] = useState(task.startDate ?? (blank ? (today ?? '') : ''));
  const [due, setDue] = useState(task.dueDate ?? (blank ? (today ?? '') : ''));
  const ref = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);

  const invalid = !!start && !!due && due < start;
  const empty = !start && !due;
  const width = 280;
  const left = Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8));
  const below = anchor.bottom + 6;
  const top = below + 240 > window.innerHeight ? Math.max(8, anchor.top - 246) : below;

  return (
    <div
      ref={ref}
      className="gantt-popover"
      role="dialog"
      aria-label={`設定「${task.title}」的日期`}
      style={{ left, top }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="gantt-popover-title">{task.title}</div>
      <form
        style={{ display: 'contents' }}
        onSubmit={(e) => {
          e.preventDefault();
          if (invalid || empty) return;
          onSave({ startDate: start || null, dueDate: due || null });
        }}
      >
        <Field label="開始日">
          <Input
            ref={firstRef}
            type="date"
            size="sm"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>
        <Field label="到期日" error={invalid ? '到期日不可早於開始日' : undefined}>
          <Input type="date" size="sm" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <div className="gantt-popover-actions">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={invalid || empty} loading={saving}>
            儲存
          </Button>
        </div>
      </form>
    </div>
  );
}
