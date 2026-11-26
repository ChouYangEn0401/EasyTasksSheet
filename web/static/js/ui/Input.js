import { createElement, Fragment } from 'preact';
import { forwardRef, useId, cloneElement, useEffect, useRef } from 'preact/compat';
import { Icon } from './Icon.js';

/** 單行輸入框：高 32（sm 28 / lg 40），focus 時 accent 邊框 + focus ring */
export const Input = forwardRef(function Input(
  { size = 'md', icon, end, invalid, autoFocus, className = '', wrapperClassName = '', ...rest },
  ref,
) {
  // autoFocus：Preact 只會寫成 HTML 屬性，動態插入的元素不會聚焦，所以掛載時自己 focus 一次
  const inner = useRef(null);
  useEffect(() => {
    if (autoFocus && inner.current && document.activeElement !== inner.current) inner.current.focus();
  }, [autoFocus]);
  const setRef = (el) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  const cls = [
    'ui-input',
    size !== 'md' && `ui-input--${size}`,
    icon && 'ui-input--has-icon',
    end != null && end !== false && 'ui-input--has-end',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return createElement(
    'span',
    { className: `ui-input-wrap ${wrapperClassName}` },
    icon && createElement('span', { className: 'ui-input-icon' }, createElement(Icon, { name: icon })),
    createElement('input', { ref: setRef, className: cls, 'aria-invalid': invalid || undefined, ...rest }),
    end != null && end !== false && createElement('span', { className: 'ui-input-end' }, end),
  );
});

export const Textarea = forwardRef(function Textarea({ invalid, className = '', ...rest }, ref) {
  return createElement('textarea', {
    ref: ref,
    className: `ui-textarea ${className}`,
    'aria-invalid': invalid || undefined,
    ...rest,
  });
});

/**
 * 表單欄位：上方 Label、下方說明或錯誤訊息（自動以 id / aria-describedby 串接）。
 * children 須為單一 Input / Textarea / Select 元素。
 */
export function Field({ label, hint, error, children, className = '' }) {
  const id = useId();
  const descId = `${id}-desc`;
  const hasDesc = !!(error || hint);
  const control = cloneElement(children, {
    id: children.props.id ?? id,
    'aria-describedby': hasDesc ? descId : undefined,
    invalid: !!error || children.props.invalid,
  });
  return createElement(
    'div',
    { className: `ui-field ${className}` },
    createElement('label', { className: 'ui-label', htmlFor: children.props.id ?? id }, label),
    control,
    error
      ? createElement('span', { id: descId, className: 'ui-field-error' }, error)
      : hint
        ? createElement('span', { id: descId, className: 'ui-hint' }, hint)
        : null,
  );
}
