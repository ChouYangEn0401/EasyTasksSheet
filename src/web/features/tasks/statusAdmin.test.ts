import { describe, expect, it } from 'vitest';
import {
  defaultMigrationTarget,
  migrationTargets,
  moveItem,
  nextFreeColor,
  sortOrderChanges,
} from './statusAdmin.ts';

describe('moveItem', () => {
  it('移動並回傳新陣列', () => {
    const src = ['a', 'b', 'c', 'd'];
    expect(moveItem(src, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(src, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(src).toEqual(['a', 'b', 'c', 'd']);
  });
  it('越界或原位不變', () => {
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});

describe('sortOrderChanges', () => {
  it('只回傳排序值有變的項目', () => {
    const list = [
      { id: 1, sortOrder: 1 },
      { id: 2, sortOrder: 2 },
      { id: 3, sortOrder: 3 },
    ];
    expect(sortOrderChanges(list)).toEqual([]);
    expect(sortOrderChanges(moveItem(list, 2, 0))).toEqual([
      { id: 3, sortOrder: 1 },
      { id: 1, sortOrder: 2 },
      { id: 2, sortOrder: 3 },
    ]);
  });
  it('重編離散的舊排序值', () => {
    expect(sortOrderChanges([{ id: 9, sortOrder: 1000 }])).toEqual([{ id: 9, sortOrder: 1 }]);
  });
});

describe('nextFreeColor', () => {
  it('挑第一個未使用的顏色，用完輪替', () => {
    expect(nextFreeColor(['gray', 'blue'])).toBe('purple');
    expect(nextFreeColor([])).toBe('gray');
    expect(nextFreeColor(['gray', 'blue', 'purple', 'green', 'yellow', 'orange', 'red', 'teal'])).toBe(
      'gray',
    );
  });
});

describe('migrationTargets', () => {
  const list = [
    { id: 1, category: 'todo' as const },
    { id: 2, category: 'doing' as const },
    { id: 3, category: 'doing' as const },
  ];
  it('排除自己', () => expect(migrationTargets(list, 2).map((s) => s.id)).toEqual([1, 3]));
  it('預設目標優先同類別', () => {
    expect(defaultMigrationTarget(list, list[1]!)).toBe(3);
    expect(defaultMigrationTarget(list, list[0]!)).toBe(2);
    expect(defaultMigrationTarget([list[0]!], list[0]!)).toBeNull();
  });
});
