import { describe, expect, it } from 'vitest';
import { resolveShortcut, shortcutsSuspended, suspendGlobalShortcuts } from './shortcuts.ts';

describe('resolveShortcut', () => {
  it('單鍵動作', () => {
    expect(resolveShortcut('n', false).action).toEqual({ type: 'focus-quickadd' });
    expect(resolveShortcut('N', false).action).toEqual({ type: 'focus-quickadd' });
    expect(resolveShortcut('/', false).action).toEqual({ type: 'focus-search' });
    expect(resolveShortcut('[', false).action).toEqual({ type: 'toggle-sidebar' });
    expect(resolveShortcut('x', false)).toEqual({ action: null, pendingG: false });
  });

  it('G 序列', () => {
    const first = resolveShortcut('g', false);
    expect(first).toEqual({ action: null, pendingG: true });
    expect(resolveShortcut('k', true)).toEqual({
      action: { type: 'goto', path: '/tasks/kanban' },
      pendingG: false,
    });
    expect(resolveShortcut('g', true).action).toEqual({ type: 'goto', path: '/tasks/gantt' });
    expect(resolveShortcut('o', true).action).toEqual({ type: 'goto', path: '/' });
    expect(resolveShortcut('z', true)).toEqual({ action: null, pendingG: false });
  });

  it('suspendGlobalShortcuts 可巢狀且只恢復一次', () => {
    const a = suspendGlobalShortcuts();
    const b = suspendGlobalShortcuts();
    expect(shortcutsSuspended()).toBe(true);
    a();
    a();
    expect(shortcutsSuspended()).toBe(true);
    b();
    expect(shortcutsSuspended()).toBe(false);
  });
});
