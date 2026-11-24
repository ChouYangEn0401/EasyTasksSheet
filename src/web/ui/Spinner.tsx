import type { CSSProperties } from 'react';

export function Spinner({ size = 16, label }: { size?: 14 | 16 | 20; label?: string }) {
  return (
    <span
      className="ui-spinner"
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function Skeleton({
  width = '100%',
  height = 12,
  className = '',
  style,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={`ui-skeleton ${className}`} style={{ width, height, ...style }} aria-hidden="true" />
  );
}
