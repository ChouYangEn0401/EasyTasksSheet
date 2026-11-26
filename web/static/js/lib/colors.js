import { TAG_COLORS } from '../shared/projects.js';

/** DB color 欄位存調色盤鍵名；未知值退回 gray */
export function tagColor(key) {
  return TAG_COLORS.includes(key ?? '') ? key : 'gray';
}

/** 調色盤的 CSS 變數：本色 / -soft 淡底 / -text 加深字 */
export function tagVars(key) {
  const c = tagColor(key);
  return {
    color: `var(--color-tag-${c})`,
    soft: `var(--color-tag-${c}-soft)`,
    text: `var(--color-tag-${c}-text)`,
  };
}

/** 依 id 對調色盤取模（Avatar 底色） */
export const colorForId = (id) => TAG_COLORS[Math.abs(id) % TAG_COLORS.length];

/** 狀態色：名稱含「審查」或 color=purple → review；其餘依 category */
export function statusTone(status) {
  if (status.name.includes('審查') || status.color === 'purple') return 'review';
  return status.category;
}

export function statusStyle(tone) {
  return {
    ['--status-dot']: `var(--color-status-${tone})`,
    ['--status-soft']: `var(--color-status-${tone}-soft)`,
    ['--status-text']: `var(--color-status-${tone}-text)`,
  };
}
