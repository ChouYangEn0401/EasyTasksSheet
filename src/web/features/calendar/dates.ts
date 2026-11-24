import {
  addDays,
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isValid,
  parse,
  startOfMonth,
  startOfWeek,
} from 'date-fns';

/** 週起始日（1 = 週一），可調 */
export const WEEK_STARTS_ON = 1 as const;

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** 依 WEEK_STARTS_ON 排好的星期標題 */
export const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, i) => WEEKDAY_NAMES[(i + WEEK_STARTS_ON) % 7]!);

export const toDateKey = (d: Date) => format(d, 'yyyy-MM-dd');
export const toMonthKey = (d: Date) => format(d, 'yyyy-MM');

/** YYYY-MM-DD → 本地時間的 Date（不受時區位移影響） */
export function fromDateKey(key: string): Date {
  return parse(key, 'yyyy-MM-dd', new Date());
}

/** 解析 URL 的 month=YYYY-MM；無效時回傳 null */
export function parseMonthKey(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return null;
  const d = parse(value, 'yyyy-MM', new Date());
  return isValid(d) ? startOfMonth(d) : null;
}

export const shiftMonth = (month: Date, delta: number) => startOfMonth(addMonths(month, delta));

/** 2026 年 11 月 */
export const monthTitle = (month: Date) => `${month.getFullYear()} 年 ${month.getMonth() + 1} 月`;

export type CalendarDay = {
  key: string;
  date: Date;
  inMonth: boolean;
  weekend: boolean;
};

/** 月曆格：依當月需要回傳 4–6 週，每週 7 天 */
export function buildMonthGrid(month: Date): CalendarDay[][] {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: WEEK_STARTS_ON });
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: WEEK_STARTS_ON });
  const days = eachDayOfInterval({ start, end }).map((date) => ({
    key: toDateKey(date),
    date,
    inMonth: date.getMonth() === month.getMonth(),
    weekend: date.getDay() === 0 || date.getDay() === 6,
  }));
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

/** 日期鍵加減天數 */
export const addDaysKey = (key: string, delta: number) => toDateKey(addDays(fromDateKey(key), delta));

/** 11 月 24 日 星期二 */
export function dayLabel(key: string): string {
  const d = fromDateKey(key);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 星期${WEEKDAY_NAMES[d.getDay()]}`;
}

/** 11 月 24 日 */
export function shortDayLabel(key: string): string {
  const d = fromDateKey(key);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 11/28 */
export const monthDay = (key: string) => {
  const d = fromDateKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
