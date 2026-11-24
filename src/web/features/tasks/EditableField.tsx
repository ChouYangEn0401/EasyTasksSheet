import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
} from 'react';
import type { Task } from '../../../shared/tasks.ts';
import { Spinner } from '../../ui/index.ts';
import { FieldDisplay, FieldEditor, type EditorApi } from './fields.tsx';
import { TEXT_KINDS, TOGGLE_KINDS, type FieldCol, type FieldMode } from './fieldText.ts';
import { getValue } from './model.ts';
import { useFieldCommit, type CommitResult } from './useFieldCommit.ts';

export type EditState = { initialText?: string } | null;

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

export type EditableFieldHandle = { focus: () => void };

type Props = {
  task: Task;
  col: FieldCol;
  mode: FieldMode;
  /** 受控：目前是否編輯中 */
  edit: EditState;
  onEditChange: (next: EditState, move?: 1 | -1) => void;
  /** 寫入完成（成功或失敗） */
  onSaved?: (col: FieldCol, result: CommitResult) => void;
  disabled?: boolean;
} & Omit<HTMLAttributes<HTMLDivElement>, 'onKeyDown' | 'onClick'>;

/**
 * 就地編輯欄位容器（List 儲存格與 Drawer 欄位值共用）：
 * 顯示 / 編輯切換、Enter / F2 進入編輯、直接輸入取代、Delete 清空、
 * 寫入中 400ms 後顯示 Spinner、錯誤態（內框 danger + 下方訊息，4 秒後消失）。
 */
export const EditableField = forwardRef<EditableFieldHandle, Props>(function EditableField(
  { task, col, mode, edit, onEditChange, onSaved, disabled, className = '', ...rest },
  ref,
) {
  const el = useRef<HTMLDivElement | null>(null);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const setRef = useCallback((n: HTMLDivElement | null) => {
    el.current = n;
    setNode(n);
  }, []);
  const commit = useFieldCommit();
  const [error, setError] = useState<string | null>(null);
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

  const run = async (value: unknown) => {
    setError(null);
    setPending((n) => n + 1);
    const r = await commit(task, col, value);
    setPending((n) => n - 1);
    if (!r.ok) setError(r.error);
    onSaved?.(col, r);
  };

  const exit = (refocus: boolean, move?: 1 | -1) => {
    onEditChange(null, move);
    if (refocus && !move) requestAnimationFrame(() => el.current?.focus());
  };

  const api: EditorApi = {
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

  const start = (initialText?: string) => {
    if (readOnly) return;
    setError(null);
    if (TOGGLE_KINDS.has(col.kind)) return void run(!(getValue(task, col) === true));
    onEditChange({ initialText });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
  return (
    <div
      ref={setRef}
      className={`tl-field tl-field--${col.kind} ${className}`}
      data-editing={editing || undefined}
      data-error={error ? true : undefined}
      data-readonly={readOnly || undefined}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (editing || readOnly) return;
        if ((e.target as HTMLElement).closest('a, input[type="checkbox"], .tl-stop')) return;
        start();
      }}
      {...rest}
    >
      <span className="tl-field-value">
        {textEditing ? (
          <FieldEditor
            task={task}
            col={col}
            mode={mode}
            anchor={node}
            initialText={edit?.initialText}
            api={api}
          />
        ) : (
          <FieldDisplay task={task} col={col} mode={mode} onToggle={(next) => void run(next)} />
        )}
      </span>
      {showSpin && (
        <span className="tl-field-spin">
          <Spinner size={14} />
        </span>
      )}
      {editing && !textEditing && <FieldEditor task={task} col={col} mode={mode} anchor={node} api={api} />}
      {error && (
        <span className="tl-field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
});
