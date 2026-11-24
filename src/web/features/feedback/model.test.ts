import { describe, expect, it } from 'vitest';
import type { FeedbackItem } from '../../../shared/feedback.ts';
import { buildMonthGrid, parseMonthKey, shiftMonth, toMonthKey, WEEKDAY_LABELS } from '../calendar/dates.ts';
import { applyFilters, applyPatch, groupItems, itemsByDate, readFilters, writeFilters } from './model.ts';

let seq = 0;
const mk = (over: Partial<FeedbackItem> = {}): FeedbackItem => {
  seq += 1;
  return {
    id: seq,
    projectId: null,
    kind: 'problem',
    title: `t${seq}`,
    body: '',
    status: 'open',
    scheduledDate: null,
    reporterId: 1,
    assigneeId: null,
    updatedBy: 1,
    createdAt: seq * 1000,
    updatedAt: seq * 1000,
    ...over,
  };
};

describe('URL 篩選', () => {
  it('讀取時忽略無效值、去重；寫回時保留其他參數', () => {
    const f = readFilters(new URLSearchParams('kind=bug&status=open,zzz,open,resolved&month=2026-11'));
    expect(f).toEqual({ kind: null, status: ['open', 'resolved'] });
    expect(readFilters(new URLSearchParams('kind=feedback')).kind).toBe('feedback');
    const sp = writeFilters(new URLSearchParams('month=2026-11'), { kind: 'problem', status: ['scheduled'] });
    expect(sp.toString()).toBe('month=2026-11&kind=problem&status=scheduled');
    expect(writeFilters(sp, { kind: null, status: [] }).toString()).toBe('month=2026-11');
  });

  it('applyFilters 同時依類型與狀態', () => {
    const a = mk({ kind: 'problem', status: 'open' });
    const b = mk({ kind: 'feedback', status: 'scheduled', scheduledDate: '2026-11-02' });
    const c = mk({ kind: 'problem', status: 'resolved' });
    expect(applyFilters([a, b, c], { kind: null, status: [] })).toEqual([a, b, c]);
    expect(applyFilters([a, b, c], { kind: 'problem', status: [] })).toEqual([a, c]);
    expect(applyFilters([a, b, c], { kind: null, status: ['scheduled', 'resolved'] })).toEqual([b, c]);
  });
});

describe('分群與排序', () => {
  it('未排程建立新→舊、已排程排程日近→遠、已解決更新新→舊', () => {
    const o1 = mk();
    const o2 = mk();
    const s1 = mk({ status: 'scheduled', scheduledDate: '2026-11-20' });
    const s2 = mk({ status: 'scheduled', scheduledDate: '2026-11-05' });
    const r1 = mk({ status: 'resolved', updatedAt: 99_000 });
    const r2 = mk({ status: 'resolved', updatedAt: 1 });
    const g = groupItems([o1, s1, r2, o2, s2, r1]);
    expect(g.open.map((i) => i.id)).toEqual([o2.id, o1.id]);
    expect(g.scheduled.map((i) => i.id)).toEqual([s2.id, s1.id]);
    expect(g.resolved.map((i) => i.id)).toEqual([r1.id, r2.id]);
  });

  it('itemsByDate 依排程日分組，已解決排在後面', () => {
    const r = mk({ status: 'resolved', scheduledDate: '2026-11-03' });
    const s = mk({ status: 'scheduled', scheduledDate: '2026-11-03' });
    const map = itemsByDate([r, s, mk()]);
    expect([...map.keys()]).toEqual(['2026-11-03']);
    expect(map.get('2026-11-03')!.map((i) => i.id)).toEqual([s.id, r.id]);
  });
});

describe('樂觀更新 applyPatch（與後端相同的狀態推導）', () => {
  it('排入 → scheduled、清空 → open、resolved 保留排程日、重新開啟依排程日', () => {
    const item = mk();
    const s = applyPatch(item, { scheduledDate: '2026-11-26' }, 5);
    expect(s).toMatchObject({ status: 'scheduled', scheduledDate: '2026-11-26', updatedAt: 5 });
    expect(applyPatch(s, { scheduledDate: null }).status).toBe('open');
    const r = applyPatch(s, { resolved: true });
    expect(r).toMatchObject({ status: 'resolved', scheduledDate: '2026-11-26' });
    expect('resolved' in r).toBe(false);
    expect(applyPatch(r, { scheduledDate: '2026-11-27' }).status).toBe('resolved');
    expect(applyPatch(r, { resolved: false }).status).toBe('scheduled');
  });
});

describe('月曆日期', () => {
  it('週一起始；2026 年 11 月為 6 週，首格 10/26、末格 12/6', () => {
    expect(WEEKDAY_LABELS).toEqual(['一', '二', '三', '四', '五', '六', '日']);
    const weeks = buildMonthGrid(parseMonthKey('2026-11')!);
    expect(weeks).toHaveLength(6);
    expect(weeks[0]![0]).toMatchObject({ key: '2026-10-26', inMonth: false });
    expect(weeks.at(-1)!.at(-1)).toMatchObject({ key: '2026-12-06', inMonth: false, weekend: true });
    expect(weeks.flat().filter((d) => d.inMonth)).toHaveLength(30);
  });

  it('2021 年 2 月剛好 4 週；月份參數解析與切換', () => {
    expect(buildMonthGrid(parseMonthKey('2021-02')!)).toHaveLength(4);
    expect(parseMonthKey('2026-13')).toBeNull();
    expect(parseMonthKey('abc')).toBeNull();
    expect(parseMonthKey(null)).toBeNull();
    expect(toMonthKey(shiftMonth(parseMonthKey('2026-12')!, 1))).toBe('2027-01');
    expect(toMonthKey(shiftMonth(parseMonthKey('2026-01')!, -1))).toBe('2025-12');
  });
});
