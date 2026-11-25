import { describe, expect, it } from 'vitest';
import {
  approxHours,
  barHeights,
  countsText,
  describeWeek,
  hoursText,
  MIN_BAR_PCT,
  MIN_SCALE,
  sumWeeks,
  teamMax,
  weekLabel,
} from './activity.ts';

const w = (completed: number, touched: number, involved: number, completedHours = 0, hoursKnown = 0) => ({
  completed,
  touched,
  involved,
  completedHours,
  hoursKnown,
});

describe('weekLabel', () => {
  it('由舊到新：前週、上週、本週', () => {
    expect([0, 1, 2].map((i) => weekLabel(i, 3))).toEqual(['前週', '上週', '本週']);
    expect(weekLabel(0, 4)).toBe('3 週前');
  });
});

describe('barHeights', () => {
  it('以全隊最大值正規化，0 維持 0', () => {
    expect(barHeights([0, 5, 10], 10)).toEqual([0, 50, 100]);
  });
  it('有資料時至少有最低高度', () => {
    expect(barHeights([1], 100)).toEqual([MIN_BAR_PCT]);
  });
  it('最大值為 0（全隊都沒有紀錄）時全部為 0', () => {
    expect(barHeights([0, 0, 0], 0)).toEqual([0, 0, 0]);
  });
  it('超過最大值時封頂 100', () => {
    expect(barHeights([12], 10)).toEqual([100]);
  });
  it('尺度有下限：全隊最多只有 1 件時不畫成滿格', () => {
    expect(barHeights([1, 0], 1)).toEqual([100 / MIN_SCALE, 0]);
  });
});

describe('teamMax', () => {
  it('取所有成員、所有週的 involved 最大值', () => {
    const data = {
      members: [
        { userId: 1, weeks: [{ ...w(1, 1, 2), items: [], itemsTotal: 2 }] },
        { userId: 2, weeks: [{ ...w(0, 7, 7), items: [], itemsTotal: 7 }] },
      ],
    };
    expect(teamMax(data)).toBe(7);
    expect(teamMax(undefined)).toBe(0);
  });
});

describe('文案（緩和語氣）', () => {
  it('有紀錄時列出件數', () => {
    expect(describeWeek('上週', w(3, 5, 6))).toBe('上週：完成 3 件、處理 5 件');
  });
  it('沒有紀錄時說「沒有紀錄」，不說沒做事', () => {
    const s = describeWeek('本週', w(0, 0, 0));
    expect(s).toBe('本週：沒有紀錄');
    expect(s).not.toMatch(/沒做|落後|最少/);
  });
  it('小字與加總', () => {
    expect(countsText(sumWeeks([w(1, 2, 2), w(0, 3, 3), w(2, 0, 2)]))).toBe('完成 3・處理 5');
  });
  it('沒有填估時就不顯示工時', () => {
    expect(hoursText(w(2, 0, 2, 0, 0))).toBeNull();
  });
  it('有填估時才顯示約略工時與件數', () => {
    expect(hoursText(w(3, 0, 3, 7.3, 2))).toBe('預估工時約 7.5 小時（2 件有填估時）');
    expect(approxHours(4)).toBe('4');
  });
});
