import { createElement, Fragment } from 'preact';

export function Spinner({ size = 16, label }) {
  return createElement('span', {
    className: 'ui-spinner',
    style: { width: size, height: size },
    role: label ? 'status' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
  });
}

export function Skeleton({ width = '100%', height = 12, className = '', style }) {
  return createElement('span', {
    className: `ui-skeleton ${className}`,
    style: { width, height, ...style },
    'aria-hidden': 'true',
  });
}
