import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { Task, TaskCreateInput } from '../../../shared/tasks.ts';
import { useCurrentUser } from '../../lib/auth.ts';
import { notifyError } from '../../lib/errorToast.ts';
import { useProjects, useStatuses } from '../../lib/hooks.ts';
import { openTask } from '../../lib/openTask.ts';
import { GLOBAL_QUICKADD_ATTR } from '../../lib/shortcuts.ts';
import { notifyTaskCreated } from '../../lib/toast.ts';
import { useTaskFilters } from '../../lib/useTaskFilters.ts';
import { Icon, Input, Kbd } from '../../ui/index.ts';
import { useOptimisticCreate } from './data.ts';
import { parseTitle, TITLE_MAX } from './model.ts';

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
  /** 無邊框的插入列外觀（List 群組底部） */
  bare?: boolean;
  /** 輸入框內 Esc 時的回呼（插入列回到列 focus）；未提供則清空並失焦 */
  onEscape?: () => void;
  /** 無障礙名稱（預設：全域實例「快速新增任務」，其餘同 placeholder） */
  label?: string;
};

type Notice = { kind: 'outside'; id: number } | { kind: 'error'; message: string } | null;

/**
 * 插槽：快速新增任務（T1 升級版）。
 * Enter → 立即樂觀插入（清單末端出現暫時列）並清空輸入、保持 focus，可連續新增；
 * 失敗則移除暫時列、還原輸入內容並顯示錯誤。新任務不在目前篩選範圍時提示並可開啟。
 * 專案預設：FilterBar 恰好選一個專案時帶入該專案。貼上換行轉為空白。
 */
export function QuickAdd({
  defaults,
  fullWidth,
  placeholder = '新增任務，按 Enter 建立',
  global,
  onCreated,
  className = '',
  bare,
  onEscape,
  label,
}: QuickAddProps) {
  const [title, setTitle] = useState('');
  const [focused, setFocused] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState(0);
  const [success, setSuccess] = useState(false);
  const create = useOptimisticCreate();
  const { filters } = useTaskFilters();
  const statuses = useStatuses().data;
  const projects = useProjects().data;
  const me = useCurrentUser();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const msgId = useId();

  useEffect(() => {
    if (!notice || notice.kind === 'error') return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!success) return;
    const t = window.setTimeout(() => setSuccess(false), 1200);
    return () => window.clearTimeout(t);
  }, [success]);

  const tooLong = title.trim().length > TITLE_MAX;

  const submit = () => {
    const parsed = parseTitle(title);
    if (!parsed.ok) {
      if (title.trim()) setNotice({ kind: 'error', message: parsed.error });
      return;
    }
    const projectId = defaults?.projectId ?? (filters.project.length === 1 ? filters.project[0] : undefined);
    const input: TaskCreateInput = {
      ...defaults,
      ...(projectId !== undefined && { projectId }),
      title: parsed.value,
    };
    const firstStatus = [...(statuses ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)[0];
    const firstProject = [...(projects ?? [])]
      .filter((p) => !p.isArchived)
      .sort((a, b) => a.sortOrder - b.sortOrder)[0];
    const now = Date.now();
    const temp: Omit<Task, 'id'> = {
      projectId: input.projectId ?? firstProject?.id ?? 0,
      title: input.title,
      description: '',
      statusId: input.statusId ?? firstStatus?.id ?? 0,
      assigneeId: input.assigneeId ?? null,
      priority: input.priority ?? 'none',
      startDate: null,
      dueDate: null,
      estimateHours: null,
      progress: 0,
      sortOrder: Number.MAX_SAFE_INTEGER,
      custom: {},
      createdBy: me?.id ?? null,
      updatedBy: me?.id ?? null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const typed = title;
    setTitle('');
    setNotice(null);
    setPending((n) => n + 1);
    inputRef.current?.focus();
    // 「重試」以相同參數重送（toast 動作）
    const retry = (): Promise<unknown> =>
      create(input, temp, filters).then(
        ({ task }) => notifyTaskCreated(task, openTask),
        (err: unknown) => notifyError(err, retry),
      );
    create(input, temp, filters)
      .then(({ task, matches }) => {
        setSuccess(true);
        // 建立成功由 toast 告知（連續新增時合併）；不在篩選範圍時另於輸入框下方提示
        setNotice(matches ? null : { kind: 'outside', id: task.id });
        notifyTaskCreated(task, openTask);
        onCreated?.(task);
      })
      .catch((err: unknown) => {
        // 失敗：暫時列已移除；還原輸入內容（若使用者尚未輸入新內容），再出現 toast
        setTitle((cur) => cur || typed);
        notifyError(err, retry);
      })
      .finally(() => setPending((n) => n - 1));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setTitle('');
      setNotice(null);
      if (onEscape) onEscape();
      else inputRef.current?.blur();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const clean = text.replace(/\s*\r?\n\s*/g, ' ');
    const start = el.selectionStart ?? title.length;
    const end = el.selectionEnd ?? title.length;
    setTitle(title.slice(0, start) + clean + title.slice(end));
  };

  const isError = notice?.kind === 'error' || tooLong;
  const end = success ? (
    <span className="flex px-2" style={{ color: 'var(--color-success)' }}>
      <Icon name="check" />
    </span>
  ) : !focused && global ? (
    <span className="flex px-2">
      <Kbd>N</Kbd>
    </span>
  ) : null;

  return (
    <div className={`relative ${fullWidth ? 'w-full' : ''} ${bare ? 'tl-quickadd-bare' : ''} ${className}`}>
      <Input
        ref={inputRef}

        icon="plus"
        end={end}
        value={title}
        placeholder={placeholder}
        aria-label={label ?? (global ? '快速新增任務' : placeholder)}
        aria-describedby={msgId}
        aria-busy={pending > 0 || undefined}
        className="ui-input--keep-border"
        invalid={isError}
        onChange={(e) => {
          setTitle(e.target.value);
          if (notice?.kind === 'error') setNotice(null);
        }}
        onPaste={onPaste}
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
        {tooLong ? (
          <span style={{ color: 'var(--color-danger-text)' }}>標題不可超過 {TITLE_MAX} 字</span>
        ) : notice?.kind === 'error' ? (
          <span style={{ color: 'var(--color-danger-text)' }}>{notice.message}</span>
        ) : notice?.kind === 'outside' ? (
          <span className="tl-outside-notice">
            已建立，但不在目前篩選範圍 ·{' '}
            <button
              type="button"
              className="tl-linkbtn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => openTask(notice.id)}
            >
              開啟
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
