import { useEffect, useId, useRef, useState } from 'react';
import {
  PERSONAL_STATUS_LABEL,
  PERSONAL_STATUSES,
  type PersonalItem,
  type PersonalStatus,
} from '../../../shared/personal.ts';
import { isEditableTarget } from '../../lib/shortcuts.ts';
import { Button, Dialog, EmptyState, Input, Select, Skeleton, Textarea, UpdatedAt } from '../../ui/index.ts';
import type { TodoPatch } from './api.ts';
import { TodoStatusBadge } from './TodoStatus.tsx';

export type SaveCallbacks = { onSuccess?: () => void; onError?: () => void };
export type InspectorSave = (patch: Omit<TodoPatch, 'id'>, cb?: SaveCallbacks) => void;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function SaveHint({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  return (
    <span className="pl-save-state" aria-live="polite">
      {state === 'saving' && '儲存中…'}
      {state === 'saved' && '已儲存'}
      {state === 'error' && (
        <span className="pl-save-error">
          儲存失敗 ·{' '}
          <button type="button" className="pl-linkbtn" onClick={onRetry}>
            重試
          </button>
        </span>
      )}
    </span>
  );
}

/**
 * 失焦（或 Ctrl+Enter）儲存的文字欄位：顯示儲存狀態；他人更新（輪詢）在未編輯時同步；
 * 卸載（關閉 inspector / 切換待辦）時送出未存內容。
 */
function TextField({
  label,
  value,
  multiline,
  placeholder,
  readOnly,
  required,
  onCommit,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  placeholder?: string;
  readOnly: boolean;
  /** true：不可存成空白（標題） */
  required?: boolean;
  onCommit: (value: string, cb: SaveCallbacks) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [base, setBase] = useState(value);
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState<SaveState>('idle');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ draft, base });
  const commitRef = useRef(onCommit);
  useEffect(() => {
    latest.current = { draft, base };
    commitRef.current = onCommit;
  });

  if (value !== base && !focused && draft === base && state !== 'saving') {
    setBase(value);
    setDraft(value);
  }

  const save = () => {
    const next = required ? draft.trim() : draft;
    if (required && !next) {
      setDraft(base);
      return;
    }
    if (next === base) return;
    setState('saving');
    onCommit(next, {
      onSuccess: () => {
        setBase(next);
        setDraft((d) => (d === draft ? next : d));
        setState('saved');
      },
      onError: () => setState('error'),
    });
  };

  useEffect(
    () => () => {
      const { draft: d, base: b } = latest.current;
      const next = required ? d.trim() : d;
      if (next !== b && (!required || next)) commitRef.current(next, {});
    },
    [required],
  );

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(multiline && label === '細節' ? 120 : 56, el.scrollHeight)}px`;
  }, [draft, multiline, label]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (!multiline && !e.nativeEvent.isComposing))) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      (e.currentTarget as HTMLElement).blur();
    }
  };

  return (
    <div className="pl-insp-section">
      <div className="pl-insp-label">
        <span>{label}</span>
        {!readOnly && <SaveHint state={state} onRetry={save} />}
      </div>
      {readOnly ? (
        <p className="pl-insp-readonly">{value || <span className="pl-insp-empty">—</span>}</p>
      ) : multiline ? (
        <Textarea
          ref={areaRef}
          className="pl-insp-text"
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          onFocus={() => setFocused(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setFocused(false);
            save();
          }}
          onKeyDown={onKeyDown}
        />
      ) : (
        <Input
          value={draft}
          placeholder={placeholder}
          aria-label={label}
          invalid={required && !draft.trim()}
          onFocus={() => setFocused(true)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setFocused(false);
            save();
          }}
          onKeyDown={onKeyDown}
        />
      )}
    </div>
  );
}

/**
 * 自由待辦詳情 inspector：由網址 `?todo=<id>` 驅動，右側抽屜（樣式同任務詳情）。
 * 關閉：✕、Esc（編輯中的 Esc 先結束編輯）、移除 ?todo 或瀏覽器上一頁。唯讀（檢視他人清單）時只顯示內容。
 */
export function TodoInspector({
  item,
  loading,
  readOnly,
  deleting,
  onClose,
  onSave,
  onDelete,
}: {
  item: PersonalItem | undefined;
  loading: boolean;
  readOnly: boolean;
  deleting: boolean;
  onClose: () => void;
  onSave: InspectorSave;
  onDelete: (item: PersonalItem) => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isEditableTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  let body;
  if (item) {
    body = <InspectorBody item={item} titleId={titleId} readOnly={readOnly} onSave={onSave} />;
  } else if (loading) {
    body = (
      <div className="pl-insp-skeleton" aria-busy="true" aria-label="載入中">
        <Skeleton height={24} width="70%" />
        <Skeleton height={14} width="40%" />
        <Skeleton height={96} />
      </div>
    );
  } else {
    body = (
      <EmptyState
        title="找不到這筆待辦"
        description="它可能已被刪除"
        action={
          <Button variant="secondary" onClick={onClose}>
            關閉
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className="task-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="task-drawer pl-inspector"
        role="dialog"
        aria-modal="false"
        aria-labelledby={item ? titleId : undefined}
        aria-label={item ? undefined : '待辦詳情'}
        tabIndex={-1}
        style={{ outline: 'none' }}
      >
        <div className="task-drawer-head">
          <span className="task-drawer-id">{readOnly ? '待辦詳情（唯讀）' : '待辦詳情'}</span>
          <Button
            ref={closeRef}
            variant="ghost"
            size="sm"
            iconOnly
            icon="x"
            aria-label="關閉待辦詳情"
            onClick={onClose}
          />
        </div>
        <div className="task-drawer-body">{body}</div>
        {item && (
          <div className="task-drawer-foot pl-insp-foot">
            <div className="pl-insp-times">
              <UpdatedAt at={item.createdAt} prefix="建立於" />
              <UpdatedAt at={item.updatedAt} prefix="更新於" />
            </div>
            {!readOnly && (
              <Button
                variant="ghost"
                size="sm"
                className="pl-insp-delete"
                onClick={() => setConfirmDelete(true)}
              >
                刪除待辦
              </Button>
            )}
          </div>
        )}
      </aside>
      <Dialog
        open={confirmDelete && !!item}
        onClose={() => setConfirmDelete(false)}
        role="alertdialog"
        title={`刪除待辦「${item?.title ?? ''}」？`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} data-autofocus>
              取消
            </Button>
            <Button
              variant="danger"
              loading={deleting}
              onClick={() => {
                if (!item) return;
                setConfirmDelete(false);
                onDelete(item);
              }}
            >
              刪除
            </Button>
          </>
        }
      >
        <p className="m-0">刪除後可按 Ctrl+Z 復原。</p>
      </Dialog>
    </>
  );
}

function InspectorBody({
  item,
  titleId,
  readOnly,
  onSave,
}: {
  item: PersonalItem;
  titleId: string;
  readOnly: boolean;
  onSave: InspectorSave;
}) {
  const statusOptions = PERSONAL_STATUSES.map((s) => ({
    value: s,
    label: PERSONAL_STATUS_LABEL[s],
  }));
  return (
    <div className="pl-insp">
      <h2 id={titleId} className="sr-only">
        {item.title}
      </h2>
      <TextField
        label="標題"
        value={item.title}
        readOnly={readOnly}
        required
        onCommit={(title, cb) => onSave({ title }, cb)}
      />
      <div className="pl-insp-fields">
        <div className="pl-insp-field">
          <span className="pl-insp-label">狀態</span>
          {readOnly ? (
            <TodoStatusBadge status={item.status} />
          ) : (
            <Select<PersonalStatus>
              aria-label="狀態"
              options={statusOptions}
              value={item.status}
              renderValue={() => (
                <span className="pl-insp-status-value">
                  <TodoStatusBadge status={item.status} />
                </span>
              )}
              onChange={(status) => onSave({ status })}
            />
          )}
        </div>
        <div className="pl-insp-field">
          <span className="pl-insp-label">到期日</span>
          {readOnly ? (
            <span>{item.dueDate ?? '—'}</span>
          ) : (
            <span className="pl-insp-date">
              <Input
                type="date"
                aria-label="到期日"
                value={item.dueDate ?? ''}
                onChange={(e) => onSave({ dueDate: e.target.value || null })}
              />
              {item.dueDate && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="x"
                  aria-label="清除到期日"
                  onClick={() => onSave({ dueDate: null })}
                />
              )}
            </span>
          )}
        </div>
      </div>
      <TextField
        label="備註"
        value={item.note}
        multiline
        placeholder="一句話備註（會顯示在列表上）"
        readOnly={readOnly}
        onCommit={(note, cb) => onSave({ note }, cb)}
      />
      <TextField
        label="細節"
        value={item.detail}
        multiline
        placeholder="記錄細節…（失焦或 Ctrl+Enter 儲存）"
        readOnly={readOnly}
        onCommit={(detail, cb) => onSave({ detail }, cb)}
      />
    </div>
  );
}
