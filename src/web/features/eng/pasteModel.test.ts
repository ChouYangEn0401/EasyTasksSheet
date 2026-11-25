import { describe, expect, it } from 'vitest';
import type { PasteItem } from '../../../shared/engManual.ts';
import {
  defaultPicked,
  dropUnpickable,
  isPickable,
  middleEllipsis,
  pasteSummary,
  pasteTags,
  pickAll,
  pickedLines,
  pickNonTemp,
  pickNone,
  togglePick,
} from './pasteModel.ts';

const item = (lineNo: number, over: Partial<PasteItem> = {}): PasteItem => ({
  path: `C:/wt/${lineNo}`,
  sha: 'abcdef12',
  branch: `b${lineNo}`,
  isDetached: false,
  isBare: false,
  isLocked: false,
  isPrunable: false,
  lockReason: '',
  prunableReason: '',
  lineNo,
  isMain: lineNo === 1,
  isTemp: false,
  tempReasons: [],
  key: `c:/wt/${lineNo}`,
  action: 'new',
  recordId: null,
  recordPath: null,
  duplicate: false,
  ...over,
});

const items = [
  item(1),
  item(2, { isTemp: true, tempReasons: ['路徑在 scratchpad'] }),
  item(3, { action: 'existing', recordId: 9 }),
  item(4, { action: 'moved', recordId: 8, recordPath: 'D:/old' }),
  item(5, { duplicate: true }),
];

describe('貼上登記的勾選規則', () => {
  it('預設只勾未登記且非暫時性、非重複', () => {
    expect([...defaultPicked(items)]).toEqual([1, 4]);
  });
  it('已存在項目只有開啟「更新已存在」才可勾；重複行永遠不可勾', () => {
    expect(isPickable(items[2]!, false)).toBe(false);
    expect(isPickable(items[2]!, true)).toBe(true);
    expect(isPickable(items[4]!, true)).toBe(false);
  });
  it('全選 / 只選非暫時性 / 全不選', () => {
    expect([...pickAll(items, false)]).toEqual([1, 2, 4]);
    expect([...pickAll(items, true)]).toEqual([1, 2, 3, 4]);
    expect([...pickNonTemp(items, false)]).toEqual([1, 4]);
    expect([...pickNonTemp(items, true)]).toEqual([1, 3, 4]);
    expect(pickNone().size).toBe(0);
  });
  it('單筆切換不改動原集合', () => {
    const a = new Set([1]);
    const b = togglePick(a, 2);
    expect([...a]).toEqual([1]);
    expect([...b].sort()).toEqual([1, 2]);
    expect([...togglePick(b, 1)]).toEqual([2]);
  });
  it('關閉更新已存在時移除已勾選的既有項目；送出行號依預覽順序且只含可勾選', () => {
    const picked = new Set([3, 1, 5]);
    expect([...dropUnpickable(items, picked, false)]).toEqual([1]);
    expect(pickedLines(items, new Set([4, 3, 1, 5]), false)).toEqual([1, 4]);
    expect(pickedLines(items, new Set([4, 3, 1]), true)).toEqual([1, 3, 4]);
  });
});

describe('顯示輔助', () => {
  it('路徑中間省略並保留尾端', () => {
    const p = 'C:/Users/someone/Desktop/local專案/worktrees/pyDMS_laneC1';
    const s = middleEllipsis(p, 30);
    expect(s.length).toBe(30);
    expect(s).toContain('…');
    expect(s.endsWith('pyDMS_laneC1')).toBe(true);
    expect(middleEllipsis('short', 30)).toBe('short');
  });
  it('標籤', () => {
    const labels = (i: PasteItem) => pasteTags(i).map((t) => t.label);
    expect(labels(item(1))).toEqual(['新增']);
    expect(
      labels(
        item(2, {
          action: 'moved',
          isTemp: true,
          tempReasons: ['x'],
          isLocked: true,
          isDetached: true,
          isPrunable: true,
          isBare: true,
        }),
      ),
    ).toEqual(['可能搬動', '暫時性', '鎖定', '分離 HEAD', '可清理', 'bare']);
    expect(labels(item(3, { action: 'existing' }))).toEqual(['已存在']);
  });
  it('toast 文字', () => {
    expect(pasteSummary({ created: 3, updated: 1, skipped: 2 })).toBe('已登記 4 筆、略過 2 筆');
  });
});
