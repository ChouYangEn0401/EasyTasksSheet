import { forwardRef, useState } from 'react';
import { Button, Input, type InputProps } from '../../ui/index.ts';

/** 密碼輸入框，尾端有顯示 / 隱藏切換 */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type' | 'end'>>(
  function PasswordInput(props, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <Input
        ref={ref}
        {...props}
        type={visible ? 'text' : 'password'}
        end={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={visible ? 'eyeOff' : 'eye'}
            aria-label={visible ? '隱藏密碼' : '顯示密碼'}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
            disabled={props.disabled}
          />
        }
      />
    );
  },
);
