import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCan } from '../../lib/permissions.ts';
import { suspendGlobalShortcuts } from '../../lib/shortcuts.ts';
import { toast } from '../../lib/toast.ts';
import { Button, Checkbox, Dialog, Icon, Input, Skeleton } from '../../ui/index.ts';
import { useChecklist, useChecklistActions } from './checklistData.ts';
import {
  recordChecklistAdd,
  recordChecklistDelete,
  recordChecklistToggle,
  undoFromToast,
} from '../undo/linkUndo.ts';
import {
  MAX_PER_TASK,
  MAX_TEXT,
  parseChecklistText,
  pasteSummary,
  progressOfItems,
  shouldSplitPaste,
  sortOrderAfter,
  sortOrderForMove,
  type ChecklistItem,
  type ParseResult,
} from './checklistModel.ts';
import './checklist.css';

const ROW = '[data-checklist-row]';

type RowActions = {
  readOnly: boolean;
  onToggle: (item: ChecklistItem, isDone: boolean) => void;
  onRename: (item: ChecklistItem, text: string) => void;
  onInsertBelow: (item: ChecklistItem) => void;
  onDelete: (item: ChecklistItem, focusPrev?: boolean) => void;
  onMove: (item: ChecklistItem, delta: -1 | 1) => void;
  onPaste: (text: string) => void;
};

/* ── 列內容（顯示 / 就地編輯） ─────────────────────── */

function RowBody({ item, handle, ...a }: RowActions & { item: ChecklistItem; handle?: ReactNode }) {
  const { readOnly } = a;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLButtonElement>(null);
  const finished = useRef(false);
  const temp = item.id < 0;

  const startEdit = () => {
    if (readOnly || temp) return;
    finished.current = false;
    setDraft(item.text);
    setEditing(true);
  };

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const finish = (commit: boolean, refocus = true) => {
    if (finished.current) return;
    finished.current = true;
    const text = draft.trim();
    setEditing(false);
    if (commit && text && text !== item.text) a.onRename(item, text);
    if (refocus) requestAnimationFrame(() => textRef.current?.focus());
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const hasText = draft.trim() !== '';
      finish(true, !hasText);
      if (hasText) a.onInsertBelow(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    } else if (e.key === 'Backspace' && draft === '') {
      e.preventDefault();
      finished.current = true;
      setEditing(false);
      a.onDelete(item, true);
    }
  };

  return (
    <div className="cl-row-main">
      {handle ?? <span className="cl-handle-gap" aria-hidden="true" />}
      <Checkbox
        checked={item.isDone}
        disabled={readOnly || temp}
        aria-label={`${item.isDone ? '標為未完成' : '標為完成'}：${item.text}`}
        onChange={(e) => a.onToggle(item, e.target.checked)}
      />
      {editing ? (
        <input
          ref={inputRef}
          className="cl-input"
          value={draft}
          maxLength={MAX_TEXT}
          aria-label={`編輯待辦：${item.text}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onInputKey}
          onBlur={() => finish(true, false)}
          onPaste={(e) => interceptPaste(e, a.onPaste)}
        />
      ) : (
        <button
          ref={textRef}
          type="button"
          className="cl-text"
          aria-label={readOnly ? item.text : `編輯待辦：${item.text}`}
          onClick={startEdit}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault();
              startEdit();
            }
          }}
        >
          {item.text}
        </button>
      )}
      {!readOnly && !temp && (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="x"
          className="cl-del"
          aria-label={`刪除待辦：${item.text}`}
          onClick={() => a.onDelete(item)}
        />
      )}
    </div>
  );
}

/** 多行貼上：攔截並交給上層確認（單行貼上維持瀏覽器預設） */
function interceptPaste(e: ClipboardEvent<HTMLInputElement>, onPaste: (text: string) => void) {
  const text = e.clipboardData.getData('text/plain');
  if (!shouldSplitPaste(text)) return;
  e.preventDefault();
  onPaste(text);
}

function rowKeyDown(e: KeyboardEvent<HTMLLIElement>, item: ChecklistItem, a: RowActions) {
  if (a.readOnly) return;
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    e.stopPropagation();
    a.onMove(item, e.key === 'ArrowUp' ? -1 : 1);
  } else if (e.key === 'Delete' && (e.target as HTMLElement).closest('button.cl-text, .cl-handle')) {
    e.preventDefault();
    e.stopPropagation();
    a.onDelete(item);
  }
}

function rowClass(item: ChecklistItem, extra = '') {
  return `cl-row${item.isDone ? ' is-done' : ''}${item.id < 0 ? ' is-temp' : ''}${extra}`;
}

function SortableRow({ item, ...a }: RowActions & { item: ChecklistItem }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: a.readOnly || item.id < 0 });
  const handle = a.readOnly ? null : (
    <button
      ref={setActivatorNodeRef}
      type="button"
      className="cl-handle"
      aria-label={`拖曳排序：${item.text}（或按 Alt 加上下方向鍵）`}
      {...attributes}
      {...listeners}
    >
      <Icon name="grip" size={14} />
    </button>
  );
  return (
    <li
      ref={setNodeRef}
      data-checklist-row={item.id}
      className={rowClass(item, isDragging ? ' is-placeholder' : '')}
      style={{ transform: CSS.Translate.toString(transform ? { ...transform, x: 0 } : null), transition }}
      onKeyDown={(e) => rowKeyDown(e, item, a)}
    >
      <RowBody item={item} handle={handle} {...a} />
    </li>
  );
}

function StaticRow({ item, ...a }: RowActions & { item: ChecklistItem }) {
  return (
    <li data-checklist-row={item.id} className={rowClass(item)} onKeyDown={(e) => rowKeyDown(e, item, a)}>
      <RowBody item={item} {...a} />
    </li>
  );
}

/* ── 「Enter 後在下方新增下一項」的草稿列 ─────────────────────── */

function DraftRow({
  onCommit,
  onClose,
  onPaste,
}: {
  onCommit: (text: string, keepGoing: boolean) => void;
  onClose: () => void;
  onPaste: (text: string) => void;
}) {
  const [value, setValue] = useState('');
  const finished = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const done = (text: string, keepGoing: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (text) onCommit(text, keepGoing);
    else onClose();
  };
  return (
    <li className="cl-row cl-row--draft" data-checklist-draft>
      <span className="cl-handle-gap" aria-hidden="true" />
      <Checkbox disabled aria-hidden="true" tabIndex={-1} />
      <input
        ref={ref}
        className="cl-input"
        value={value}
        maxLength={MAX_TEXT}
        placeholder="輸入待辦，Enter 繼續新增，Esc 結束"
        aria-label="新增下一項待辦"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            done(value.trim(), true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            done('', false);
          } else if (e.key === 'Backspace' && value === '') {
            e.preventDefault();
            done('', false);
          }
        }}
        onBlur={() => done(value.trim(), false)}
        onPaste={(e) => interceptPaste(e, onPaste)}
      />
    </li>
  );
}

/* ── 貼上確認 ─────────────────────── */

function PasteConfirm({
  result,
  existing,
  onConfirm,
  onCancel,
}: {
  result: ParseResult;
  existing: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const over = existing + result.items.length > MAX_PER_TASK;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, []);
  return (
    <div
      ref={ref}
      className="cl-paste"
      role="group"
      aria-label="貼上待辦確認"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="cl-paste-title" role="status">
        {pasteSummary(result)}
      </div>
      <ul className="cl-paste-list">
        {result.items.slice(0, 5).map((it, i) => (
          <li key={i}>
            <span aria-hidden="true">{it.isDone ? '☑' : '☐'}</span>
            <span>{it.text}</span>
          </li>
        ))}
        {result.items.length > 5 && <li>…還有 {result.items.length - 5} 項</li>}
      </ul>
      {result.overflow > 0 && (
        <p className="cl-paste-note">一次最多建立 100 項，另有 {result.overflow} 行未納入。</p>
      )}
      {result.trimmed > 0 && <p className="cl-paste-note">有 {result.trimmed} 項超過 500 字，已截斷。</p>}
      {over && (
        <p className="cl-paste-note is-error" role="alert">
          每個任務最多 {MAX_PER_TASK} 項待辦，無法再加入這麼多。
        </p>
      )}
      <div className="cl-paste-actions">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button size="sm" disabled={over} onClick={onConfirm} data-autofocus>
          建立 {result.items.length} 項
        </Button>
      </div>
    </div>
  );
}

/* ── 新增列 ─────────────────────── */

function AddRow({
  disabled,
  onAdd,
  onPaste,
}: {
  disabled: boolean;
  onAdd: (text: string) => void;
  onPaste: (text: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <Input
      icon="plus"
      size="sm"
      value={value}
      maxLength={MAX_TEXT}
      disabled={disabled}
      placeholder="新增待辦…"
      aria-label="新增待辦"
      data-checklist-add
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          const text = value.trim();
          if (text) {
            onAdd(text);
            setValue('');
          }
        } else if (e.key === 'Escape' && value) {
          e.preventDefault();
          e.stopPropagation();
          setValue('');
        }
      }}
      onPaste={(e) => interceptPaste(e, onPaste)}
    />
  );
}

/* ── 區塊 ─────────────────────── */

export function Checklist({ taskId }: { taskId: number }) {
  const q = useChecklist(taskId);
  const { add, patch, remove, clearDone } = useChecklistActions(taskId);
  const qc = useQueryClient();
  const canEdit = useCan('tasks.edit');
  const readOnly = !canEdit;
  const titleId = useId();
  const [draft, setDraft] = useState<{ afterOrder: number | null } | null>(null);
  const [pending, setPending] = useState<ParseResult | null>(null);
  const [showDone, setShowDone] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [live, setLive] = useState('');
  const rootRef = useRef<HTMLElement>(null);
  const resume = useRef<(() => void) | null>(null);
  useEffect(() => () => resume.current?.(), []);

  const items = q.data;
  const all = items ?? [];
  const open = all.filter((i) => !i.isDone);
  const done = all.filter((i) => i.isDone);
  const progress = progressOfItems(all);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /* 動作 */
  const onToggle = (item: ChecklistItem, isDone: boolean) =>
    patch.mutate(
      { id: item.id, patch: { isDone } },
      { onSuccess: () => void recordChecklistToggle(qc, taskId, item, isDone) },
    );
  const onRename = (item: ChecklistItem, text: string) => patch.mutate({ id: item.id, patch: { text } });

  const focusRowText = (id: string | undefined) => {
    requestAnimationFrame(() => {
      const el = id
        ? rootRef.current?.querySelector<HTMLElement>(`[data-checklist-row="${id}"] .cl-text`)
        : rootRef.current?.querySelector<HTMLElement>(
            '[data-checklist-add] input, input[data-checklist-add]',
          );
      el?.focus();
    });
  };

  const onDelete = (item: ChecklistItem, focusPrev = false) => {
    const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>(ROW) ?? [])];
    const idx = rows.findIndex((r) => r.dataset.checklistRow === String(item.id));
    const target = (focusPrev ? rows[idx - 1] : (rows[idx + 1] ?? rows[idx - 1]))?.dataset.checklistRow;
    remove.mutate(item.id, { onSuccess: () => void recordChecklistDelete(qc, taskId, item) });
    focusRowText(target);
  };

  const moveTo = (item: ChecklistItem, to: number) => {
    const from = open.findIndex((i) => i.id === item.id);
    if (from < 0 || to < 0 || to >= open.length || from === to) return;
    patch.mutate({ id: item.id, patch: { sortOrder: sortOrderForMove(open, from, to) } });
  };

  const onMove = (item: ChecklistItem, delta: -1 | 1) => {
    if (item.isDone) return;
    const from = open.findIndex((i) => i.id === item.id);
    const to = from + delta;
    if (to < 0 || to >= open.length) return;
    moveTo(item, to);
    setLive(`已移到第 ${to + 1} 項，共 ${open.length} 項`);
    const focused = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => focused?.focus());
  };

  const addOne = (text: string, sortOrder?: number) =>
    add.mutate(
      { items: [{ text }], sortOrder },
      { onSuccess: (created) => void recordChecklistAdd(qc, taskId, created) },
    );

  const onInsertBelow = (item: ChecklistItem) => setDraft({ afterOrder: item.sortOrder });

  const commitDraft = (text: string, keepGoing: boolean) => {
    const order = sortOrderAfter(all, draft?.afterOrder ?? null);
    addOne(text, order);
    setDraft(keepGoing ? { afterOrder: order } : null);
  };

  const askPaste = (text: string) => {
    setDraft(null);
    const r = parseChecklistText(text);
    if (r.items.length > 0) setPending(r);
  };

  const confirmPaste = () => {
    if (!pending) return;
    const batch = pending.items;
    setPending(null);
    add.mutate(
      { items: batch },
      {
        onSuccess: (created) => {
          // 同時登記到全站復原堆疊（Ctrl+Z）；toast 的「復原」走同一筆
          const entry = recordChecklistAdd(qc, taskId, created);
          toast({
            key: 'checklist-pasted',
            tone: 'success',
            title: `已建立 ${created.length} 項待辦`,
            action: {
              label: '復原',
              onClick: () =>
                entry
                  ? undoFromToast(entry)
                  : void Promise.all(created.map((c) => remove.mutateAsync(c.id).catch(() => undefined))),
            },
            duration: 8000,
          });
          focusRowText(undefined);
        },
      },
    );
  };

  /* 拖曳 */
  const onDragStart = (_e: DragStartEvent) => {
    resume.current = suspendGlobalShortcuts();
  };
  const endDrag = () => {
    resume.current?.();
    resume.current = null;
  };
  const onDragEnd = (e: DragEndEvent) => {
    endDrag();
    if (!e.over || e.active.id === e.over.id) return;
    const item = open.find((i) => i.id === e.active.id);
    const to = open.findIndex((i) => i.id === e.over!.id);
    if (item) {
      moveTo(item, to);
      setLive(`已移到第 ${to + 1} 項，共 ${open.length} 項`);
    }
  };

  const rowActions: RowActions = {
    readOnly,
    onToggle,
    onRename,
    onInsertBelow,
    onDelete,
    onMove,
    onPaste: askPaste,
  };

  /* 開放項目（含草稿列的插入位置） */
  const openRows: ReactNode[] = [];
  let draftPlaced = false;
  const renderDraft = () => (
    <DraftRow
      key={`draft-${draft?.afterOrder}`}
      onCommit={commitDraft}
      onClose={() => setDraft(null)}
      onPaste={askPaste}
    />
  );
  for (const item of open) {
    if (draft && !draftPlaced && draft.afterOrder != null && item.sortOrder > draft.afterOrder) {
      openRows.push(renderDraft());
      draftPlaced = true;
    }
    openRows.push(<SortableRow key={item.id} item={item} {...rowActions} />);
  }
  if (draft && !draftPlaced) openRows.push(renderDraft());

  let body: ReactNode;
  if (!items && q.isError)
    body = (
      <div className="cl-error" role="alert">
        <span>無法載入待辦清單</span>
        <Button variant="ghost" size="sm" onClick={() => void q.refetch()}>
          重試
        </Button>
      </div>
    );
  else if (!items)
    body = (
      <div className="cl-skeleton" aria-busy="true" aria-label="載入待辦清單">
        <Skeleton height={16} width="70%" />
        <Skeleton height={16} width="50%" />
      </div>
    );
  else
    body = (
      <>
        {all.length === 0 && !draft && (
          <p className="cl-empty">
            {readOnly
              ? '這個任務還沒有待辦項目'
              : '把工作拆成小步驟，逐項勾選。可在下方輸入，或貼上多行文字快速建立。'}
          </p>
        )}
        {(open.length > 0 || draft) && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            accessibility={{
              screenReaderInstructions: {
                draggable: '按空白鍵拿起，↑ ↓ 移動，再按空白鍵放下，Esc 取消。',
              },
            }}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={endDrag}
          >
            <SortableContext items={open.map((i) => i.id)} strategy={verticalListSortingStrategy}>
              <ul className="cl-list" aria-label="待辦項目">
                {openRows}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        {done.length > 0 && (
          <>
            <button
              type="button"
              className="cl-done-toggle"
              aria-expanded={showDone}
              onClick={() => setShowDone((v) => !v)}
            >
              <Icon name={showDone ? 'chevronDown' : 'chevronRight'} size={14} />
              已完成 {done.length} 項
            </button>
            {showDone && (
              <ul className="cl-list" aria-label="已完成的待辦">
                {done.map((item) => (
                  <StaticRow key={item.id} item={item} {...rowActions} />
                ))}
              </ul>
            )}
          </>
        )}
      </>
    );

  return (
    <section
      ref={rootRef}
      className="task-drawer-section cl"
      aria-labelledby={titleId}
      data-testid="checklist"
    >
      <div className="cl-head">
        <span id={titleId}>待辦清單</span>
        {progress.total > 0 && (
          <span className="cl-count" data-testid="checklist-progress">
            {progress.done} / {progress.total}
          </span>
        )}
        <span className="cl-head-end">
          {progress.complete && (
            <span className="cl-complete" role="status">
              <Icon name="checkCircle" size={14} />
              全部完成
            </span>
          )}
          {!readOnly && done.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
              清除已完成
            </Button>
          )}
        </span>
      </div>
      {progress.total > 0 && (
        <div
          className={`cl-bar${progress.complete ? ' is-complete' : ''}`}
          role="progressbar"
          aria-label="待辦清單進度"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-valuetext={`${progress.done} / ${progress.total} 完成`}
        >
          <span style={{ width: `${progress.percent}%` }} />
        </div>
      )}
      {body}
      {pending && (
        <PasteConfirm
          result={pending}
          existing={all.length}
          onConfirm={confirmPaste}
          onCancel={() => {
            setPending(null);
            focusRowText(undefined);
          }}
        />
      )}
      {!readOnly && items && (
        <AddRow disabled={all.length >= MAX_PER_TASK} onAdd={(text) => addOne(text)} onPaste={askPaste} />
      )}
      <div className="sr-only" aria-live="polite">
        {live}
      </div>
      {confirmClear && (
        <ClearDoneDialog
          count={done.length}
          loading={clearDone.isPending}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            clearDone.mutate();
          }}
        />
      )}
    </section>
  );
}

function ClearDoneDialog({
  count,
  loading,
  onCancel,
  onConfirm,
}: {
  count: number;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onCancel}
      role="alertdialog"
      title={`清除 ${count} 項已完成的待辦？`}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel} data-autofocus>
            取消
          </Button>
          <Button variant="danger" loading={loading} onClick={onConfirm}>
            清除
          </Button>
        </>
      }
    >
      <p className="m-0">清除後無法復原。</p>
    </Dialog>
  );
}
