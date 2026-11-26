import { createElement, Fragment } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/compat';
import { useCurrentUser } from '../../lib/auth.js';
import { notifyError } from '../../lib/errorToast.js';
import { useProjects, useStatuses } from '../../lib/hooks.js';
import { openTask } from '../../lib/openTask.js';
import { GLOBAL_QUICKADD_ATTR } from '../../lib/shortcuts.js';
import { notifyTaskCreated } from '../../lib/toast.js';
import { useTaskFilters } from '../../lib/useTaskFilters.js';
import { Icon, Input, Kbd } from '../../ui/index.js';
import { useOptimisticCreate } from './data.js';
import { parseTitle, TITLE_MAX } from './model.js';

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
}) {
  const [title, setTitle] = useState('');
  const [focused, setFocused] = useState(false);
  const [notice, setNotice] = useState(null);
  const [pending, setPending] = useState(0);
  const [success, setSuccess] = useState(false);
  const create = useOptimisticCreate();
  const { filters } = useTaskFilters();
  const statuses = useStatuses().data;
  const projects = useProjects().data;
  const me = useCurrentUser();
  const inputRef = useRef(null);
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
    const input = {
      ...defaults,
      ...(projectId !== undefined && { projectId }),
      title: parsed.value,
    };
    const firstStatus = [...(statuses ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)[0];
    const firstProject = [...(projects ?? [])]
      .filter((p) => !p.isArchived)
      .sort((a, b) => a.sortOrder - b.sortOrder)[0];
    const now = Date.now();
    const temp = {
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
    const retry = () =>
      create(input, temp, filters).then(
        ({ task }) => notifyTaskCreated(task, openTask),
        (err) => notifyError(err, retry),
      );
    create(input, temp, filters)
      .then(({ task, matches }) => {
        setSuccess(true);
        // 建立成功由 toast 告知（連續新增時合併）；不在篩選範圍時另於輸入框下方提示
        setNotice(matches ? null : { kind: 'outside', id: task.id });
        notifyTaskCreated(task, openTask);
        onCreated?.(task);
      })
      .catch((err) => {
        // 失敗：暫時列已移除；還原輸入內容（若使用者尚未輸入新內容），再出現 toast
        setTitle((cur) => cur || typed);
        notifyError(err, retry);
      })
      .finally(() => setPending((n) => n - 1));
  };

  const onKeyDown = (e) => {
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

  const onPaste = (e) => {
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
  const end = success
    ? createElement(
        'span',
        { className: 'flex px-2', style: { color: 'var(--color-success)' } },
        createElement(Icon, { name: 'check' }),
      )
    : !focused && global
      ? createElement('span', { className: 'flex px-2' }, createElement(Kbd, null, 'N'))
      : null;

  return createElement(
    'div',
    { className: `relative ${fullWidth ? 'w-full' : ''} ${bare ? 'tl-quickadd-bare' : ''} ${className}` },
    createElement(Input, {
      ref: inputRef,

      icon: 'plus',
      end: end,
      value: title,
      placeholder: placeholder,
      'aria-label': label ?? (global ? '快速新增任務' : placeholder),
      'aria-describedby': msgId,
      'aria-busy': pending > 0 || undefined,
      className: 'ui-input--keep-border',
      invalid: isError,
      onChange: (e) => {
        setTitle(e.target.value);
        if (notice?.kind === 'error') setNotice(null);
      },
      onPaste: onPaste,
      onKeyDown: onKeyDown,
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      ...(global ? { [GLOBAL_QUICKADD_ATTR]: '' } : {}),
    }),
    createElement(
      'div',
      {
        id: msgId,
        'aria-live': 'polite',
        className: 'absolute left-0 top-full mt-1 text-xs whitespace-nowrap',
        style: { zIndex: 'var(--z-popover)' },
      },
      tooLong
        ? createElement(
            'span',
            { style: { color: 'var(--color-danger-text)' } },
            '標題不可超過 ',
            TITLE_MAX,
            ' 字',
          )
        : notice?.kind === 'error'
          ? createElement('span', { style: { color: 'var(--color-danger-text)' } }, notice.message)
          : notice?.kind === 'outside'
            ? createElement(
                'span',
                { className: 'tl-outside-notice' },
                '已建立，但不在目前篩選範圍 ·',
                ' ',
                createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'tl-linkbtn',
                    onMouseDown: (e) => e.preventDefault(),
                    onClick: () => openTask(notice.id),
                  },
                  '開啟',
                ),
              )
            : null,
    ),
  );
}
