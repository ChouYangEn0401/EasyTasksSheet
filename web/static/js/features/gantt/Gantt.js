import { createElement, Fragment } from 'preact';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/compat';
import { useSearchParams } from '../../lib/router.js';
import { statusStyle, statusTone } from '../../lib/colors.js';
import { formatRelative } from '../../lib/format.js';
import { useProjects, useStatusesById, useUsersById } from '../../lib/hooks.js';
import { prefersReducedMotion } from '../../lib/motion.js';
import { openTask, readTaskParam } from '../../lib/openTask.js';
import { isEditableTarget } from '../../lib/shortcuts.js';
import { readStorage, writeStorage } from '../../lib/storage.js';
import { Avatar, Badge, ColorDot, Icon, Tooltip } from '../../ui/index.js';
import { buildGroups, groupSpan } from './grouping.js';
import {
  dayAtClientX,
  defaultScheduleDays,
  formatScheduleBubble,
  groupFields,
  growExtent,
  moveKeyboardTarget,
  ownGroupKey,
  rangeWithExtent,
  rowAtClientY,
  scheduleFieldNote,
  spanFrom,
} from './scheduleDrop.js';
import {
  applyDrag,
  barGeometry,
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
} from './timeline.js';

const ALL_GROUP = { kind: 'all', refId: null, label: '全部任務' };

/** 左欄（sticky）寬 */
const leftWidthOf = (el) => el?.querySelector('.gantt-head-corner')?.offsetWidth ?? 0;

/** 拖曳排程時在邊緣區停留多久才開始自動捲動 */
const EDGE_DWELL_MS = 250;
/** 拖曳排程時貼近邊緣的自動捲動速度（px / frame） */
const edgeSpeed = (depth) => Math.min(24, 4 + Math.max(0, depth) * 0.5);

const DRAG_THRESHOLD = 4;
const EDGE = 40;
const KEY_COMMIT_MS = 500;
const FLASH_MS = 1500;

function readCollapsed(key) {
  try {
    const raw = readStorage(key);
    return new Set(raw ? JSON.parse(raw) : []);
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
  scheduleDrag,
  onScheduleTarget,
}) {
  const editable = !compact && !!onChangeDates;
  const schedTask = editable && scheduleDrag ? scheduleDrag.task : null;
  const schedKeyboard = !!schedTask && !!scheduleDrag?.keyboard;
  const schedOwnKey = schedTask ? ownGroupKey(schedTask, groupBy) : null;
  const statusesById = useStatusesById();
  const usersById = useUsersById();
  const projects = useProjects().data;
  const [searchParams] = useSearchParams();
  const selectedId = readTaskParam(searchParams);

  const [collapsed, setCollapsed] = useState(() => readCollapsed(storageKey));
  const toggleGroup = useCallback(
    (key) =>
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
  const [kbPreview, setKbPreview] = useState(null);
  const kbTimer = useRef(undefined);
  const [announce, setAnnounce] = useState('');
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const [hoverBar, setHoverBar] = useState(null);
  const [flashId, setFlashId] = useState(null);
  const flashTimer = useRef(undefined);

  /* ── 範圍（填滿可視寬度；拖曳中凍結） ───────────── */
  const scrollRef = useRef(null);
  const [viewW, setViewW] = useState(0);
  const dw = DAY_WIDTH[scale];
  const minDays = viewW > 0 ? Math.ceil(viewW / dw) : 0;
  // 拖曳排程經過的日期範圍（只增不減，放下後保留 → 範圍重算穩定不跳動）
  const [extent, setExtent] = useState(null);
  const computedRange = useMemo(
    () => rangeWithExtent(tasks, today, scale, minDays, extent),
    [tasks, today, scale, minDays, extent],
  );
  const [dragRange, setDragRange] = useState(null);
  const range = dragRange ?? computedRange;
  const totalWidth = (range.end - range.start) * dw;
  const todayDay = toDay(today);
  const header = useMemo(() => headerCells(range, scale, todayDay), [range, scale, todayDay]);
  /** 今天那一天的中心 x */
  const todayX = (todayDay - range.start) * dw + dw / 2;
  const todayInRange = todayDay >= range.start && todayDay < range.end;

  const isOverdue = useCallback(
    (t) => !!t.dueDate && t.dueDate < today && statusesById.get(t.statusId)?.category !== 'done',
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
  // 沒有已排程任務的成員不佔列，集中到摘要列（拖曳排程中，被拖任務自己的分組改為暫時的空白列）
  const emptyGroups = useMemo(
    () => groups.filter((g) => g.kind === 'user' && g.tasks.length === 0 && g.key !== schedOwnKey),
    [groups, schedOwnKey],
  );

  const rows = useMemo(() => {
    const out = [];
    let ownShown = false;
    for (const g of groups) {
      if (g.kind === 'all') {
        for (const t of g.tasks)
          out.push({ type: 'task', key: `t${t.id}`, task: t, grouped: false, groupKey: g.key });
        continue;
      }
      if (g.key === schedOwnKey) ownShown = true;
      if (g.tasks.length === 0) {
        if (g.key === schedOwnKey)
          out.push({ type: 'group', key: g.key, group: g, collapsed: false, placeholder: true });
        continue;
      }
      const isCollapsed = collapsed.has(g.key);
      out.push({ type: 'group', key: g.key, group: g, collapsed: isCollapsed });
      if (!isCollapsed)
        for (const t of g.tasks)
          out.push({ type: 'task', key: `t${t.id}`, task: t, grouped: true, groupKey: g.key });
    }
    // 拖曳排程：被拖任務自己的分組（負責人 / 專案）尚無已排程任務時，暫時補一列空白列，放這裡不改負責人 / 專案
    if (schedTask && schedOwnKey && groupBy !== 'none' && !ownShown) {
      const group =
        groupBy === 'project'
          ? {
              key: schedOwnKey,
              kind: 'project',
              label:
                projects?.find((p) => p.id === schedTask.projectId)?.name ?? `專案 #${schedTask.projectId}`,
              refId: schedTask.projectId,
              color: projects?.find((p) => p.id === schedTask.projectId)?.color,
              tasks: [],
            }
          : schedTask.assigneeId == null
            ? { key: schedOwnKey, kind: 'unassigned', label: '未指派', refId: null, tasks: [] }
            : {
                key: schedOwnKey,
                kind: 'user',
                label: usersById.get(schedTask.assigneeId)?.displayName ?? `成員 #${schedTask.assigneeId}`,
                refId: schedTask.assigneeId,
                tasks: [],
              };
      out.push({ type: 'group', key: schedOwnKey, group, collapsed: false, placeholder: true });
    }
    return out;
  }, [groups, collapsed, schedTask, schedOwnKey, groupBy, projects, usersById]);

  const [focusKey, setFocusKey] = useState(null);
  const focusIndex = Math.max(
    0,
    rows.findIndex((r) => r.key === focusKey),
  );

  /* ── 捲動 ─────────────────────────────── */
  const layoutRef = useRef(null);
  const [scrolledX, setScrolledX] = useState(false);
  const [edge, setEdge] = useState(null);

  const leftWidth = () => leftWidthOf(scrollRef.current);
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
    const out = [];
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
    (id) => {
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

  const flashTask = useCallback((id) => {
    window.clearTimeout(flashTimer.current);
    setFlashId(id);
    flashTimer.current = window.setTimeout(() => setFlashId(null), FLASH_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  /* ── 未排程任務拖曳排程（§A7） ─────────────── */
  const [schedPos, setSchedPos] = useState(null);
  const activeSched = schedTask ? schedPos : null;
  const schedPointer = useRef(null);
  const schedDays = useRef(1);
  // 事件處理器 / rAF 中讀取最新的範圍與列（不放進依賴，避免重建監聽）
  const live = useRef({ range, dw, rows });
  useLayoutEffect(() => {
    live.current = { range, dw, rows };
  });

  /** 指標 → 落點（日 + 列）；不在時間軸列區（表頭、左欄、容器外、列以外的空白）回傳 null */
  const hitSchedule = useCallback((x, y) => {
    const el = scrollRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const headBottom = el.querySelector('.gantt-head')?.getBoundingClientRect().bottom ?? r.top;
    if (y < Math.max(r.top, headBottom) || y >= r.top + el.clientHeight) return null;
    const { range: rg, dw: w } = live.current;
    const day = dayAtClientX(x, {
      left: r.left + el.clientLeft,
      leftWidth: leftWidthOf(el),
      clientWidth: el.clientWidth,
      scrollLeft: el.scrollLeft,
      rangeStart: rg.start,
      dw: w,
    });
    if (day == null) return null;
    const rowEls = [...el.querySelectorAll('.gantt-body > .gantt-row')];
    const i = rowAtClientY(
      y,
      rowEls.map((n) => {
        const b = n.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom };
      }),
    );
    const rowKey = i >= 0 ? rowEls[i].dataset.rowKey : undefined;
    return rowKey ? { day, rowKey } : null;
  }, []);

  const schedPosRef = useRef(null);
  const setSched = useCallback((next) => {
    schedPosRef.current = next;
    setSchedPos((prev) => (prev?.day === next?.day && prev?.rowKey === next?.rowKey ? prev : next));
    // 落點超出目前範圍時延伸（沿用 computeRange 的邊界規則）
    if (next) setExtent((e) => growExtent(e, spanFrom(next.day, schedDays.current)));
  }, []);

  const recomputeSchedule = useCallback(() => {
    const p = schedPointer.current;
    setSched(p ? hitSchedule(p.x, p.y) : null);
  }, [hitSchedule, setSched]);

  /** 鍵盤拖曳可停的列：有分組時為各群組列，不分組時為各任務列 */
  const scheduleAnchors = () =>
    live.current.rows
      .filter((r) => (groupBy === 'none' ? r.type === 'task' : r.type === 'group'))
      .map((r) => r.key);

  const pointerScheduling = !!schedTask && !schedKeyboard;
  // 指標拖曳：貼近時間軸邊緣時自動捲動；已到範圍盡頭則延伸範圍
  useEffect(() => {
    if (!pointerScheduling) return;
    let raf = 0;
    /** 指標進入邊緣區的時間：停留超過 EDGE_DWELL_MS 才捲動（只是路過不捲） */
    let edgeSince = null;
    const tick = (now) => {
      raf = window.requestAnimationFrame(tick);
      const el = scrollRef.current;
      const p = schedPointer.current;
      if (!el || !p) return;
      const r = el.getBoundingClientRect();
      const timeLeft = r.left + leftWidthOf(el);
      const right = r.left + el.clientWidth;
      const bottom = r.top + el.clientHeight;
      const headH = el.querySelector('.gantt-head')?.offsetHeight ?? 0;
      let dx = 0;
      let dy = 0;
      // 邊緣區只算時間軸可視區內側（從左欄 / 未排程區拖進來時不會誤觸）
      if (p.x >= timeLeft && p.x <= right && p.y >= r.top + headH && p.y <= bottom) {
        if (p.x > right - EDGE) dx = edgeSpeed(p.x - (right - EDGE));
        else if (p.x < timeLeft + EDGE) dx = -edgeSpeed(timeLeft + EDGE - p.x);
        if (p.y < r.top + headH + EDGE) dy = -edgeSpeed(r.top + headH + EDGE - p.y);
        else if (p.y > bottom - EDGE) dy = edgeSpeed(p.y - (bottom - EDGE));
      }
      if (!dx && !dy) {
        edgeSince = null;
        return;
      }
      edgeSince ??= now;
      if (now - edgeSince < EDGE_DWELL_MS) return;
      const rg = live.current.range;
      if (dx > 0 && el.scrollLeft >= el.scrollWidth - el.clientWidth - 1)
        setExtent((e) => growExtent(e, { start: rg.end, end: rg.end }));
      else if (dx < 0 && el.scrollLeft <= 0)
        setExtent((e) => growExtent(e, { start: rg.start - 1, end: rg.start - 1 }));
      else el.scrollLeft += dx;
      if (dy) el.scrollTop += dy;
      recomputeSchedule();
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [pointerScheduling, recomputeSchedule]);

  // 鍵盤拖曳：落點保持在可視範圍內（在範圍效果之後執行）
  useLayoutEffect(() => {
    if (!schedKeyboard || !activeSched) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = (activeSched.day - range.start) * dw;
    const vis = visibleWidth();
    if (x < el.scrollLeft || x + dw > el.scrollLeft + vis) el.scrollLeft = Math.max(0, x - vis / 3);
    el.querySelector(`[data-row-key="${activeSched.rowKey}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [schedKeyboard, activeSched, range.start, dw, visibleWidth]);

  const groupByKey = useMemo(() => {
    const m = new Map();
    for (const r of rows) if (r.type === 'group') m.set(r.key, r.group);
    return m;
  }, [rows]);

  /** 目前落點 → 起訖與分組欄位 */
  const schedInfo = useMemo(() => {
    if (!schedTask || !activeSched) return null;
    const row = rows.find((r) => r.key === activeSched.rowKey);
    if (!row) return null;
    const groupKey = row.type === 'group' ? row.key : row.groupKey;
    const g = groupKey === 'all' ? ALL_GROUP : groupByKey.get(groupKey);
    if (!g) return null;
    const group = { kind: g.kind, refId: g.refId, label: g.label };
    const span = spanFrom(activeSched.day, defaultScheduleDays(schedTask.estimateHours));
    return { ...span, groupKey, group, fields: groupFields(group, schedTask) };
  }, [schedTask, activeSched, rows, groupByKey]);

  useEffect(() => {
    onScheduleTarget?.(schedInfo);
  }, [schedInfo, onScheduleTarget]);

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
      focusTask: (id) => {
        const el = scrollRef.current?.querySelector(`[data-row-key="t${id}"]`);
        if (!el) return;
        setFocusKey(`t${id}`);
        el.focus({ preventScroll: true });
      },
      expandGroup: (key) => {
        if (collapsed.has(key)) toggleGroup(key);
      },
      scheduleBegin: (task, keyboard) => {
        schedPointer.current = null;
        schedDays.current = defaultScheduleDays(task.estimateHours);
        if (!keyboard) return setSched(null);
        const own = ownGroupKey(task, groupBy);
        const first = live.current.rows.find((r) => r.type === 'task')?.key;
        const rowKey = groupBy === 'none' ? first : own;
        setSched(rowKey ? { day: todayDay, rowKey } : null);
      },
      schedulePointer: (x, y) => {
        schedPointer.current = { x, y };
        recomputeSchedule();
      },
      scheduleKey: (key, shift) => {
        const prev = schedPosRef.current;
        if (prev) setSched(moveKeyboardTarget(prev, key, scheduleAnchors(), shift));
      },
    }),

    [
      scrollToToday,
      scrollToTask,
      visibleWidth,
      flashTask,
      collapsed,
      toggleGroup,
      groupBy,
      todayDay,
      setSched,
      recomputeSchedule,
    ],
  );

  /* ── 拖曳 ─────────────────────────────── */
  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
    setDragRange(null);
  }, []);

  useEffect(() => {
    if (!drag) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        endDrag();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drag, endDrag]);

  const onBarPointerDown = (e, task, mode) => {
    if (e.button !== 0) return;
    const span = taskSpan(task);
    if (!span) return;
    e.stopPropagation();
    if (!editable) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const state = {
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

  const onBarPointerMove = (e) => {
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

  const onBarPointerUp = (e, task) => {
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
  const focusRow = (idx) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, idx))];
    if (!row) return;
    setFocusKey(row.key);
    const el = scrollRef.current?.querySelector(`[data-row-key="${row.key}"]`);
    el?.focus();
    if (row.type === 'task') scrollToTask(row.task.id);
  };

  const shiftByKeyboard = (task, mode, delta) => {
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

  const onTreeKeyDown = (e) => {
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

  const onRootKeyDown = (e) => {
    if (e.defaultPrevented || isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      scrollToToday();
    } else if (onScaleChange && ['1', '2', '3'].includes(e.key)) {
      e.preventDefault();
      onScaleChange(SCALES[Number(e.key) - 1]);
    }
  };

  /* ── 繪製 ─────────────────────────────── */
  const spanOf = (task) => {
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
            createElement('span', {
              key: c.key,
              className: 'gantt-gridline',
              style: { left: (c.start - range.start) * dw },
            }),
          );
    for (const c of header.top)
      if (c.start > range.start)
        out.push(
          createElement('span', {
            key: c.key,
            className: 'gantt-gridline gantt-gridline--major',
            style: { left: (c.start - range.start) * dw },
          }),
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
          createElement('span', {
            key: d,
            className: 'gantt-weekend',
            style: { left: (d - range.start) * dw, width: (wd === 5 ? 2 : 1) * dw },
          }),
        );
    }
    if (todayInRange)
      out.push(
        createElement('span', {
          key: 'today',
          className: 'gantt-today-band',
          style: { left: (todayDay - range.start) * dw, width: dw },
        }),
      );
    return out;
  }, [scale, range, dw, todayDay, todayInRange]);

  const rootStyle = {
    '--gantt-total': `${totalWidth}px`,
    '--gantt-dw': `${dw}px`,
  };

  const userLabel = (id) => (id == null ? '未指派' : (usersById.get(id)?.displayName ?? '—'));

  // 拖曳排程的預覽：半透明長條 + 日期氣泡（畫在落點那一列的時間軸格內）
  const schedNote = schedInfo ? scheduleFieldNote(schedInfo) : null;
  const dropGroupKey = schedInfo && groupBy !== 'none' ? schedInfo.groupKey : null;
  const renderSchedPreview = (rowKey, idx) =>
    schedInfo && schedTask && activeSched?.rowKey === rowKey
      ? createElement(
          'span',
          {
            className: `gantt-sched-slot${idx === 0 ? ' is-first' : ''}`,
            style: {
              left: (schedInfo.start - range.start) * dw,
              width: (schedInfo.end - schedInfo.start + 1) * dw,
            },
            'aria-hidden': 'true',
          },
          createElement(
            'span',
            { className: 'gantt-sched-bar', 'data-testid': 'gantt-sched-preview' },
            createElement('span', { className: 'gantt-sched-title' }, schedTask.title),
          ),
          createElement(
            'span',
            { className: 'gantt-sched-bubble', 'data-testid': 'gantt-sched-bubble' },
            createElement('span', null, formatScheduleBubble(schedInfo.start, schedInfo.end)),
            schedNote && createElement('span', { className: 'gantt-sched-note' }, schedNote),
          ),
        )
      : null;

  return createElement(
    'div',
    {
      className: [
        'gantt',
        compact && 'gantt--compact',
        drag?.moved && 'gantt--dragging',
        schedTask && 'gantt--scheduling',
        scrolledX && 'is-scrolled-x',
      ]
        .filter(Boolean)
        .join(' '),
      style: rootStyle,
      onKeyDown: onRootKeyDown,
      'data-scale': scale,
    },
    createElement(
      'div',
      {
        className: 'gantt-scroll',
        ref: scrollRef,
        onScroll: () => {
          syncScroll();
          if (pointerScheduling) recomputeSchedule();
        },
      },
      createElement(
        'div',
        { className: 'gantt-inner' },
        createElement(
          'div',
          { className: 'gantt-head' },
          createElement(
            'div',
            { className: 'gantt-head-corner' },
            createElement('span', null, '任務'),
            createElement('span', null, '起訖'),
          ),
          createElement(
            'div',
            { className: 'gantt-head-time', 'aria-hidden': 'true' },
            createElement(
              'div',
              { className: 'gantt-head-row gantt-head-row--top' },
              header.top.map((c) =>
                createElement(
                  'span',
                  {
                    key: c.key,
                    className: 'gantt-head-cell',
                    style: { left: (c.start - range.start) * dw, width: c.days * dw },
                  },
                  createElement('span', { className: 'gantt-head-label' }, c.label),
                ),
              ),
            ),
            createElement(
              'div',
              { className: 'gantt-head-row gantt-head-row--bottom' },
              header.bottom.map((c) => {
                const mode = c.today ? todayCellMode(scale, c.days * dw) : null;
                return createElement(
                  'span',
                  {
                    key: c.key,
                    className: [
                      'gantt-head-cell',
                      c.weekend && 'gantt-head-cell--weekend',
                      mode && `is-today is-today--${mode}`,
                    ]
                      .filter(Boolean)
                      .join(' '),
                    style: { left: (c.start - range.start) * dw, width: c.days * dw },
                  },
                  scale === 'day'
                    ? createElement(
                        'span',
                        { className: 'gantt-head-day' },
                        c.label.split(' ').map((part) => createElement('span', { key: part }, part)),
                      )
                    : mode !== 'chip' && createElement('span', { className: 'gantt-head-label' }, c.label),
                  (mode === 'both' || mode === 'chip') &&
                    createElement('span', { className: 'gantt-today-chip' }, '今天'),
                );
              }),
            ),
            todayInRange &&
              !edge &&
              createElement('span', { className: 'gantt-today-dot', style: { left: todayX } }),
          ),
        ),

        createElement(
          'div',
          {
            className: 'gantt-body',
            role: 'tree',
            'aria-label': ariaLabel,
            onKeyDown: onTreeKeyDown,
            'data-scale': scale,
          },
          bands && createElement('div', { className: 'gantt-bands', 'aria-hidden': 'true' }, bands),
          createElement(
            'div',
            { className: 'gantt-overlay', 'aria-hidden': 'true' },
            gridLines,
            todayInRange && createElement('span', { className: 'gantt-today-line', style: { left: todayX } }),
            schedInfo &&
              activeSched &&
              createElement('span', {
                className: 'gantt-sched-col',
                style: { left: (activeSched.day - range.start) * dw, width: dw },
              }),
          ),

          rows.map((row, idx) => {
            const tabIndex = idx === focusIndex ? 0 : -1;
            if (row.type === 'group') {
              const g = row.group;
              const span = groupSpan(g.tasks);
              const overdueCount = g.tasks.filter(isOverdue).length;
              return createElement(
                'div',
                {
                  key: row.key,
                  'data-row-key': row.key,
                  className: [
                    'gantt-row gantt-row--group',
                    row.placeholder && 'gantt-row--placeholder',
                    dropGroupKey === row.key && 'is-drop-target',
                  ]
                    .filter(Boolean)
                    .join(' '),
                  role: 'treeitem',
                  'aria-level': 1,
                  'aria-expanded': !row.collapsed,
                  'aria-label': `${g.label}，${g.tasks.length} 筆${overdueCount ? `，逾期 ${overdueCount} 筆` : ''}`,
                  tabIndex: tabIndex,
                  onFocus: () => setFocusKey(row.key),
                },
                createElement(
                  'div',
                  {
                    className: 'gantt-cell-left',
                    onClick: () => {
                      if (!row.placeholder) toggleGroup(row.key);
                    },
                  },
                  createElement(Icon, {
                    name: row.collapsed ? 'chevronRight' : 'chevronDown',
                    size: 16,
                    className: 'gantt-chevron',
                  }),
                  g.kind === 'project'
                    ? createElement(ColorDot, { color: g.color, size: 'md' })
                    : g.kind === 'user'
                      ? createElement(Avatar, { userId: g.refId, size: 'sm', tooltip: false })
                      : createElement(Avatar, { user: null, size: 'sm', tooltip: false }),
                  createElement('span', { className: 'gantt-group-name' }, g.label),
                  row.placeholder
                    ? createElement('span', { className: 'gantt-group-hint' }, '尚無排程')
                    : createElement(
                        Tooltip,
                        { content: `${g.tasks.length} 筆已排程任務` },
                        createElement(Badge, { count: true }, g.tasks.length),
                      ),
                  overdueCount > 0 &&
                    createElement(
                      'span',
                      { className: 'gantt-group-overdue' },
                      createElement(Badge, { tone: 'danger' }, '逾期 ', overdueCount),
                    ),
                ),
                createElement(
                  'div',
                  { className: 'gantt-cell-time', 'aria-hidden': 'true' },
                  span &&
                    !row.collapsed &&
                    createElement('span', {
                      className: 'gantt-group-line',
                      style: {
                        left: (span.start - range.start) * dw,
                        width: (span.end - span.start + 1) * dw,
                      },
                    }),
                  span &&
                    row.collapsed &&
                    createElement(
                      Fragment,
                      null,
                      g.tasks.map((t) => {
                        const s = taskSpan(t);
                        if (!s) return null;
                        const tone = (() => {
                          const st = statusesById.get(t.statusId);
                          return st ? statusTone(st) : 'todo';
                        })();
                        return createElement('span', {
                          key: t.id,
                          className: 'gantt-group-mini',
                          style: {
                            left: (s.start - range.start) * dw,
                            width: Math.max(4, (s.end - s.start + 1) * dw),
                            ...statusStyle(tone),
                          },
                        });
                      }),
                      createElement(
                        'span',
                        {
                          className: 'gantt-group-summary',
                          style: { left: (span.end - range.start + 1) * dw + 10 },
                        },
                        g.tasks.length,
                        ' 筆 · ',
                        formatDayRange(span.start, span.end),
                      ),
                    ),
                  renderSchedPreview(row.key, idx),
                ),
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
            return createElement(
              'div',
              {
                key: row.key,
                'data-row-key': row.key,
                'data-task-id': t.id,
                className: [
                  'gantt-row gantt-row--task',
                  selectedId === t.id && 'is-selected',
                  flashId === t.id && 'is-flash',
                  dropGroupKey != null && dropGroupKey === row.groupKey && 'is-drop-target',
                ]
                  .filter(Boolean)
                  .join(' '),
                role: 'treeitem',
                'aria-level': row.grouped ? 2 : 1,
                'aria-selected': selectedId === t.id,
                'aria-label': rowLabel,
                tabIndex: tabIndex,
                onFocus: (e) => {
                  if (e.target === e.currentTarget) setFocusKey(row.key);
                },
              },
              createElement(
                'div',
                {
                  className: `gantt-cell-left${row.grouped ? ' gantt-cell-left--indent' : ''}`,
                  onClick: () => openTask(t.id),
                },
                createElement(
                  Tooltip,
                  { content: status?.name },
                  createElement('span', { className: 'gantt-status-dot', style: statusStyle(tone) }),
                ),
                createElement('span', { className: 'gantt-task-title', title: t.title }, t.title),
                dates &&
                  createElement(
                    'span',
                    { className: `gantt-task-dates${overdue ? ' is-overdue' : ''}` },
                    overdue ? createElement(Tooltip, { content: `已逾期 ${odDays} 天` }, dates) : dates,
                  ),
              ),
              createElement(
                'div',
                { className: 'gantt-cell-time' },
                span &&
                  geo &&
                  createElement(
                    'div',
                    {
                      className: [
                        'gantt-bar',
                        geo.narrow && 'gantt-bar--narrow',
                        real?.single && 'gantt-bar--single',
                        overdue && 'gantt-bar--overdue',
                        done && 'gantt-bar--done',
                        isDragging && 'is-dragging',
                        editable && 'is-editable',
                      ]
                        .filter(Boolean)
                        .join(' '),
                      style: { left, width: geo.visualWidth, ...statusStyle(tone) },
                      'data-testid': `gantt-bar-${t.id}`,
                      onPointerDown: (e) => onBarPointerDown(e, t, 'move'),
                      onPointerMove: onBarPointerMove,
                      onPointerUp: (e) => onBarPointerUp(e, t),
                      onPointerCancel: endDrag,
                      onPointerEnter: () => setHoverBar(t.id),
                      onPointerLeave: () => setHoverBar((h) => (h === t.id ? null : h)),
                      onClick: (e) => {
                        // 非拖曳模式（唯讀）時以 click 開啟
                        if (!editable) {
                          e.stopPropagation();
                          openTask(t.id);
                        }
                      },
                    },
                    showInside &&
                      createElement(
                        'span',
                        { className: 'gantt-bar-label gantt-bar-label--in', 'aria-hidden': 'true' },
                        done &&
                          createElement(Icon, { name: 'check', size: 12, className: 'gantt-bar-check' }),
                        createElement('span', { className: 'gantt-bar-title' }, t.title),
                        overdue &&
                          geo.overdueInside &&
                          createElement('span', { className: 'gantt-bar-overdue' }, '逾期 ', odDays, ' 天'),
                        showPct &&
                          geo.pctInside &&
                          createElement('span', { className: 'gantt-bar-pct' }, t.progress, '%'),
                      ),
                    !done &&
                      !geo.narrow &&
                      t.progress > 0 &&
                      createElement('span', {
                        className: 'gantt-bar-progress',
                        style: { width: `${Math.min(100, t.progress)}%` },
                      }),
                    editable &&
                      createElement(
                        Fragment,
                        null,
                        createElement('span', {
                          className: 'gantt-handle gantt-handle--start',
                          'data-testid': `gantt-handle-start-${t.id}`,
                          onPointerDown: (e) => onBarPointerDown(e, t, 'start'),
                        }),
                        createElement('span', {
                          className: 'gantt-handle gantt-handle--end',
                          'data-testid': `gantt-handle-end-${t.id}`,
                          onPointerDown: (e) => onBarPointerDown(e, t, 'end'),
                        }),
                      ),
                    showOutside &&
                      createElement(
                        'span',
                        { className: 'gantt-bar-label gantt-bar-label--out', 'aria-hidden': 'true' },
                        createElement('span', { className: 'gantt-bar-title' }, t.title),
                        t.progress > 0 &&
                          createElement('span', { className: 'gantt-bar-meta' }, ' · ', t.progress, '%'),
                        overdue &&
                          createElement(
                            'span',
                            { className: 'gantt-bar-overdue' },
                            ' · 逾期 ',
                            odDays,
                            ' 天',
                          ),
                      ),
                    isDragging
                      ? createElement(
                          'span',
                          { className: 'ui-tooltip', role: 'status' },
                          formatSpan(span.start, span.end),
                        )
                      : hoverBar === t.id &&
                          !drag &&
                          createElement(
                            'span',
                            {
                              className: `ui-tooltip gantt-tip${idx < 2 ? ' ui-tooltip--bottom' : ''}`,
                              role: 'tooltip',
                            },
                            createElement('strong', null, t.title),
                            '\n',
                            formatSpan(span.start, span.end),
                            overdue ? ` · 已逾期 ${odDays} 天` : '',
                            '\n',
                            '進度 ',
                            t.progress,
                            '% · ',
                            status?.name ?? '—',
                            ' · ',
                            userLabel(t.assigneeId),
                            '\n',
                            '更新於 ',
                            formatRelative(t.updatedAt),
                            updaterName ? ` · 由 ${updaterName}` : '',
                          ),
                  ),
                isDragging &&
                  real &&
                  createElement('span', {
                    className: 'gantt-bar-ghost',
                    style: {
                      left: (real.start - range.start) * dw,
                      width: (real.end - real.start + 1) * dw,
                    },
                  }),
                renderSchedPreview(row.key, idx),
              ),
            );
          }),
        ),
      ),
    ),

    edge &&
      createElement(
        'button',
        {
          type: 'button',
          className: `gantt-today-edge gantt-today-edge--${edge}`,
          'aria-label': '捲動到今天',
          onClick: scrollToToday,
        },
        edge === 'left' ? '‹ 今天' : '今天 ›',
      ),
    emptyGroups.length > 0 &&
      createElement(
        'div',
        { className: 'gantt-empty-groups', role: 'group', 'aria-label': '無排程任務的成員' },
        createElement(
          'span',
          { className: 'gantt-empty-groups-label' },
          '無排程任務（',
          emptyGroups.length,
          '）',
        ),
        emptyGroups.map((g) => {
          const id = g.refId;
          const count = unscheduledCountByAssignee?.get(id) ?? 0;
          const inner = createElement(
            Fragment,
            null,
            createElement(Avatar, { user: { id, displayName: g.label }, size: 'xs', tooltip: false }),
            createElement('span', { className: 'gantt-empty-groups-name' }, g.label),
          );
          return count > 0 && onShowUnscheduled
            ? createElement(
                'button',
                {
                  key: g.key,
                  type: 'button',
                  className: 'gantt-empty-groups-item gantt-empty-groups-item--button',
                  onClick: () => onShowUnscheduled(id),
                },
                inner,
                createElement('span', { className: 'gantt-empty-groups-extra' }, '· 未排程 ', count),
              )
            : createElement('span', { key: g.key, className: 'gantt-empty-groups-item' }, inner);
        }),
      ),
    createElement('span', { className: 'sr-only', 'aria-live': 'polite' }, announce),
  );
}
