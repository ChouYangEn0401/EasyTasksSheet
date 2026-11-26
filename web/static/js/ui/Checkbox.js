import { createElement, Fragment } from 'preact';
import { forwardRef } from 'preact/compat';

/** 16px 方形勾選框；有 label 時以 <label> 包住，點文字也可切換 */
export const Checkbox = forwardRef(function Checkbox({ label, className = '', ...rest }, ref) {
  const box = createElement('input', {
    ref: ref,
    type: 'checkbox',
    className: `ui-checkbox ${className}`,
    ...rest,
  });
  if (label == null) return box;
  return createElement('label', { className: 'ui-checkbox-label' }, box, createElement('span', null, label));
});
