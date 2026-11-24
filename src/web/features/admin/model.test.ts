import { describe, expect, it } from 'vitest';
import type { AdminUser } from '../../../shared/admin.ts';
import {
  filterUsers,
  hasFilters,
  lockTooltip,
  readFilters,
  rowState,
  sortUsers,
  writeFilters,
} from './model.ts';

const NOW = 1_700_000_000_000;
let seq = 0;
const u = (over: Partial<AdminUser> = {}): AdminUser => {
  seq += 1;
  return {
    id: seq,
    username: `user${seq}`,
    displayName: `成員${seq}`,
    role: 'member',
    isActive: true,
    mustChangePassword: false,
    lockedUntil: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
};

describe('URL 篩選', () => {
  it('讀取並忽略不合法的 state', () => {
    expect(readFilters(new URLSearchParams('q=wang&state=disabled'))).toEqual({
      q: 'wang',
      state: 'disabled',
    });
    expect(readFilters(new URLSearchParams('state=nope'))).toEqual({ q: '', state: 'all' });
  });
  it('預設值不寫入 URL，保留其他參數', () => {
    const sp = writeFilters(new URLSearchParams('q=x&state=active&other=1'), { q: '', state: 'all' });
    expect(sp.toString()).toBe('other=1');
    expect(writeFilters(new URLSearchParams(), { q: '王', state: 'active' }).get('state')).toBe('active');
    expect(hasFilters({ q: ' ', state: 'all' })).toBe(false);
    expect(hasFilters({ q: '', state: 'disabled' })).toBe(true);
  });
});

describe('排序與過濾', () => {
  it('啟用在前、停用在後；同組內管理員優先，再依名稱', () => {
    const off = u({ displayName: 'A', isActive: false, role: 'admin' });
    const m1 = u({ displayName: 'B' });
    const m2 = u({ displayName: 'A' });
    const adm = u({ displayName: 'Z', role: 'admin' });
    expect(sortUsers([off, m1, m2, adm]).map((x) => x.id)).toEqual([adm.id, m2.id, m1.id, off.id]);
  });
  it('關鍵字比對名稱與帳號，不分大小寫；狀態篩選', () => {
    const a = u({ displayName: '王小明', username: 'wang' });
    const b = u({ displayName: '李大華', username: 'lee', isActive: false });
    expect(filterUsers([a, b], { q: 'WAN', state: 'all' })).toEqual([a]);
    expect(filterUsers([a, b], { q: '大華', state: 'all' })).toEqual([b]);
    expect(filterUsers([a, b], { q: '', state: 'disabled' })).toEqual([b]);
    expect(filterUsers([a, b], { q: '', state: 'active' })).toEqual([a]);
  });
});

describe('列狀態', () => {
  it('停用優先於鎖定；鎖定過期視為啟用', () => {
    expect(rowState(u({ isActive: false, lockedUntil: NOW + 1000 }), NOW)).toBe('disabled');
    expect(rowState(u({ lockedUntil: NOW + 1000 }), NOW)).toBe('locked');
    expect(rowState(u({ lockedUntil: NOW - 1 }), NOW)).toBe('active');
  });
  it('鎖定 tooltip 顯示剩餘分鐘', () => {
    expect(lockTooltip(u({ lockedUntil: NOW + 9.5 * 60_000 }), NOW)).toBe(
      '登入失敗次數過多，暫時無法登入，約 10 分鐘後自動解除',
    );
    expect(lockTooltip(u(), NOW)).toBe('登入失敗次數過多，暫時無法登入');
  });
});
