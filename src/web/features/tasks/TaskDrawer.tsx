import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { Task } from '../../../shared/tasks.ts';
import { ApiError } from '../../lib/api.ts';
import { useCurrentUser } from '../../lib/auth.ts';
import { useCan } from '../../lib/permissions.ts';
import { useProperties, useTask, useUsersById } from '../../lib/hooks.ts';
import { fxAttr, motionMs, prefersReducedMotion, useItemFx, type ItemFx } from '../../lib/motion.ts';
import { closeTask, readTaskParam } from '../../lib/openTask.ts';
import { noticeText, useRemoteTaskChanges } from '../../lib/remoteNotice.ts';
import { isEditableTarget } from '../../lib/shortcuts.ts';
import { notifySuccess, quoteName, truncate } from '../../lib/toast.ts';
import { useTaskFilters } from '../../lib/useTaskFilters.ts';
import {
  Alert,
  Avatar,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Menu,
  Skeleton,
  Textarea,
  UpdatedAt,
} from '../../ui/index.ts';
import { TaskHistorySection } from '../audit/TaskHistorySection.tsx';
import { PinButton } from '../personal/PinButton.tsx';
import { DependenciesSection } from '../delay-link/DependenciesSection.tsx';
import { TaskPresenceHint } from '../presence/TaskPresence.tsx';
import { reportEditing } from '../../lib/presence.ts';
import { useDeleteTaskOptimistic, useOptimisticUpdate } from './data.ts';
import { DrawerActiveContext } from './drawerActive.ts';
import { backTargetFor, consumeTitleFocus, goBackFrom } from './drawerNav.ts';
import { DuplicateDialog } from './DuplicateDialog.tsx';
import { RelatedTasks } from './RelatedTasks.tsx';
import { DescriptionLockBanner, DescriptionLockButton } from './DescriptionLock.tsx';
import { DiscussionSection } from './DiscussionSection.tsx';
import { EditableField, type EditState } from './EditableField.tsx';
import type { FieldCol } from './fields.tsx';
import { Checklist } from './Checklist.tsx';
import { applicableProperties, propertyColumn } from './model.ts';
import { Popover } from './Popover.tsx';
import { NewPropertyForm } from './PropertyPanel.tsx';
import './tasks.css';

/**
 * 插槽：任務詳情抽屜（T1 升級為可編輯）。
 * 由網址 `?task=<id>` 驅動（以 openTask(id) 開啟）；由 AppShell 全域掛載，任何頁面皆可開啟。
 * 關閉：✕、Esc（編輯中的 Esc 優先取消編輯）、移除 ?task 或瀏覽器上一頁。
 */
export function TaskDrawer() {
  const [sp] = useSearchParams();
  const id = readTaskParam(sp);
  // 關閉時保留最後一個面板播放離場動畫（reduced motion 時直接移除）
  const [lastId, setLastId] = useState(id);
  const [closing, setClosing] = useState<number | null>(null);
  if (id !== lastId) {
    setLastId(id);
    setClosing(id == null && lastId != null && !prefersReducedMotion() ? lastId : null);
  }
  useEffect(() => {
    if (closing == null) return;
    const t = window.setTimeout(() => setClosing(null), motionMs('--duration-exit'));
    return () => window.clearTimeout(t);
  }, [closing]);
  if (id != null) return <TaskDrawerPanel key={id} id={id} />;
  if (closing != null) return <TaskDrawerPanel key={closing} id={closing} leaving />;
  return null;
}

const FIELDS: FieldCol[] = [
  { key: 'assignee', label: '負責人', kind: 'assignee' },
  { key: 'project', label: '專案', kind: 'project' },
  { key: 'priority', label: '優先度', kind: 'priority' },
  { key: 'startDate', label: '開始日', kind: 'startDate' },
  { key: 'dueDate', label: '到期日', kind: 'dueDate' },
  { key: 'estimateHours', label: '預估工時', kind: 'estimate' },
  { key: 'progress', label: '進度', kind: 'progress' },
];
const TITLE: FieldCol = { key: 'title', label: '標題', kind: 'title' };
const STATUS: FieldCol = { key: 'status', label: '狀態', kind: 'status' };

function TaskDrawerPanel({ id, leaving = false }: { id: number; leaving?: boolean }) {
  const query = useTask(id);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [backTo] = useState(() => backTargetFor(id));
  const del = useDeleteTaskOptimistic();
  const usersById = useUsersById();
  const properties = useProperties().data;
  const nameOf = (uid: number | null) =>
    (uid != null ? usersById.get(uid)?.displayName : undefined) ?? '其他成員';
  const remote = useRemoteTaskChanges(id, query.data, { properties, nameOf });

  useEffect(() => {
    // 複製任務後切換過來：聚焦標題（資料已預先放入快取）；否則聚焦關閉鈕
    if (consumeTitleFocus(id)) {
      const raf = requestAnimationFrame(() => {
        const title = document.querySelector<HTMLElement>('.task-drawer .tl-drawer-title-field');
        (title ?? closeRef.current)?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    closeRef.current?.focus();
  }, [id]);

  const hasTask = !!query.data;
  useEffect(() => {
    if (leaving || !hasTask) return;
    // D：在抽屜內（非輸入框、無對話框）開啟複製任務對話框
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'd' && e.key !== 'D') return;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isEditableTarget(e.target) || document.querySelector('dialog[open]')) return;
      const panel = document.querySelector('.task-drawer:not([data-leaving])');
      if (!panel?.contains(e.target as Node)) return;
      e.preventDefault();
      setDuplicating(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [leaving, hasTask]);

  useEffect(() => {
    if (leaving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F6') {
        // 非 modal 時在清單與 Drawer 間切換 focus
        const panel = document.querySelector('.task-drawer');
        if (panel?.contains(e.target as Node)) {
          const cell = document.querySelector<HTMLElement>('[role="grid"] [data-nav][tabindex="0"]');
          if (cell) {
            e.preventDefault();
            cell.focus();
          }
        }
        return;
      }
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isEditableTarget(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      closeTask();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [leaving]);

  const notFound = query.error instanceof ApiError && query.error.status === 404;
  const deletedByOther = remote.deletedBy !== undefined;
  const task = deletedByOther ? undefined : query.data;

  let body: ReactNode;
  if (deletedByOther)
    body = (
      <EmptyState
        title={`此任務已被 ${nameOf(remote.deletedBy ?? null)} 刪除`}
        action={
          <Button variant="secondary" onClick={closeTask}>
            關閉
          </Button>
        }
      />
    );
  else if (query.isPending) body = <DrawerSkeleton />;
  else if (notFound)
    body = (
      <EmptyState
        title="此任務不存在或已被刪除"
        action={
          <Button variant="secondary" onClick={closeTask}>
            關閉
          </Button>
        }
      />
    );
  else if (query.isError && !task)
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (task) body = <TaskDetail task={task} titleId={titleId} />;

  return (
    <DrawerActiveContext.Provider value={!leaving}>
      <div className="task-drawer-backdrop" onClick={closeTask} aria-hidden="true" />
      <aside
        className="task-drawer"
        data-leaving={leaving || undefined}
        inert={leaving || undefined}
        aria-hidden={leaving || undefined}
        role="dialog"
        aria-modal="false"
        aria-labelledby={task ? titleId : undefined}
        aria-label={task ? undefined : '任務詳情'}
        tabIndex={-1}
        style={{ outline: 'none' }}
      >
        <div className="task-drawer-head">
          {backTo && (
            <Button
              variant="ghost"
              size="sm"
              className="tr-back"
              onClick={() => goBackFrom(id)}
              aria-label={`返回「${backTo.title}」`}
              title={`返回「${backTo.title}」`}
            >
              ← 返回 {truncate(backTo.title, 8)}
            </Button>
          )}
          <span className="task-drawer-id">#{id}</span>
          {task && <PinButton taskId={task.id} size="sm" />}
          {task && (
            <Menu
              align="end"
              width={180}
              label="更多動作"
              trigger={(p) => (
                <Button {...p} variant="ghost" size="sm" iconOnly icon="menu" aria-label="更多動作" />
              )}
              items={[
                { key: 'duplicate', label: '複製任務（D）', onSelect: () => setDuplicating(true) },
                {
                  key: 'copy',
                  label: '複製連結',
                  onSelect: () =>
                    void navigator.clipboard
                      ?.writeText(`${window.location.origin}/tasks/list?task=${task.id}`)
                      .catch(() => undefined),
                },
                { key: 'sep', separator: true },
                { key: 'delete', label: '刪除任務', danger: true, onSelect: () => setConfirmDelete(true) },
              ]}
            />
          )}
          <Button
            ref={closeRef}
            variant="ghost"
            size="sm"
            iconOnly
            icon="x"
            aria-label="關閉任務詳情"
            onClick={closeTask}
          />
        </div>
        {task && remote.notice && (
          <div className="rt-notice tl-rt-notice">
            <Alert tone="info" onClose={remote.dismiss}>
              {remote.notice.actorIds[0] != null && (
                <Avatar userId={remote.notice.actorIds[0]} size="xs" tooltip={false} />
              )}
              <span>{noticeText(remote.notice, nameOf)}</span>
            </Alert>
          </div>
        )}
        {task && !leaving && <TaskPresenceHint taskId={task.id} />}
        <div className="task-drawer-body scroll-soft">{body}</div>
        {task && (
          <div className="task-drawer-foot tl-drawer-foot">
            <UpdatedAt at={task.createdAt} by={task.createdBy} prefix="建立於" />
            <UpdatedAt at={task.updatedAt} by={task.updatedBy} prefix="更新於" />
          </div>
        )}
        {task && !leaving && <DiscussionSection task={task} />}
      </aside>
      <Dialog
        open={confirmDelete && !!task}
        onClose={() => setConfirmDelete(false)}
        role="alertdialog"
        title={`刪除任務「${task?.title ?? ''}」？`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} data-autofocus>
              取消
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                task &&
                del.mutate(task.id, {
                  onSuccess: () => {
                    setConfirmDelete(false);
                    closeTask();
                    notifySuccess(`已刪除${quoteName(task.title)}`);
                  },
                })
              }
            >
              刪除
            </Button>
          </>
        }
      >
        <p className="m-0">刪除後將從所有檢視中移除。</p>
      </Dialog>
      {task && <DuplicateDialog task={task} open={duplicating} onClose={() => setDuplicating(false)} />}
    </DrawerActiveContext.Provider>
  );
}

function FieldRow({ label, fx, children }: { label: string; fx?: ItemFx; children: ReactNode }) {
  return (
    <div className="task-field tl-drawer-field" {...fxAttr(fx)}>
      <span className="task-field-label">{label}</span>
      {children}
    </div>
  );
}

function TaskDetail({ task, titleId }: { task: Task; titleId: string }) {
  const [editing, setEditing] = useState<{ key: string; state: EditState } | null>(null);
  const properties = useProperties().data;
  const { filters } = useTaskFilters();
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const custom = applicableProperties(properties ?? [], task.projectId).map(propertyColumn);
  // 他人變更的欄位值播更新高亮（lib/remoteNotice.ts）
  const fxMap = useItemFx();
  const fieldFx = (key: string) => fxMap.get(`taskfield:${task.id}:${key}`);

  const field = (col: FieldCol, className = '', ariaLabel: string | null = col.label) => (
    <EditableField
      task={task}
      col={col}
      mode="drawer"
      tabIndex={0}
      aria-label={ariaLabel ?? undefined}
      className={`tl-drawer-value ${className}`}
      edit={editing?.key === col.key ? editing.state : null}
      onEditChange={(next) => setEditing(next ? { key: col.key, state: next } : null)}
    />
  );

  return (
    <>
      {/* 標題欄不設 aria-label，讓 Drawer 的名稱即為任務標題 */}
      <h2 id={titleId} className="task-drawer-title tl-drawer-title" {...fxAttr(fieldFx('title'))}>
        {field(TITLE, 'tl-drawer-title-field', null)}
      </h2>
      <div {...fxAttr(fieldFx('status'))}>{field(STATUS, 'tl-drawer-status')}</div>
      <div className="task-drawer-section" style={{ marginTop: 16 }}>
        {FIELDS.map((f) => (
          <FieldRow key={f.key} label={f.label} fx={fieldFx(f.key)}>
            {field(f)}
          </FieldRow>
        ))}
      </div>
      <div className="task-drawer-section">
        <div className="tl-section-title">自訂欄位</div>
        {custom.length === 0 && <div className="tl-empty tl-drawer-none">尚未建立自訂欄位</div>}
        {custom.map((c) => (
          <FieldRow key={c.key} label={c.label} fx={fieldFx(c.key)}>
            {field(c)}
          </FieldRow>
        ))}
        <Button
          variant="ghost"
          size="sm"
          icon="plus"
          className="tl-drawer-add"
          onClick={(e) => setAddAnchor(addAnchor ? null : e.currentTarget)}
        >
          新增欄位
        </Button>
        {addAnchor && (
          <Popover anchor={addAnchor} onClose={() => setAddAnchor(null)} width={300} label="新增欄位">
            <NewPropertyForm
              scopeProjectId={filters.project.length === 1 ? filters.project[0]! : null}
              onDone={() => setAddAnchor(null)}
            />
          </Popover>
        )}
      </div>
      <RelatedTasks task={task} />
      <DependenciesSection task={task} />
      <Description task={task} fx={fieldFx('description')} />
      <Checklist taskId={task.id} />
      <TaskHistorySection taskId={task.id} />
    </>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** 描述：失焦或 Ctrl+Enter 儲存；關閉 / 切換任務前先送出未存內容 */
function Description({ task, fx }: { task: Task; fx?: ItemFx }) {
  const update = useOptimisticUpdate();
  const me = useCurrentUser();
  // 描述鎖定（DescriptionLock.tsx）：鎖定中且沒有 tasks.lock 時唯讀（仍可選取複製）
  const canLock = useCan('tasks.lock');
  const readOnly = !!task.descriptionLocked && !canLock;
  const [draft, setDraft] = useState(task.description);
  const [base, setBase] = useState(task.description);
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState<SaveState>('idle');
  const ref = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ draft, base, id: task.id, readOnly });
  useEffect(() => {
    latest.current = { draft, base, id: task.id, readOnly };
  });

  // 他人修改（輪詢）：未在編輯且無未存內容時同步；被鎖定成唯讀時捨棄未存內容
  if (task.description !== base && !focused && draft === base && state !== 'saving') {
    setBase(task.description);
    setDraft(task.description);
  } else if (readOnly && draft !== task.description && state !== 'saving') {
    setBase(task.description);
    setDraft(task.description);
  }

  const save = () => {
    if (draft === base || readOnly) return;
    const value = draft;
    setState('saving');
    update.mutate(
      { id: task.id, patch: { description: value }, userId: me?.id },
      {
        onSuccess: () => {
          setBase(value);
          setState('saved');
        },
        onError: () => setState('error'),
      },
    );
  };

  // 在線感知：描述輸入中回報 editing，失焦即回 viewing
  useEffect(() => (focused && !readOnly ? reportEditing(task.id) : undefined), [focused, readOnly, task.id]);

  // 卸載（關閉 Drawer / 切換任務）時送出未存內容
  const mutate = update.mutate;
  useEffect(
    () => () => {
      const { draft: d, base: b, id, readOnly: ro } = latest.current;
      if (d !== b && !ro) mutate({ id, patch: { description: d } });
    },
    [mutate],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(96, el.scrollHeight)}px`;
  }, [draft]);

  return (
    <div className="task-drawer-section" {...fxAttr(fx)}>
      <div className="tl-section-title">
        <span className="lock-toggle">
          描述
          <DescriptionLockButton task={task} />
        </span>
        <span className="tl-save-state" aria-live="polite">
          {state === 'saving' && '儲存中…'}
          {state === 'saved' && '已儲存'}
          {state === 'error' && (
            <span className="tl-danger-text">
              儲存失敗 ·{' '}
              <button type="button" className="tl-linkbtn" onClick={save}>
                重試
              </button>
            </span>
          )}
        </span>
      </div>
      <DescriptionLockBanner task={task} />
      <Textarea
        ref={ref}
        value={draft}
        readOnly={readOnly}
        placeholder={readOnly ? '（沒有描述）' : '加入描述…'}
        aria-label="描述"
        className="tl-desc"
        onFocus={() => setFocused(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          save();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function DrawerSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="載入中">
      <Skeleton height={24} width="70%" />
      <Skeleton height={22} width={72} />
      <div className="mt-4 flex flex-col gap-4">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} height={14} width={`${50 + ((i * 13) % 40)}%`} />
        ))}
      </div>
    </div>
  );
}
