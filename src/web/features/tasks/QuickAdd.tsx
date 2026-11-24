import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Task, TaskCreateInput } from '../../../shared/tasks.ts';
import { errorMessage } from '../../lib/api.ts';
import { useCreateTask } from '../../lib/hooks.ts';
import { GLOBAL_QUICKADD_ATTR } from '../../lib/shortcuts.ts';
import { Icon, Input, Kbd, Spinner } from '../../ui/index.ts';

export type QuickAddProps = {
  /** 建立時一併帶入的欄位（如 statusId、projectId、assigneeId、sortOrder） */
  defaults?: Omit<Partial<TaskCreateInput>, 'title'>;
  /** 滿寬（Header 以外的引用處） */
  fullWidth?: boolean;
  placeholder?: string;
  /** Header 的全域實例（快捷鍵 N 聚焦此實例；只應有一個） */
  global?: boolean;
  /** 建立成功後的回呼 */
  onCreated?: (task: Task) => void;
  className?: string;
};

/**
 * 插槽：快速新增任務（core 最小版，由 feat/task-list 升級）。
 * 輸入標題 → Enter 建立 → 清空並保持 focus 可連續新增；空白時 Enter 無作用；Esc 清空並失焦。
 * 建立成功即 invalidate 任務查詢。
 */
export function QuickAdd({
  defaults,
  fullWidth,
  placeholder = '新增任務，按 Enter 建立',
  global,
  onCreated,
  className = '',
}: QuickAddProps) {
  const [title, setTitle] = useState('');
  const [focused, setFocused] = useState(false);
  const [success, setSuccess] = useState(false);
  const create = useCreateTask();
  const inputRef = useRef<HTMLInputElement>(null);
  const msgId = useId();

  useEffect(() => {
    if (!success) return;
    const t = window.setTimeout(() => setSuccess(false), 1200);
    return () => window.clearTimeout(t);
  }, [success]);

  const submit = () => {
    const value = title.trim();
    if (!value || create.isPending) return;
    create.mutate(
      { ...defaults, title: value },
      {
        onSuccess: (task) => {
          setTitle('');
          setSuccess(true);
          inputRef.current?.focus();
          onCreated?.(task);
        },
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setTitle('');
      create.reset();
      inputRef.current?.blur();
    }
  };

  const end = create.isPending ? (
    <span className="flex px-2">
      <Spinner size={14} />
    </span>
  ) : success ? (
    <span className="flex px-2" style={{ color: 'var(--color-success)' }}>
      <Icon name="check" />
    </span>
  ) : !focused && global ? (
    <span className="flex px-2">
      <Kbd>N</Kbd>
    </span>
  ) : null;

  return (
    <div className={`relative ${fullWidth ? 'w-full' : ''} ${className}`}>
      <Input
        ref={inputRef}
        icon="plus"
        end={end}
        value={title}
        placeholder={placeholder}
        aria-label="快速新增任務"
        aria-describedby={msgId}
        readOnly={create.isPending}
        className="ui-input--keep-border"
        invalid={create.isError}
        onChange={(e) => {
          setTitle(e.target.value);
          if (create.isError) create.reset();
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...(global ? { [GLOBAL_QUICKADD_ATTR]: '' } : {})}
      />
      <div
        id={msgId}
        aria-live="polite"
        className="absolute left-0 top-full mt-1 text-xs whitespace-nowrap"
        style={{ zIndex: 'var(--z-popover)' }}
      >
        {create.isError ? (
          <span style={{ color: 'var(--color-danger-text)' }}>{errorMessage(create.error)}</span>
        ) : success ? (
          <span style={{ color: 'var(--color-success-text)' }}>已建立</span>
        ) : null}
      </div>
    </div>
  );
}
