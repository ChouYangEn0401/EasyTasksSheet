/*
 * 未排程任務拖到時間軸排程（docs/design/gantt-overview.md §A7）的純函式：
 * 預設天數、游標座標 → 日期吸附、分組列 → 欄位 patch、範圍延伸、播報 / 氣泡文案、鍵盤落點移動。
 * 不依賴 React / DOM，方便單元測試（scheduleDrop.test.ts）。
 */
import type { GroupBy } from './grouping.ts';
import { computeRange, fromDay, type DatedLike, type Scale } from './timeline.ts';

/** 沒有預估工時時的預設天數 */
export const DEFAULT_SCHEDULE_DAYS = 3;
/** 一個工作天的工時（換算預設天數用） */
export const HOURS_PER_DAY = 8;

/**
 * 預設排程天數（日曆天，不跳過週末）：有預估工時（> 0）→ max(1, ceil(hours / 8))；沒有 / 0 → 3 天。
 */
export function defaultScheduleDays(estimateHours: number | null | undefined): number {
  if (estimateHours == null || !Number.isFinite(estimateHours) || estimateHours <= 0)
    return DEFAULT_SCHEDULE_DAYS;
  return Math.max(1, Math.ceil(estimateHours / HOURS_PER_DAY));
}

/** 開始日 + 天數 → 起訖（到期日 = 開始日 + 天數 − 1） */
export function spanFrom(startDay: number, days: number): { start: number; end: number } {
  return { start: startDay, end: startDay + Math.max(1, Math.floor(days)) - 1 };
}

export type TimeGeometry = {
  /** 捲動容器左緣（client x） */
  left: number;
  /** 左欄（sticky）寬 */
  leftWidth: number;
  /** 捲動容器可視寬（不含捲軸） */
  clientWidth: number;
  scrollLeft: number;
  rangeStart: number;
  /** 每日寬（px） */
  dw: number;
};

/**
 * 游標 client x → 吸附到的日（日序）；不在時間軸可視區（左欄上或容器外）回傳 null。
 * 週 / 月刻度一樣以日為單位吸附。
 */
export function dayAtClientX(clientX: number, g: TimeGeometry): number | null {
  const timeLeft = g.left + g.leftWidth;
  const right = g.left + g.clientWidth;
  if (clientX < timeLeft || clientX >= right || g.dw <= 0) return null;
  const x = clientX - timeLeft + g.scrollLeft;
  return g.rangeStart + Math.floor(x / g.dw);
}

/** 依 client y 找所在列（rows 為各列的 client 上下緣，依顯示順序）；不在任何列上回傳 -1 */
export function rowAtClientY(clientY: number, rows: { top: number; bottom: number }[]): number {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (clientY >= r.top && clientY < r.bottom) return i;
  }
  return -1;
}

export type ScheduleGroup = {
  kind: 'all' | 'user' | 'unassigned' | 'project';
  refId: number | null;
  label: string;
};

export type GroupFields = { assigneeId?: number | null; projectId?: number };

/**
 * 放到某分組列時要一併改的欄位（只回傳有變動者）：
 * 負責人列 → 指派給他（原本就是他則不改）；「未指派」列 → 取消指派；專案列 → 改專案；不分組 → 不改。
 */
export function groupFields(
  group: Pick<ScheduleGroup, 'kind' | 'refId'>,
  task: { assigneeId: number | null; projectId: number },
): GroupFields {
  switch (group.kind) {
    case 'user':
      return group.refId != null && group.refId !== task.assigneeId ? { assigneeId: group.refId } : {};
    case 'unassigned':
      return task.assigneeId != null ? { assigneeId: null } : {};
    case 'project':
      return group.refId != null && group.refId !== task.projectId ? { projectId: group.refId } : {};
    case 'all':
      return {};
  }
}

/** 任務在目前分組方式下「自己的」分組 key（與 grouping.ts 的 key 規則一致） */
export function ownGroupKey(
  task: { assigneeId: number | null; projectId: number },
  groupBy: GroupBy,
): string {
  if (groupBy === 'none') return 'all';
  if (groupBy === 'project') return `p${task.projectId}`;
  return task.assigneeId == null ? 'none' : `u${task.assigneeId}`;
}

export type ScheduleTarget = {
  start: number;
  end: number;
  groupKey: string;
  group: ScheduleGroup;
  fields: GroupFields;
};

export type SchedulePatch = {
  startDate: string;
  dueDate: string;
  assigneeId?: number | null;
  projectId?: number;
};

/** 放下後要送出的 PATCH（日期 + 依分組的欄位） */
export function schedulePatch(target: Pick<ScheduleTarget, 'start' | 'end' | 'fields'>): SchedulePatch {
  return { startDate: fromDay(target.start), dueDate: fromDay(target.end), ...target.fields };
}

/** 復原用前值：排程前的日期與分組欄位 */
export function scheduleBefore(task: {
  startDate: string | null;
  dueDate: string | null;
  assigneeId: number | null;
  projectId: number;
}) {
  return {
    startDate: task.startDate,
    dueDate: task.dueDate,
    assigneeId: task.assigneeId,
    projectId: task.projectId,
  };
}

/** 日序 → 11/26 */
export function formatMonthDay(day: number): string {
  const [, m, d] = fromDay(day).split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** 11/26 – 11/28 */
export const formatScheduleRange = (start: number, end: number) =>
  `${formatMonthDay(start)} – ${formatMonthDay(end)}`;

/** 氣泡：11/26 – 11/28（3 天） */
export const formatScheduleBubble = (start: number, end: number) =>
  `${formatScheduleRange(start, end)}（${end - start + 1} 天）`;

/** 分組欄位變更的提示（氣泡第二行、toast 說明）；沒有變更回傳 null */
export function scheduleFieldNote(target: Pick<ScheduleTarget, 'fields' | 'group'>): string | null {
  if ('assigneeId' in target.fields)
    return target.fields.assigneeId == null ? '同時改為未指派' : `同時指派給 ${target.group.label}`;
  if ('projectId' in target.fields) return `同時移到專案 ${target.group.label}`;
  return null;
}

/** 復原紀錄標籤：排程『X』（11/26–11/28） */
export const scheduleUndoLabel = (title: string, start: number, end: number) =>
  `排程『${title}』（${formatMonthDay(start)}–${formatMonthDay(end)}）`;

/** aria-live 播報 */
export const announceSchedule = {
  pickup: (title: string) =>
    `已拿起『${title}』，左右方向鍵移動日期，上下方向鍵切換分組，空白鍵放下，Esc 取消`,
  target: (t: Pick<ScheduleTarget, 'start' | 'end' | 'fields' | 'group'>) => {
    const base = `預計排程 ${formatMonthDay(t.start)} 到 ${formatMonthDay(t.end)}`;
    if ('assigneeId' in t.fields)
      return t.fields.assigneeId == null ? `${base}，改為未指派` : `${base}，指派給 ${t.group.label}`;
    if ('projectId' in t.fields) return `${base}，移到專案 ${t.group.label}`;
    return base;
  },
  outside: '不在時間軸上，放開將取消',
  drop: (title: string, start: number, end: number) =>
    `已排程『${title}』：${formatMonthDay(start)} 到 ${formatMonthDay(end)}`,
  cancel: (title: string) => `已取消排程『${title}』`,
};

export type Extent = { start: number; end: number };

/** 拖曳時要涵蓋的日期範圍（只增不減；已涵蓋時回傳同一物件，避免多餘的 re-render） */
export function growExtent(extent: Extent | null, span: Extent): Extent {
  if (!extent) return { start: span.start, end: span.end };
  if (span.start >= extent.start && span.end <= extent.end) return extent;
  return { start: Math.min(extent.start, span.start), end: Math.max(extent.end, span.end) };
}

/**
 * 繪製範圍 = computeRange（沿用其邊界、對齊與填滿規則），另把拖曳期間經過的範圍視為一個虛擬任務納入。
 * extent 在放下後保留，放下的任務起訖必在 extent 內 → 範圍重算結果不變、不跳動。
 */
export function rangeWithExtent(
  tasks: DatedLike[],
  today: string,
  scale: Scale,
  minDays: number,
  extent: Extent | null,
): { start: number; end: number } {
  if (!extent) return computeRange(tasks, today, scale, minDays);
  return computeRange(
    [...tasks, { startDate: fromDay(extent.start), dueDate: fromDay(extent.end) }],
    today,
    scale,
    minDays,
  );
}

export type KeyboardMove = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

/**
 * 鍵盤拖曳：←→ 移動 1 天（Shift 時 7 天）、↑↓ 在可放置的列（anchors）間移動，頭尾不循環。
 * current 不在 anchors 內時，↑↓ 從第一列開始。
 */
export function moveKeyboardTarget(
  target: { day: number; rowKey: string },
  key: KeyboardMove,
  anchors: string[],
  shift = false,
): { day: number; rowKey: string } {
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const step = (shift ? 7 : 1) * (key === 'ArrowLeft' ? -1 : 1);
    return { ...target, day: target.day + step };
  }
  if (!anchors.length) return target;
  const i = anchors.indexOf(target.rowKey);
  if (i < 0) return { ...target, rowKey: anchors[0]! };
  const next = Math.max(0, Math.min(anchors.length - 1, i + (key === 'ArrowUp' ? -1 : 1)));
  return { ...target, rowKey: anchors[next]! };
}
