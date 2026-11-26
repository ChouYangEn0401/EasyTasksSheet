import { createElement, Fragment } from 'preact';

/** 鍵盤按鍵提示 */
export function Kbd({ children }) {
  return createElement('kbd', { className: 'ui-kbd' }, children);
}
