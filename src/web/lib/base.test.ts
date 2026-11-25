import { describe, expect, it } from 'vitest';
import { apiUrl, BASE_PATH, stripBase, withBase } from './base.ts';

// 測試環境的 BASE_URL 為 "/"（根目錄部署）：所有函式都應維持原本的網址
describe('base（根目錄部署）', () => {
  it('BASE_PATH 為空字串', () => expect(BASE_PATH).toBe(''));
  it('apiUrl 加上 /api', () => expect(apiUrl('/tasks?x=1')).toBe('/api/tasks?x=1'));
  it('withBase / stripBase 不改路徑', () => {
    expect(withBase('/login')).toBe('/login');
    expect(stripBase('/me')).toBe('/me');
  });
});
