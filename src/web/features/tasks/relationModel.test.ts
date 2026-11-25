import { describe, expect, it } from 'vitest';
import type { Status } from '../../../shared/projects.ts';
import {
  COPY_SUFFIX,
  defaultCopyTitle,
  defaultDuplicateStatus,
  relationCandidates,
  relationCountLabel,
  TITLE_MAX,
} from './relationModel.ts';

const t = (id: number) => ({ id, title: `任務 ${id}` });

describe('relationCandidates', () => {
  it('排除自己與已關聯者，保持順序', () => {
    const out = relationCandidates([t(1), t(2), t(3), t(4)], 2, [4]);
    expect(out.map((x) => x.id)).toEqual([1, 3]);
  });

  it('排除暫時列（負 id）', () => {
    expect(relationCandidates([t(-1), t(5)], 1, []).map((x) => x.id)).toEqual([5]);
  });

  it('最多 8 筆（可自訂上限）', () => {
    const many = Array.from({ length: 20 }, (_, i) => t(i + 1));
    expect(relationCandidates(many, 1, [2, 3])).toHaveLength(8);
    expect(relationCandidates(many, 1, [2, 3])[0]!.id).toBe(4);
    expect(relationCandidates(many, 1, [], 3).map((x) => x.id)).toEqual([2, 3, 4]);
  });

  it('沒有結果時為空陣列', () => {
    expect(relationCandidates([t(1)], 1, [])).toEqual([]);
  });
});

describe('defaultCopyTitle', () => {
  it('原標題加上（複製）', () => {
    expect(defaultCopyTitle('ntu ranking new workflow')).toBe('ntu ranking new workflow（複製）');
    expect(defaultCopyTitle('  空白  ')).toBe('空白（複製）');
  });

  it('超過上限時截斷原標題', () => {
    const out = defaultCopyTitle('長'.repeat(TITLE_MAX));
    expect([...out]).toHaveLength(TITLE_MAX);
    expect(out.endsWith(COPY_SUFFIX)).toBe(true);
  });
});

describe('defaultDuplicateStatus', () => {
  const s = (id: number, category: Status['category'], sortOrder: number) =>
    ({ id, name: `s${id}`, color: 'gray', category, sortOrder, createdAt: 0, updatedAt: 0 }) as Status;

  it('取 sortOrder 最前的待辦類狀態', () => {
    expect(defaultDuplicateStatus([s(1, 'doing', 1), s(2, 'todo', 3), s(3, 'todo', 2)])).toBe(3);
  });

  it('沒有待辦類時取第一個；沒有狀態時為 null', () => {
    expect(defaultDuplicateStatus([s(5, 'done', 2), s(4, 'doing', 1)])).toBe(4);
    expect(defaultDuplicateStatus([])).toBeNull();
    expect(defaultDuplicateStatus(undefined)).toBeNull();
  });
});

it('relationCountLabel', () => {
  expect(relationCountLabel(3)).toBe('3 個相關任務');
});
