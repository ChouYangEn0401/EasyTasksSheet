import { createElement, Fragment } from 'preact';
import { forwardRef } from 'preact/compat';
import { statusStyle, statusTone } from '../lib/colors.js';
import { useStatusesById } from '../lib/hooks.js';
import { Icon } from './Icon.js';

/** 狀態膠囊：前置圓點，顏色依 category（審查中用 review 色） */
export const StatusBadge = forwardRef(function StatusBadge(
  { status, statusId, interactive, className = '', style, ...rest },
  ref,
) {
  const byId = useStatusesById();
  const s = status ?? (statusId != null ? byId.get(statusId) : undefined);
  const tone = s ? statusTone(s) : 'todo';
  const label = s?.name ?? '—';
  const merged = { ...statusStyle(tone), ...style };
  if (interactive) {
    return createElement(
      'button',
      {
        ref: ref,
        type: 'button',
        className: `ui-status-badge ${className}`,
        style: merged,
        'aria-label': `狀態：${label}`,
        ...rest,
      },
      createElement('span', { className: 'ui-dot' }),
      label,
      createElement(Icon, { name: 'chevronDown', size: 12 }),
    );
  }
  return createElement(
    'span',
    { className: `ui-status-badge ${className}`, style: merged },
    createElement('span', { className: 'ui-dot' }),
    label,
  );
});
