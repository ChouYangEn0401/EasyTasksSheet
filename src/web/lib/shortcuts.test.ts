import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveShortcut,
  resolveUndoShortcut,
  shortcutsSuspended,
  suspendGlobalShortcuts,
} from './shortcuts.ts';

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

describe('resolveUndoShortcut（復原 / 重做）', () => {
  class FakeElement {
    isContentEditable = false;
    tagName: string;
    type: string;
    constructor(tagName: string, type = '') {
      this.tagName = tagName;
      this.type = type;
    }
  }
  beforeEach(() => {
    vi.stubGlobal('HTMLElement', FakeElement);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const key = (
    k: string,
    mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {},
    target: unknown = null,
  ) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
    target: target as EventTarget | null,
  });

  it('Ctrl / Cmd + Z 復原；加 Shift 或 Ctrl+Y 重做', () => {
    expect(resolveUndoShortcut(key('z', { ctrlKey: true }))).toBe('undo');
    expect(resolveUndoShortcut(key('z', { metaKey: true }))).toBe('undo');
    expect(resolveUndoShortcut(key('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo');
    expect(resolveUndoShortcut(key('z', { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(resolveUndoShortcut(key('y', { ctrlKey: true }))).toBe('redo');
  });

  it('沒有修飾鍵、加 Alt 或其他按鍵時不觸發', () => {
    expect(resolveUndoShortcut(key('z'))).toBeNull();
    expect(resolveUndoShortcut(key('z', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(resolveUndoShortcut(key('x', { ctrlKey: true }))).toBeNull();
    expect(resolveUndoShortcut(key('y', { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('焦點在可編輯元素時不攔截（保留原生文字復原）', () => {
    const mod = { ctrlKey: true };
    expect(resolveUndoShortcut(key('z', mod, new FakeElement('INPUT', 'text')))).toBeNull();
    expect(resolveUndoShortcut(key('z', mod, new FakeElement('TEXTAREA')))).toBeNull();
    expect(resolveUndoShortcut(key('z', mod, new FakeElement('SELECT')))).toBeNull();
    const editable = new FakeElement('DIV');
    editable.isContentEditable = true;
    expect(resolveUndoShortcut(key('z', mod, editable))).toBeNull();
    // 非文字輸入（核取方塊、按鈕）與一般元素：觸發全域復原
    expect(resolveUndoShortcut(key('z', mod, new FakeElement('INPUT', 'checkbox')))).toBe('undo');
    expect(resolveUndoShortcut(key('z', mod, new FakeElement('BUTTON')))).toBe('undo');
    expect(resolveUndoShortcut(key('z', mod, new FakeElement('DIV')))).toBe('undo');
  });
});
