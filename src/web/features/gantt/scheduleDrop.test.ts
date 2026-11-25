import { describe, expect, it } from 'vitest';
import {
  announceSchedule,
  dayAtClientX,
  defaultScheduleDays,
  formatScheduleBubble,
  formatScheduleRange,
  groupFields,
  growExtent,
  moveKeyboardTarget,
  ownGroupKey,
  rangeWithExtent,
  rowAtClientY,
  scheduleBefore,
  scheduleFieldNote,
  schedulePatch,
  scheduleUndoLabel,
  spanFrom,
  type ScheduleTarget,
} from './scheduleDrop.ts';
import { computeRange, DAY_WIDTH, fromDay, toDay } from './timeline.ts';

const D = (s: string) => toDay(s);

describe('defaultScheduleDays', () => {
  it('沒有預估工時 → 3 天', () => {
    expect(defaultScheduleDays(null)).toBe(3);
    expect(defaultScheduleDays(undefined)).toBe(3);
    expect(defaultScheduleDays(0)).toBe(3);
    expect(defaultScheduleDays(-2)).toBe(3);
    expect(defaultScheduleDays(Number.NaN)).toBe(3);
  });
  it('有預估工時 → max(1, ceil(hours / 8))', () => {
    expect(defaultScheduleDays(0.5)).toBe(1);
    expect(defaultScheduleDays(8)).toBe(1);
    expect(defaultScheduleDays(8.1)).toBe(2);
    expect(defaultScheduleDays(16)).toBe(2);
    expect(defaultScheduleDays(20)).toBe(3);
    expect(defaultScheduleDays(40)).toBe(5);
  });
});

describe('spanFrom', () => {
  it('到期日 = 開始日 + 天數 − 1（日曆天，不跳過週末）', () => {
    // 2026-11-27 是週五：3 天 → 11/29（週日）
    expect(spanFrom(D('2026-11-27'), 3)).toEqual({ start: D('2026-11-27'), end: D('2026-11-29') });
    expect(spanFrom(D('2026-11-26'), 1)).toEqual({ start: D('2026-11-26'), end: D('2026-11-26') });
  });
  it('天數至少 1', () => {
    expect(spanFrom(100, 0)).toEqual({ start: 100, end: 100 });
  });
});

describe('dayAtClientX', () => {
  const geo = { left: 100, leftWidth: 300, clientWidth: 1000, scrollLeft: 0, rangeStart: 1000, dw: 32 };
  it('吸附到游標所在的日', () => {
    expect(dayAtClientX(400, geo)).toBe(1000);
    expect(dayAtClientX(431, geo)).toBe(1000);
    expect(dayAtClientX(432, geo)).toBe(1001);
    expect(dayAtClientX(400 + 32 * 5 + 16, geo)).toBe(1005);
  });
  it('計入水平捲動', () => {
    expect(dayAtClientX(400, { ...geo, scrollLeft: 320 })).toBe(1010);
  });
  it('週 / 月刻度一樣以日計', () => {
    expect(dayAtClientX(400 + 16 * 3, { ...geo, dw: DAY_WIDTH.week })).toBe(1003);
    expect(dayAtClientX(400 + 4 * 30 + 1, { ...geo, dw: DAY_WIDTH.month })).toBe(1030);
  });
  it('左欄上或容器外 → null', () => {
    expect(dayAtClientX(399, geo)).toBeNull();
    expect(dayAtClientX(50, geo)).toBeNull();
    expect(dayAtClientX(1100, geo)).toBeNull();
    expect(dayAtClientX(1099, geo)).not.toBeNull();
  });
});

describe('rowAtClientY', () => {
  const rows = [
    { top: 50, bottom: 90 },
    { top: 90, bottom: 130 },
  ];
  it('找所在列；邊界屬於下一列', () => {
    expect(rowAtClientY(60, rows)).toBe(0);
    expect(rowAtClientY(90, rows)).toBe(1);
    expect(rowAtClientY(129, rows)).toBe(1);
  });
  it('列以外 → -1', () => {
    expect(rowAtClientY(130, rows)).toBe(-1);
    expect(rowAtClientY(10, rows)).toBe(-1);
    expect(rowAtClientY(10, [])).toBe(-1);
  });
});

describe('groupFields / ownGroupKey', () => {
  const task = { assigneeId: 3, projectId: 1 };
  it('負責人列：指派給他；原本就是他則不改', () => {
    expect(groupFields({ kind: 'user', refId: 5 }, task)).toEqual({ assigneeId: 5 });
    expect(groupFields({ kind: 'user', refId: 3 }, task)).toEqual({});
  });
  it('未指派列：取消指派；本來就未指派則不改', () => {
    expect(groupFields({ kind: 'unassigned', refId: null }, task)).toEqual({ assigneeId: null });
    expect(groupFields({ kind: 'unassigned', refId: null }, { ...task, assigneeId: null })).toEqual({});
  });
  it('專案列：改專案；同專案不改', () => {
    expect(groupFields({ kind: 'project', refId: 2 }, task)).toEqual({ projectId: 2 });
    expect(groupFields({ kind: 'project', refId: 1 }, task)).toEqual({});
  });
  it('不分組：只排日期', () => {
    expect(groupFields({ kind: 'all', refId: null }, task)).toEqual({});
  });
  it('自己的分組 key 與 grouping.ts 一致', () => {
    expect(ownGroupKey(task, 'assignee')).toBe('u3');
    expect(ownGroupKey({ ...task, assigneeId: null }, 'assignee')).toBe('none');
    expect(ownGroupKey(task, 'project')).toBe('p1');
    expect(ownGroupKey(task, 'none')).toBe('all');
  });
});

describe('schedulePatch / 文案', () => {
  const target: ScheduleTarget = {
    start: D('2026-11-26'),
    end: D('2026-11-28'),
    groupKey: 'u5',
    group: { kind: 'user', refId: 5, label: '晟榕' },
    fields: { assigneeId: 5 },
  };
  it('PATCH 含日期與分組欄位', () => {
    expect(schedulePatch(target)).toEqual({ startDate: '2026-11-26', dueDate: '2026-11-28', assigneeId: 5 });
    expect(schedulePatch({ ...target, fields: {} })).toEqual({
      startDate: '2026-11-26',
      dueDate: '2026-11-28',
    });
  });
  it('復原前值帶日期與分組欄位', () => {
    expect(scheduleBefore({ startDate: null, dueDate: null, assigneeId: 3, projectId: 1 })).toEqual({
      startDate: null,
      dueDate: null,
      assigneeId: 3,
      projectId: 1,
    });
  });
  it('氣泡 / 範圍 / 復原標籤', () => {
    expect(formatScheduleBubble(target.start, target.end)).toBe('11/26 – 11/28（3 天）');
    expect(formatScheduleRange(target.start, target.end)).toBe('11/26 – 11/28');
    expect(scheduleUndoLabel('寫文件', target.start, target.end)).toBe('排程『寫文件』（11/26–11/28）');
    expect(formatScheduleBubble(D('2026-12-31'), D('2027-01-01'))).toBe('12/31 – 1/1（2 天）');
  });
  it('分組欄位提示', () => {
    expect(scheduleFieldNote(target)).toBe('同時指派給 晟榕');
    expect(scheduleFieldNote({ ...target, fields: { assigneeId: null } })).toBe('同時改為未指派');
    expect(
      scheduleFieldNote({ group: { kind: 'project', refId: 2, label: '官網' }, fields: { projectId: 2 } }),
    ).toBe('同時移到專案 官網');
    expect(scheduleFieldNote({ ...target, fields: {} })).toBeNull();
  });
  it('播報', () => {
    expect(announceSchedule.target(target)).toBe('預計排程 11/26 到 11/28，指派給 晟榕');
    expect(announceSchedule.target({ ...target, fields: {} })).toBe('預計排程 11/26 到 11/28');
    expect(announceSchedule.drop('寫文件', target.start, target.end)).toBe(
      '已排程『寫文件』：11/26 到 11/28',
    );
  });
});

describe('growExtent / rangeWithExtent', () => {
  it('只增不減；已涵蓋時回傳同一物件', () => {
    const e = growExtent(null, { start: 10, end: 12 });
    expect(e).toEqual({ start: 10, end: 12 });
    expect(growExtent(e, { start: 11, end: 12 })).toBe(e);
    expect(growExtent(e, { start: 8, end: 9 })).toEqual({ start: 8, end: 12 });
    expect(growExtent(e, { start: 12, end: 20 })).toEqual({ start: 10, end: 20 });
  });
  const today = '2026-11-25';
  const tasks = [{ startDate: '2026-11-20', dueDate: '2026-11-30' }];
  it('沒有 extent 時與 computeRange 相同', () => {
    expect(rangeWithExtent(tasks, today, 'day', 30, null)).toEqual(computeRange(tasks, today, 'day', 30));
  });
  it('超出範圍的日期 → 依 computeRange 規則延伸（含邊界與對齊）', () => {
    const base = computeRange(tasks, today, 'week', 0);
    const far = base.end + 20;
    const r = rangeWithExtent(tasks, today, 'week', 0, { start: far, end: far + 2 });
    expect(r.start).toBe(base.start);
    expect(r.end).toBeGreaterThan(far + 2);
    const early = base.start - 30;
    const r2 = rangeWithExtent(tasks, today, 'month', 0, { start: early, end: early });
    expect(r2.start).toBeLessThan(early);
    expect(fromDay(r2.start).endsWith('-01')).toBe(true);
  });
  it('放下後範圍不跳動：任務落在 extent 內時重算結果相同', () => {
    const extent = { start: D('2027-01-10'), end: D('2027-01-12') };
    const during = rangeWithExtent(tasks, today, 'day', 40, extent);
    const dropped = [...tasks, { startDate: '2027-01-10', dueDate: '2027-01-12' }];
    expect(rangeWithExtent(dropped, today, 'day', 40, extent)).toEqual(during);
  });
});

describe('moveKeyboardTarget', () => {
  const anchors = ['u1', 'u2', 'none'];
  it('←→ 移動 1 天，Shift 7 天', () => {
    expect(moveKeyboardTarget({ day: 10, rowKey: 'u1' }, 'ArrowRight', anchors)).toEqual({
      day: 11,
      rowKey: 'u1',
    });
    expect(moveKeyboardTarget({ day: 10, rowKey: 'u1' }, 'ArrowLeft', anchors, true)).toEqual({
      day: 3,
      rowKey: 'u1',
    });
  });
  it('↑↓ 切換分組列，頭尾不循環', () => {
    expect(moveKeyboardTarget({ day: 10, rowKey: 'u1' }, 'ArrowDown', anchors).rowKey).toBe('u2');
    expect(moveKeyboardTarget({ day: 10, rowKey: 'u1' }, 'ArrowUp', anchors).rowKey).toBe('u1');
    expect(moveKeyboardTarget({ day: 10, rowKey: 'none' }, 'ArrowDown', anchors).rowKey).toBe('none');
  });
  it('目前列不在清單內 → 從第一列開始；清單為空不動', () => {
    expect(moveKeyboardTarget({ day: 10, rowKey: 't9' }, 'ArrowDown', anchors).rowKey).toBe('u1');
    expect(moveKeyboardTarget({ day: 10, rowKey: 'u1' }, 'ArrowDown', [])).toEqual({ day: 10, rowKey: 'u1' });
  });
});
