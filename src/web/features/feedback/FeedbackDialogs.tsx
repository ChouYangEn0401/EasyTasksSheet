import { useState } from 'react';
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_LABELS,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackUpdateInput,
} from '../../../shared/feedback.ts';
import { errorMessage } from '../../lib/api.ts';
import { todayString } from '../../lib/format.ts';
import { useUsers, useUsersById } from '../../lib/hooks.ts';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
  UpdatedAt,
} from '../../ui/index.ts';
import { useDeleteFeedback, useUpdateFeedback } from './api.ts';
import { KindSegmented } from './FeedbackList.tsx';

const STATUS_TONE = { open: 'neutral', scheduled: 'accent', resolved: 'success' } as const;
const UNASSIGNED = 0;

type Draft = {
  kind: FeedbackKind;
  title: string;
  body: string;
  assigneeId: number | null;
  scheduledDate: string;
};

const toDraft = (item: FeedbackItem): Draft => ({
  kind: item.kind,
  title: item.title,
  body: item.body,
  assigneeId: item.assigneeId,
  scheduledDate: item.scheduledDate ?? '',
});

/** 只取出有改動的欄位（PATCH 只送改動欄位） */
function diff(item: FeedbackItem, d: Draft): FeedbackUpdateInput {
  const patch: FeedbackUpdateInput = {};
  if (d.kind !== item.kind) patch.kind = d.kind;
  if (d.title.trim() !== item.title) patch.title = d.title.trim();
  if (d.body !== item.body) patch.body = d.body;
  if (d.assigneeId !== item.assigneeId) patch.assigneeId = d.assigneeId;
  if ((d.scheduledDate || null) !== item.scheduledDate) patch.scheduledDate = d.scheduledDate || null;
  return patch;
}

function EditForm({
  item,
  onClose,
  onDelete,
}: {
  item: FeedbackItem;
  onClose: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(() => toDraft(item));
  const update = useUpdateFeedback();
  const users = useUsers();
  const usersById = useUsersById();
  const patch = diff(item, draft);
  const dirty = Object.keys(patch).length > 0;
  const titleError = draft.title.trim() ? undefined : '請輸入標題';
  const reporter = item.reporterId != null ? usersById.get(item.reporterId)?.displayName : undefined;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = () => {
    if (!dirty || titleError) return;
    update.mutate({ id: item.id, ...patch }, { onSuccess: onClose });
  };

  const assigneeOptions = [
    { value: UNASSIGNED, label: '未指派', leading: <Avatar size="xs" tooltip={false} /> },
    ...(users.data ?? [])
      .filter((u) => u.isActive || u.id === item.assigneeId)
      .map((u) => ({
        value: u.id,
        label: u.displayName,
        leading: <Avatar user={u} size="xs" tooltip={false} />,
      })),
  ];

  return (
    <Dialog
      open
      size="md"
      dirty={dirty}
      onClose={onClose}
      title={item.kind === 'problem' ? '編輯問題' : '編輯回饋'}
      actions={
        <>
          <div className="fb-dialog-meta">
            <Button variant="ghost" size="sm" className="fb-danger-text" onClick={onDelete}>
              刪除
            </Button>
            <span className="fb-dialog-footer-info">
              回報者 {reporter ?? '—'} · <UpdatedAt at={item.updatedAt} by={item.updatedBy} prefix="更新於" />
            </span>
          </div>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || !!titleError}
            loading={update.isPending}
            onClick={save}
          >
            儲存
          </Button>
        </>
      }
    >
      <form
        className="fb-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {update.isError && <Alert tone="danger">{errorMessage(update.error)}</Alert>}
        <div className="ui-field">
          <span className="ui-label">類型</span>
          <KindSegmented<FeedbackKind>
            label="類型"
            value={draft.kind}
            options={(['problem', 'feedback'] as const).map((k) => ({
              value: k,
              label: FEEDBACK_KIND_LABELS[k],
            }))}
            onChange={(k) => set('kind', k)}
          />
        </div>
        <Field label="標題" error={titleError}>
          <Input value={draft.title} onChange={(e) => set('title', e.target.value)} data-autofocus />
        </Field>
        <Field label="內容">
          <Textarea rows={6} value={draft.body} onChange={(e) => set('body', e.target.value)} />
        </Field>
        <div className="fb-form-row">
          <Field label="負責人">
            <Select<number>
              options={assigneeOptions}
              value={draft.assigneeId ?? UNASSIGNED}
              onChange={(v) => set('assigneeId', v === UNASSIGNED ? null : v)}
            />
          </Field>
          <Field label="排程日">
            <Input
              type="date"
              value={draft.scheduledDate}
              onChange={(e) => set('scheduledDate', e.target.value)}
              end={
                draft.scheduledDate ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon="x"
                    aria-label="清除排程日"
                    onClick={() => set('scheduledDate', '')}
                  />
                ) : null
              }
            />
          </Field>
        </div>
        <div className="ui-field">
          <span className="ui-label">狀態</span>
          <span>
            <Badge tone={STATUS_TONE[item.status]}>{FEEDBACK_STATUS_LABELS[item.status]}</Badge>
          </span>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function DeleteConfirm({
  item,
  onClose,
  onDeleted,
}: {
  item: FeedbackItem;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const del = useDeleteFeedback();
  const noun = FEEDBACK_KIND_LABELS[item.kind];
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      title={`刪除這筆${noun}？`}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={del.isPending}
            data-autofocus
            onClick={() => del.mutate(item.id, { onSuccess: onDeleted })}
          >
            刪除
          </Button>
        </>
      }
    >
      {del.isError && <Alert tone="danger">{errorMessage(del.error)}</Alert>}
      <p className="fb-confirm-text">「{item.title}」將被刪除，此動作無法復原。</p>
    </Dialog>
  );
}

/** 排入日期…（拖曳的非指標替代路徑） */
function ScheduleForm({
  item,
  onClose,
  onSubmit,
}: {
  item: FeedbackItem;
  onClose: () => void;
  onSubmit: (date: string) => void;
}) {
  const [date, setDate] = useState(item.scheduledDate ?? todayString());
  const submit = () => {
    if (!date) return;
    onSubmit(date);
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="排入日期"
      actions={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" disabled={!date} onClick={submit}>
            排入
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={`「${item.title}」的排程日`}>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-autofocus />
        </Field>
      </form>
    </Dialog>
  );
}

export type DialogState =
  | { type: 'edit'; id: number }
  | { type: 'delete'; id: number; from?: 'edit' }
  | { type: 'schedule'; id: number }
  | null;

/** 依目前 dialog 狀態渲染對應的 Dialog（項目以 id 從最新資料取出，避免顯示過期內容） */
export function FeedbackDialogs({
  state,
  items,
  onChange,
  onSchedule,
}: {
  state: DialogState;
  items: FeedbackItem[];
  onChange: (s: DialogState) => void;
  onSchedule: (item: FeedbackItem, date: string) => void;
}) {
  if (!state) return null;
  const item = items.find((i) => i.id === state.id);
  if (!item) return null;
  const close = () => onChange(null);
  switch (state.type) {
    case 'edit':
      return (
        <EditForm
          key={item.id}
          item={item}
          onClose={close}
          onDelete={() => onChange({ type: 'delete', id: item.id, from: 'edit' })}
        />
      );
    case 'delete':
      return (
        <DeleteConfirm
          item={item}
          onClose={() => onChange(state.from === 'edit' ? { type: 'edit', id: item.id } : null)}
          onDeleted={close}
        />
      );
    case 'schedule':
      return <ScheduleForm item={item} onClose={close} onSubmit={(d) => onSchedule(item, d)} />;
  }
}
