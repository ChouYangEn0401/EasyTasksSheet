import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
  cloneElement,
} from 'react';
import { Icon, type IconName } from './Icon.tsx';

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  size?: 'sm' | 'md' | 'lg';
  /** 前置圖示（如 search） */
  icon?: IconName;
  /** 尾端內容（清除鈕、Kbd、Spinner…） */
  end?: ReactNode;
  invalid?: boolean;
  /** 外層 wrapper 的 className（控制寬度用） */
  wrapperClassName?: string;
};

/** 單行輸入框：高 32（sm 28 / lg 40），focus 時 accent 邊框 + focus ring */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', icon, end, invalid, className = '', wrapperClassName = '', ...rest },
  ref,
) {
  const cls = [
    'ui-input',
    size !== 'md' && `ui-input--${size}`,
    icon && 'ui-input--has-icon',
    end != null && end !== false && 'ui-input--has-end',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={`ui-input-wrap ${wrapperClassName}`}>
      {icon && (
        <span className="ui-input-icon">
          <Icon name={icon} />
        </span>
      )}
      <input ref={ref} className={cls} aria-invalid={invalid || undefined} {...rest} />
      {end != null && end !== false && <span className="ui-input-end">{end}</span>}
    </span>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className = '', ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={`ui-textarea ${className}`}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

/**
 * 表單欄位：上方 Label、下方說明或錯誤訊息（自動以 id / aria-describedby 串接）。
 * children 須為單一 Input / Textarea / Select 元素。
 */
export function Field({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; invalid?: boolean }>;
  className?: string;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  const hasDesc = !!(error || hint);
  const control = cloneElement(children, {
    id: children.props.id ?? id,
    'aria-describedby': hasDesc ? descId : undefined,
    invalid: !!error || children.props.invalid,
  });
  return (
    <div className={`ui-field ${className}`}>
      <label className="ui-label" htmlFor={children.props.id ?? id}>
        {label}
      </label>
      {control}
      {error ? (
        <span id={descId} className="ui-field-error">
          {error}
        </span>
      ) : hint ? (
        <span id={descId} className="ui-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
