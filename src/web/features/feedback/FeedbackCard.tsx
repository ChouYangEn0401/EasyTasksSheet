import { useDraggable } from '@dnd-kit/core';
import type { KeyboardEvent } from 'react';
import { FEEDBACK_KIND_LABELS, type FeedbackItem } from '../../../shared/feedback.ts';
import { isOverdue } from '../../lib/format.ts';
import { useUsersById } from '../../lib/hooks.ts';
import { Avatar, Badge, Button, Icon, Menu, UpdatedAt } from '../../ui/index.ts';
import { monthDay } from '../calendar/dates.ts';
import { handleItemKey, itemMenu, kindTone, useFeedbackActions, type DragData } from './actions.ts';

/** ⋯ 圖示（core Icon 無此圖形，於本 feature 內自備） */
export function MoreIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

/** 解決圈：一次點擊標記已解決 / 重新開啟 */
function ResolveToggle({ item }: { item: FeedbackItem }) {
  const actions = useFeedbackActions();
  const resolved = item.status === 'resolved';
  return (
    <button
      type="button"
      className="fb-resolve"
      data-resolved={resolved || undefined}
      aria-label={resolved ? `重新開啟「${item.title}」` : `標記「${item.title}」為已解決`}
      aria-pressed={resolved}
      onClick={(e) => {
        e.stopPropagation();
        actions.toggleResolved(item);
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {resolved && <Icon name="check" size={12} strokeWidth={2.5} />}
    </button>
  );
}

/** 卡片內容（清單卡片與拖曳浮層共用） */
export function FeedbackCardBody({
  item,
  interactive = true,
}: {
  item: FeedbackItem;
  interactive?: boolean;
}) {
  const actions = useFeedbackActions();
  const usersById = useUsersById();
  const assignee = item.assigneeId != null ? usersById.get(item.assigneeId) : undefined;
  const resolved = item.status === 'resolved';
  return (
    <>
      {interactive ? <ResolveToggle item={item} /> : <span className="fb-resolve" aria-hidden="true" />}
      <div className="fb-card-main">
        <div className="fb-card-title-row">
          <Badge tone={kindTone(item.kind)}>{FEEDBACK_KIND_LABELS[item.kind]}</Badge>
          <span className="fb-card-title">{item.title}</span>
        </div>
        <div className="fb-card-meta">
          <Avatar user={assignee} size="xs" tooltip={false} />
          <span className="fb-card-assignee">{assignee?.displayName ?? '未指派'}</span>
          {item.scheduledDate && item.status !== 'open' && (
            <>
              <span aria-hidden="true">·</span>
              <span
                className="fb-card-date"
                data-overdue={(!resolved && isOverdue(item.scheduledDate)) || undefined}
                aria-label={`排程 ${item.scheduledDate}`}
              >
                {monthDay(item.scheduledDate)}
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          {interactive ? (
            <span onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
              <UpdatedAt at={item.updatedAt} by={item.updatedBy} />
            </span>
          ) : (
            <UpdatedAt at={item.updatedAt} by={item.updatedBy} />
          )}
        </div>
      </div>
      {interactive && (
        <span
          className="fb-card-more"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Menu
            align="end"
            label="項目動作"
            items={itemMenu(item, actions)}
            trigger={(props) => (
              <Button
                {...props}
                variant="ghost"
                size="sm"
                iconOnly
                icon={<MoreIcon />}
                aria-label={`「${item.title}」的更多動作`}
              />
            )}
          />
        </span>
      )}
    </>
  );
}

/** 清單項目卡：整張可拖曳（已解決除外），點擊開啟編輯 */
export function FeedbackCard({ item }: { item: FeedbackItem }) {
  const actions = useFeedbackActions();
  const resolved = item.status === 'resolved';
  const data: DragData = { item, source: 'list' };
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `card-${item.id}`,
    data,
    disabled: resolved,
  });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cards = [...document.querySelectorAll<HTMLElement>('[data-fb-card]')];
      const i = cards.indexOf(e.currentTarget);
      cards[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && handleItemKey(e.key, item, actions)) {
      e.preventDefault();
      return;
    }
    listeners?.onKeyDown?.(e);
  };
  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        setActivatorNodeRef(node);
      }}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      aria-roledescription={resolved ? '項目' : '可拖曳項目'}
      // 已解決只是不可拖曳，仍可點擊編輯與重新開啟（不沿用 dnd-kit 的 aria-disabled）
      aria-disabled={undefined}
      aria-label={`${FEEDBACK_KIND_LABELS[item.kind]}：${item.title}`}
      data-fb-card=""
      data-testid={`fb-card-${item.id}`}
      className="fb-card"
      data-resolved={resolved || undefined}
      data-dragging={isDragging || undefined}
      onKeyDown={onKeyDown}
      onClick={() => actions.edit(item)}
    >
      <FeedbackCardBody item={item} />
    </div>
  );
}
