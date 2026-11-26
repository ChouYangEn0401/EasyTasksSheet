import { createElement, Fragment } from 'preact';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'preact/compat';
import { reportEditing } from '../../lib/presence.js';
import { Spinner } from '../../ui/index.js';
import { FieldDisplay, FieldEditor } from './fields.js';
import { TEXT_KINDS, TOGGLE_KINDS } from './fieldText.js';
import { getValue } from './model.js';
import { useFieldCommit } from './useFieldCommit.js';

/** 不可清空 / 不可編輯的欄位 */
const NOT_CLEARABLE = new Set([
  'title',
  'status',
  'project',
  'priority',
  'progress',
  'updatedAt',
  'checkbox',
]);
const READ_ONLY = new Set(['updatedAt']);

const SPINNER_DELAY_MS = 400;
const ERROR_MS = 4000;

/**
 * 就地編輯欄位容器（List 儲存格與 Drawer 欄位值共用）：
 * 顯示 / 編輯切換、Enter / F2 進入編輯、直接輸入取代、Delete 清空、
 * 寫入中 400ms 後顯示 Spinner、錯誤態（內框 danger + 下方訊息，4 秒後消失）。
 */
export const EditableField = forwardRef(function EditableField(
  { task, col, mode, edit, onEditChange, onSaved, disabled, className = '', ...rest },
  ref,
) {
  const el = useRef(null);
  const [node, setNode] = useState(null);
  const setRef = useCallback((n) => {
    el.current = n;
    setNode(n);
  }, []);
  const commit = useFieldCommit();
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(0);
  const [showSpin, setShowSpin] = useState(false);
  useImperativeHandle(ref, () => ({ focus: () => el.current?.focus() }), []);

  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), ERROR_MS);
    return () => window.clearTimeout(t);
  }, [error]);
  useEffect(() => {
    if (!pending) {
      setShowSpin(false);
      return;
    }
    const t = window.setTimeout(() => setShowSpin(true), SPINNER_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [pending]);

  const run = async (value) => {
    setError(null);
    setPending((n) => n + 1);
    const r = await commit(task, col, value);
    setPending((n) => n - 1);
    if (!r.ok) setError(r.error);
    onSaved?.(col, r);
  };

  const exit = (refocus, move) => {
    onEditChange(null, move);
    if (refocus && !move) requestAnimationFrame(() => el.current?.focus());
  };

  const api = {
    submit: (value, opts = {}) => {
      exit(opts.refocus ?? true, opts.move);
      void run(value);
    },
    submitKeep: (value) => void run(value),
    cancel: (refocus = true) => exit(refocus),
    fail: (message, refocus = true) => {
      setError(message);
      exit(refocus);
    },
  };

  const readOnly = disabled || READ_ONLY.has(col.kind) || task.id < 0;
  const editing = !!edit && !readOnly;
  // 在線感知：就地編輯中回報 mode=editing，結束即回 viewing
  useEffect(() => (editing ? reportEditing(task.id) : undefined), [editing, task.id]);

  const start = (initialText) => {
    if (readOnly) return;
    setError(null);
    if (TOGGLE_KINDS.has(col.kind)) return void run(!(getValue(task, col) === true));
    onEditChange({ initialText });
  };

  const onKeyDown = (e) => {
    if (editing || e.target !== el.current || e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      start();
    } else if (e.key === ' ' && TOGGLE_KINDS.has(col.kind)) {
      e.preventDefault();
      start();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !NOT_CLEARABLE.has(col.kind) && !readOnly) {
      e.preventDefault();
      void run(null);
    } else if (
      TEXT_KINDS.has(col.kind) &&
      e.key.length === 1 &&
      e.key !== ' ' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !readOnly
    ) {
      e.preventDefault();
      start(e.key);
    }
  };

  const textEditing = editing && TEXT_KINDS.has(col.kind);
  return createElement(
    'div',
    {
      ref: setRef,
      className: `tl-field tl-field--${col.kind} ${className}`,
      'data-editing': editing || undefined,
      'data-error': error ? true : undefined,
      'data-readonly': readOnly || undefined,
      onKeyDown: onKeyDown,
      onClick: (e) => {
        if (editing || readOnly) return;
        if (e.target.closest('a, input[type="checkbox"], .tl-stop')) return;
        start();
      },
      ...rest,
    },
    createElement(
      'span',
      { className: 'tl-field-value' },
      textEditing
        ? createElement(FieldEditor, {
            task: task,
            col: col,
            mode: mode,
            anchor: node,
            initialText: edit?.initialText,
            api: api,
          })
        : createElement(FieldDisplay, {
            task: task,
            col: col,
            mode: mode,
            onToggle: (next) => void run(next),
          }),
    ),
    showSpin && createElement('span', { className: 'tl-field-spin' }, createElement(Spinner, { size: 14 })),
    editing &&
      !textEditing &&
      createElement(FieldEditor, { task: task, col: col, mode: mode, anchor: node, api: api }),
    error && createElement('span', { className: 'tl-field-error', role: 'alert' }, error),
  );
});
