import { describe, expect, it } from 'vitest';
import {
  checkFile,
  DEFAULT_LIMITS,
  extOf,
  formatBytes,
  formatDuration,
  kindOfName,
  middleEllipsis,
  pastedName,
} from './attachModel.ts';

describe('attachModel', () => {
  it('副檔名與類型', () => {
    expect(extOf('a.PNG')).toBe('png');
    expect(extOf('.env')).toBe('');
    expect(extOf('noext')).toBe('');
    expect(kindOfName('clip.MOV')).toBe('video');
    expect(kindOfName('song.m4a')).toBe('audio');
    expect(kindOfName('x.svg')).toBe('file');
  });

  it('檔案大小與時長格式', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(Number.NaN)).toBe('');
  });

  it('過長檔名中間省略並保留副檔名', () => {
    expect(middleEllipsis('short.png')).toBe('short.png');
    const s = middleEllipsis('a-very-long-screenshot-name-from-yesterday-final.png', 28);
    expect(s.length).toBe(28);
    expect(s).toContain('…');
    expect(s.endsWith('al.png')).toBe(true);
  });

  it('前端檢查：類型、空檔、分級大小上限', () => {
    const L = DEFAULT_LIMITS;
    expect(checkFile({ name: 'a.exe', size: 10 }, L)).toMatch('不支援');
    expect(checkFile({ name: 'a.svg', size: 10 }, L)).toMatch('不支援');
    expect(checkFile({ name: 'a.png', size: 0 }, L)).toBe('空檔案');
    expect(checkFile({ name: 'a.png', size: 26 * 1024 * 1024 }, L)).toMatch('25 MB');
    expect(checkFile({ name: 'a.mp4', size: 26 * 1024 * 1024 }, L)).toBeNull();
    expect(checkFile({ name: 'a.mp4', size: 201 * 1024 * 1024 }, L)).toMatch('200 MB');
  });

  it('貼上的圖片檔名', () => {
    expect(pastedName('image/png', new Date(2026, 0, 2, 3, 4, 5))).toBe('貼上的圖片-20260102-030405.png');
    expect(pastedName('image/jpeg', new Date(2026, 0, 2, 3, 4, 5))).toMatch(/\.jpg$/);
  });
});
