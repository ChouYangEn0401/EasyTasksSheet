import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastStore, defaultDuration, quoteName, truncate } from './toast.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const store = () => createToastStore({ now: () => Date.now(), exitMs: () => 150 });
const live = (s: ReturnType<typeof store>) => s.getSnapshot().items.filter((t) => !t.leaving);

describe('toast store', () => {
  it('依類型自動消失：success 2.5 秒；danger 帶動作時不消失', () => {
    const s = store();
    s.show({ tone: 'success', title: '已建立任務' });
    s.show({ tone: 'danger', title: '無法儲存變更', action: { label: '重試', onClick: () => undefined } });
    vi.advanceTimersByTime(2499);
    expect(live(s)).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(live(s).map((t) => t.title)).toEqual(['無法儲存變更']);
    vi.advanceTimersByTime(150);
    expect(s.getSnapshot().items).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(live(s)).toHaveLength(1);
  });

  it('預設停留時間', () => {
    expect(defaultDuration({ tone: 'success' })).toBe(2500);
    expect(defaultDuration({ tone: 'info' })).toBe(5000);
    expect(defaultDuration({ tone: 'warning' })).toBe(8000);
    expect(defaultDuration({ tone: 'danger' })).toBe(8000);
  });

  it('最多同時 3 則，超過時最舊的先離場', () => {
    const s = store();
    for (const n of [1, 2, 3, 4]) s.show({ tone: 'info', title: `訊息 ${n}` });
    expect(live(s).map((t) => t.title)).toEqual(['訊息 2', '訊息 3', '訊息 4']);
  });

  it('同 key 尚未消失時更新原則內容並重新計時', () => {
    const s = store();
    const a = s.show({ key: 'k', tone: 'success', title: '已建立任務' });
    vi.advanceTimersByTime(2000);
    const b = s.show({ key: 'k', tone: 'success', title: '已建立 2 個任務' });
    expect(b).toBe(a);
    expect(live(s)).toHaveLength(1);
    expect(live(s)[0]).toMatchObject({ title: '已建立 2 個任務', version: 1 });
    vi.advanceTimersByTime(2000);
    expect(live(s)).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(live(s)).toHaveLength(0);
  });

  it('相同錯誤 2 秒內重複只顯示一則', () => {
    const s = store();
    s.show({ tone: 'danger', title: '無法儲存變更' });
    s.show({ tone: 'danger', title: '無法儲存變更' });
    expect(live(s)).toHaveLength(1);
    vi.advanceTimersByTime(2001);
    s.show({ tone: 'danger', title: '無法儲存變更' });
    expect(live(s)).toHaveLength(2);
  });

  it('暫停期間不計時，恢復後接續剩餘時間', () => {
    const s = store();
    s.show({ tone: 'success', title: 'A' });
    vi.advanceTimersByTime(2000);
    s.pause('hover');
    s.pause('window');
    vi.advanceTimersByTime(10_000);
    expect(live(s)).toHaveLength(1);
    s.resume('hover');
    vi.advanceTimersByTime(10_000);
    expect(live(s)).toHaveLength(1);
    s.resume('window');
    vi.advanceTimersByTime(499);
    expect(live(s)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(live(s)).toHaveLength(0);
  });

  it('連線狀態 toast 獨立於佇列', () => {
    const s = store();
    for (const n of [1, 2, 3]) s.show({ tone: 'info', title: `訊息 ${n}` });
    s.setConnection({ tone: 'warning', title: '即時更新中斷，正在重新連線…', spinner: true });
    expect(live(s)).toHaveLength(3);
    expect(s.getSnapshot().connection?.title).toBe('即時更新中斷，正在重新連線…');
  });
});

describe('文案工具', () => {
  it('名稱用「」包住並截斷為 20 字', () => {
    expect(quoteName('短標題')).toBe('「短標題」');
    expect(quoteName('一二三四五六七八九十一二三四五六七八九十一')).toBe(
      '「一二三四五六七八九十一二三四五六七八九十…」',
    );
    expect(truncate(' abc ')).toBe('abc');
  });
});
