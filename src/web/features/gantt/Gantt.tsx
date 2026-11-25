import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react';
import { useSearchParams } from 'react-router';
import type { Task } from '../../../shared/tasks.ts';
import { statusStyle, statusTone } from '../../lib/colors.ts';
import { formatRelative } from '../../lib/format.ts';
import { useProjects, useStatusesById, useUsersById } from '../../lib/hooks.ts';
import { prefersReducedMotion } from '../../lib/motion.ts';
import { openTask, readTaskParam } from '../../lib/openTask.ts';
import { isEditableTarget } from '../../lib/shortcuts.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
import { Avatar, Badge, ColorDot, Icon, Tooltip } from '../../ui/index.ts';
import { buildGroups, groupSpan, type GanttGroup, type GroupBy } from './grouping.ts';
import {
  applyDrag,
  barGeometry,
  computeRange,
  DAY_WIDTH,
  datePatch,
  formatDateRange,
  formatDayRange,
  formatSpan,
  formatSpanSpoken,
  headerCells,
  initialScrollLeft,
  overdueDays,
  SCALES,
  taskSpan,
  todayCellMode,
  todayEdge,
  toDay,
  weekdayIndex,
  type DragMode,
  type Scale,
} from './timeline.ts';
import './gantt.css';

export type DatePatch = { startDate?: string; dueDate?: string };

export type GanttHandle = {
  /** 捲到今天（預設平滑；prefers-reduced-motion 時瞬間） */
  scrollToToday: () => void;
  /** 前後捲動一個可視寬度 */
  scrollPage: (dir: -1 | 1) => void;
  scrollToTask: (id: number) => void;
  /** 該任務列以 accent-soft 底標示 1.5 秒 */
  flashTask: (id: number) => void;
};

export type GanttProps = {
  tasks: Task[];
  groupBy: GroupBy;
  scale: Scale;
  today: string;
  /** 負責人分組時的成員順序（沒有排程任務的成員集中到「無排程任務」摘要列） */
  members: { id: number; displayName: string }[];
  /** 精簡版：唯讀、列高 28、左欄窄 */
  compact?: boolean;
  /** 有提供才可拖曳 / 鍵盤改日期（完整版） */
  onChangeDates?: (task: Task, patch: DatePatch) => void;
  /** 任務列按 D：開啟日期 Popover */
  onRequestDates?: (task: Task) => void;
  onScaleChange?: (scale: Scale) => void;
  handleRef?: Ref<GanttHandle>;
  /** 群組收合狀態的 localStorage 鍵 */
  storageKey?: string;
  ariaLabel?: string;
  /** 各負責人的未排程任務數（空分組摘要列顯示「· 未排程 M」） */
  unscheduledCountByAssignee?: Map<number, number>;
  /** 點空分組摘要列中的成員：展開未排程區並標示該成員 */
  onShowUnscheduled?: (assigneeId: number) => void;
};

type Row =
  | { type: 'group'; key: string; group: GanttGroup<Task>; collapsed: boolean }
  | { type: 'task'; key: string; task: Task; grouped: boolean };

type DragState = {
  taskId: number;
  mode: DragMode;
  pointerId: number;
  originX: number;
  originScroll: number;
  span: { start: number; end: number };
  delta: number;
  moved: boolean;
};

type Range = { start: number; end: number };

const DRAG_THRESHOLD = 4;
const EDGE = 40;
const KEY_COMMIT_MS = 500;
const FLASH_MS = 1500;

function readCollapsed(key: string): Set<string> {
  try {
    const raw = readStorage(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/**
 * 甘特圖（完整版與總覽精簡版共用；docs/design/gantt-polish.md）。
 * 單一捲動容器：表頭 sticky top、左欄 sticky left，時間軸隨容器水平捲動；範圍至少填滿可視寬度。
 */
export function Gantt({
  tasks,
  groupBy,
  scale,
  today,
  members,
  compact = false,
  onChangeDates,
  onRequestDates,
  onScaleChange,
  handleRef,
  storageKey = compact ? 'gantt.compact.collapsed' : 'gantt.collapsed',
  ariaLabel = '甘特圖',
  unscheduledCountByAssignee,
  onShowUnscheduled,
}: GanttProps) {
  const editable = !compact && !!onChangeDates;
  const statusesById = useStatusesById();
  const usersById = useUsersById();
  const projects = useProjects().data;
  const [searchParams] = useSearchParams();
  const selectedId = readTaskParam(searchParams);

  const [collapsed, setCollapsed] = useState(() => readCollapsed(storageKey));
  const toggleGroup = useCallback(
    (key: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        writeStorage(storageKey, JSON.stringify([...next]));
        return next;
      }),
    [storageKey],
  );

  // 鍵盤改日期的預覽（停止按鍵 500ms 後送出）
  const [kbPreview, setKbPreview] = useState<{ taskId: number; start: number; end: number } | null>(null);
  const kbTimer = useRef<number | undefined>(undefined);
  const [announce, setAnnounce] = useState('');
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [hoverBar, setHoverBar] = useState<number | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  /* ── 範圍（填滿可視寬度；拖曳中凍結） ───────────── */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const dw = DAY_WIDTH[scale];
  const minDays = viewW > 0 ? Math.ceil(viewW / dw) : 0;
  const computedRange = useMemo(
    () => computeRange(tasks, today, scale, minDays),
    [tasks, today, scale, minDays],
  );
  const [dragRange, setDragRange] = useState<Range | null>(null);
  const range = dragRange ?? computedRange;
  const totalWidth = (range.end - range.start) * dw;
  const todayDay = toDay(today);
  const header = useMemo(() => headerCells(range, scale, todayDay), [range, scale, todayDay]);
  /** 今天那一天的中心 x */
  const todayX = (todayDay - range.start) * dw + dw / 2;
  const todayInRange = todayDay >= range.start && todayDay < range.end;

  const isOverdue = useCallback(
    (t: Task) => !!t.dueDate && t.dueDate < today && statusesById.get(t.statusId)?.category !== 'done',
    [today, statusesById],
  );

  const groups = useMemo(
    () =>
      buildGroups(tasks, groupBy, {
        members,
        projects: (projects ?? []).map((p) => ({ id: p.id, name: p.name, color: p.color })),
        userName: (id) => usersById.get(id)?.displayName,
      }),
    [tasks, groupBy, members, projects, usersById],
  );
  // 沒有已排程任務的成員不佔列，集中到摘要列
  const emptyGroups = useMemo(
    () => groups.filter((g) => g.kind === 'user' && g.tasks.length === 0),
    [groups],
  );

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of groups) {
      if (g.kind === 'all') {
        for (const t of g.tasks) out.push({ type: 'task', key: `t${t.id}`, task: t, grouped: false });
        continue;
      }
      if (g.tasks.length === 0) continue;
      const isCollapsed = collapsed.has(g.key);
      out.push({ type: 'group', key: g.key, group: g, collapsed: isCollapsed });
      if (!isCollapsed)
        for (const t of g.tasks) out.push({ type: 'task', key: `t${t.id}`, task: t, grouped: true });
    }
    return out;
  }, [groups, collapsed]);

  const [focusKey, setFocusKey] = useState<string | null>(null);
  const focusIndex = Math.max(
    0,
    rows.findIndex((r) => r.key === focusKey),
  );

  /* ── 捲動 ─────────────────────────────── */
  const layoutRef = useRef<{ start: number; dw: number } | null>(null);
  const [scrolledX, setScrolledX] = useState(false);
  const [edge, setEdge] = useState<'left' | 'right' | null>(null);

  const leftWidth = () =>
    (scrollRef.current?.querySelector('.gantt-head-corner') as HTMLElement | null)?.offsetWidth ?? 0;
  const visibleWidth = useCallback(() => {
    const el = scrollRef.current;
    return el ? Math.max(0, el.clientWidth - leftWidth()) : 0;
  }, []);

  // 量測可視時間軸寬（首次 + ResizeObserver）
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewW(visibleWidth());
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [visibleWidth]);

  const syncScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrolledX(el.scrollLeft > 0);
    setEdge(todayInRange ? todayEdge(todayX, el.scrollLeft, visibleWidth()) : null);
  }, [todayInRange, todayX, visibleWidth]);

  const scrollToToday = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      left: Math.max(0, todayX - visibleWidth() / 3),
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [todayX, visibleWidth]);

  const barsPx = useMemo(() => {
    const out: { x: number; w: number }[] = [];
    for (const t of tasks) {
      const s = taskSpan(t);
      if (s) out.push({ x: (s.start - range.start) * dw, w: (s.end - s.start + 1) * dw });
    }
    return out;
  }, [tasks, range.start, dw]);

  // 量測後首次定位（今天在左側 1/3，視窗內無長條則改對最近的長條）；之後刻度或範圍起點變動時保持可視中心日期
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || viewW <= 0) return;
    const prev = layoutRef.current;
    if (!prev) {
      el.scrollLeft = initialScrollLeft(todayX, viewW, barsPx);
    } else if (prev.start !== range.start || prev.dw !== dw) {
      const half = viewW / 2;
      const center = prev.start + (el.scrollLeft + half) / prev.dw;
      el.scrollLeft = Math.max(0, (center - range.start) * dw - half);
    }
    layoutRef.current = { start: range.start, dw };
    syncScroll();
  }, [range.start, dw, viewW, todayX, barsPx, syncScroll]);

  const scrollToTask = useCallback(
    (id: number) => {
      const t = tasks.find((x) => x.id === id);
      const span = t && taskSpan(t);
      const el = scrollRef.current;
      if (!span || !el) return;
      const x = (span.start - range.start) * dw;
      const vis = visibleWidth();
      if (x < el.scrollLeft || x > el.scrollLeft + vis - 40) el.scrollLeft = Math.max(0, x - vis / 3);
      el.querySelector(`[data-row-key="t${id}"]`)?.scrollIntoView({ block: 'nearest' });
    },
    [tasks, range.start, dw, visibleWidth],
  );

  const flashTask = useCallback((id: number) => {
    window.clearTimeout(flashTimer.current);
    setFlashId(id);
    flashTimer.current = window.setTimeout(() => setFlashId(null), FLASH_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToToday,
      scrollPage: (dir) => {
        const el = scrollRef.current;
        if (el)
          el.scrollBy({
            left: dir * visibleWidth(),
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          });
      },
      scrollToTask,
      flashTask,
    }),
    [scrollToToday, scrollToTask, visibleWidth, flashTask],
  );

  /* ── 拖曳 ─────────────────────────────── */
  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
    setDragRange(null);
  }, []);

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        endDrag();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag, endDrag]);

  const onBarPointerDown = (e: ReactPointerEvent<HTMLElement>, task: Task, mode: DragMode) => {
    if (e.button !== 0) return;
    const span = taskSpan(task);
    if (!span) return;
    e.stopPropagation();
    if (!editable) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const state: DragState = {
      taskId: task.id,
      mode,
      pointerId: e.pointerId,
      originX: e.clientX,
      originScroll: scrollRef.current?.scrollLeft ?? 0,
      span,
      delta: 0,
      moved: false,
    };
    dragRef.current = state;
    setDrag(state);
    setDragRange(range);
  };

  const onBarPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = scrollRef.current;
    if (!d || d.pointerId !== e.pointerId || !el) return;
    // 拖到可視邊緣時自動捲動
    const rect = el.getBoundingClientRect();
    if (e.clientX > rect.right - EDGE) el.scrollLeft += dw;
    else if (e.clientX < rect.left + leftWidth() + EDGE) el.scrollLeft -= dw;
    const dx = e.clientX - d.originX + (el.scrollLeft - d.originScroll);
    const moved = d.moved || Math.abs(dx) >= DRAG_THRESHOLD;
    const next = { ...d, moved, delta: moved ? Math.round(dx / dw) : 0 };
    dragRef.current = next;
    if (next.delta !== d.delta || next.moved !== d.moved) setDrag(next);
  };

  const onBarPointerUp = (e: ReactPointerEvent<HTMLDivElement>, task: Task) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    endDrag();
    if (!d.moved) {
      openTask(task.id);
      return;
    }
    // 拖出圖表放開 = 取消
    const rect = scrollRef.current?.getBoundingClientRect();
    if (
      rect &&
      (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom)
    )
      return;
    const patch = datePatch(task, applyDrag(d.span, d.mode, d.delta));
    if (Object.keys(patch).length) onChangeDates?.(task, patch);
  };

  /* ── 鍵盤 ─────────────────────────────── */
  const focusRow = (idx: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, idx))];
    if (!row) return;
    setFocusKey(row.key);
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-key="${row.key}"]`);
    el?.focus();
    if (row.type === 'task') scrollToTask(row.task.id);
  };

  const shiftByKeyboard = (task: Task, mode: DragMode, delta: number) => {
    const base =
      kbPreview?.taskId === task.id ? { start: kbPreview.start, end: kbPreview.end } : taskSpan(task);
    if (!base) return;
    const next = applyDrag(base, mode, delta);
    setKbPreview({ taskId: task.id, ...next });
    setAnnounce(`${task.title}：${formatSpanSpoken(next.start, next.end)}`);
    window.clearTimeout(kbTimer.current);
    kbTimer.current = window.setTimeout(() => {
      setKbPreview(null);
      const patch = datePatch(task, next);
      if (Object.keys(patch).length) onChangeDates?.(task, patch);
    }, KEY_COMMIT_MS);
  };
  useEffect(() => () => window.clearTimeout(kbTimer.current), []);

  const onTreeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isEditableTarget(e.target)) return;
    const row = rows[focusIndex];
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        return focusRow(focusIndex + 1);
      case 'ArrowUp':
        e.preventDefault();
        return focusRow(focusIndex - 1);
      case 'Home':
        e.preventDefault();
        return focusRow(0);
      case 'End':
        e.preventDefault();
        return focusRow(rows.length - 1);
      case 'Enter':
        if (!row) return;
        e.preventDefault();
        if (row.type === 'group') toggleGroup(row.key);
        else openTask(row.task.id);
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (!row) return;
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (row.type === 'group') {
          e.preventDefault();
          if ((dir === -1) !== row.collapsed) toggleGroup(row.key);
          return;
        }
        if (!editable || !taskSpan(row.task)) return;
        if (e.shiftKey && e.altKey) {
          e.preventDefault();
          return shiftByKeyboard(row.task, 'start', dir);
        }
        if (e.altKey) {
          e.preventDefault();
          return shiftByKeyboard(row.task, 'end', dir);
        }
        if (e.shiftKey) {
          e.preventDefault();
          return shiftByKeyboard(row.task, 'move', dir);
        }
        return;
      }
      case 'd':
      case 'D':
        if (row?.type === 'task' && onRequestDates && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          onRequestDates(row.task);
        }
        return;
    }
  };

  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      scrollToToday();
    } else if (onScaleChange && ['1', '2', '3'].includes(e.key)) {
      e.preventDefault();
      onScaleChange(SCALES[Number(e.key) - 1]!);
    }
  };

  /* ── 繪製 ─────────────────────────────── */
  const spanOf = (task: Task) => {
    if (drag?.taskId === task.id && drag.moved) return applyDrag(drag.span, drag.mode, drag.delta);
    if (kbPreview?.taskId === task.id) return { start: kbPreview.start, end: kbPreview.end };
    const s = taskSpan(task);
    return s && { start: s.start, end: s.end };
  };

  // 格線：刻度單位線（淡）+ 月份 / 年邊界（深）；日刻度每日線以背景漸層繪製
  const gridLines = useMemo(() => {
    const out = [];
    if (scale !== 'day')
      for (const c of header.bottom)
        if (c.start > range.start)
          out.push(
            <span key={c.key} className="gantt-gridline" style={{ left: (c.start - range.start) * dw }} />,
          );
    for (const c of header.top)
      if (c.start > range.start)
        out.push(
          <span
            key={c.key}
            className="gantt-gridline gantt-gridline--major"
            style={{ left: (c.start - range.start) * dw }}
          />,
        );
    return out;
  }, [header, scale, range.start, dw]);

  // 週末帶（日 / 週刻度）與今天帶
  const bands = useMemo(() => {
    if (scale === 'month') return null;
    const out = [];
    for (let d = range.start; d < range.end; d++) {
      const wd = weekdayIndex(d);
      if (wd === 5 || (d === range.start && wd === 6))
        out.push(
          <span
            key={d}
            className="gantt-weekend"
            style={{ left: (d - range.start) * dw, width: (wd === 5 ? 2 : 1) * dw }}
          />,
        );
    }
    if (todayInRange)
      out.push(
        <span
          key="today"
          className="gantt-today-band"
          style={{ left: (todayDay - range.start) * dw, width: dw }}
        />,
      );
    return out;
  }, [scale, range, dw, todayDay, todayInRange]);

  const rootStyle = {
    '--gantt-total': `${totalWidth}px`,
    '--gantt-dw': `${dw}px`,
  } as CSSProperties;

  const userLabel = (id: number | null) => (id == null ? '未指派' : (usersById.get(id)?.displayName ?? '—'));

  return (
    <div
      className={[
        'gantt',
        compact && 'gantt--compact',
        drag?.moved && 'gantt--dragging',
        scrolledX && 'is-scrolled-x',
      ]
        .filter(Boolean)
        .join(' ')}
      style={rootStyle}
      onKeyDown={onRootKeyDown}
      data-scale={scale}
    >
      <div className="gantt-scroll" ref={scrollRef} onScroll={syncScroll}>
        <div className="gantt-inner">
          <div className="gantt-head">
            <div className="gantt-head-corner">
              <span>任務</span>
              <span>起訖</span>
            </div>
            <div className="gantt-head-time" aria-hidden="true">
              <div className="gantt-head-row gantt-head-row--top">
                {header.top.map((c) => (
                  <span
                    key={c.key}
                    className="gantt-head-cell"
                    style={{ left: (c.start - range.start) * dw, width: c.days * dw }}
                  >
                    <span className="gantt-head-label">{c.label}</span>
                  </span>
                ))}
              </div>
              <div className="gantt-head-row gantt-head-row--bottom">
                {header.bottom.map((c) => {
                  const mode = c.today ? todayCellMode(scale, c.days * dw) : null;
                  return (
                    <span
                      key={c.key}
                      className={[
                        'gantt-head-cell',
                        c.weekend && 'gantt-head-cell--weekend',
                        mode && `is-today is-today--${mode}`,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ left: (c.start - range.start) * dw, width: c.days * dw }}
                    >
                      {scale === 'day' ? (
                        // 日刻度格寬 32px：日期與星期緊排置中
                        <span className="gantt-head-day">
                          {c.label.split(' ').map((part) => (
                            <span key={part}>{part}</span>
                          ))}
                        </span>
                      ) : (
                        mode !== 'chip' && <span className="gantt-head-label">{c.label}</span>
                      )}
                      {(mode === 'both' || mode === 'chip') && <span className="gantt-today-chip">今天</span>}
                    </span>
                  );
                })}
              </div>
              {todayInRange && !edge && <span className="gantt-today-dot" style={{ left: todayX }} />}
            </div>
          </div>

          <div
            className="gantt-body"
            role="tree"
            aria-label={ariaLabel}
            onKeyDown={onTreeKeyDown}
            data-scale={scale}
          >
            {bands && (
              <div className="gantt-bands" aria-hidden="true">
                {bands}
              </div>
            )}
            <div className="gantt-overlay" aria-hidden="true">
              {gridLines}
              {todayInRange && <span className="gantt-today-line" style={{ left: todayX }} />}
            </div>

            {rows.map((row, idx) => {
              const tabIndex = idx === focusIndex ? 0 : -1;
              if (row.type === 'group') {
                const g = row.group;
                const span = groupSpan(g.tasks);
                const overdueCount = g.tasks.filter(isOverdue).length;
                return (
                  <div
                    key={row.key}
                    data-row-key={row.key}
                    className="gantt-row gantt-row--group"
                    role="treeitem"
                    aria-level={1}
                    aria-expanded={!row.collapsed}
                    aria-label={`${g.label}，${g.tasks.length} 筆${overdueCount ? `，逾期 ${overdueCount} 筆` : ''}`}
                    tabIndex={tabIndex}
                    onFocus={() => setFocusKey(row.key)}
                  >
                    <div className="gantt-cell-left" onClick={() => toggleGroup(row.key)}>
                      <Icon
                        name={row.collapsed ? 'chevronRight' : 'chevronDown'}
                        size={16}
                        className="gantt-chevron"
                      />
                      {g.kind === 'project' ? (
                        <ColorDot color={g.color} size="md" />
                      ) : g.kind === 'user' ? (
                        <Avatar userId={g.refId} size="sm" tooltip={false} />
                      ) : (
                        <Avatar user={null} size="sm" tooltip={false} />
                      )}
                      <span className="gantt-group-name">{g.label}</span>
                      <Tooltip content={`${g.tasks.length} 筆已排程任務`}>
                        <Badge count>{g.tasks.length}</Badge>
                      </Tooltip>
                      {overdueCount > 0 && (
                        <span className="gantt-group-overdue">
                          <Badge tone="danger">逾期 {overdueCount}</Badge>
                        </span>
                      )}
                    </div>
                    <div className="gantt-cell-time" aria-hidden="true">
                      {span && !row.collapsed && (
                        <span
                          className="gantt-group-line"
                          style={{
                            left: (span.start - range.start) * dw,
                            width: (span.end - span.start + 1) * dw,
                          }}
                        />
                      )}
                      {span && row.collapsed && (
                        <>
                          {g.tasks.map((t) => {
                            const s = taskSpan(t);
                            if (!s) return null;
                            const tone = (() => {
                              const st = statusesById.get(t.statusId);
                              return st ? statusTone(st) : 'todo';
                            })();
                            return (
                              <span
                                key={t.id}
                                className="gantt-group-mini"
                                style={{
                                  left: (s.start - range.start) * dw,
                                  width: Math.max(4, (s.end - s.start + 1) * dw),
                                  ...statusStyle(tone),
                                }}
                              />
                            );
                          })}
                          <span
                            className="gantt-group-summary"
                            style={{ left: (span.end - range.start + 1) * dw + 10 }}
                          >
                            {g.tasks.length} 筆 · {formatDayRange(span.start, span.end)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                );
              }

              const t = row.task;
              const status = statusesById.get(t.statusId);
              const tone = status ? statusTone(status) : 'todo';
              const done = status?.category === 'done';
              const overdue = isOverdue(t);
              const odDays = overdue ? overdueDays(t.dueDate, today) : 0;
              const real = taskSpan(t);
              const span = spanOf(t);
              const isDragging = drag?.taskId === t.id && drag.moved;
              const geo = span && barGeometry(span, dw, !!real?.single);
              const left = span && geo ? (span.start - range.start) * dw + geo.offset : 0;
              const showInside = !!geo && geo.labelInside && !compact;
              const showOutside = !!geo && !geo.labelInside && (!compact || geo.narrow);
              const showPct = t.progress > 0 && t.progress < 100;
              const rowLabel = `${t.title}，${t.startDate ?? '未設定'} 至 ${t.dueDate ?? '未設定'}，進度 ${t.progress}%，${status?.name ?? ''}${overdue ? `，已逾期 ${odDays} 天` : ''}，負責人 ${userLabel(t.assigneeId)}`;
              const updaterName = t.updatedBy != null ? usersById.get(t.updatedBy)?.displayName : undefined;
              const dates = formatDateRange(t.startDate, t.dueDate, today);
              return (
                <div
                  key={row.key}
                  data-row-key={row.key}
                  data-task-id={t.id}
                  className={[
                    'gantt-row gantt-row--task',
                    selectedId === t.id && 'is-selected',
                    flashId === t.id && 'is-flash',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  role="treeitem"
                  aria-level={row.grouped ? 2 : 1}
                  aria-selected={selectedId === t.id}
                  aria-label={rowLabel}
                  tabIndex={tabIndex}
                  onFocus={(e) => {
                    if (e.target === e.currentTarget) setFocusKey(row.key);
                  }}
                >
                  <div
                    className={`gantt-cell-left${row.grouped ? ' gantt-cell-left--indent' : ''}`}
                    onClick={() => openTask(t.id)}
                  >
                    <Tooltip content={status?.name}>
                      <span className="gantt-status-dot" style={statusStyle(tone)} />
                    </Tooltip>
                    <span className="gantt-task-title" title={t.title}>
                      {t.title}
                    </span>
                    {dates && (
                      <span className={`gantt-task-dates${overdue ? ' is-overdue' : ''}`}>
                        {overdue ? <Tooltip content={`已逾期 ${odDays} 天`}>{dates}</Tooltip> : dates}
                      </span>
                    )}
                  </div>
                  <div className="gantt-cell-time">
                    {span && geo && (
                      <div
                        className={[
                          'gantt-bar',
                          geo.narrow && 'gantt-bar--narrow',
                          real?.single && 'gantt-bar--single',
                          overdue && 'gantt-bar--overdue',
                          done && 'gantt-bar--done',
                          isDragging && 'is-dragging',
                          editable && 'is-editable',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        style={{ left, width: geo.visualWidth, ...statusStyle(tone) }}
                        data-testid={`gantt-bar-${t.id}`}
                        onPointerDown={(e) => onBarPointerDown(e, t, 'move')}
                        onPointerMove={onBarPointerMove}
                        onPointerUp={(e) => onBarPointerUp(e, t)}
                        onPointerCancel={endDrag}
                        onPointerEnter={() => setHoverBar(t.id)}
                        onPointerLeave={() => setHoverBar((h) => (h === t.id ? null : h))}
                        onClick={(e) => {
                          // 非拖曳模式（唯讀）時以 click 開啟
                          if (!editable) {
                            e.stopPropagation();
                            openTask(t.id);
                          }
                        }}
                      >
                        {showInside && (
                          <span className="gantt-bar-label gantt-bar-label--in" aria-hidden="true">
                            {done && <Icon name="check" size={12} className="gantt-bar-check" />}
                            <span className="gantt-bar-title">{t.title}</span>
                            {overdue && geo.overdueInside && (
                              <span className="gantt-bar-overdue">逾期 {odDays} 天</span>
                            )}
                            {showPct && geo.pctInside && <span className="gantt-bar-pct">{t.progress}%</span>}
                          </span>
                        )}
                        {!done && !geo.narrow && t.progress > 0 && (
                          <span
                            className="gantt-bar-progress"
                            style={{ width: `${Math.min(100, t.progress)}%` }}
                          />
                        )}
                        {editable && (
                          <>
                            <span
                              className="gantt-handle gantt-handle--start"
                              data-testid={`gantt-handle-start-${t.id}`}
                              onPointerDown={(e) => onBarPointerDown(e, t, 'start')}
                            />
                            <span
                              className="gantt-handle gantt-handle--end"
                              data-testid={`gantt-handle-end-${t.id}`}
                              onPointerDown={(e) => onBarPointerDown(e, t, 'end')}
                            />
                          </>
                        )}
                        {showOutside && (
                          <span className="gantt-bar-label gantt-bar-label--out" aria-hidden="true">
                            <span className="gantt-bar-title">{t.title}</span>
                            {t.progress > 0 && <span className="gantt-bar-meta"> · {t.progress}%</span>}
                            {overdue && <span className="gantt-bar-overdue"> · 逾期 {odDays} 天</span>}
                          </span>
                        )}
                        {isDragging ? (
                          <span className="ui-tooltip" role="status">
                            {formatSpan(span.start, span.end)}
                          </span>
                        ) : (
                          hoverBar === t.id &&
                          !drag && (
                            <span
                              className={`ui-tooltip gantt-tip${idx < 2 ? ' ui-tooltip--bottom' : ''}`}
                              role="tooltip"
                            >
                              <strong>{t.title}</strong>
                              {'\n'}
                              {formatSpan(span.start, span.end)}
                              {overdue ? ` · 已逾期 ${odDays} 天` : ''}
                              {'\n'}進度 {t.progress}% · {status?.name ?? '—'} · {userLabel(t.assigneeId)}
                              {'\n'}更新於 {formatRelative(t.updatedAt)}
                              {updaterName ? ` · 由 ${updaterName}` : ''}
                            </span>
                          )
                        )}
                      </div>
                    )}
                    {isDragging && real && (
                      <span
                        className="gantt-bar-ghost"
                        style={{
                          left: (real.start - range.start) * dw,
                          width: (real.end - real.start + 1) * dw,
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {edge && (
        <button
          type="button"
          className={`gantt-today-edge gantt-today-edge--${edge}`}
          aria-label="捲動到今天"
          onClick={scrollToToday}
        >
          {edge === 'left' ? '‹ 今天' : '今天 ›'}
        </button>
      )}

      {emptyGroups.length > 0 && (
        <div className="gantt-empty-groups" role="group" aria-label="無排程任務的成員">
          <span className="gantt-empty-groups-label">無排程任務（{emptyGroups.length}）</span>
          {emptyGroups.map((g) => {
            const id = g.refId!;
            const count = unscheduledCountByAssignee?.get(id) ?? 0;
            const inner = (
              <>
                <Avatar user={{ id, displayName: g.label }} size="xs" tooltip={false} />
                <span className="gantt-empty-groups-name">{g.label}</span>
              </>
            );
            return count > 0 && onShowUnscheduled ? (
              <button
                key={g.key}
                type="button"
                className="gantt-empty-groups-item gantt-empty-groups-item--button"
                onClick={() => onShowUnscheduled(id)}
              >
                {inner}
                <span className="gantt-empty-groups-extra">· 未排程 {count}</span>
              </button>
            ) : (
              <span key={g.key} className="gantt-empty-groups-item">
                {inner}
              </span>
            );
          })}
        </div>
      )}

      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
