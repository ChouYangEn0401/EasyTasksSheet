import { describe, expect, it } from 'vitest';
import { taskListQuery } from '../../shared/tasks.ts';
import {
  clearTaskFilters,
  emptyFilters,
  hasActiveFilters,
  parseTaskFilters,
  toggleValue,
  toTaskQueryString,
  writeTaskFilters,
} from './filters.ts';

const sp = (s: string) => new URLSearchParams(s);

describe('parseTaskFilters', () => {
  it('空網址得到空條件', () => {
    expect(parseTaskFilters(sp(''))).toEqual(emptyFilters());
  });

  it('解析逗號分隔多值，排序並去重', () => {
    expect(parseTaskFilters(sp('q=%20報告%20&project=3,1,3&status=4,2&assignee=5,none,2'))).toEqual({
      q: '報告',
      project: [1, 3],
      status: [2, 4],
      assignee: ['none', 2, 5],
    });
  });

  it('忽略格式錯誤的值', () => {
    expect(parseTaskFilters(sp('project=abc,2,,-1,0&assignee=x,none&status='))).toEqual({
      q: '',
      project: [2],
      assignee: ['none'],
      status: [],
    });
  });
});

describe('writeTaskFilters', () => {
  it('寫入時保留其他參數（如 task）並刪除空值', () => {
    const next = writeTaskFilters(sp('task=7&project=1&q=abc'), { project: [], status: [3, 1] });
    expect(next.get('task')).toBe('7');
    expect(next.has('project')).toBe(false);
    expect(next.get('status')).toBe('1,3');
    expect(next.get('q')).toBe('abc');
  });

  it('assignee none 以字串 none 寫入', () => {
    expect(writeTaskFilters(sp(''), { assignee: [4, 'none'] }).get('assignee')).toBe('none,4');
  });

  it('來回轉換一致', () => {
    const f = { q: 'x', project: [2], assignee: ['none' as const, 1], status: [3] };
    expect(parseTaskFilters(writeTaskFilters(sp(''), f))).toEqual(f);
  });

  it('clearTaskFilters 只清篩選參數', () => {
    const next = clearTaskFilters(sp('q=a&project=1&assignee=none&status=2&task=9'));
    expect(next.toString()).toBe('task=9');
  });
});

describe('toTaskQueryString / hasActiveFilters', () => {
  it('無條件為空字串', () => {
    expect(toTaskQueryString(emptyFilters())).toBe('');
    expect(hasActiveFilters(emptyFilters())).toBe(false);
  });

  it('產生的 query 可被後端 taskListQuery 解析', () => {
    const f = parseTaskFilters(sp('q=報告&project=1,2&assignee=none,3&status=4'));
    expect(hasActiveFilters(f)).toBe(true);
    const qs = toTaskQueryString(f);
    const parsed = taskListQuery.parse(Object.fromEntries(new URLSearchParams(qs.slice(1))));
    expect(parsed).toEqual({
      q: '報告',
      project: [1, 2],
      assignee: { ids: [3], none: true },
      status: [4],
    });
  });

  it('toggleValue 切換多選值', () => {
    expect(toggleValue([1, 2], 2)).toEqual([1]);
    expect(toggleValue<number | 'none'>([1], 'none')).toEqual([1, 'none']);
  });
});
