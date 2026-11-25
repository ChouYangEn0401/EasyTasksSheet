import type { ActivityResponse, ActivityWeekStats } from '../../../shared/overview.ts';

/**
 * 近三週（gantt-overview.md §B5）的純函式：週標籤、直條高度正規化、緩和語氣的文案。
 * 原則（docs/product-principles.md）：不排名、不比較、沒有紀錄就說「沒有紀錄」。
 */

/** 有資料時直條的最低高度（%），避免 1 件看起來像沒有 */
export const MIN_BAR_PCT = 14;

/** 正規化尺度的下限：全隊都只有一兩件時，不讓 1 件就畫成滿格（避免放大差異） */
export const MIN_SCALE = 5;

/** 週標籤：由舊到新排列，最後一週為「本週」 */
export function weekLabel(index: number, total: number): string {
  const back = total - 1 - index;
  if (back === 0) return '本週';
  if (back === 1) return '上週';
  if (back === 2) return '前週';
  return `${back} 週前`;
}

/**
 * 直條高度（0–100%）：以全隊所有人、所有週的最大值正規化（不以個人自己為基準，也不與他人排名）。
 * 0 → 0（畫淡灰虛線）；有資料者至少 MIN_BAR_PCT。
 */
export function barHeights(values: readonly number[], max: number): number[] {
  const scale = Math.max(max, MIN_SCALE);
  return values.map((v) => {
    if (v <= 0) return 0;
    return Math.max(MIN_BAR_PCT, Math.round((Math.min(v, scale) / scale) * 100));
  });
}

/** 全隊所有成員、所有週的 involved 最大值 */
export function teamMax(data: Pick<ActivityResponse, 'members'> | undefined): number {
  let max = 0;
  for (const m of data?.members ?? []) for (const w of m.weeks) max = Math.max(max, w.involved);
  return max;
}

/** 「上週：完成 3 件、處理 5 件」；沒有紀錄時「上週：沒有紀錄」 */
export function describeWeek(label: string, w: ActivityWeekStats): string {
  if (w.involved === 0) return `${label}：沒有紀錄`;
  return `${label}：完成 ${w.completed} 件、處理 ${w.touched} 件`;
}

/** 卡片上的小字：「完成 N・處理 M」 */
export function countsText(w: Pick<ActivityWeekStats, 'completed' | 'touched'>): string {
  return `完成 ${w.completed}・處理 ${w.touched}`;
}

/** 多週加總（卡片小字用；同一任務跨週會各算一次，屬「大約」） */
export function sumWeeks(
  weeks: readonly ActivityWeekStats[],
): Pick<ActivityWeekStats, 'completed' | 'touched'> {
  return weeks.reduce((s, w) => ({ completed: s.completed + w.completed, touched: s.touched + w.touched }), {
    completed: 0,
    touched: 0,
  });
}

/** 約略工時：取到 0.5 小時 */
export function approxHours(n: number): string {
  const r = Math.round(n * 2) / 2;
  return String(r);
}

/** 有填估時才回傳「預估工時約 N 小時（M 件有填估時）」；沒有則 null（完全不顯示工時） */
export function hoursText(w: Pick<ActivityWeekStats, 'completedHours' | 'hoursKnown'>): string | null {
  if (w.hoursKnown <= 0) return null;
  return `預估工時約 ${approxHours(w.completedHours)} 小時（${w.hoursKnown} 件有填估時）`;
}

/** Unix ms → 11/24（瀏覽器時區） */
export function shortDay(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
