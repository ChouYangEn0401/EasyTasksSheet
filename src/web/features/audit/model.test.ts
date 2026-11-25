import { describe, expect, it } from 'vitest';
import type { RevertField } from '../../../shared/audit.ts';
import {
  canShowRevert,
  conflictFields,
  conflictFromError,
  DEFAULT_FILTERS,
  entryState,
  hasActiveFilters,
  inlineDiff,
  rangeOf,
  readFilters,
  sideOf,
  toApiParams,
  tokenize,
  writeFilters,
  type AuditFilters,
} from './model.ts';

const join = (segs: { text: string }[]) => segs.map((s) => s.text).join('');

describe('inlineDiff', () => {
  it('相同文字只有一段 same', () => {
    expect(inlineDiff('abc', 'abc')).toEqual([{ type: 'same', text: 'abc' }]);
  });
  it('中文逐字比對，保留共同前後綴', () => {
    const segs = inlineDiff('請在週五前完成設計稿', '請在週三前完成設計稿與標註');
    expect(segs).toEqual([
      { type: 'same', text: '請在週' },
      { type: 'del', text: '五' },
      { type: 'add', text: '三' },
      { type: 'same', text: '前完成設計稿' },
      { type: 'add', text: '與標註' },
    ]);
  });
  it('幾乎整段改寫時整段顯示為替換（不切成零碎的字）', () => {
    expect(inlineDiff('請在週五前完成首頁設計稿', '改成下週再說')).toEqual([
      { type: 'del', text: '請在週五前完成首頁設計稿' },
      { type: 'add', text: '改成下週再說' },
    ]);
  });
  it('英文以詞為單位', () => {
    const segs = inlineDiff('fix the login bug', 'fix the signup bug');
    expect(segs).toContainEqual({ type: 'del', text: 'login' });
    expect(segs).toContainEqual({ type: 'add', text: 'signup' });
  });
  it('兩側各自重組回原文', () => {
    const a = '第一行\n第二行 hello\n第三行';
    const b = '第一行\n第二行 world\n新的第四行';
    const segs = inlineDiff(a, b);
    expect(join(sideOf(segs, 'before'))).toBe(a);
    expect(join(sideOf(segs, 'after'))).toBe(b);
  });
  it('空字串與新增 / 清除', () => {
    expect(inlineDiff('', '新內容')).toEqual([{ type: 'add', text: '新內容' }]);
    expect(inlineDiff('舊內容', '')).toEqual([{ type: 'del', text: '舊內容' }]);
  });
  it('很長的文字改以行比較，仍可重組', () => {
    const a = Array.from({ length: 2500 }, (_, i) => `第 ${i} 行內容`).join('\n');
    const b = a.replace('第 10 行內容', '第 10 行改過').replace('第 2000 行內容', '');
    const segs = inlineDiff(a, b);
    expect(join(sideOf(segs, 'before'))).toBe(a);
    expect(join(sideOf(segs, 'after'))).toBe(b);
    expect(segs.some((s) => s.type === 'same' && s.text.includes('第 1500 行內容'))).toBe(true);
  });
  it('tokenize：中文逐字、英數成詞、換行獨立', () => {
    expect(tokenize('ab 中文\nx1')).toEqual(['ab', ' ', '中', '文', '\n', 'x1']);
  });
});

describe('篩選條件', () => {
  const now = new Date(2026, 10, 25, 15, 30).getTime();
  const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

  it('時間範圍快選', () => {
    expect(rangeOf({ ...DEFAULT_FILTERS, range: 'today' }, now)).toEqual({
      from: day(2026, 11, 25),
      to: undefined,
    });
    expect(rangeOf({ ...DEFAULT_FILTERS, range: '7d' }, now).from).toBe(day(2026, 11, 19));
    expect(rangeOf({ ...DEFAULT_FILTERS, range: '30d' }, now).from).toBe(day(2026, 10, 27));
    expect(rangeOf({ ...DEFAULT_FILTERS, range: 'all' }, now)).toEqual({ from: undefined, to: undefined });
    expect(
      rangeOf({ ...DEFAULT_FILTERS, range: 'custom', fromDate: '2026-11-01', toDate: '2026-11-03' }, now),
    ).toEqual({ from: day(2026, 11, 1), to: day(2026, 11, 4) });
    expect(rangeOf({ ...DEFAULT_FILTERS, range: 'custom', fromDate: 'bad', toDate: '' }, now)).toEqual({
      from: undefined,
      to: undefined,
    });
  });

  it('組合成 API 參數（略過未設定者）', () => {
    const f: AuditFilters = {
      ...DEFAULT_FILTERS,
      range: 'all',
      actor: 3,
      entityType: 'task',
      action: 'update',
      revertable: 'yes',
      q: '  設計 ',
      taskId: 12,
    };
    expect(toApiParams(f, now)).toEqual({
      from: undefined,
      to: undefined,
      actor: 3,
      entityType: 'task',
      action: 'update',
      revertable: 'true',
      q: '設計',
      taskId: 12,
    });
    expect(toApiParams({ ...DEFAULT_FILTERS, range: 'all', revertable: 'no' }, now).revertable).toBe('false');
    expect(toApiParams({ ...DEFAULT_FILTERS, range: 'all' }, now)).toEqual({
      from: undefined,
      to: undefined,
      actor: undefined,
      entityType: undefined,
      action: undefined,
      revertable: undefined,
      q: undefined,
      taskId: undefined,
    });
  });

  it('網址往返；不合法的值忽略；有任務 ID 時預設看全部時間', () => {
    const f: AuditFilters = {
      ...DEFAULT_FILTERS,
      range: 'custom',
      fromDate: '2026-11-01',
      toDate: '2026-11-02',
      actor: 2,
      entityType: 'status',
      action: 'delete',
      revertable: 'no',
      q: '暫停',
    };
    expect(readFilters(writeFilters(f))).toEqual(f);
    expect(writeFilters(DEFAULT_FILTERS).toString()).toBe('');
    expect(readFilters(new URLSearchParams('type=nope&action=x&actor=-1&revertable=maybe&range=1y'))).toEqual(
      DEFAULT_FILTERS,
    );
    const byTask = readFilters(new URLSearchParams('taskId=7'));
    expect(byTask.range).toBe('all');
    expect(writeFilters(byTask).toString()).toBe('taskId=7');
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    expect(hasActiveFilters(byTask)).toBe(true);
  });
});

describe('狀態與衝突判斷', () => {
  it('entryState / canShowRevert', () => {
    expect(entryState({ revertable: true, revertedAt: null })).toBe('revertable');
    expect(entryState({ revertable: true, revertedAt: 5 })).toBe('reverted');
    expect(entryState({ revertable: false, revertedAt: null })).toBe('locked');
    expect(canShowRevert({ revertable: true, revertedAt: null }, true)).toBe(true);
    expect(canShowRevert({ revertable: true, revertedAt: null }, false)).toBe(false);
    expect(canShowRevert({ revertable: true, revertedAt: 1 }, true)).toBe(false);
  });

  const field = (over: Partial<RevertField>): RevertField => ({
    field: 'description',
    label: '描述',
    before: 'A',
    after: 'B',
    current: 'B',
    beforeText: 'A',
    afterText: 'B',
    currentText: 'B',
    long: true,
    conflict: false,
    ...over,
  });

  it('conflictFields：只取目前值與該次修改後不同者', () => {
    const preview = {
      fields: [field({}), field({ field: 'title', current: 'C', currentText: 'C', conflict: true })],
    };
    expect(conflictFields(preview).map((f) => f.field)).toEqual(['title']);
    expect(conflictFields(null)).toEqual([]);
  });

  it('conflictFromError：解析 409 details', () => {
    const fields = [field({ conflict: true })];
    expect(conflictFromError({ conflicts: fields, fields })).toEqual(fields);
    expect(conflictFromError(undefined)).toBeNull();
    expect(conflictFromError({ fields: 'x' })).toBeNull();
  });
});
