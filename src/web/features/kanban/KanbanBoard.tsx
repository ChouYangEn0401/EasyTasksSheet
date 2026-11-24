import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  closestCenter,
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import type { Project, Status } from '../../../shared/projects.ts';
import type { Task } from '../../../shared/tasks.ts';
import type { TaskFilters } from '../../lib/filters.ts';
import { useUpdateTask, useUsersById } from '../../lib/hooks.ts';
import { openTask, readTaskParam } from '../../lib/openTask.ts';
import { queryKeys } from '../../lib/queryClient.ts';
import { suspendGlobalShortcuts } from '../../lib/shortcuts.ts';
import { Alert, Button } from '../../ui/index.ts';
import { KanbanCard, KanbanCardOverlay } from './KanbanCard.tsx';
import { KanbanColumnFoot, KanbanColumnMain } from './KanbanColumn.tsx';
import {
  announce,
  arrayMove,
  COLUMN_PAGE_SIZE,
  columnId,
  findColumn,
  groupTaskIds,
  moveToColumn,
  NAV_KEYS,
  navTarget,
  parseColumnId,
  planSortOrders,
  type NavKey,
  type SortPatch,
} from './kanbanModel.ts';

const ERROR_MS = 8_000;
const KEY_CODES = { start: ['Space'], cancel: ['Escape'], end: ['Space'] };
const SR_INSTRUCTIONS = { draggable: '按空白鍵拿起，方向鍵移動，再按空白鍵放下，Esc 取消' };
// 播報改由看板自己的 aria-live 區域負責（需要欄名與位置）
const NO_ANNOUNCEMENTS = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

type DragState = {
  activeId: number;
  keyboard: boolean;
  /** 拖曳期間的欄內容（凍結於拿起時的資料，背景更新於放下後才套用） */
  columns: Record<number, number[]>;
  byId: Map<number, Task>;
  order: number[];
  origin: { statusId: number; index: number };
};

type Move = {
  taskId: number;
  title: string;
  statusId: number;
  patches: SortPatch[];
  original: Map<number, { statusId: number; sortOrder: number }>;
};

type SaveError = { key: number; title: string; retry: () => void };

const asTaskId = (id: UniqueIdentifier): number | null => (typeof id === 'number' ? id : null);

export function KanbanBoard({
  tasks,
  statuses,
  filters,
  projects,
  onClearFilters,
}: {
  tasks: Task[];
  statuses: Status[];
  filters: TaskFilters;
  projects: Project[];
  onClearFilters: () => void;
}) {
  const qc = useQueryClient();
  const update = useUpdateTask();
  const users = useUsersById();
  const [sp] = useSearchParams();
  const selectedId = readTaskParam(sp);

  const statusIds = useMemo(() => statuses.map((s) => s.id), [statuses]);
  const liveColumns = useMemo(() => groupTaskIds(tasks, statusIds), [tasks, statusIds]);
  const liveById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const showProject = projects.length > 1;

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const kbTargetRef = useRef<UniqueIdentifier | null>(null);
  /** 最近一次播報的位置（`欄:索引`），避免重複播報 */
  const lastPosRef = useRef('');
  const boardRef = useRef<HTMLDivElement>(null);
  const setDragState = (d: DragState | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const expand = useCallback(
    (statusId: number) => setExpanded((prev) => (prev.has(statusId) ? prev : new Set(prev).add(statusId))),
    [],
  );
  const [cursor, setCursor] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ statusId: number; id: number } | null>(null);
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  const columns = drag?.columns ?? liveColumns;
  const byId = drag?.byId ?? liveById;
  const navCols = statusIds.map((id) => columns[id] ?? []);
  const tabbableId =
    cursor != null && navCols.some((c) => c.includes(cursor))
      ? cursor
      : (navCols.find((c) => c.length)?.[0] ?? null);
  const activeTask = drag ? byId.get(drag.activeId) : undefined;
  const activeColumn = drag ? findColumn(drag.columns, drag.activeId) : null;
  const statusName = (id: number | null) => (id != null ? (statusById.get(id)?.name ?? '') : '');

  // 錯誤提示列 8 秒後自動消失
  useEffect(() => {
    if (!saveError) return;
    const t = window.setTimeout(() => setSaveError(null), ERROR_MS);
    return () => window.clearTimeout(t);
  }, [saveError]);

  // 拖曳中：停用全域快捷鍵；Esc 優先用於取消拖曳（不讓 TaskDrawer 關閉）
  const dragging = drag != null;
  useEffect(() => {
    if (!dragging) return;
    const release = suspendGlobalShortcuts();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      release();
      window.removeEventListener('keydown', onKey, true);
    };
  }, [dragging]);

  const focusCard = (id: number) =>
    requestAnimationFrame(() =>
      window.setTimeout(() =>
        boardRef.current?.querySelector<HTMLElement>(`[data-task-id="${id}"]`)?.focus(),
      ),
    );

  /** 樂觀更新 + PATCH；失敗時還原並顯示錯誤提示列 */
  const commit = (move: Move) => {
    const key = queryKeys.tasks.list(filters);
    void qc.cancelQueries({ queryKey: queryKeys.tasks.lists() });
    const next = new Map(move.patches.map((p) => [p.id, p.sortOrder]));
    qc.setQueryData<Task[]>(key, (old) =>
      old?.map((t) =>
        next.has(t.id)
          ? { ...t, sortOrder: next.get(t.id)!, ...(t.id === move.taskId ? { statusId: move.statusId } : {}) }
          : t,
      ),
    );
    setSaveError(null);
    const statusChanged = move.original.get(move.taskId)?.statusId !== move.statusId;
    Promise.all(
      move.patches.map((p) =>
        update.mutateAsync({
          id: p.id,
          sortOrder: p.sortOrder,
          ...(p.id === move.taskId && statusChanged ? { statusId: move.statusId } : {}),
        }),
      ),
    ).catch(() => {
      qc.setQueryData<Task[]>(key, (old) =>
        old?.map((t) => {
          const o = move.original.get(t.id);
          return o ? { ...t, ...o } : t;
        }),
      );
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
      setSaveError({ key: Date.now(), title: move.title, retry: () => commit(move) });
    });
  };

  // ── dnd-kit ───────────────────────────────────────────
  /** 鍵盤拖曳：依欄模型決定目標（↑↓ 欄內一格、←→ 相鄰欄相近位置，空欄落在欄首） */
  const coordinateGetter = useCallback<KeyboardCoordinateGetter>(
    (event, { active, context, currentCoordinates }) => {
      const d = dragRef.current;
      if (!d) return undefined;
      const aid = asTaskId(active);
      if (aid == null) return undefined;
      const from = findColumn(d.columns, aid);
      if (from == null) return undefined;
      const list = d.columns[from] ?? [];
      const overId = context.over?.id;
      const pos =
        overId != null && typeof overId === 'number' && list.includes(overId)
          ? list.indexOf(overId)
          : list.indexOf(aid);
      let target: UniqueIdentifier | null = null;
      switch (event.code) {
        case 'ArrowDown':
          target = list[pos + 1] ?? null;
          break;
        case 'ArrowUp':
          target = pos > 0 ? (list[pos - 1] ?? null) : null;
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          const ci = d.order.indexOf(from) + (event.code === 'ArrowLeft' ? -1 : 1);
          const to = d.order[ci];
          if (to == null) break;
          const other = d.columns[to] ?? [];
          target = other.length ? other[Math.min(pos, other.length - 1)]! : columnId(to);
          break;
        }
        default:
          return undefined;
      }
      event.preventDefault();
      if (target == null) return currentCoordinates;
      kbTargetRef.current = target;
      const rect = context.droppableRects.get(target);
      // 尚未量測到目標位置時仍需微幅改變座標，讓碰撞偵測重新計算（目標由 kbTargetRef 決定）
      if (!rect)
        return { x: currentCoordinates.x, y: currentCoordinates.y + (event.code === 'ArrowUp' ? -1 : 1) };
      if (event.code === 'ArrowDown')
        return { x: rect.left, y: rect.top + rect.height - (context.collisionRect?.height ?? 0) };
      return { x: rect.left, y: typeof target === 'string' ? rect.top + 44 : rect.top };
    },
    [],
  );

  /**
   * 碰撞偵測：指標在看板外 → 無（放下即取消）；否則先決定欄，再取該欄最接近的卡片（空欄回傳欄本身）。
   * 鍵盤拖曳時直接採用 coordinateGetter 決定的目標。
   */
  const collisionDetection = useCallback<CollisionDetection>((args) => {
    if (!args.pointerCoordinates) {
      const t = kbTargetRef.current;
      return t != null ? [{ id: t }] : [];
    }
    const d = dragRef.current;
    const p = args.pointerCoordinates;
    const hit = pointerWithin(args).find((c) => parseColumnId(c.id) != null);
    let col = hit ? parseColumnId(hit.id) : null;
    if (col == null) {
      const r = boardRef.current?.getBoundingClientRect();
      if (!r || p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom) return [];
      const cols = args.droppableContainers.filter((c) => parseColumnId(c.id) != null);
      const near = closestCorners({ ...args, droppableContainers: cols })[0];
      col = near ? parseColumnId(near.id) : null;
      if (col == null) return [];
    }
    const ids = d?.columns[col] ?? [];
    const items = args.droppableContainers.filter((c) => typeof c.id === 'number' && ids.includes(c.id));
    if (!items.length) return [{ id: columnId(col) }];
    return closestCenter({ ...args, droppableContainers: items });
  }, []);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter, keyboardCodes: KEY_CODES }),
  );

  const onDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const aid = asTaskId(active.id);
    if (aid == null) return;
    const statusId = findColumn(liveColumns, aid);
    if (statusId == null) return;
    const list = liveColumns[statusId] ?? [];
    const index = list.indexOf(aid);
    setDragState({
      activeId: aid,
      keyboard: activatorEvent instanceof KeyboardEvent,
      columns: liveColumns,
      byId: liveById,
      order: statusIds,
      origin: { statusId, index },
    });
    kbTargetRef.current = aid;
    lastPosRef.current = `${statusId}:${index}`;
    setCursor(aid);
    const title = liveById.get(aid)?.title ?? '';
    setMessage(announce.pickup(title, statusName(statusId), index + 1, list.length));
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    const d = dragRef.current;
    if (!d || !over) return;
    const aid = d.activeId;
    const from = findColumn(d.columns, aid);
    const overCol = parseColumnId(over.id);
    const overTask = asTaskId(over.id);
    const to = overCol ?? (overTask != null ? findColumn(d.columns, overTask) : null);
    if (from == null || to == null) return;
    let next = d;
    if (from !== to) {
      const toItems = d.columns[to] ?? [];
      let idx = toItems.length;
      if (overTask != null) {
        const tr = active.rect.current.translated;
        const below = !d.keyboard && !!tr && tr.top > over.rect.top + over.rect.height / 2;
        idx = toItems.indexOf(overTask) + (below ? 1 : 0);
      }
      next = { ...d, columns: moveToColumn(d.columns, aid, from, to, idx) };
      setDragState(next);
      expand(to);
      if (d.keyboard) kbTargetRef.current = aid;
    }
    const list = next.columns[to] ?? [];
    const pos = from === to && overTask != null ? list.indexOf(overTask) : list.indexOf(aid);
    if (lastPosRef.current === `${to}:${pos}`) return;
    lastPosRef.current = `${to}:${pos}`;
    setMessage(announce.move(statusName(to), pos + 1));
    if (d.keyboard) {
      requestAnimationFrame(() =>
        boardRef.current
          ?.querySelector<HTMLElement>(`[data-task-id="${aid}"]`)
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
      );
    }
  };

  const cancelDrag = () => {
    const d = dragRef.current;
    setDragState(null);
    kbTargetRef.current = null;
    if (!d) return;
    setMessage(announce.cancel(statusName(d.origin.statusId), d.origin.index + 1));
    if (d.keyboard) focusCard(d.activeId);
  };

  const onDragEnd = ({ over }: DragEndEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!over) return cancelDrag();
    setDragState(null);
    kbTargetRef.current = null;
    const aid = d.activeId;
    const to = findColumn(d.columns, aid);
    if (to == null) return;
    const cur = d.columns[to] ?? [];
    const ai = cur.indexOf(aid);
    const overTask = asTaskId(over.id);
    const oi = overTask != null && cur.includes(overTask) ? cur.indexOf(overTask) : ai;
    const list = arrayMove(cur, ai, oi);
    setMessage(announce.drop(statusName(to), oi + 1));
    if (d.keyboard) focusCard(aid);
    if (to === d.origin.statusId && oi === d.origin.index) return;
    const task = d.byId.get(aid);
    if (!task) return;
    const ordered = list
      .map((id) => d.byId.get(id))
      .filter((t): t is Task => !!t)
      .map((t) => ({ id: t.id, sortOrder: t.sortOrder }));
    const patches = planSortOrders(
      ordered,
      ordered.findIndex((t) => t.id === aid),
    );
    const original = new Map(
      patches.map((p) => {
        const t = d.byId.get(p.id)!;
        return [p.id, { statusId: t.statusId, sortOrder: t.sortOrder }] as const;
      }),
    );
    commit({ taskId: aid, title: task.title, statusId: to, patches, original });
  };

  // ── 鍵盤瀏覽（roving tabindex） ───────────────────────────
  const onNavKey = (e: KeyboardEvent<HTMLDivElement>, id: number) => {
    if (dragRef.current || e.target !== e.currentTarget) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (NAV_KEYS.includes(e.key)) {
      e.preventDefault();
      const t = navTarget(navCols, id, e.key as NavKey);
      if (t == null) return;
      const s = findColumn(columns, t);
      if (s != null && (columns[s] ?? []).indexOf(t) >= COLUMN_PAGE_SIZE) expand(s);
      setCursor(t);
      focusCard(t);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openTask(id);
    } else if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      const s = findColumn(columns, id);
      boardRef.current?.querySelector<HTMLInputElement>(`[data-quickadd-status="${s}"] input`)?.focus();
    }
  };

  const onOpen = (id: number) => {
    setCursor(id);
    openTask(id);
  };

  return (
    <>
      {saveError && (
        <Alert
          key={saveError.key}
          tone="danger"
          className="kanban-alert"
          onClose={() => setSaveError(null)}
          action={
            <Button variant="ghost" size="sm" onClick={saveError.retry} style={{ color: 'inherit' }}>
              重試
            </Button>
          }
        >
          無法更新『{saveError.title}』，已還原。
        </Alert>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        accessibility={{
          announcements: NO_ANNOUNCEMENTS,
          screenReaderInstructions: SR_INSTRUCTIONS,
          // 跨欄後卡片會重新掛載，由 focusCard 自行還原 focus
          restoreFocus: false,
        }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={cancelDrag}
      >
        <div ref={boardRef} className="kanban-board">
          {statuses.map((s, i) => {
            const colTasks = (columns[s.id] ?? []).map((id) => byId.get(id)).filter((t): t is Task => !!t);
            const isDone = s.category === 'done';
            return (
              <KanbanColumnMain
                key={s.id}
                status={s}
                tasks={colTasks}
                index={i}
                expanded={expanded.has(s.id)}
                dropTarget={activeColumn === s.id}
                onExpand={expand}
                scrollToTaskId={scrollTarget?.statusId === s.id ? scrollTarget.id : null}
              >
                {(visible) =>
                  visible.map((t) => (
                    <KanbanCard
                      key={t.id}
                      task={t}
                      project={projectById.get(t.projectId)}
                      showProject={showProject}
                      isDone={isDone}
                      assigneeName={
                        t.assigneeId != null ? (users.get(t.assigneeId)?.displayName ?? null) : null
                      }
                      tabbable={t.id === tabbableId}
                      selected={t.id === selectedId}
                      keyboardActive={!!drag?.keyboard && drag.activeId === t.id}
                      reducedMotion={reducedMotion}
                      onOpen={onOpen}
                      onFocusCard={setCursor}
                      onNavKey={onNavKey}
                    />
                  ))
                }
              </KanbanColumnMain>
            );
          })}
          {statuses.map((s, i) => {
            const colTasks = (liveColumns[s.id] ?? [])
              .map((id) => liveById.get(id))
              .filter((t): t is Task => !!t);
            return (
              <KanbanColumnFoot
                key={s.id}
                status={s}
                tasks={colTasks}
                index={i}
                filters={filters}
                dropTarget={activeColumn === s.id}
                onClearFilters={onClearFilters}
                onCreated={(task, matched) => {
                  if (!matched) return;
                  expand(s.id);
                  setScrollTarget({ statusId: s.id, id: task.id });
                }}
              />
            );
          })}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <KanbanCardOverlay
              task={activeTask}
              project={projectById.get(activeTask.projectId)}
              showProject={showProject}
              isDone={statusById.get(activeColumn ?? -1)?.category === 'done'}
              keyboard={!!drag?.keyboard}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">
        {message}
      </div>
    </>
  );
}
