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
import { useProjects, useStatusesById, useUsersById } from '../../lib/hooks.ts';
import { openTask, readTaskParam } from '../../lib/openTask.ts';
import { isEditableTarget } from '../../lib/shortcuts.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
import { Avatar, Badge, ColorDot, Icon, UpdatedAt } from '../../ui/index.ts';
import { buildGroups, groupSpan, type GanttGroup, type GroupBy } from './grouping.ts';
import {
  applyDrag,
  computeRange,
  DAY_WIDTH,
  datePatch,
  formatSpan,
  formatSpanSpoken,
  headerCells,
  SCALES,
  taskSpan,
  toDay,
  weekdayIndex,
  type DragMode,
  type Scale,
} from './timeline.ts';
import './gantt.css';

export type DatePatch = { startDate?: string; dueDate?: string };

export type GanttHandle = {
  scrollToToday: () => void;
  /** 前後捲動一個可視寬度 */
  scrollPage: (dir: -1 | 1) => void;
  scrollToTask: (id: number) => void;
};

export type GanttProps = {
  tasks: Task[];
  groupBy: GroupBy;
  scale: Scale;
  today: string;
  /** 負責人分組時的成員順序（沒有排程任務的成員仍顯示群組列） */
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

const DRAG_THRESHOLD = 4;
const EDGE = 40;
const KEY_COMMIT_MS = 500;

function readCollapsed(key: string): Set<string> {
  try {
    const raw = readStorage(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/**
 * 甘特圖（完整版與總覽精簡版共用）。
 * 單一捲動容器：表頭 sticky top、左欄 sticky left，時間軸隨容器水平捲動。
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

  const dw = DAY_WIDTH[scale];
  const range = useMemo(() => computeRange(tasks, today, scale), [tasks, today, scale]);
  const totalWidth = (range.end - range.start) * dw;
  const header = useMemo(() => headerCells(range, scale), [range, scale]);
  const todayDay = toDay(today);
  const todayX = (todayDay - range.start) * dw;

  const groups = useMemo(
    () =>
      buildGroups(tasks, groupBy, {
        members,
        projects: (projects ?? []).map((p) => ({ id: p.id, name: p.name, color: p.color })),
        userName: (id) => usersById.get(id)?.displayName,
      }),
    [tasks, groupBy, members, projects, usersById],
  );

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of groups) {
      if (g.kind === 'all') {
        for (const t of g.tasks) out.push({ type: 'task', key: `t${t.id}`, task: t, grouped: false });
        continue;
      }
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<{ start: number; dw: number } | null>(null);

  const leftWidth = () =>
    (scrollRef.current?.querySelector('.gantt-head-corner') as HTMLElement | null)?.offsetWidth ?? 0;
  const visibleWidth = useCallback(() => {
    const el = scrollRef.current;
    return el ? Math.max(0, el.clientWidth - leftWidth()) : 0;
  }, []);

  const scrollToToday = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, todayX - visibleWidth() / 3);
  }, [todayX, visibleWidth]);

  // 首次進頁捲到今天；之後刻度或範圍變動時保持可視中心日期不變
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = layoutRef.current;
    if (!prev) {
      el.scrollLeft = Math.max(0, todayX - visibleWidth() / 3);
    } else if (prev.start !== range.start || prev.dw !== dw) {
      const half = visibleWidth() / 2;
      const center = prev.start + (el.scrollLeft + half) / prev.dw;
      el.scrollLeft = Math.max(0, (center - range.start) * dw - half);
    }
    layoutRef.current = { start: range.start, dw };
  }, [range.start, dw, todayX, visibleWidth]);

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

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToToday,
      scrollPage: (dir) => {
        const el = scrollRef.current;
        if (el) el.scrollBy({ left: dir * visibleWidth(), behavior: 'smooth' });
      },
      scrollToTask,
    }),
    [scrollToToday, scrollToTask, visibleWidth],
  );

  /* ── 拖曳 ─────────────────────────────── */
  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
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

  const gridLines = useMemo(() => {
    if (scale === 'day') return null; // 日刻度以背景漸層繪製每日格線
    return header.bottom.map((c) => (
      <span key={c.key} className="gantt-gridline" style={{ left: (c.start - range.start) * dw }} />
    ));
  }, [header, scale, range.start, dw]);

  const weekendBands = useMemo(() => {
    if (scale !== 'day') return null;
    const out = [];
    for (let d = range.start; d < range.end; d++) {
      if (weekdayIndex(d) === 5)
        out.push(
          <span key={d} className="gantt-weekend" style={{ left: (d - range.start) * dw, width: 2 * dw }} />,
        );
    }
    return out;
  }, [scale, range, dw]);

  const rootStyle = {
    '--gantt-total': `${totalWidth}px`,
    '--gantt-dw': `${dw}px`,
  } as CSSProperties;

  const userLabel = (id: number | null) => (id == null ? '未指派' : (usersById.get(id)?.displayName ?? '—'));

  return (
    <div
      className={`gantt${compact ? ' gantt--compact' : ''}${drag?.moved ? ' gantt--dragging' : ''}`}
      style={rootStyle}
      onKeyDown={onRootKeyDown}
    >
      <div className="gantt-scroll" ref={scrollRef}>
        <div className="gantt-inner">
          <div className="gantt-head">
            <div className="gantt-head-corner">
              <span>任務</span>
              <span>更新</span>
            </div>
            <div className="gantt-head-time" aria-hidden="true">
              <div className="gantt-head-row">
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
              <div className="gantt-head-row">
                {header.bottom.map((c) => (
                  <span
                    key={c.key}
                    className={`gantt-head-cell${c.weekend ? ' gantt-head-cell--weekend' : ''}`}
                    style={{ left: (c.start - range.start) * dw, width: c.days * dw }}
                  >
                    <span className="gantt-head-label">{c.label}</span>
                  </span>
                ))}
              </div>
              {todayDay >= range.start && todayDay < range.end && (
                <span className="gantt-today-pill" style={{ left: todayX + dw / 2 }}>
                  今天
                </span>
              )}
            </div>
          </div>

          <div
            className="gantt-body"
            role="tree"
            aria-label={ariaLabel}
            onKeyDown={onTreeKeyDown}
            data-scale={scale}
          >
            <div className="gantt-overlay" aria-hidden="true">
              {weekendBands}
              {gridLines}
              {todayDay >= range.start && todayDay < range.end && (
                <span className="gantt-today-line" style={{ left: todayX + dw / 2 }} />
              )}
            </div>

            {rows.map((row, idx) => {
              const tabIndex = idx === focusIndex ? 0 : -1;
              if (row.type === 'group') {
                const g = row.group;
                const span = groupSpan(g.tasks);
                return (
                  <div
                    key={row.key}
                    data-row-key={row.key}
                    className="gantt-row gantt-row--group"
                    role="treeitem"
                    aria-level={1}
                    aria-expanded={!row.collapsed}
                    aria-label={`${g.label}，${g.tasks.length} 筆`}
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
                      <Badge count>{g.tasks.length}</Badge>
                    </div>
                    <div className="gantt-cell-time" aria-hidden="true">
                      {span ? (
                        <span
                          className="gantt-group-line"
                          style={{
                            left: (span.start - range.start) * dw,
                            width: (span.end - span.start + 1) * dw,
                          }}
                        />
                      ) : (
                        <span className="gantt-group-empty" style={{ left: Math.max(0, todayX - 120) }}>
                          無排程任務
                        </span>
                      )}
                    </div>
                  </div>
                );
              }

              const t = row.task;
              const status = statusesById.get(t.statusId);
              const tone = status ? statusTone(status) : 'todo';
              const done = status?.category === 'done';
              const overdue = !!t.dueDate && t.dueDate < today && !done;
              const real = taskSpan(t);
              const span = spanOf(t);
              const isDragging = drag?.taskId === t.id && drag.moved;
              const left = span ? (span.start - range.start) * dw : 0;
              const width = span ? (span.end - span.start + 1) * dw : 0;
              const ariaLabel = `${t.title}，${t.startDate ?? '未設定'} 至 ${t.dueDate ?? '未設定'}，進度 ${t.progress}%，${status?.name ?? ''}，負責人 ${userLabel(t.assigneeId)}`;
              return (
                <div
                  key={row.key}
                  data-row-key={row.key}
                  data-task-id={t.id}
                  className={`gantt-row gantt-row--task${selectedId === t.id ? ' is-selected' : ''}`}
                  role="treeitem"
                  aria-level={row.grouped ? 2 : 1}
                  aria-selected={selectedId === t.id}
                  aria-label={ariaLabel}
                  tabIndex={tabIndex}
                  onFocus={(e) => {
                    if (e.target === e.currentTarget) setFocusKey(row.key);
                  }}
                >
                  <div
                    className={`gantt-cell-left${row.grouped ? ' gantt-cell-left--indent' : ''}`}
                    onClick={() => openTask(t.id)}
                  >
                    <span className="gantt-task-title" title={t.title}>
                      {t.title}
                    </span>
                    {overdue && <Badge tone="danger">逾期</Badge>}
                    <span className="gantt-task-updated" onClick={(e) => e.stopPropagation()}>
                      <UpdatedAt at={t.updatedAt} by={t.updatedBy} />
                    </span>
                  </div>
                  <div className="gantt-cell-time">
                    {span && (
                      <div
                        className={[
                          'gantt-bar',
                          real?.single && 'gantt-bar--single',
                          overdue && 'gantt-bar--overdue',
                          isDragging && 'is-dragging',
                          editable && 'is-editable',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        style={{ left, width, ...statusStyle(tone) }}
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
                        <span className="gantt-bar-fill" style={{ width: `${t.progress}%` }} />
                        {width >= 44 && (
                          <span
                            className={`gantt-bar-pct${t.progress >= 100 ? ' gantt-bar-pct--on-fill' : ''}`}
                          >
                            {t.progress}%
                          </span>
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
                        {isDragging && span ? (
                          <span className="ui-tooltip" role="status">
                            {formatSpan(span.start, span.end)}
                          </span>
                        ) : (
                          hoverBar === t.id &&
                          !drag &&
                          span && (
                            <span
                              className={`ui-tooltip gantt-tip${idx < 2 ? ' ui-tooltip--bottom' : ''}`}
                              role="tooltip"
                            >
                              <strong>{t.title}</strong>
                              {'\n'}
                              {formatSpan(span.start, span.end)}
                              {'\n'}進度 {t.progress}% · {status?.name ?? '—'} · {userLabel(t.assigneeId)}
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
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
