import { describe, expect, it } from 'vitest';
import type { ImportConflict } from '../../../shared/dataTransfer.ts';
import { countUseImport, effectiveResolution, formatValue } from './dataModel.ts';

const conflict = (key: string, newer: ImportConflict['newer']): ImportConflict => ({
  key,
  category: 'tasks',
  categoryLabel: '任務',
  title: key,
  localUpdatedAt: 1,
  importUpdatedAt: 2,
  newer,
  fields: [],
});

describe('effectiveResolution', () => {
  it('keep_newer：匯入檔較新才用匯入檔，同時間保留本機', () => {
    expect(effectiveResolution('keep_newer', undefined, 'import')).toBe('use_import');
    expect(effectiveResolution('keep_newer', undefined, 'local')).toBe('keep_local');
    expect(effectiveResolution('keep_newer', undefined, 'same')).toBe('keep_local');
  });
  it('固定策略與逐筆覆寫', () => {
    expect(effectiveResolution('keep_local', undefined, 'import')).toBe('keep_local');
    expect(effectiveResolution('use_import', undefined, 'local')).toBe('use_import');
    expect(effectiveResolution('keep_local', 'use_import', 'local')).toBe('use_import');
  });
});

it('countUseImport', () => {
  const list = [conflict('a', 'import'), conflict('b', 'local'), conflict('c', 'same')];
  expect(countUseImport(list, 'keep_newer', {})).toBe(1);
  expect(countUseImport(list, 'keep_newer', { b: 'use_import' })).toBe(2);
  expect(countUseImport(list, 'use_import', { a: 'keep_local' })).toBe(2);
});

it('formatValue', () => {
  expect(formatValue(null)).toBe('（空）');
  expect(formatValue('')).toBe('（空）');
  expect(formatValue(true)).toBe('是');
  expect(formatValue(3)).toBe('3');
  expect(formatValue({ a: 1 })).toBe('{"a":1}');
});
