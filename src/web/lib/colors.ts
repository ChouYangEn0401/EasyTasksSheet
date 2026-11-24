import type { CSSProperties } from 'react';
import { TAG_COLORS, type Status, type TagColor } from '../../shared/projects.ts';

/** DB color 欄位存調色盤鍵名；未知值退回 gray */
export function tagColor(key: string | null | undefined): TagColor {
  return (TAG_COLORS as readonly string[]).includes(key ?? '') ? (key as TagColor) : 'gray';
}

/** 調色盤的 CSS 變數：本色 / -soft 淡底 / -text 加深字 */
export function tagVars(key: string | null | undefined) {
  const c = tagColor(key);
  return {
    color: `var(--color-tag-${c})`,
    soft: `var(--color-tag-${c}-soft)`,
    text: `var(--color-tag-${c}-text)`,
  };
}

/** 依 id 對調色盤取模（Avatar 底色） */
export const colorForId = (id: number): TagColor => TAG_COLORS[Math.abs(id) % TAG_COLORS.length]!;

export type StatusTone = 'todo' | 'doing' | 'review' | 'done';

/** 狀態色：名稱含「審查」或 color=purple → review；其餘依 category */
export function statusTone(status: Pick<Status, 'name' | 'color' | 'category'>): StatusTone {
  if (status.name.includes('審查') || status.color === 'purple') return 'review';
  return status.category;
}

export function statusStyle(tone: StatusTone): CSSProperties {
  return {
    ['--status-dot' as string]: `var(--color-status-${tone})`,
    ['--status-soft' as string]: `var(--color-status-${tone}-soft)`,
    ['--status-text' as string]: `var(--color-status-${tone}-text)`,
  };
}
