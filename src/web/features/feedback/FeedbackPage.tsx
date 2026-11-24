import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { errorMessage } from '../../lib/api.ts';
import { isEditableTarget } from '../../lib/shortcuts.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
import { Alert, Button } from '../../ui/index.ts';
import { dayLabel, parseMonthKey, shortDayLabel, toMonthKey } from '../calendar/dates.ts';
import { MonthCalendar } from '../calendar/MonthCalendar.tsx';
import {
  dayDropId,
  FeedbackActionsContext,
  LIST_DROP_ID,
  type DragData,
  type DropData,
  type FeedbackActions,
} from './actions.ts';
import { useFeedbackItems, useUpdateFeedback, type FeedbackPatch } from './api.ts';
import { FeedbackCardBody } from './FeedbackCard.tsx';
import { FeedbackDialogs, type DialogState } from './FeedbackDialogs.tsx';
import { FeedbackList } from './FeedbackList.tsx';
import { applyFilters, readFilters, writeFilters, type FeedbackFilters } from './model.ts';
import './feedback.css';

const SHOW_TASKS_KEY = 'feedback.calendar.showTasks';
const SCHEDULE_FAILED = '排程未儲存，已還原';

type Rect = Pick<ClientRect, 'left' | 'top' | 'width' | 'height'>;
const centerOf = (r: Rect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/**
 * 拖曳中的鍵盤操作：方向鍵移到相鄰日格（←→ ±1 天、↑↓ ±7 天），Home 移到清單（= 取消排程）。
 * 自清單拿起時第一下方向鍵落在今天（今天不在畫面上則為當月 1 日）。
 */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const { collisionRect, droppableRects, droppableContainers } = context;
  if (!collisionRect) return undefined;
  const to = (r: Rect) => {
    const c = centerOf(r);
    return { x: c.x - collisionRect.width / 2, y: c.y - collisionRect.height / 2 };
  };
  if (event.code === 'Home') {
    const rect = droppableRects.get(LIST_DROP_ID);
    if (!rect) return undefined;
    event.preventDefault();
    return to(rect);
  }
  const dirs: Record<string, [number, number]> = {
    ArrowRight: [1, 0],
    ArrowLeft: [-1, 0],
    ArrowDown: [0, 1],
    ArrowUp: [0, -1],
  };
  const dir = dirs[event.code];
  if (!dir) return undefined;
  event.preventDefault();
  const from = centerOf(collisionRect);
  const cells = droppableContainers
    .getEnabled()
    .filter((c) => (c.data.current as DropData | undefined)?.type === 'day');
  const onCalendar = cells.some((c) => {
    const r = droppableRects.get(c.id);
    if (!r) return false;
    const p = centerOf(r);
    return Math.abs(p.x - from.x) < 2 && Math.abs(p.y - from.y) < 2;
  });
  if (!onCalendar) {
    const cell =
      document.querySelector<HTMLElement>('[role="gridcell"][aria-current="date"]') ??
      document.querySelector<HTMLElement>('[role="gridcell"]:not([data-outside])');
    const rect = cell?.dataset.date ? droppableRects.get(dayDropId(cell.dataset.date)) : undefined;
    return rect ? to(rect) : undefined;
  }
  let best: { score: number; rect: Rect } | null = null;
  for (const c of cells) {
    const r = droppableRects.get(c.id);
    if (!r) continue;
    const p = centerOf(r);
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 2) continue;
    const score = along + Math.abs(dir[0] ? dy : dx) * 4;
    if (!best || score < best.score) best = { score, rect: r };
  }
  return best ? to(best.rect) : undefined;
};

/** 指標拖曳以指標位置判定；鍵盤拖曳（無指標座標）以最近中心判定 */
const collisionDetection: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

type WriteError = { message: string; retry?: () => void };

/** 區域二：問題 / 回饋清單 + 月曆（同一個拖曳 context；篩選與月份存在 URL） */
export function FeedbackPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readFilters(searchParams), [searchParams]);
  const monthParam = searchParams.get('month');
  const month = useMemo(
    () => parseMonthKey(monthParam) ?? parseMonthKey(toMonthKey(new Date()))!,
    [monthParam],
  );
  const query = useFeedbackItems();
  const update = useUpdateFeedback();
  const all = useMemo(() => query.data ?? [], [query.data]);
  const visible = useMemo(() => applyFilters(all, filters), [all, filters]);

  const [dialog, setDialog] = useState<DialogState>(null);
  const [writeError, setWriteError] = useState<WriteError | null>(null);
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  const [showTasks, setShowTasks] = useState(() => readStorage(SHOW_TASKS_KEY) !== '0');
  const newInputRef = useRef<HTMLInputElement>(null);

  const setFilters = (f: FeedbackFilters) =>
    setSearchParams(writeFilters(searchParams, f), { replace: true });
  const clearFilters = () => setFilters({ kind: null, status: [] });
  const setMonth = (d: Date) => {
    const next = new URLSearchParams(searchParams);
    next.set('month', toMonthKey(d));
    setSearchParams(next, { replace: true });
  };

  /** 送出 PATCH（樂觀更新）；失敗時已還原，於頁面頂部顯示提示與「重試」 */
  function patch(vars: FeedbackPatch, failMessage: string) {
    setWriteError(null);
    update.mutate(vars, {
      onError: (err) =>
        setWriteError({
          message: `${failMessage}（${errorMessage(err)}）`,
          retry: () => patch(vars, failMessage),
        }),
    });
  }

  const actions: FeedbackActions = {
    edit: (item) => setDialog({ type: 'edit', id: item.id }),
    pickDate: (item) => setDialog({ type: 'schedule', id: item.id }),
    unschedule: (item) => patch({ id: item.id, scheduledDate: null }, SCHEDULE_FAILED),
    toggleResolved: (item) =>
      patch({ id: item.id, resolved: item.status !== 'resolved' }, '狀態未儲存，已還原'),
    remove: (item) => setDialog({ type: 'delete', id: item.id }),
  };

  // C：聚焦新增列（focus 在輸入框或有 Dialog 開啟時不觸發）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'c' && e.key !== 'C') return;
      if (isEditableTarget(e.target) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      newInputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
      coordinateGetter: keyboardCoordinates,
    }),
  );

  const onDragStart = (e: DragStartEvent) => setActiveDrag((e.active.data.current as DragData) ?? null);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveDrag(null);
    const data = active.data.current as DragData | undefined;
    const target = over?.data.current as DropData | undefined;
    if (!data || !target) return; // 無效區域：浮層回到原位，不送請求
    const { item, source } = data;
    if (target.type === 'day') {
      if (target.date === item.scheduledDate) return;
      patch({ id: item.id, scheduledDate: target.date }, SCHEDULE_FAILED);
    } else if (source === 'calendar' && item.scheduledDate) {
      patch({ id: item.id, scheduledDate: null }, SCHEDULE_FAILED);
    }
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => `已拿起 ${(active.data.current as DragData).item.title}`,
    onDragOver: ({ over }) => {
      const d = over?.data.current as DropData | undefined;
      if (!d) return undefined;
      return d.type === 'day' ? `目標 ${shortDayLabel(d.date)}` : '目標 清單（取消排程）';
    },
    onDragEnd: ({ active, over }) => {
      const target = over?.data.current as DropData | undefined;
      const data = active.data.current as DragData;
      if (target?.type === 'day') return `已排入 ${dayLabel(target.date)}`;
      if (target?.type === 'list' && data.source === 'calendar') return '已取消排程';
      return '已取消';
    },
    onDragCancel: () => '已取消',
  };

  const hasScheduled = all.some((i) => i.scheduledDate);

  return (
    <FeedbackActionsContext.Provider value={actions}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveDrag(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable: '按空白鍵拿起，方向鍵選擇日期（Home 回到清單），再按空白鍵放下，Esc 取消。',
          },
        }}
      >
        <div className="fb-page">
          {writeError && (
            <Alert
              tone="danger"
              onClose={() => setWriteError(null)}
              action={
                writeError.retry && (
                  <Button variant="secondary" size="sm" onClick={writeError.retry}>
                    重試
                  </Button>
                )
              }
            >
              {writeError.message}
            </Alert>
          )}
          <div className="fb-layout">
            <FeedbackList
              ref={newInputRef}
              items={visible}
              total={all.length}
              isLoading={query.isPending}
              error={query.isError && !query.data ? query.error : null}
              onRetry={() => void query.refetch()}
              filters={filters}
              onFiltersChange={setFilters}
              onClearFilters={clearFilters}
              acceptsDrop={activeDrag?.source === 'calendar'}
            />
            <MonthCalendar
              month={month}
              onMonthChange={setMonth}
              items={visible}
              isLoading={query.isPending}
              showTasks={showTasks}
              onShowTasksChange={(v) => {
                setShowTasks(v);
                writeStorage(SHOW_TASKS_KEY, v ? '1' : '0');
              }}
              hint={
                !query.isPending && !query.isError && !hasScheduled
                  ? '把左側項目拖到日期上即可排程'
                  : undefined
              }
            />
          </div>
        </div>
        <DragOverlay dropAnimation={{ duration: 200 }}>
          {activeDrag ? (
            activeDrag.source === 'list' ? (
              <div className="fb-card fb-card--overlay">
                <FeedbackCardBody item={activeDrag.item} interactive={false} />
              </div>
            ) : (
              <div className="cal-chip cal-chip--overlay" data-kind={activeDrag.item.kind}>
                <span className="cal-chip-text">{activeDrag.item.title}</span>
              </div>
            )
          ) : null}
        </DragOverlay>
      </DndContext>
      <FeedbackDialogs
        state={dialog}
        items={all}
        onChange={setDialog}
        onSchedule={(item, date) => patch({ id: item.id, scheduledDate: date }, SCHEDULE_FAILED)}
      />
    </FeedbackActionsContext.Provider>
  );
}
