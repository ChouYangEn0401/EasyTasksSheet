import { createElement, Fragment } from 'preact';
import { forwardRef, useState } from 'preact/compat';
import { Button, Input } from '../../ui/index.js';

/** 密碼輸入框，尾端有顯示 / 隱藏切換 */
export const PasswordInput = forwardRef(function PasswordInput(props, ref) {
  const [visible, setVisible] = useState(false);
  return createElement(Input, {
    ref: ref,
    ...props,
    type: visible ? 'text' : 'password',
    end: createElement(Button, {
      variant: 'ghost',
      size: 'sm',
      iconOnly: true,
      icon: visible ? 'eyeOff' : 'eye',
      'aria-label': visible ? '隱藏密碼' : '顯示密碼',
      'aria-pressed': visible,
      onClick: () => setVisible((v) => !v),
      disabled: props.disabled,
    }),
  });
});
