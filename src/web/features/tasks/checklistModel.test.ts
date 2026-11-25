import { describe, expect, it } from 'vitest';
import {
  badgeInfo,
  MAX_BATCH,
  MAX_TEXT,
  parseChecklistText,
  parseLine,
  pasteSummary,
  progressOf,
  progressOfItems,
  shouldSplitPaste,
  sortItems,
  sortOrderAfter,
  sortOrderForMove,
  sortOrderLast,
} from './checklistModel.ts';

describe('parseChecklistText', () => {
  it('辨識 Markdown 核取方塊並保留勾選狀態', () => {
    const r = parseChecklistText('- [ ] 買牛奶\n- [x] 寄信\n- [X] 開會\n* [ ] 打掃');
    expect(r.items).toEqual([
      { text: '買牛奶', isDone: false },
      { text: '寄信', isDone: true },
      { text: '開會', isDone: true },
      { text: '打掃', isDone: false },
    ]);
  });

  it('辨識項目符號與編號', () => {
    const r = parseChecklistText('* 一\n- 二\n+ 三\n1. 四\n2) 五\n3、六\n• 七');
    expect(r.items.map((i) => i.text)).toEqual(['一', '二', '三', '四', '五', '六', '七']);
    expect(r.items.every((i) => !i.isDone)).toBe(true);
  });

  it('編號加核取方塊、符號核取方塊', () => {
    const r = parseChecklistText('1. [x] 甲\n2. [ ] 乙\n☐ 丙\n☑ 丁\n- ☑ 戊');
    expect(r.items).toEqual([
      { text: '甲', isDone: true },
      { text: '乙', isDone: false },
      { text: '丙', isDone: false },
      { text: '丁', isDone: true },
      { text: '戊', isDone: true },
    ]);
  });

  it('純文字每行一項，空行與縮排忽略（子項目攤平）', () => {
    const r = parseChecklistText('  第一件\n\n\t\t第二件   有  多餘空白  \r\n   \n    - 縮排子項\r第三件\n');
    expect(r.items.map((i) => i.text)).toEqual(['第一件', '第二件 有 多餘空白', '縮排子項', '第三件']);
  });

  it('只有標記沒有內容的行略過；一般文字中的符號不誤判', () => {
    const r = parseChecklistText('- [ ]\n-\n1.\n-foo\n1.5 倍速\n2026 年計畫\n[重要] 事項');
    expect(r.items.map((i) => i.text)).toEqual(['-foo', '1.5 倍速', '2026 年計畫', '[重要] 事項']);
  });

  it('超過上限的行數計入 overflow，過長文字截斷', () => {
    const lines = Array.from({ length: MAX_BATCH + 7 }, (_, i) => `項目 ${i + 1}`);
    const r = parseChecklistText(lines.join('\n'));
    expect(r.items).toHaveLength(MAX_BATCH);
    expect(r.overflow).toBe(7);
    const long = parseChecklistText('字'.repeat(MAX_TEXT + 20));
    expect([...long.items[0]!.text]).toHaveLength(MAX_TEXT);
    expect(long.trimmed).toBe(1);
    expect(parseChecklistText('a\nb\nc', 2)).toMatchObject({ overflow: 1 });
  });

  it('空字串沒有項目', () => {
    expect(parseChecklistText('  \n\n').items).toEqual([]);
    expect(parseLine('')).toBeNull();
  });
});

describe('shouldSplitPaste / pasteSummary', () => {
  it('單行或只有一項不攔截', () => {
    expect(shouldSplitPaste('只有一行')).toBe(false);
    expect(shouldSplitPaste('只有一行\n')).toBe(false);
    expect(shouldSplitPaste('- [ ] a\n\n  \n')).toBe(false);
  });
  it('多行且兩項以上才攔截', () => {
    expect(shouldSplitPaste('a\nb')).toBe(true);
    expect(shouldSplitPaste('- [x] a\n- [ ] b\n')).toBe(true);
  });
  it('摘要文字', () => {
    expect(pasteSummary(parseChecklistText('a\nb\nc'))).toBe('將建立 3 項');
    expect(pasteSummary(parseChecklistText('- [x] a\n- [ ] b'))).toBe('將建立 2 項，其中 1 項已勾選');
  });
});

describe('排序值', () => {
  const list = [{ sortOrder: 1 }, { sortOrder: 2 }, { sortOrder: 3 }, { sortOrder: 4 }];
  it('移到中間取兩側平均', () => {
    expect(sortOrderForMove(list, 0, 2)).toBe(3.5);
    expect(sortOrderForMove(list, 3, 1)).toBe(1.5);
    expect(sortOrderForMove(list, 1, 2)).toBe(3.5);
  });
  it('移到最前 / 最後', () => {
    expect(sortOrderForMove(list, 3, 0)).toBe(0);
    expect(sortOrderForMove(list, 0, 3)).toBe(5);
  });
  it('單一項目維持原值', () => {
    expect(sortOrderForMove([{ sortOrder: 7 }], 0, 0)).toBe(7);
  });
  it('在某項之後插入', () => {
    expect(sortOrderAfter(list, 2)).toBe(2.5);
    expect(sortOrderAfter(list, 4)).toBe(5);
    expect(sortOrderAfter(list, null)).toBe(0);
    expect(sortOrderAfter([], null)).toBe(1);
    expect(sortOrderAfter([], 3)).toBe(4);
  });
  it('最後與排序', () => {
    expect(sortOrderLast(list)).toBe(5);
    expect(sortOrderLast([])).toBe(1);
    const sorted = sortItems([
      { id: 3, sortOrder: 2 },
      { id: 1, sortOrder: 2 },
      { id: 2, sortOrder: 1 },
    ]);
    expect(sorted.map((i) => i.id)).toEqual([2, 1, 3]);
  });
});

describe('進度與徽章', () => {
  it('進度百分比與完成判斷', () => {
    expect(progressOf(5, 3)).toEqual({ total: 5, done: 3, percent: 60, complete: false });
    expect(progressOf(2, 2).complete).toBe(true);
    expect(progressOf(0, 0)).toEqual({ total: 0, done: 0, percent: 0, complete: false });
    expect(progressOf(2, 9).done).toBe(2);
    expect(progressOfItems([{ isDone: true }, { isDone: false }]).percent).toBe(50);
  });
  it('徽章只在有清單時顯示', () => {
    expect(badgeInfo({})).toBeNull();
    expect(badgeInfo({ checklistTotal: 0, checklistDone: 0 })).toBeNull();
    expect(badgeInfo({ checklistTotal: 5, checklistDone: 3 })).toMatchObject({
      text: '3/5',
      label: '待辦清單 3/5 完成',
      complete: false,
    });
    expect(badgeInfo({ checklistTotal: 2, checklistDone: 2 })?.complete).toBe(true);
  });
});
