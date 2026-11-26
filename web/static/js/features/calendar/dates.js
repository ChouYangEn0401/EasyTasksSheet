// 本地時間的日期運算（以前靠外部函式庫，只用到下面這幾個；全部以本地時區計算，不碰 UTC）
const pad2 = (n) => String(n).padStart(2, '0');
const format = (d, pattern) =>
  pattern === 'yyyy-MM'
    ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
    : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** 'yyyy-MM-dd' 或 'yyyy-MM' → 本地 Date；格式不合回傳 Invalid Date */
function parse(value, pattern) {
  const m = pattern === 'yyyy-MM' ? /^(\d{4})-(\d{2})$/.exec(value) : /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return new Date(NaN);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1);
  // 溢位（2月30日）視為無效，與原本的 parse 行為一致
  if (d.getMonth() !== Number(m[2]) - 1 || (m[3] && d.getDate() !== Number(m[3]))) return new Date(NaN);
  return d;
}
const isValid = (d) => d instanceof Date && !Number.isNaN(d.getTime());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const startOfWeek = (d, { weekStartsOn }) => addDays(d, -((d.getDay() - weekStartsOn + 7) % 7));
const endOfWeek = (d, { weekStartsOn }) => addDays(startOfWeek(d, { weekStartsOn }), 6);
function eachDayOfInterval({ start, end }) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 週起始日（1 = 週一），可調 */
export const WEEK_STARTS_ON = 1;

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

/** 依 WEEK_STARTS_ON 排好的星期標題 */
export const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, i) => WEEKDAY_NAMES[(i + WEEK_STARTS_ON) % 7]);

export const toDateKey = (d) => format(d, 'yyyy-MM-dd');
export const toMonthKey = (d) => format(d, 'yyyy-MM');

/** YYYY-MM-DD → 本地時間的 Date（不受時區位移影響） */
export function fromDateKey(key) {
  return parse(key, 'yyyy-MM-dd', new Date());
}

/** 解析 URL 的 month=YYYY-MM；無效時回傳 null */
export function parseMonthKey(value) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return null;
  const d = parse(value, 'yyyy-MM', new Date());
  return isValid(d) ? startOfMonth(d) : null;
}

export const shiftMonth = (month, delta) => startOfMonth(addMonths(month, delta));

/** 2026 年 11 月 */
export const monthTitle = (month) => `${month.getFullYear()} 年 ${month.getMonth() + 1} 月`;

/** 月曆格：依當月需要回傳 4–6 週，每週 7 天 */
export function buildMonthGrid(month) {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: WEEK_STARTS_ON });
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: WEEK_STARTS_ON });
  const days = eachDayOfInterval({ start, end }).map((date) => ({
    key: toDateKey(date),
    date,
    inMonth: date.getMonth() === month.getMonth(),
    weekend: date.getDay() === 0 || date.getDay() === 6,
  }));
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

/** 日期鍵加減天數 */
export const addDaysKey = (key, delta) => toDateKey(addDays(fromDateKey(key), delta));

/** 11 月 24 日 星期二 */
export function dayLabel(key) {
  const d = fromDateKey(key);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 星期${WEEKDAY_NAMES[d.getDay()]}`;
}

/** 11 月 24 日 */
export function shortDayLabel(key) {
  const d = fromDateKey(key);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 11/28 */
export const monthDay = (key) => {
  const d = fromDateKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
