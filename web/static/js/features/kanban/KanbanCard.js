import { createElement, Fragment } from 'preact';
import { useEffect, useRef } from 'preact/compat';
import { useSortable } from '../../lib/dnd.js';
import { CSS } from '../../lib/dnd.js';
import { fxAttr, motionEasing, motionMs } from '../../lib/motion.js';
import { Avatar, ColorDot, UpdatedAt } from '../../ui/index.js';
import { PinButton } from '../personal/PinButton.js';
import { TaskPresenceDots } from '../presence/TaskPresence.js';
import { RelationBadge } from '../tasks/RelationBadge.js';
import { BlockedLock, DependencyBadges } from '../delay-link/DependencyBadge.js';
import { dependencyAriaSuffix, useDependencyCardClass } from '../delay-link/depFields.js';
import { ChecklistBadge } from '../tasks/ChecklistBadge.js';
import { TaskBadges } from '../tasks/TaskBadges.js';
import { cardAriaLabel, dueDisplay, formatHours } from './kanbanModel.js';

/** 16px 線條圖示（core Icon 尚無日曆 / 時鐘，僅供卡片中繼列使用） */
function MetaIcon({ name }) {
  const d =
    name === 'calendar'
      ? 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4'
      : 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2';
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
      className: 'kanban-meta-icon',
    },
    createElement('path', { d: d }),
  );
}

const stop = (e) => e.stopPropagation();

/** 卡片內容（清單中的卡片與拖曳浮層共用） */
export function KanbanCardContent({ task, project, showProject, isDone }) {
  const due = dueDisplay(task.dueDate, isDone);
  return createElement(
    Fragment,
    null,
    showProject &&
      createElement(
        'div',
        { className: 'kanban-card-project' },
        createElement(ColorDot, { color: project?.color }),
        createElement('span', { className: 'truncate' }, project?.name ?? '—'),
      ),
    createElement(
      'span',
      {
        className: 'kanban-card-pin',
        onPointerDown: stop,
        onMouseDown: stop,
        onTouchStart: stop,
        onClick: stop,
        onKeyDown: stop,
      },
      createElement(PinButton, { taskId: task.id, size: 'sm' }),
    ),
    createElement(
      'div',
      { className: 'kanban-card-title' },
      createElement(BlockedLock, { task: task }),
      task.title,
      createElement(TaskBadges, { task: task }),
    ),
    task.id > 0 && createElement(TaskPresenceDots, { taskId: task.id }),
    createElement(
      'div',
      { className: 'kanban-card-meta' },
      createElement(Avatar, { userId: task.assigneeId, size: 'sm' }),
      due &&
        createElement(
          'span',
          {
            className: `kanban-meta-item kanban-due${due.tone !== 'normal' ? ` kanban-due--${due.tone}` : ''}`,
          },
          createElement(MetaIcon, { name: 'calendar' }),
          due.text,
        ),
      createElement(RelationBadge, { count: task.relationCount }),
      task.id > 0 && createElement(ChecklistBadge, { task: task }),
      task.estimateHours != null &&
        createElement(
          'span',
          { className: 'kanban-meta-item' },
          createElement(MetaIcon, { name: 'clock' }),
          formatHours(task.estimateHours),
        ),
      createElement(
        'span',
        { className: 'kanban-card-updated' },
        createElement(UpdatedAt, { at: task.updatedAt, by: task.updatedBy }),
      ),
    ),
    createElement(DependencyBadges, { task: task, isDone: isDone }),
  );
}

/** 可拖曳的任務卡片（role="listitem"，dnd-kit sortable） */
export function KanbanCard(props) {
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
  const nodeRef = useRef(null);
  const depClass = useDependencyCardClass(task, props.isDone);

  // UpdatedAt 預設可聚焦；為維持 roving tabindex，卡片內的時間不進入 Tab 順序
  useEffect(() => {
    nodeRef.current?.querySelectorAll('time[tabindex="0"]').forEach((el) => (el.tabIndex = -1));
  });

  // 鍵盤拖曳跨欄時卡片會重新掛載，需把 focus 拉回
  useEffect(() => {
    const el = nodeRef.current;
    if (keyboardActive && el && document.activeElement !== el) el.focus({ preventScroll: true });
  });

  const onClick = (e) => {
    if (e.defaultPrevented) return;
    onOpen(task.id);
  };

  return createElement(
    'div',
    {
      ref: (el) => {
        nodeRef.current = el;
        setNodeRef(el);
      },
      ...attributes,
      ...listeners,
      onKeyDown: (e) => {
        onNavKey(e, task.id);
        if (!e.defaultPrevented) listeners?.onKeyDown?.(e);
      },
      onFocus: (e) => {
        if (e.target === e.currentTarget) onFocusCard(task.id);
      },
      onClick: onClick,
      'aria-label': cardAriaLabel(task, assigneeName) + dependencyAriaSuffix(task),
      'aria-current': selected ? 'true' : undefined,
      'data-task-id': task.id,
      ...fxAttr(isDragging ? undefined : fx),
      className: [
        'kanban-card',
        selected && 'is-selected',
        isDragging && 'is-placeholder',
        isDragging && keyboardActive && 'is-keyboard',
        depClass,
      ]
        .filter(Boolean)
        .join(' '),
      style: { transform: CSS.Translate.toString(transform), transition },
    },
    createElement(KanbanCardContent, { ...props }),
  );
}

/** 拖曳浮層 */
export function KanbanCardOverlay(props) {
  return createElement(
    'div',
    { className: `kanban-card is-overlay${props.keyboard ? ' is-keyboard' : ''}`, 'aria-hidden': 'true' },
    createElement(KanbanCardContent, { ...props }),
  );
}
