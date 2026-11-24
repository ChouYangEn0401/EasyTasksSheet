/*
 * Gantt 時間軸計算（純函式）。日期一律以「自 1970-01-01 起的天數」（UTC 日序）運算，
 * 與 YYYY-MM-DD 互轉，避免時區位移。完整版與總覽精簡版共用。
 */

export type Scale = 'day' | 'week' | 'month';
export const SCALES: Scale[] = ['day', 'week', 'month'];
export const SCALE_LABEL: Record<Scale, string> = { day: '日', week: '週', month: '月' };
/** 每日寬度（px） */
export const DAY_WIDTH: Record<Scale, number> = { day: 32, week: 12, month: 4 };

const DAY_MS = 86_400_000;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function toDay(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

export function fromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export const addDays = (date: string, n: number) => fromDay(toDay(date) + n);

/** 0 = 週一 … 6 = 週日 */
export const weekdayIndex = (day: number) => (new Date(day * DAY_MS).getUTCDay() + 6) % 7;

function ymd(day: number) {
  const d = new Date(day * DAY_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}
const dayOfUtc = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m, d) / DAY_MS);
const startOfMonth = (day: number) => {
  const { y, m } = ymd(day);
  return dayOfUtc(y, m, 1);
};
const startOfNextMonth = (day: number) => {
  const { y, m } = ymd(day);
  return dayOfUtc(y, m + 1, 1);
};
const startOfWeek = (day: number) => day - weekdayIndex(day);

export type DatedLike = { startDate: string | null; dueDate: string | null };

/** 任務的實際起訖（只有單一日期時視為 1 天）；兩者皆無回傳 null */
export function taskSpan(t: DatedLike): { start: number; end: number; single: boolean } | null {
  if (!t.startDate && !t.dueDate) return null;
  const s = toDay((t.startDate ?? t.dueDate)!);
  const e = toDay((t.dueDate ?? t.startDate)!);
  return { start: Math.min(s, e), end: Math.max(s, e), single: !t.startDate || !t.dueDate };
}

export const isScheduled = (t: DatedLike) => !!(t.startDate || t.dueDate);

/**
 * 繪製範圍：min(最早開始, 今天 − 14) 至 max(最晚到期, 今天 + 56)，
 * 日 / 週刻度對齊到整週（週一起），月刻度對齊到整月。回傳 [start, endExclusive)。
 */
export function computeRange(
  tasks: DatedLike[],
  today: string,
  scale: Scale,
): { start: number; end: number } {
  const t = toDay(today);
  let min = t - 14;
  let max = t + 56;
  for (const task of tasks) {
    const span = taskSpan(task);
    if (!span) continue;
    min = Math.min(min, span.start);
    max = Math.max(max, span.end);
  }
  if (scale === 'month') return { start: startOfMonth(min), end: startOfNextMonth(max) };
  return { start: startOfWeek(min), end: startOfWeek(max) + 7 };
}

export type HeaderCell = { key: string; label: string; start: number; days: number; weekend?: boolean };

/** 表頭上下兩層 */
export function headerCells(
  range: { start: number; end: number },
  scale: Scale,
): {
  top: HeaderCell[];
  bottom: HeaderCell[];
} {
  const top: HeaderCell[] = [];
  const bottom: HeaderCell[] = [];
  const clip = (start: number, endEx: number) => {
    const s = Math.max(start, range.start);
    return { start: s, days: Math.min(endEx, range.end) - s };
  };

  // 上層：日 / 週 → 年月；月 → 年
  for (let d = range.start; d < range.end;) {
    const { y, m } = ymd(d);
    const next = scale === 'month' ? dayOfUtc(y + 1, 0, 1) : dayOfUtc(y, m + 1, 1);
    const label = scale === 'month' ? `${y} 年` : `${y} 年 ${m + 1} 月`;
    top.push({ key: `t${d}`, label, ...clip(d, next) });
    d = next;
  }

  if (scale === 'day') {
    for (let d = range.start; d < range.end; d++) {
      const wd = weekdayIndex(d);
      bottom.push({
        key: `b${d}`,
        label: `${ymd(d).d} ${WEEKDAYS[(wd + 1) % 7]}`,
        start: d,
        days: 1,
        weekend: wd >= 5,
      });
    }
  } else if (scale === 'week') {
    for (let d = startOfWeek(range.start); d < range.end; d += 7) {
      const { m, d: dd } = ymd(d);
      bottom.push({ key: `b${d}`, label: `${m + 1}/${dd}`, ...clip(d, d + 7) });
    }
  } else {
    for (let d = range.start; d < range.end;) {
      const next = startOfNextMonth(d);
      bottom.push({ key: `b${d}`, label: `${ymd(d).m + 1} 月`, ...clip(d, next) });
      d = next;
    }
  }
  return { top, bottom };
}

export type DragMode = 'move' | 'start' | 'end';

/** 拖曳後的新起訖（以天為單位吸附；最短 1 天） */
export function applyDrag(
  span: { start: number; end: number },
  mode: DragMode,
  delta: number,
): { start: number; end: number } {
  if (mode === 'move') return { start: span.start + delta, end: span.end + delta };
  if (mode === 'start') return { start: Math.min(span.start + delta, span.end), end: span.end };
  return { start: span.start, end: Math.max(span.end + delta, span.start) };
}

/** 只回傳有變動的日期欄位（單一日期的任務拖曳後補上缺的日期） */
export function datePatch(
  task: DatedLike,
  next: { start: number; end: number },
): { startDate?: string; dueDate?: string } {
  const startDate = fromDay(next.start);
  const dueDate = fromDay(next.end);
  const patch: { startDate?: string; dueDate?: string } = {};
  if (task.startDate !== startDate) patch.startDate = startDate;
  if (task.dueDate !== dueDate) patch.dueDate = dueDate;
  return patch;
}

/** 11/20 → 11/28（9 天） */
export function formatSpan(start: number, end: number): string {
  const f = (d: number) => {
    const { m, d: dd } = ymd(d);
    return `${m + 1}/${dd}`;
  };
  return `${f(start)} → ${f(end)}（${end - start + 1} 天）`;
}

/** 11/22 至 11/30（螢幕報讀用） */
export function formatSpanSpoken(start: number, end: number): string {
  const f = (d: number) => {
    const { m, d: dd } = ymd(d);
    return `${m + 1}/${dd}`;
  };
  return `${f(start)} 至 ${f(end)}`;
}
