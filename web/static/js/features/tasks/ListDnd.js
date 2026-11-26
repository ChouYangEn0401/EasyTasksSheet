import { createElement, Fragment } from 'preact';
/**
 * 清單拖曳（docs/design/task-list.md §13）：把任務拖到別的群組（改狀態 / 負責人 / 專案）或調整順序。
 * - ListDnd：包住清單表格，提供 DndContext、拖曳浮層、播報、錯誤提示列；拖曳中凍結群組資料（背景重抓於放下後才套用）。
 * - ListRowDnd / ListGroupDnd / ListInsertDnd：放在列內的小元件，向上找到所在的 role="row" 註冊 droppable，
 *   並以 data-* 屬性標示放置指示線 / 目標群組，避免整列重新渲染（大量列時的效能）。
 */
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'preact/compat';
import { useQueryClient } from '../../lib/query.js';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '../../lib/dnd.js';
import { useProjectsById, useStatusesById, useUpdateTask, useUsersById } from '../../lib/hooks.js';
import { findCachedTask, newUndoGroup } from '../../lib/taskUndo.js';
import { motionEasing, motionMs, useReducedMotion } from '../../lib/motion.js';
import { useCan } from '../../lib/permissions.js';
import { queryKeys } from '../../lib/queryClient.js';
import { suspendGlobalShortcuts } from '../../lib/shortcuts.js';
import { notifySuccess, truncate } from '../../lib/toast.js';
import { Alert, Button, Icon, StatusBadge, Tooltip } from '../../ui/index.js';
import { flashTask } from './data.js';
import {
  announceDnd,
  dragId,
  dropId,
  keyboardSlots,
  markerFor,
  originOf,
  parseDragId,
  planDrop,
  resolveTarget,
  sameTarget,
  slotDropId,
} from './listDndModel.js';
import { createViewStore, ListDndContext } from './listDndContext.js';
import { applyPatch } from './model.js';

const ERROR_MS = 8_000;
const EXPAND_MS = 600;
const KEY_CODES = { start: ['Space'], cancel: ['Escape'], end: ['Space'] };
const SR_INSTRUCTIONS = { draggable: '按空白鍵拿起，上下方向鍵移動，再按空白鍵放下，Esc 取消' };
const NO_ANNOUNCEMENTS = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

export function ListDnd({ groups, mode, sort, scrollRef, children }) {
  const canEdit = useCan('tasks.edit');
  const sortLocked = sort != null;
  const handles = !canEdit ? 'off' : mode === 'none' && sortLocked ? 'disabled' : 'on';
  const [store] = useState(createViewStore);
  const qc = useQueryClient();
  // 失敗由本元件的提示列（含重試）呈現，不另發全域 toast
  const update = useUpdateTask({ silentError: true });
  const reducedMotion = useReducedMotion();
  const statusesById = useStatusesById();
  const users = useUsersById();
  const projects = useProjectsById();

  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState(null);
  const [dropAnim, setDropAnim] = useState(true);
  const collapsedRef = useRef(new Map());
  const pointerRef = useRef(null);
  const kbRef = useRef(null);
  const kbOverRef = useRef(null);
  const expandTimer = useRef(undefined);
  const expandKey = useRef(null);
  const sortLockedRef = useRef(sortLocked);
  const modeRef = useRef(mode);

  const setDragState = useCallback(
    (d) => {
      dragRef.current = d;
      setDrag(d);
      store.set(
        d
          ? {
              activeId: d.activeId,
              marker: markerFor(d.target, d.origin, d.groups, d.activeId, sortLockedRef.current),
            }
          : { activeId: null, marker: null },
      );
    },
    [store],
  );

  const groupName = useCallback(
    (key, list) => {
      const g = list.find((x) => x.key === key);
      if (!g) return '';
      if (g.mode === 'status') return g.id != null ? (statusesById.get(g.id)?.name ?? '') : '';
      if (g.mode === 'assignee') return g.id == null ? '未指派' : (users.get(g.id)?.displayName ?? '');
      if (g.mode === 'project') return g.id != null ? (projects.get(g.id)?.name ?? '') : '';
      return '清單';
    },
    [statusesById, users, projects],
  );
  const groupNameRef = useRef(groupName);
  useLayoutEffect(() => {
    sortLockedRef.current = sortLocked;
    modeRef.current = mode;
    groupNameRef.current = groupName;
  });

  // 錯誤提示列 8 秒後自動消失
  useEffect(() => {
    if (!saveError) return;
    const t = window.setTimeout(() => setSaveError(null), ERROR_MS);
    return () => window.clearTimeout(t);
  }, [saveError]);

  // 拖曳中：停用全域快捷鍵；Esc 只用於取消拖曳（不讓抽屜關閉）；記錄指標位置；禁止選取文字
  const dragging = drag != null;
  useEffect(() => {
    if (!dragging) return;
    const release = suspendGlobalShortcuts();
    const onKey = (e) => {
      if (e.key === 'Escape') e.preventDefault();
    };
    const onMove = (e) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointermove', onMove, true);
    document.body.dataset.listDragging = 'true';
    return () => {
      release();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointermove', onMove, true);
      delete document.body.dataset.listDragging;
      window.clearTimeout(expandTimer.current);
      expandKey.current = null;
    };
  }, [dragging]);

  const position = (t) => (sortLocked ? null : t.index + 1);

  const setTarget = useCallback(
    (d, target) => {
      if (sameTarget(target, d.target) || (target == null && d.target == null)) return;
      setDragState({ ...d, target });
      if (target)
        setMessage(
          announceDnd.move(
            groupNameRef.current(target.groupKey, d.groups),
            sortLockedRef.current ? null : target.index + 1,
          ),
        );
    },
    [setDragState],
  );

  // ── 樂觀更新 + PATCH；失敗時還原並顯示提示列 ──
  const commit = (plan, title, label) => {
    const sortMap = new Map(plan.sortPatches.map((p) => [p.id, p.sortOrder]));
    const ids = new Set([plan.taskId, ...sortMap.keys()]);
    // 復原用前值：各快取中 updatedAt 最新的一份（不能取第一個含該任務的清單——最早建立的可能是不再更新的舊篩選快取）
    const original = new Map();
    for (const id of ids) {
      const t = findCachedTask(qc, id);
      if (t)
        original.set(id, {
          statusId: t.statusId,
          assigneeId: t.assigneeId,
          projectId: t.projectId,
          sortOrder: t.sortOrder,
        });
    }
    const apply = () =>
      qc.setQueriesData({ queryKey: queryKeys.tasks.lists() }, (old) =>
        old?.map((t) => {
          if (!ids.has(t.id)) return t;
          const next = sortMap.has(t.id) ? { ...t, sortOrder: sortMap.get(t.id) } : t;
          // updatedAt 由伺服器回應更新（此處不呼叫 Date.now，保持 render 純度規則）
          return t.id === plan.taskId && plan.groupChanged
            ? applyPatch(next, plan.fields, t.updatedAt)
            : next;
        }),
      );
    // 先立即套用（放下的瞬間列就到新位置）；取消進行中的背景重抓會把快取還原成重抓前的值，故取消後再套用一次
    let failed = false;
    apply();
    void qc.cancelQueries({ queryKey: queryKeys.tasks.lists() }).then(() => {
      if (!failed) apply();
    });
    flashTask(plan.taskId);
    setSaveError(null);
    // 同一次放下的多筆 PATCH 合併成一筆復原紀錄；快取已先改寫，前值由 original 提供（見 docs/design/undo.md §3）
    const undoGroup = newUndoGroup('list');
    const undoLabel = plan.groupChanged
      ? `把『${truncate(title)}』移到『${truncate(label)}』`
      : `調整『${truncate(title)}』的順序`;
    Promise.all(
      [...ids].map((id) =>
        update.mutateAsync({
          id,
          ...(id === plan.taskId ? plan.fields : {}),
          ...(sortMap.has(id) ? { sortOrder: sortMap.get(id) } : {}),
          undo: { group: undoGroup, label: undoLabel, before: original.get(id) },
        }),
      ),
    ).then(
      () => {
        if (plan.groupChanged) notifySuccess(`已移到「${truncate(label)}」`);
      },
      () => {
        failed = true;
        qc.setQueriesData({ queryKey: queryKeys.tasks.lists() }, (old) =>
          old?.map((t) => {
            const o = original.get(t.id);
            return o ? { ...t, ...o } : t;
          }),
        );
        void qc.invalidateQueries({ queryKey: queryKeys.tasks.lists() });
        setSaveError({ key: Date.now(), title, retry: () => commit(plan, title, label) });
      },
    );
  };

  // ── dnd-kit ───────────────────────────────────────────
  /** 鍵盤拖曳：↑↓ 在落點序列間移動（列與列之間、空群組、收合群組標頭） */
  const coordinateGetter = useCallback(
    (event, { context, currentCoordinates }) => {
      const d = dragRef.current;
      const kb = kbRef.current;
      if (!d || !kb) return undefined;
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault();
        return currentCoordinates;
      }
      if (event.code !== 'ArrowDown' && event.code !== 'ArrowUp') return undefined;
      event.preventDefault();
      const next = Math.max(
        0,
        Math.min(kb.slots.length - 1, kb.index + (event.code === 'ArrowDown' ? 1 : -1)),
      );
      if (next === kb.index) return currentCoordinates;
      kb.index = next;
      const slot = kb.slots[next];
      const id = slotDropId(slot, d.groups, d.activeId, sortLockedRef.current);
      kbOverRef.current = id;
      setTarget(d, { groupKey: slot.groupKey, index: slot.index });
      const rect = context.droppableRects.get(id);
      // 尚未量測到目標位置時仍微幅改變座標，讓碰撞偵測重新計算（目標由 kbOverRef 決定）
      if (!rect)
        return { x: currentCoordinates.x, y: currentCoordinates.y + (event.code === 'ArrowUp' ? -1 : 1) };
      return { x: currentCoordinates.x, y: rect.top - (context.collisionRect?.height ?? 0) / 2 };
    },
    [setTarget],
  );

  /** 碰撞偵測：指標在清單外 → 無（放開即取消）；否則取指標下的列，再退而求最近者。鍵盤拖曳直接採用落點。 */
  const collisionDetection = useCallback(
    (args) => {
      if (!args.pointerCoordinates) {
        const id = kbOverRef.current;
        return id ? [{ id }] : [];
      }
      const p = args.pointerCoordinates;
      const r = scrollRef.current?.getBoundingClientRect();
      if (!r || p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom) return [];
      const hit = pointerWithin(args);
      if (hit.length) return hit.slice(0, 1);
      return closestCenter(args).slice(0, 1);
    },
    [scrollRef],
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter, keyboardCodes: KEY_CODES }),
  );

  const onDragStart = ({ active, activatorEvent }) => {
    const id = parseDragId(active.id);
    if (id == null) return;
    const origin = originOf(groups, id);
    if (!origin) return;
    const task = groups.flatMap((g) => g.tasks).find((t) => t.id === id);
    const keyboard = activatorEvent instanceof globalThis.KeyboardEvent;
    const d = {
      activeId: id,
      title: task?.title ?? '',
      statusId: task?.statusId ?? 0,
      keyboard,
      groups,
      origin,
      target: origin,
    };
    if (keyboard) {
      const collapsed = new Set([...collapsedRef.current].filter(([, c]) => c).map(([k]) => k));
      const slots = keyboardSlots(groups, id, origin, collapsed, sortLocked);
      const index = Math.max(
        0,
        slots.findIndex((s) => sameTarget(s, origin)),
      );
      kbRef.current = { slots, index };
      kbOverRef.current = slots[index] ? slotDropId(slots[index], groups, id, sortLocked) : null;
    } else {
      kbRef.current = null;
      kbOverRef.current = null;
    }
    setDragState(d);
    setMessage(announceDnd.pickup(d.title, groupName(origin.groupKey, groups), origin.index + 1));
  };

  const pointerTarget = (d, over) => {
    if (d.keyboard) return;
    if (!over) return setTarget(d, null);
    const data = over.data.current;
    if (!data) return;
    let below = false;
    const node = data.node();
    const p = pointerRef.current;
    if (data.kind === 'row' && node && p) {
      const r = node.getBoundingClientRect();
      below = p.y > r.top + r.height / 2;
    }
    const collapsed = data.kind === 'group' ? !!data.collapsed : false;
    const target = resolveTarget({
      groups: d.groups,
      activeId: d.activeId,
      origin: d.origin,
      over: { ...data, collapsed },
      below,
      sortLocked: sortLockedRef.current,
    });
    setTarget(d, target);
  };

  const onDragMove = ({ over }) => {
    const d = dragRef.current;
    if (d) pointerTarget(d, over);
  };

  const onDragOver = ({ over }) => {
    const d = dragRef.current;
    if (!d) return;
    // 懸停在收合群組標頭 600ms → 自動展開（鍵盤拖曳不展開，落點即標頭）
    const data = over?.data.current;
    const key = !d.keyboard && data?.kind === 'group' && data.collapsed ? data.groupKey : null;
    if (key !== expandKey.current) {
      window.clearTimeout(expandTimer.current);
      expandKey.current = key;
      if (key && data?.expand) {
        const expand = data.expand;
        expandTimer.current = window.setTimeout(() => {
          expandKey.current = null;
          expand();
        }, EXPAND_MS);
      }
    }
    pointerTarget(d, over);
  };

  /** moved：放到新位置時不播放回彈動畫（浮層會飛回舊位置的量測值），改由列的高亮確認落點 */
  const finish = (moved = false) => {
    kbRef.current = null;
    kbOverRef.current = null;
    setDropAnim(!moved);
    setDragState(null);
  };

  const onDragCancel = () => {
    const d = dragRef.current;
    finish();
    if (d) setMessage(announceDnd.cancel(groupName(d.origin.groupKey, d.groups), d.origin.index + 1));
  };

  const onDragEnd = ({ over }) => {
    const d = dragRef.current;
    if (!d) return;
    if (!over || !d.target) return onDragCancel();
    const target = d.target;
    const plan = planDrop({
      groups: d.groups,
      mode: modeRef.current,
      activeId: d.activeId,
      origin: d.origin,
      target,
      sortLocked: sortLockedRef.current,
    });
    finish(plan != null);
    const label = groupName(target.groupKey, d.groups);
    if (!plan) {
      setMessage(announceDnd.cancel(groupName(d.origin.groupKey, d.groups), d.origin.index + 1));
      return;
    }
    setMessage(announceDnd.drop(label, position(target)));
    commit(plan, d.title, label);
  };

  const ctx = useMemo(
    () => ({
      store,
      handles,
      sortLocked,
      isDragging: () => dragRef.current != null,
      setCollapsed: (key, collapsed) => {
        if (collapsed == null) collapsedRef.current.delete(key);
        else collapsedRef.current.set(key, collapsed);
      },
    }),
    [store, handles, sortLocked],
  );

  const overlayStatus =
    drag && mode === 'status' && drag.target
      ? (drag.groups.find((g) => g.key === drag.target.groupKey)?.id ?? drag.statusId)
      : (drag?.statusId ?? null);

  return createElement(
    Fragment,
    null,
    saveError &&
      createElement(
        Alert,
        {
          key: saveError.key,
          tone: 'danger',
          className: 'tl-dnd-alert',
          onClose: () => setSaveError(null),
          action: createElement(
            Button,
            { variant: 'ghost', size: 'sm', onClick: saveError.retry, style: { color: 'inherit' } },
            '重試',
          ),
        },
        '無法移動『',
        saveError.title,
        '』，已還原。',
      ),
    createElement(
      ListDndContext.Provider,
      { value: ctx },
      createElement(
        DndContext,
        {
          sensors: sensors,
          collisionDetection: collisionDetection,
          measuring: { droppable: { strategy: MeasuringStrategy.Always } },
          accessibility: { announcements: NO_ANNOUNCEMENTS, screenReaderInstructions: SR_INSTRUCTIONS },
          onDragStart: onDragStart,
          onDragMove: onDragMove,
          onDragOver: onDragOver,
          onDragEnd: onDragEnd,
          onDragCancel: onDragCancel,
        },
        children(drag ? drag.groups : groups),
        createElement(
          DragOverlay,
          {
            dropAnimation:
              reducedMotion || !dropAnim
                ? null
                : { duration: motionMs('--duration-base'), easing: motionEasing('--ease-standard') },
          },
          drag
            ? createElement(
                'div',
                { className: `tl-drag-overlay${drag.keyboard ? ' is-keyboard' : ''}`, 'aria-hidden': 'true' },
                createElement(Icon, { name: 'grip', size: 14 }),
                createElement('span', { className: 'tl-drag-overlay-title' }, drag.title),
                overlayStatus != null &&
                  overlayStatus > 0 &&
                  createElement(StatusBadge, { statusId: overlayStatus }),
                sortLocked &&
                  createElement('span', { className: 'tl-drag-overlay-note' }, announceDnd.sortLocked),
              )
            : null,
        ),
      ),
    ),
    createElement(
      'div',
      { className: 'tl-sr-only', 'aria-live': 'assertive', 'aria-atomic': 'true' },
      message,
    ),
  );
}

// ── 列內的小元件 ─────────────────────────────────────────

/** 由 marker span 往上找所在的列 */
const rowOf = (el) => el?.closest('[role="row"]') ?? null;

function setMark(row, name, value) {
  if (!row) return;
  if (value) row.setAttribute(name, value);
  else row.removeAttribute(name);
}

function useMark(ctx, select) {
  return useSyncExternalStore(
    ctx.store.subscribe,
    () => select(ctx.store.get()),
    () => '',
  );
}

/** 任務列：拖曳把手（勾選欄左側）+ 註冊為放置目標 */
export function ListRowDnd(props) {
  const ctx = useContext(ListDndContext);
  if (!ctx || ctx.handles === 'off') return null;
  return createElement(RowDnd, { ctx: ctx, ...props });
}

function RowDnd({ ctx, task, groupKey, navProps }) {
  const slotRef = useRef(null);
  const temp = task.id < 0;
  const disabled = ctx.handles === 'disabled' || temp;
  const { setNodeRef: setDropRef } = useDroppable({
    id: dropId.row(task.id),
    data: { kind: 'row', groupKey, taskId: task.id, node: () => rowOf(slotRef.current) },
    disabled: temp,
  });
  const { attributes, listeners, setNodeRef, setActivatorNodeRef } = useDraggable({
    id: dragId(task.id),
    disabled,
    attributes: { roleDescription: '可拖曳的任務列' },
  });
  useLayoutEffect(() => {
    const row = rowOf(slotRef.current);
    setDropRef(row);
    setNodeRef(row);
  });
  const mark = useMark(ctx, (v) =>
    v.activeId === task.id ? 'active' : v.marker?.beforeTaskId === task.id ? 'before' : '',
  );
  useLayoutEffect(() => {
    const row = rowOf(slotRef.current);
    setMark(row, 'data-dnd-active', mark === 'active' ? 'true' : '');
    setMark(row, 'data-drop', mark === 'before' ? 'before' : '');
  }, [mark]);

  const onKeyDown = (e) => {
    // 拖曳中：方向鍵 / 空白鍵交給 dnd-kit 的鍵盤感應器（window 上），不讓表格的鍵盤導覽處理
    if (ctx.isDragging()) {
      e.preventDefault();
      return;
    }
    listeners?.onKeyDown?.(e);
  };

  const button = createElement(
    'button',
    {
      type: 'button',
      ref: setActivatorNodeRef,
      className: 'tl-drag-handle',
      ...attributes,
      ...navProps,
      ...listeners,
      'aria-label': `拖曳「${task.title}」`,
      'aria-disabled': disabled || undefined,
      onKeyDown: onKeyDown,
    },
    createElement(Icon, { name: 'grip', size: 14 }),
  );
  return createElement(
    'span',
    { ref: slotRef, className: 'tl-drag-slot' },
    ctx.sortLocked
      ? createElement(
          Tooltip,
          {
            placement: 'right',
            content:
              ctx.handles === 'disabled'
                ? announceDnd.sortLocked
                : `${announceDnd.sortLocked}；仍可拖到其他群組`,
          },
          button,
        )
      : button,
  );
}

/** 群組標頭列：放置目標（收合時放到群組尾端；懸停 600ms 自動展開） */
export function ListGroupDnd(props) {
  const ctx = useContext(ListDndContext);
  if (!ctx || ctx.handles === 'off') return null;
  return createElement(GroupDnd, { ctx: ctx, ...props });
}

function GroupDnd({ ctx, group, collapsed, onExpand }) {
  const ref = useRef(null);
  const { setNodeRef } = useDroppable({
    id: dropId.group(group.key),
    data: {
      kind: 'group',
      groupKey: group.key,
      collapsed,
      expand: collapsed ? onExpand : undefined,
      node: () => rowOf(ref.current),
    },
  });
  useLayoutEffect(() => setNodeRef(rowOf(ref.current)));
  useEffect(() => {
    ctx.setCollapsed(group.key, collapsed);
  }, [ctx, group.key, collapsed]);
  useEffect(() => () => ctx.setCollapsed(group.key, null), [ctx, group.key]);
  const mark = useMark(ctx, (v) => (v.marker?.groupKey === group.key ? 'target' : ''));
  useLayoutEffect(() => setMark(rowOf(ref.current), 'data-drop-target', mark ? 'true' : ''), [mark]);
  return createElement('span', { ref: ref, hidden: true });
}

/** 群組底部「新增任務」列：放置目標（放到群組尾端；空群組唯一的列） */
export function ListInsertDnd({ groupKey }) {
  const ctx = useContext(ListDndContext);
  if (!ctx || ctx.handles === 'off') return null;
  return createElement(InsertDnd, { ctx: ctx, groupKey: groupKey });
}

function InsertDnd({ ctx, groupKey }) {
  const ref = useRef(null);
  const { setNodeRef } = useDroppable({
    id: dropId.insert(groupKey),
    data: { kind: 'insert', groupKey, node: () => rowOf(ref.current) },
  });
  useLayoutEffect(() => setNodeRef(rowOf(ref.current)));
  const mark = useMark(ctx, (v) =>
    v.marker?.groupKey === groupKey ? (v.marker.atInsert ? 'before' : 'target') : '',
  );
  useLayoutEffect(() => {
    const row = rowOf(ref.current);
    setMark(row, 'data-drop', mark === 'before' ? 'before' : '');
    setMark(row, 'data-drop-target', mark ? 'true' : '');
  }, [mark]);
  return createElement('span', { ref: ref, hidden: true });
}
