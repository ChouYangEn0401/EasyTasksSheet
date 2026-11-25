import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type SyntheticEvent } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Project } from '../../../shared/projects.ts';
import type { Task } from '../../../shared/tasks.ts';
import { fxAttr, motionEasing, motionMs, type ItemFx } from '../../lib/motion.ts';
import { Avatar, ColorDot, UpdatedAt } from '../../ui/index.ts';
import { PinButton } from '../personal/PinButton.tsx';
import { TaskPresenceDots } from '../presence/TaskPresence.tsx';
import { cardAriaLabel, dueDisplay, formatHours } from './kanbanModel.ts';

/** 16px 線條圖示（core Icon 尚無日曆 / 時鐘，僅供卡片中繼列使用） */
function MetaIcon({ name }: { name: 'calendar' | 'clock' }) {
  const d =
    name === 'calendar'
      ? 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4'
      : 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2';
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
      className="kanban-meta-icon"
    >
      <path d={d} />
    </svg>
  );
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

export type CardViewProps = {
  task: Task;
  project: Project | undefined;
  showProject: boolean;
  isDone: boolean;
};

/** 卡片內容（清單中的卡片與拖曳浮層共用） */
export function KanbanCardContent({ task, project, showProject, isDone }: CardViewProps) {
  const due = dueDisplay(task.dueDate, isDone);
  return (
    <>
      {showProject && (
        <div className="kanban-card-project">
          <ColorDot color={project?.color} />
          <span className="truncate">{project?.name ?? '—'}</span>
        </div>
      )}
      <span
        className="kanban-card-pin"
        onPointerDown={stop}
        onMouseDown={stop}
        onTouchStart={stop}
        onClick={stop}
        onKeyDown={stop}
      >
        <PinButton taskId={task.id} size="sm" />
      </span>
      <div className="kanban-card-title">{task.title}</div>
      {task.id > 0 && <TaskPresenceDots taskId={task.id} />}
      <div className="kanban-card-meta">
        <Avatar userId={task.assigneeId} size="sm" />
        {due && (
          <span
            className={`kanban-meta-item kanban-due${due.tone !== 'normal' ? ` kanban-due--${due.tone}` : ''}`}
          >
            <MetaIcon name="calendar" />
            {due.text}
          </span>
        )}
        {task.estimateHours != null && (
          <span className="kanban-meta-item">
            <MetaIcon name="clock" />
            {formatHours(task.estimateHours)}
          </span>
        )}
        <span className="kanban-card-updated">
          <UpdatedAt at={task.updatedAt} by={task.updatedBy} />
        </span>
      </div>
    </>
  );
}

export type KanbanCardProps = CardViewProps & {
  assigneeName: string | null | undefined;
  /** roving tabindex：整個看板只有一張卡片為 0 */
  tabbable: boolean;
  selected: boolean;
  /** 鍵盤拖曳中的卡片：重新掛載後維持 focus */
  keyboardActive: boolean;
  reducedMotion: boolean;
  /** 項目效果（他人更新 / 新增的高亮） */
  fx?: ItemFx;
  onOpen: (id: number) => void;
  onFocusCard: (id: number) => void;
  onNavKey: (e: KeyboardEvent<HTMLDivElement>, id: number) => void;
};

/** 可拖曳的任務卡片（role="listitem"，dnd-kit sortable） */
export function KanbanCard(props: KanbanCardProps) {
  const {
    task,
    assigneeName,
    tabbable,
    selected,
    keyboardActive,
    reducedMotion,
    fx,
    onOpen,
    onFocusCard,
    onNavKey,
  } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    attributes: { role: 'listitem', roleDescription: '可拖曳的任務卡片', tabIndex: tabbable ? 0 : -1 },
    // 讓位：--duration-base / --ease-standard
    transition: reducedMotion
      ? null
      : { duration: motionMs('--duration-base'), easing: motionEasing('--ease-standard') },
  });
  const nodeRef = useRef<HTMLDivElement | null>(null);

  // UpdatedAt 預設可聚焦；為維持 roving tabindex，卡片內的時間不進入 Tab 順序
  useEffect(() => {
    nodeRef.current?.querySelectorAll<HTMLElement>('time[tabindex="0"]').forEach((el) => (el.tabIndex = -1));
  });

  // 鍵盤拖曳跨欄時卡片會重新掛載，需把 focus 拉回
  useEffect(() => {
    const el = nodeRef.current;
    if (keyboardActive && el && document.activeElement !== el) el.focus({ preventScroll: true });
  });

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    onOpen(task.id);
  };

  return (
    <div
      ref={(el) => {
        nodeRef.current = el;
        setNodeRef(el);
      }}
      {...attributes}
      {...listeners}
      onKeyDown={(e) => {
        onNavKey(e, task.id);
        if (!e.defaultPrevented) listeners?.onKeyDown?.(e);
      }}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onFocusCard(task.id);
      }}
      onClick={onClick}
      aria-label={cardAriaLabel(task, assigneeName)}
      aria-current={selected ? 'true' : undefined}
      data-task-id={task.id}
      {...fxAttr(isDragging ? undefined : fx)}
      className={[
        'kanban-card',
        selected && 'is-selected',
        isDragging && 'is-placeholder',
        isDragging && keyboardActive && 'is-keyboard',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <KanbanCardContent {...props} />
    </div>
  );
}

/** 拖曳浮層 */
export function KanbanCardOverlay(props: CardViewProps & { keyboard: boolean }) {
  return (
    <div className={`kanban-card is-overlay${props.keyboard ? ' is-keyboard' : ''}`} aria-hidden="true">
      <KanbanCardContent {...props} />
    </div>
  );
}
