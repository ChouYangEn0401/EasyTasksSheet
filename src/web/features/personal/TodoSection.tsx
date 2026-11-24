import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
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
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { sortOrderForMove, type PersonalItem } from '../../../shared/personal.ts';
import { isEditableTarget, shortcutsSuspended, suspendGlobalShortcuts } from '../../lib/shortcuts.ts';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  Spinner,
  Textarea,
  UpdatedAt,
} from '../../ui/index.ts';
import {
  useClearDoneTodos,
  useCreateTodo,
  useDeleteTodo,
  useTodos,
  useUpdateTodo,
  type TodoPatch,
} from './api.ts';
import { GripIcon, PencilIcon } from './icons.tsx';
import { announce } from './model.ts';
import { SectionCard, SkeletonRows } from './TaskSections.tsx';

const SAVE_FAILED = '儲存失敗，請再試一次';
const ROW_SELECTOR = '[data-todo-id]';

/* ── 新增列 ─────────────────────── */

function AddTodo({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const [value, setValue] = useState('');
  const create = useCreateTodo();
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const title = value.trim();
    if (!title || create.isPending) return;
    setError(null);
    create.mutate(
      { title },
      {
        onSuccess: () => setValue(''),
        onError: () => setError('新增失敗，請再試一次'),
      },
    );
  };

  return (
    <div className="pl-add">
      <Input
        ref={inputRef}
        icon="plus"
        value={value}
        placeholder="新增待辦，按 Enter 建立"
        aria-label="新增待辦"
        readOnly={create.isPending}
        invalid={!!error}
        end={create.isPending ? <Spinner size={14} /> : null}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === 'Escape') {
            setValue('');
            setError(null);
            e.currentTarget.blur();
          }
        }}
      />
      {error && (
        <p className="pl-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/* ── 待辦列 ─────────────────────── */

type RowActions = {
  readOnly: boolean;
  onSave: (patch: TodoPatch, onError: () => void) => void;
  onDelete: (item: PersonalItem) => void;
  onMoveBy: (item: PersonalItem, delta: -1 | 1) => void;
};

function TodoRowContent({
  item,
  readOnly,
  onSave,
  onDelete,
  handle,
}: Omit<RowActions, 'onMoveBy'> & { item: PersonalItem; handle?: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(item.note);
  const [failed, setFailed] = useState(false);
  const done = useRef(false);
  const titleBtn = useRef<HTMLButtonElement>(null);

  const save = (patch: Omit<TodoPatch, 'id'>) => {
    setFailed(false);
    onSave({ id: item.id, ...patch }, () => setFailed(true));
  };

  const startEdit = () => {
    if (readOnly) return;
    done.current = false;
    setDraft(item.title);
    setEditing(true);
  };
  const finishEdit = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const title = draft.trim();
    if (commit && title && title !== item.title) save({ title });
    requestAnimationFrame(() => titleBtn.current?.focus());
  };

  const openNote = () => {
    setNoteDraft(item.note);
    setNoteOpen(true);
  };
  const closeNote = () => {
    setNoteOpen(false);
    if (noteDraft !== item.note) save({ note: noteDraft });
  };

  return (
    <>
      <div className="pl-todo-line">
        {handle}
        <Checkbox
          checked={item.isDone}
          disabled={readOnly}
          aria-label={`${item.isDone ? '標為未完成' : '標為完成'}：${item.title}`}
          onChange={(e) => save({ isDone: e.target.checked })}
        />
        {editing ? (
          <Input
            size="sm"
            autoFocus
            value={draft}
            aria-label="待辦標題"
            wrapperClassName="pl-todo-edit"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => finishEdit(true)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                finishEdit(true);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                finishEdit(false);
              }
            }}
          />
        ) : readOnly ? (
          <span className="pl-todo-title">{item.title}</span>
        ) : (
          <button
            ref={titleBtn}
            type="button"
            className="pl-todo-title pl-todo-title--btn"
            aria-label={`編輯待辦：${item.title}`}
            onClick={startEdit}
          >
            {item.title}
          </button>
        )}
        <span className="pl-todo-updated">
          <UpdatedAt at={item.updatedAt} />
        </span>
        {!readOnly && (
          <span className="pl-todo-actions">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<PencilIcon />}
              aria-label={`備註：${item.title}`}
              aria-expanded={noteOpen}
              onClick={() => (noteOpen ? closeNote() : openNote())}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="x"
              aria-label={`刪除待辦：${item.title}`}
              onClick={() => onDelete(item)}
            />
          </span>
        )}
      </div>
      {noteOpen && !readOnly ? (
        <Textarea
          className="pl-todo-note-input"
          rows={2}
          autoFocus
          value={noteDraft}
          aria-label={`備註：${item.title}`}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={closeNote}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
              setNoteDraft(item.note);
              setNoteOpen(false);
            }
          }}
        />
      ) : (
        item.note && <p className="pl-todo-note">{item.note}</p>
      )}
      {failed && (
        <p className="pl-field-error" role="alert">
          {SAVE_FAILED}
        </p>
      )}
    </>
  );
}

function SortableTodoRow({
  item,
  readOnly,
  onSave,
  onDelete,
  onMoveBy,
}: RowActions & { item: PersonalItem }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: readOnly });

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (readOnly || isEditableTarget(e.target)) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      e.stopPropagation();
      onMoveBy(item, e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      e.stopPropagation();
      onDelete(item);
    }
  };

  const handle = readOnly ? null : (
    <button
      ref={setActivatorNodeRef}
      type="button"
      className="pl-todo-handle"
      aria-label={`拖曳排序：${item.title}`}
      {...attributes}
      {...listeners}
    >
      <GripIcon />
    </button>
  );

  return (
    <li
      ref={setNodeRef}
      data-todo-id={item.id}
      className={`pl-todo-row${isDragging ? ' is-placeholder' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      onKeyDown={onKeyDown}
    >
      <TodoRowContent item={item} readOnly={readOnly} onSave={onSave} onDelete={onDelete} handle={handle} />
    </li>
  );
}

function DoneTodoRow({ item, readOnly, onSave, onDelete }: RowActions & { item: PersonalItem }) {
  return (
    <li
      data-todo-id={item.id}
      className="pl-todo-row is-done"
      onKeyDown={(e) => {
        if (!readOnly && e.key === 'Delete' && !isEditableTarget(e.target)) {
          e.preventDefault();
          onDelete(item);
        }
      }}
    >
      <TodoRowContent item={item} readOnly={readOnly} onSave={onSave} onDelete={onDelete} />
    </li>
  );
}

/** ↑ ↓：移到相鄰列的同一種控制項（找不到則該列第一個可聚焦元素） */
function onListArrowKeys(e: KeyboardEvent<HTMLElement>, dragging: boolean) {
  if (dragging || e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  if (isEditableTarget(e.target)) return;
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>(ROW_SELECTOR);
  if (!row) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
  const next = rows[rows.indexOf(row) + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  const same = [...row.querySelectorAll<HTMLElement>('button, input')].indexOf(target);
  const candidates = [...next.querySelectorAll<HTMLElement>('button, input')];
  (candidates[same] ?? candidates[0])?.focus();
}

/* ── 區塊 ─────────────────────── */

export function TodoSection({
  userId,
  readOnly,
  text,
}: {
  userId: number;
  readOnly: boolean;
  text: { title: string; empty: string; emptyDesc?: string };
}) {
  const q = useTodos(userId);
  const update = useUpdateTodo();
  const del = useDeleteTodo();
  const clear = useClearDoneTodos();
  const addRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [showDone, setShowDone] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [live, setLive] = useState('');
  const resumeShortcuts = useRef<(() => void) | null>(null);

  const items = q.data;
  const open = items?.filter((i) => !i.isDone) ?? [];
  const done = items?.filter((i) => i.isDone) ?? [];
  const active = activeId != null ? open.find((i) => i.id === activeId) : undefined;

  // C：聚焦新增列（focus 在輸入框時、唯讀檢視、有對話框時不觸發）
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'c' && e.key !== 'C') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isEditableTarget(e.target) || shortcutsSuspended() || document.querySelector('dialog[open]'))
        return;
      e.preventDefault();
      addRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly]);

  useEffect(() => () => resumeShortcuts.current?.(), []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onSave = (patch: TodoPatch, onError: () => void) => {
    setActionError(null);
    update.mutate(patch, { onError });
  };

  const moveTo = (item: PersonalItem, to: number) => {
    const from = open.findIndex((i) => i.id === item.id);
    if (from < 0 || to < 0 || to >= open.length || from === to) return;
    onSave({ id: item.id, sortOrder: sortOrderForMove(open, from, to) }, () =>
      setActionError('排序儲存失敗，請再試一次'),
    );
  };

  const onMoveBy = (item: PersonalItem, delta: -1 | 1) => {
    const from = open.findIndex((i) => i.id === item.id);
    const to = from + delta;
    if (to < 0 || to >= open.length) return;
    moveTo(item, to);
    setLive(announce.move(to + 1));
    // 列重新排序後讓 focus 留在原本的控制項上
    const focused = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => focused?.focus());
  };

  const onDelete = (item: PersonalItem) => {
    // 刪除後 focus 移到下一列（沒有則上一列，該區已空則新增列 / 區塊標題）
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? [])];
    const idx = rows.findIndex((r) => r.dataset.todoId === String(item.id));
    const nextRow = rows[idx + 1] ?? rows[idx - 1];
    const nextId = nextRow?.dataset.todoId;
    setActionError(null);
    del.mutate(item.id, { onError: () => setActionError('刪除失敗，請再試一次') });
    requestAnimationFrame(() => {
      const el = nextId
        ? listRef.current?.querySelector<HTMLElement>(`[data-todo-id="${nextId}"] .pl-todo-title--btn`)
        : null;
      if (el) el.focus();
      else if (addRef.current) addRef.current.focus();
      else document.getElementById('pl-todos-title')?.focus();
    });
  };

  const announcements: Announcements = {
    onDragStart: ({ active: a }) => {
      const i = open.findIndex((x) => x.id === a.id);
      return announce.pickup(open[i]?.title ?? '', i + 1, open.length);
    },
    onDragOver: ({ over }) => {
      if (!over) return undefined;
      return announce.move(open.findIndex((x) => x.id === over.id) + 1);
    },
    onDragEnd: ({ over }) =>
      over ? announce.drop(open.findIndex((x) => x.id === over.id) + 1) : announce.cancel(),
    onDragCancel: () => announce.cancel(),
  };

  const endDrag = () => {
    setActiveId(null);
    resumeShortcuts.current?.();
    resumeShortcuts.current = null;
  };

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(Number(e.active.id));
    resumeShortcuts.current = suspendGlobalShortcuts();
  };

  const onDragEnd = (e: DragEndEvent) => {
    endDrag();
    if (!e.over || e.active.id === e.over.id) return;
    const item = open.find((i) => i.id === e.active.id);
    const to = open.findIndex((i) => i.id === e.over!.id);
    if (item) moveTo(item, to);
  };

  const rowProps = { readOnly, onSave, onDelete, onMoveBy };

  let body: ReactNode;
  if (!items && q.isError) body = <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  else if (!items) body = <SkeletonRows />;
  else if (items.length === 0)
    body = <EmptyState icon="listCheck" title={text.empty} description={text.emptyDesc} />;
  else
    body = (
      <div ref={listRef} onKeyDown={(e) => onListArrowKeys(e, activeId != null)}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable: '按空白鍵拿起，↑ ↓ 移動，再按空白鍵放下，Esc 取消。',
            },
          }}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={endDrag}
        >
          <SortableContext items={open.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            <ul className="pl-todo-list" aria-label={text.title}>
              {open.map((item) => (
                <SortableTodoRow key={item.id} item={item} {...rowProps} />
              ))}
            </ul>
          </SortableContext>
          <DragOverlay>
            {active ? (
              <div className="pl-todo-row is-overlay" aria-hidden="true">
                <TodoRowContent
                  item={active}
                  readOnly
                  onSave={() => undefined}
                  onDelete={() => undefined}
                  handle={
                    <span className="pl-todo-handle">
                      <GripIcon />
                    </span>
                  }
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
        {done.length > 0 && (
          <div className="pl-done">
            <div className="pl-done-head">
              <button
                type="button"
                className="pl-done-toggle"
                aria-expanded={showDone}
                onClick={() => setShowDone((v) => !v)}
              >
                <Icon name={showDone ? 'chevronDown' : 'chevronRight'} />
                已完成 {done.length}
              </button>
              {!readOnly && (
                <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
                  清除已完成
                </Button>
              )}
            </div>
            {showDone && (
              <ul className="pl-todo-list" aria-label="已完成">
                {done.map((item) => (
                  <DoneTodoRow key={item.id} item={item} {...rowProps} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );

  return (
    <SectionCard
      id="pl-todos-title"
      title={text.title}
      count={items ? open.length : null}
      className="pl-card--todos"
    >
      {!readOnly && <AddTodo inputRef={addRef} />}
      {body}
      {actionError && (
        <p className="pl-field-error pl-section-error" role="alert">
          {actionError}
        </p>
      )}
      <div className="sr-only" aria-live="assertive">
        {live}
      </div>
      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title={`刪除 ${done.length} 筆已完成的待辦？`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmClear(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={clear.isPending}
              onClick={() =>
                clear.mutate(undefined, {
                  onSuccess: () => setConfirmClear(false),
                  onError: () => {
                    setConfirmClear(false);
                    setActionError('清除失敗，請再試一次');
                  },
                })
              }
            >
              刪除
            </Button>
          </>
        }
      />
    </SectionCard>
  );
}
