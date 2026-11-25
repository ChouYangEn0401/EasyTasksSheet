/*
 * Gantt 時間軸計算（純函式）。日期一律以「自 1970-01-01 起的天數」（UTC 日序）運算，
 * 與 YYYY-MM-DD 互轉，避免時區位移。完整版與總覽精簡版共用。
 */

export type Scale = 'day' | 'week' | 'month';
export const SCALES: Scale[] = ['day', 'week', 'month'];
export const SCALE_LABEL: Record<Scale, string> = { day: '日', week: '週', month: '月' };
/** 每日寬度（px） */
export const DAY_WIDTH: Record<Scale, number> = { day: 32, week: 16, month: 4 };
/** 範圍前邊界（天） */
export const LEAD_DAYS: Record<Scale, number> = { day: 3, week: 7, month: 31 };
/** 範圍後邊界（天）：保證長條右側外標題（最寬 220px + 間距）不被裁切 */
export const tailDays = (scale: Scale) => Math.ceil(240 / DAY_WIDTH[scale]);

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
 * 繪製範圍（docs/design/gantt-polish.md §1），回傳 [start, endExclusive)：
 * 1. start = min(最早開始, 今天) − lead；end = max(最晚到期, 今天) + tail
 * 2. 日 / 週刻度對齊整週（週一起），月刻度對齊整月
 * 3. 填滿：總天數 ≥ minDays，且 end ≥ 今天 + ceil(minDays × 2/3)（今天可置於左側 1/3）；只往後延伸
 */
export function computeRange(
  tasks: DatedLike[],
  today: string,
  scale: Scale,
  minDays = 0,
): { start: number; end: number } {
  const t = toDay(today);
  let min = t;
  let max = t;
  for (const task of tasks) {
    const span = taskSpan(task);
    if (!span) continue;
    min = Math.min(min, span.start);
    max = Math.max(max, span.end);
  }
  min -= LEAD_DAYS[scale];
  max += tailDays(scale);
  const monthly = scale === 'month';
  const start = monthly ? startOfMonth(min) : startOfWeek(min);
  let end = monthly ? startOfNextMonth(max) : startOfWeek(max) + 7;
  const need = Math.ceil(Math.max(0, minDays));
  const todayNeed = t + Math.ceil((need * 2) / 3);
  while (end - start < need || end < todayNeed) end = monthly ? startOfNextMonth(end) : end + 7;
  return { start, end };
}

/** 自動刻度：已排程任務最早開始到最晚到期（含今天）的天數 ≤ 28 → 日；≤ 182 → 週；其餘 → 月 */
export function autoScale(tasks: DatedLike[], today: string): Scale {
  const t = toDay(today);
  let min = t;
  let max = t;
  for (const task of tasks) {
    const span = taskSpan(task);
    if (!span) continue;
    min = Math.min(min, span.start);
    max = Math.max(max, span.end);
  }
  const span = max - min + 1;
  return span <= 28 ? 'day' : span <= 182 ? 'week' : 'month';
}

export const parseScale = (raw: string | null | undefined): Scale | null =>
  raw === 'day' || raw === 'week' || raw === 'month' ? raw : null;

/** 預設刻度優先序：URL > localStorage（手動切換時寫入）> 自動 */
export function pickScale(
  urlValue: string | null | undefined,
  stored: string | null | undefined,
  tasks: DatedLike[],
  today: string,
): Scale {
  return parseScale(urlValue) ?? parseScale(stored) ?? autoScale(tasks, today);
}

export type HeaderCell = {
  key: string;
  label: string;
  start: number;
  days: number;
  weekend?: boolean;
  /** 下層列中包含今天的那一格 */
  today?: boolean;
};

/** 表頭上下兩層 */
export function headerCells(
  range: { start: number; end: number },
  scale: Scale,
  today?: number,
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
  if (today != null) for (const c of bottom) if (today >= c.start && today < c.start + c.days) c.today = true;
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

/* ── 長條外觀（gantt-polish §4） ─────────────────── */

export const BAR_NARROW = 24;
export const BAR_LABEL_INSIDE = 96;
export const BAR_PCT_INSIDE = 140;
export const BAR_OVERDUE_INSIDE = 200;

export type BarGeometry = {
  /** 實際起訖寬 = 天數 × dw */
  w: number;
  /** 繪製寬（窄長條最小 8px，單一日期窄長條固定 10px） */
  visualWidth: number;
  /** 相對於起點的位移（窄長條以實際寬置中） */
  offset: number;
  narrow: boolean;
  labelInside: boolean;
  pctInside: boolean;
  overdueInside: boolean;
};

export function barGeometry(span: { start: number; end: number }, dw: number, single = false): BarGeometry {
  const w = (span.end - span.start + 1) * dw;
  const narrow = w < BAR_NARROW;
  const visualWidth = narrow ? (single ? 10 : Math.max(w, 8)) : w;
  return {
    w,
    visualWidth,
    offset: (w - visualWidth) / 2,
    narrow,
    labelInside: w >= BAR_LABEL_INSIDE,
    pctInside: w >= BAR_PCT_INSIDE,
    overdueInside: w >= BAR_OVERDUE_INSIDE,
  };
}

/** 逾期天數（到期日早於今天才 > 0） */
export function overdueDays(dueDate: string | null, today: string): number {
  return dueDate ? Math.max(0, toDay(today) - toDay(dueDate)) : 0;
}

/* ── 今天（gantt-polish §3） ─────────────────────── */

/** 表頭今天格的呈現：日刻度整格淡底；格寬 ≥ 84 時文字 + 膠囊；不足時只顯示膠囊 */
export function todayCellMode(scale: Scale, cellWidth: number): 'fill' | 'both' | 'chip' {
  if (scale === 'day') return 'fill';
  return cellWidth >= 84 ? 'both' : 'chip';
}

/** 今天（中心點 x）相對可視範圍：在左側之外 / 右側之外 / 可見 */
export function todayEdge(todayX: number, scrollLeft: number, visible: number): 'left' | 'right' | null {
  if (visible <= 0) return null;
  if (todayX < scrollLeft) return 'left';
  if (todayX > scrollLeft + visible) return 'right';
  return null;
}

/**
 * 進頁定位（§7）：今天置於可視寬度左側 1/3；若該視窗內沒有任何長條，
 * 改為把距今天最近的長條起點置於左側 1/3。bars 為像素區間 [x, x + w)。
 */
export function initialScrollLeft(todayX: number, visible: number, bars: { x: number; w: number }[]): number {
  const target = Math.max(0, todayX - visible / 3);
  if (!bars.length || bars.some((b) => b.x + b.w > target && b.x < target + visible)) return target;
  let best = bars[0]!;
  let bestDist = Infinity;
  for (const b of bars) {
    const dist = b.x > todayX ? b.x - todayX : Math.max(0, todayX - (b.x + b.w));
    if (dist < bestDist) {
      best = b;
      bestDist = dist;
    }
  }
  return Math.max(0, best.x - visible / 3);
}

/* ── 左欄日期區間（§5） ──────────────────────────── */

/** 11/24–11/26；同一天 11/24；只有到期日「到期 11/26」；只有開始日「開始 11/24」；非今年加年 2027/1/4 */
export function formatDateRange(startDate: string | null, dueDate: string | null, today: string): string {
  const year = ymd(toDay(today)).y;
  const f = (date: string) => {
    const { y, m, d } = ymd(toDay(date));
    return y === year ? `${m + 1}/${d}` : `${y}/${m + 1}/${d}`;
  };
  if (startDate && dueDate) return startDate === dueDate ? f(startDate) : `${f(startDate)}–${f(dueDate)}`;
  if (dueDate) return `到期 ${f(dueDate)}`;
  if (startDate) return `開始 ${f(startDate)}`;
  return '';
}

/** 11/20–12/5（群組摘要用，日序） */
export function formatDayRange(start: number, end: number): string {
  const f = (day: number) => {
    const { m, d } = ymd(day);
    return `${m + 1}/${d}`;
  };
  return start === end ? f(start) : `${f(start)}–${f(end)}`;
}
