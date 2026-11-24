import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Status } from '../../../shared/projects.ts';
import type { Task } from '../../../shared/tasks.ts';
import { statusStyle, statusTone } from '../../lib/colors.ts';
import type { TaskFilters } from '../../lib/filters.ts';
import { Badge, Button, Skeleton } from '../../ui/index.ts';
import { QuickAdd } from '../tasks/QuickAdd.tsx';
import {
  COLUMN_PAGE_SIZE,
  columnId,
  formatHours,
  matchesFilters,
  quickAddDefaults,
  sumHours,
} from './kanbanModel.ts';

const NOTE_MS = 6_000;

type ColumnMainProps = {
  status: Status;
  tasks: Task[];
  index: number;
  expanded: boolean;
  dropTarget: boolean;
  onExpand: (statusId: number) => void;
  /** 建立成功後要捲到底的任務 id（出現在本欄後捲動） */
  scrollToTaskId: number | null;
  children: (visible: Task[]) => ReactNode;
};

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
}: ColumnMainProps) {
  const { setNodeRef } = useDroppable({ id: columnId(status.id) });
  const headingId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
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

  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-labelledby={headingId}
      data-status-id={status.id}
      className={`kanban-col${dropTarget ? ' is-over' : ''}`}
      style={{ gridColumn: index + 1, ...statusStyle(statusTone(status)) }}
    >
      <div className={`kanban-col-head${scrolled ? ' is-scrolled' : ''}`}>
        <span className="kanban-col-dot" aria-hidden="true" />
        <span id={headingId} className="kanban-col-name truncate">
          {status.name}
        </span>
        <Badge count>
          <span aria-label={`${tasks.length} 張`}>{tasks.length}</span>
        </Badge>
        {!isDone && hours > 0 && (
          <span className="kanban-col-sum" aria-label={`預估合計 ${formatHours(hours)}`}>
            Σ {formatHours(hours)}
          </span>
        )}
      </div>
      <div
        ref={bodyRef}
        className="kanban-col-body"
        role="list"
        aria-labelledby={headingId}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        <SortableContext items={visible.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {children(visible)}
        </SortableContext>
        {tasks.length === 0 && <div className="kanban-col-empty">拖曳卡片到這裡</div>}
        {rest > 0 && (
          <Button variant="ghost" fullWidth className="kanban-col-more" onClick={() => onExpand(status.id)}>
            顯示其餘 {rest} 筆
          </Button>
        )}
      </div>
    </div>
  );
}

type ColumnFootProps = {
  status: Status;
  tasks: Task[];
  index: number;
  filters: TaskFilters;
  dropTarget: boolean;
  onCreated: (task: Task, matched: boolean) => void;
  onClearFilters: () => void;
};

/** 欄尾 QuickAdd（獨立一列，使 Tab 順序為「看板卡片 → 各欄 QuickAdd」） */
export function KanbanColumnFoot({
  status,
  tasks,
  index,
  filters,
  dropTarget,
  onCreated,
  onClearFilters,
}: ColumnFootProps) {
  const [note, setNote] = useState(0);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(0), NOTE_MS);
    return () => window.clearTimeout(t);
  }, [note]);
  const last = tasks[tasks.length - 1];

  return (
    <div
      role="group"
      aria-label={`新增任務到「${status.name}」`}
      data-quickadd-status={status.id}
      className={`kanban-col-foot${dropTarget ? ' is-over' : ''}`}
      style={{ gridColumn: index + 1 }}
    >
      <QuickAdd
        fullWidth
        placeholder="新增任務…"
        defaults={quickAddDefaults(status.id, filters, last ? last.sortOrder : null)}
        onCreated={(task) => {
          const matched = matchesFilters(task, filters);
          if (!matched) setNote(Date.now());
          else setNote(0);
          onCreated(task, matched);
        }}
      />
      <div className="kanban-col-note" aria-live="polite">
        {note ? (
          <>
            已建立，但不符合目前篩選{' '}
            <button
              type="button"
              className="kanban-link"
              onClick={() => {
                setNote(0);
                onClearFilters();
              }}
            >
              清除篩選
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** 首次載入：4 個骨架欄，每欄 3 張骨架卡 */
export function KanbanSkeleton() {
  return (
    <div className="kanban-board" aria-busy="true" aria-label="載入中">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="kanban-col" style={{ gridColumn: i + 1 }}>
          <div className="kanban-col-head">
            <Skeleton width={80} height={14} />
          </div>
          <div className="kanban-col-body">
            {Array.from({ length: 3 }, (_, j) => (
              <Skeleton key={j} height={84} style={{ borderRadius: 'var(--radius-md)', display: 'block' }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
