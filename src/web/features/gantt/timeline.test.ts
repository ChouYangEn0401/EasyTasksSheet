import { describe, expect, it } from 'vitest';
import { buildGroups, groupSpan, parseGroupBy } from './grouping.ts';
import {
  addDays,
  applyDrag,
  autoScale,
  barGeometry,
  computeRange,
  DAY_WIDTH,
  datePatch,
  formatDateRange,
  formatDayRange,
  formatSpan,
  fromDay,
  headerCells,
  initialScrollLeft,
  overdueDays,
  pickScale,
  tailDays,
  taskSpan,
  todayCellMode,
  todayEdge,
  toDay,
  weekdayIndex,
} from './timeline.ts';

const d = toDay;

describe('timeline', () => {
  it('日期與日序互轉', () => {
    expect(fromDay(d('2026-11-24'))).toBe('2026-11-24');
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(weekdayIndex(d('2026-11-23'))).toBe(0); // 週一
    expect(weekdayIndex(d('2026-11-29'))).toBe(6); // 週日
  });

  it('taskSpan：單一日期視為 1 天，兩者皆無為 null', () => {
    expect(taskSpan({ startDate: '2026-11-20', dueDate: '2026-11-28' })).toEqual({
      start: d('2026-11-20'),
      end: d('2026-11-28'),
      single: false,
    });
    expect(taskSpan({ startDate: null, dueDate: '2026-11-28' })).toEqual({
      start: d('2026-11-28'),
      end: d('2026-11-28'),
      single: true,
    });
    expect(taskSpan({ startDate: null, dueDate: null })).toBeNull();
  });

  it('每日寬與後邊界：週 16px、tail = ceil(240 / dw)', () => {
    expect(DAY_WIDTH).toEqual({ day: 32, week: 16, month: 4 });
    expect([tailDays('day'), tailDays('week'), tailDays('month')]).toEqual([8, 15, 60]);
  });

  it('繪製範圍：今天 − lead 至 今天 + tail，對齊整週 / 整月', () => {
    const today = '2026-11-24'; // 週二
    const r = computeRange([], today, 'week');
    expect(fromDay(r.start)).toBe('2026-11-16'); // 11/17 所在週的週一
    expect(weekdayIndex(r.end)).toBe(0);
    expect(r.end).toBeGreaterThanOrEqual(d(today) + 15);
    expect(r.end - (d(today) + 15)).toBeLessThan(7);
    const day = computeRange([], today, 'day');
    expect(fromDay(day.start)).toBe('2026-11-16'); // 11/21 所在週
    expect(day.end).toBeGreaterThanOrEqual(d(today) + 8);
    const withTask = computeRange([{ startDate: '2026-06-03', dueDate: '2027-03-01' }], today, 'month');
    expect(fromDay(withTask.start)).toBe('2026-05-01'); // 6/3 − 31 天
    expect(fromDay(withTask.end)).toBe('2027-05-01'); // 3/1 + 60 天 → 4/30 所在月
  });

  it('後邊界保證最晚到期日右側至少 tail 天（外側標題不被裁切）', () => {
    const r = computeRange([{ startDate: '2026-11-24', dueDate: '2026-12-20' }], '2026-11-24', 'week');
    expect(r.end - (d('2026-12-20') + 1)).toBeGreaterThanOrEqual(tailDays('week') - 1);
  });

  it('填滿：總天數 ≥ minDays，只往後延伸、起點不變', () => {
    const today = '2026-11-24';
    const base = computeRange([], today, 'week');
    const filled = computeRange([], today, 'week', 120);
    expect(filled.start).toBe(base.start);
    expect(filled.end - filled.start).toBeGreaterThanOrEqual(120);
    expect(weekdayIndex(filled.end)).toBe(0); // 以整週延伸
    const month = computeRange([], today, 'month', 400);
    expect(month.end - month.start).toBeGreaterThanOrEqual(400);
    expect(fromDay(month.end).endsWith('-01')).toBe(true); // 以整月延伸
  });

  it('填滿：今天之後至少 ceil(minDays × 2/3) 天（今天可置於左側 1/3）', () => {
    const today = '2026-11-24';
    // 有很早的任務時總天數已足夠，但今天右側仍需延伸
    const r = computeRange([{ startDate: '2026-06-01', dueDate: '2026-06-10' }], today, 'week', 90);
    expect(r.end).toBeGreaterThanOrEqual(d(today) + 60);
    expect(r.end - r.start).toBeGreaterThanOrEqual(90);
  });

  it('自動刻度：跨度 ≤ 28 → 日；≤ 182 → 週；其餘 → 月（含今天）', () => {
    const today = '2026-11-24';
    expect(autoScale([], today)).toBe('day');
    // 今天 ~ 12/21 共 28 天
    expect(autoScale([{ startDate: '2026-11-24', dueDate: '2026-12-21' }], today)).toBe('day');
    expect(autoScale([{ startDate: '2026-11-24', dueDate: '2026-12-22' }], today)).toBe('week');
    // 今天 ~ 2027-05-24 共 182 天
    expect(autoScale([{ startDate: null, dueDate: '2027-05-24' }], today)).toBe('week');
    expect(autoScale([{ startDate: null, dueDate: '2027-05-25' }], today)).toBe('month');
    // 過去的任務也納入跨度
    expect(autoScale([{ startDate: '2026-01-01', dueDate: '2026-01-02' }], today)).toBe('month');
    // 優先序：URL > localStorage > 自動；無效值略過
    expect(pickScale('month', 'day', [], today)).toBe('month');
    expect(pickScale(null, 'week', [], today)).toBe('week');
    expect(pickScale('x', null, [], today)).toBe('day');
  });

  it('長條外觀：一般 / 窄長條、標題在內或外、單日寬度', () => {
    const one = { start: 100, end: 100 };
    // 日刻度單日 = 32px：一般長條、標題在外
    expect(barGeometry(one, 32, true)).toMatchObject({
      w: 32,
      visualWidth: 32,
      offset: 0,
      narrow: false,
      labelInside: false,
    });
    // 週刻度單日 = 16px：窄長條；單一日期固定 10px 並置中
    expect(barGeometry(one, 16, true)).toMatchObject({ w: 16, visualWidth: 10, offset: 3, narrow: true });
    // 有起訖的 1 天窄長條維持實際寬
    expect(barGeometry(one, 16)).toMatchObject({ visualWidth: 16, narrow: true });
    // 月刻度 1 天 = 4px → 最小 8px
    expect(barGeometry(one, 4)).toMatchObject({ visualWidth: 8, offset: -2, narrow: true });
    // 6 天 × 16 = 96：標題在內；140 起顯示百分比；200 起顯示逾期
    expect(barGeometry({ start: 0, end: 5 }, 16)).toMatchObject({ labelInside: true, pctInside: false });
    expect(barGeometry({ start: 0, end: 8 }, 16)).toMatchObject({ pctInside: true, overdueInside: false });
    expect(barGeometry({ start: 0, end: 12 }, 16)).toMatchObject({ overdueInside: true });
    expect(barGeometry({ start: 0, end: 4 }, 16).labelInside).toBe(false);
  });

  it('今天：表頭格呈現、可視範圍外的邊緣膠囊', () => {
    expect(todayCellMode('day', 32)).toBe('fill');
    expect(todayCellMode('week', 112)).toBe('both');
    expect(todayCellMode('month', 120)).toBe('both');
    expect(todayCellMode('week', 64)).toBe('chip');
    expect(todayEdge(500, 0, 800)).toBeNull();
    expect(todayEdge(500, 600, 800)).toBe('left');
    expect(todayEdge(500, 0, 400)).toBe('right');
    const cells = headerCells({ start: d('2026-11-16'), end: d('2026-12-07') }, 'week', d('2026-11-24'));
    expect(cells.bottom.filter((c) => c.today).map((c) => c.label)).toEqual(['11/23']);
  });

  it('進頁定位：今天在左側 1/3；視窗內無長條則對最近的長條', () => {
    expect(initialScrollLeft(900, 600, [{ x: 800, w: 100 }])).toBe(700);
    expect(initialScrollLeft(100, 600, [])).toBe(0);
    // 視窗 [700, 1300) 內沒有長條 → 最近的長條起點 2000 置於左側 1/3
    expect(
      initialScrollLeft(900, 600, [
        { x: 2000, w: 50 },
        { x: 3000, w: 50 },
      ]),
    ).toBe(1800);
    // 過去的長條較近
    expect(
      initialScrollLeft(2000, 600, [
        { x: 200, w: 100 },
        { x: 4000, w: 10 },
      ]),
    ).toBe(0);
  });

  it('左欄日期區間與逾期天數', () => {
    const today = '2026-11-25';
    expect(formatDateRange('2026-11-24', '2026-11-26', today)).toBe('11/24–11/26');
    expect(formatDateRange('2026-11-24', '2026-11-24', today)).toBe('11/24');
    expect(formatDateRange(null, '2026-11-26', today)).toBe('到期 11/26');
    expect(formatDateRange('2026-11-24', null, today)).toBe('開始 11/24');
    expect(formatDateRange('2026-12-28', '2027-01-04', today)).toBe('12/28–2027/1/4');
    expect(formatDayRange(d('2026-11-20'), d('2026-12-05'))).toBe('11/20–12/5');
    expect(overdueDays('2026-11-20', today)).toBe(5);
    expect(overdueDays('2026-11-26', today)).toBe(0);
    expect(overdueDays(null, today)).toBe(0);
  });

  it('表頭：日 / 週 / 月', () => {
    const range = { start: d('2026-11-30'), end: d('2026-12-14') };
    const day = headerCells(range, 'day');
    expect(day.top.map((c) => [c.label, c.days])).toEqual([
      ['2026 年 11 月', 1],
      ['2026 年 12 月', 13],
    ]);
    expect(day.bottom[0]).toMatchObject({ label: '30 一', weekend: false });
    expect(day.bottom[5]).toMatchObject({ label: '5 六', weekend: true });
    const week = headerCells(range, 'week');
    expect(week.bottom.map((c) => c.label)).toEqual(['11/30', '12/7']);
    const month = headerCells({ start: d('2026-11-01'), end: d('2027-02-01') }, 'month');
    expect(month.top.map((c) => c.label)).toEqual(['2026 年', '2027 年']);
    expect(month.bottom.map((c) => [c.label, c.days])).toEqual([
      ['11 月', 30],
      ['12 月', 31],
      ['1 月', 31],
    ]);
  });

  it('拖曳：平移、改開始 / 到期，最短 1 天', () => {
    const span = { start: 10, end: 14 };
    expect(applyDrag(span, 'move', 3)).toEqual({ start: 13, end: 17 });
    expect(applyDrag(span, 'start', -2)).toEqual({ start: 8, end: 14 });
    expect(applyDrag(span, 'start', 9)).toEqual({ start: 14, end: 14 });
    expect(applyDrag(span, 'end', -9)).toEqual({ start: 10, end: 10 });
  });

  it('datePatch 只送有變動的欄位，單一日期會補上缺的日期', () => {
    const t = { startDate: '2026-11-20', dueDate: '2026-11-28' };
    expect(datePatch(t, { start: d('2026-11-20'), end: d('2026-11-30') })).toEqual({ dueDate: '2026-11-30' });
    expect(
      datePatch({ startDate: null, dueDate: '2026-11-28' }, { start: d('2026-11-28'), end: d('2026-11-28') }),
    ).toEqual({ startDate: '2026-11-28' });
    expect(formatSpan(d('2026-11-20'), d('2026-11-28'))).toBe('11/20 → 11/28（9 天）');
  });
});

describe('grouping', () => {
  const tasks = [
    { id: 1, projectId: 1, assigneeId: 10, startDate: '2026-11-20', dueDate: '2026-11-25' },
    { id: 2, projectId: 2, assigneeId: null, startDate: '2026-11-18', dueDate: null },
    { id: 3, projectId: 1, assigneeId: 10, startDate: null, dueDate: null },
    { id: 4, projectId: 1, assigneeId: 99, startDate: '2026-11-01', dueDate: '2026-11-02' },
  ];
  const ctx = {
    members: [
      { id: 11, displayName: '無排程' },
      { id: 10, displayName: '王' },
    ],
    projects: [
      { id: 2, name: 'P2', color: 'red' },
      { id: 1, name: 'P1', color: 'blue' },
    ],
    userName: (id: number) => (id === 99 ? '停用者' : undefined),
  };

  it('負責人分組：保留成員順序、無排程成員仍回傳（由 Gantt 移到摘要列）、未指派最後、未排程不納入', () => {
    const g = buildGroups(tasks, 'assignee', ctx);
    expect(g.map((x) => [x.label, x.tasks.map((t) => t.id)])).toEqual([
      ['無排程', []],
      ['王', [1]],
      ['停用者', [4]],
      ['未指派', [2]],
    ]);
  });

  it('專案分組依專案順序，不分組依開始日排序', () => {
    expect(buildGroups(tasks, 'project', ctx).map((x) => [x.label, x.tasks.map((t) => t.id)])).toEqual([
      ['P2', [2]],
      ['P1', [4, 1]],
    ]);
    expect(buildGroups(tasks, 'none', ctx)[0]!.tasks.map((t) => t.id)).toEqual([4, 2, 1]);
  });

  it('groupSpan 與 parseGroupBy', () => {
    expect(groupSpan(tasks)).toEqual({ start: d('2026-11-01'), end: d('2026-11-25') });
    expect(groupSpan([])).toBeNull();
    expect(parseGroupBy('project')).toBe('project');
    expect(parseGroupBy('x')).toBe('assignee');
  });
});
