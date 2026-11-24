import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label?: ReactNode };

/** 16px 方形勾選框；有 label 時以 <label> 包住，點文字也可切換 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className = '', ...rest },
  ref,
) {
  const box = <input ref={ref} type="checkbox" className={`ui-checkbox ${className}`} {...rest} />;
  if (label == null) return box;
  return (
    <label className="ui-checkbox-label">
      {box}
      <span>{label}</span>
    </label>
  );
});
