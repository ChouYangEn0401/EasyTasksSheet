import type { CSSProperties, ReactNode } from 'react';
import type { TagColor } from '../../shared/projects.ts';
import { tagVars } from '../lib/colors.ts';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | TagColor;

const SEMANTIC: Record<string, { bg: string; fg: string; dot: string }> = {
  neutral: {
    bg: 'var(--color-surface-active)',
    fg: 'var(--color-text-secondary)',
    dot: 'var(--color-text-tertiary)',
  },
  accent: { bg: 'var(--color-accent-soft)', fg: 'var(--color-accent-text)', dot: 'var(--color-accent)' },
  success: { bg: 'var(--color-success-soft)', fg: 'var(--color-success-text)', dot: 'var(--color-success)' },
  warning: { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning-text)', dot: 'var(--color-warning)' },
  danger: { bg: 'var(--color-danger-soft)', fg: 'var(--color-danger-text)', dot: 'var(--color-danger)' },
};

/** 小標籤：高 20；tone 為語意色或調色盤 8 色；dot 顯示前置色點；count 為計數膠囊 */
export function Badge({
  tone = 'neutral',
  dot,
  count,
  children,
  className = '',
}: {
  tone?: BadgeTone;
  dot?: boolean;
  count?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const sem = SEMANTIC[tone];
  const t =
    sem ??
    (() => {
      const v = tagVars(tone);
      return { bg: v.soft, fg: v.text, dot: v.color };
    })();
  const style = { '--badge-bg': t.bg, '--badge-fg': t.fg, '--badge-dot': t.dot } as CSSProperties;
  return (
    <span className={`ui-badge${count ? ' ui-badge--count' : ''} ${className}`} style={style}>
      {dot && <span className="ui-dot" />}
      {children}
    </span>
  );
}

/** 調色盤色點（專案、select 選項用） */
export function ColorDot({ color, size = 'sm' }: { color: string | null | undefined; size?: 'sm' | 'md' }) {
  return (
    <span
      className={`ui-dot${size === 'md' ? ' ui-dot--md' : ''}`}
      style={{ color: tagVars(color).color }}
      aria-hidden="true"
    />
  );
}
