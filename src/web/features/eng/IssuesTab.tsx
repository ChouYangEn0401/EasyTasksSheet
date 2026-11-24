import { useId, useState, type FormEvent } from 'react';
import {
  ISSUE_STATUS_LABELS,
  ISSUE_STATUSES,
  type IssueStatus,
  type ManualIssue,
} from '../../../shared/engManual.ts';
import { errorMessage } from '../../lib/api.ts';
import { useUsersById } from '../../lib/hooks.ts';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Menu,
  Select,
  Textarea,
  Tooltip,
  UpdatedAt,
  type MenuItem,
  type SelectOption,
} from '../../ui/index.ts';
import { useDeleteIssue, useSaveIssue } from './api.ts';
import { ExternalIcon, MoreIcon, NameList, SkeletonRows } from './bits.tsx';
import { NONE, useUserOptions } from './userOptions.ts';
import { ISSUE_TONE, openIssueCount, visibleIssues } from './model.ts';

const STATUS_OPTIONS: SelectOption<IssueStatus>[] = ISSUE_STATUSES.map((s) => ({
  value: s,
  label: ISSUE_STATUS_LABELS[s],
}));

type Draft = {
  id?: number;
  title: string;
  project: string;
  status: IssueStatus;
  assigneeId: number | null;
  url: string;
  description: string;
};

const emptyDraft = (): Draft => ({
  title: '',
  project: '',
  status: 'open',
  assigneeId: null,
  url: '',
  description: '',
});

const toInput = (d: Draft) => ({
  title: d.title.trim(),
  project: d.project.trim(),
  status: d.status,
  assigneeId: d.assigneeId,
  url: d.url.trim() || null,
  description: d.description.trim(),
});

/** 頂部的新增表單：填標題即可送出（Enter），其餘欄位選填 */
function AddIssueForm({ listId }: { listId: string }) {
  const [form, setForm] = useState(emptyDraft);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveIssue({ silent: true });
  const userOptions = useUserOptions(form.assigneeId);
  const set = (patch: Partial<Draft>) => setForm((f) => ({ ...f, ...patch }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || save.isPending) return;
    setError(null);
    save.mutate(toInput(form), {
      // 保留專案與負責人，方便連續登錄同一專案的問題
      onSuccess: () => setForm((f) => ({ ...emptyDraft(), project: f.project, assigneeId: f.assigneeId })),
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <form className="eng-card eng-add" aria-label="新增問題" onSubmit={submit}>
      <div className="eng-add-grid eng-add-grid--issue">
        <Field label="標題" className="eng-add-title">
          <Input
            value={form.title}
            maxLength={200}
            placeholder="發生了什麼問題？"
            onChange={(e) => set({ title: e.target.value })}
          />
        </Field>
        <Field label="專案 / Repo">
          <Input
            value={form.project}
            maxLength={100}
            list={listId}
            placeholder="選填"
            onChange={(e) => set({ project: e.target.value })}
          />
        </Field>
        <Field label="負責人">
          <Select
            options={userOptions}
            value={form.assigneeId ?? NONE}
            onChange={(v) => set({ assigneeId: v === NONE ? null : v })}
            aria-label="負責人"
          />
        </Field>
        <Field label="連結">
          <Input
            type="url"
            value={form.url}
            maxLength={500}
            placeholder="https://…（選填）"
            onChange={(e) => set({ url: e.target.value })}
          />
        </Field>
      </div>
      <Field label="說明">
        <Textarea
          rows={2}
          maxLength={5000}
          value={form.description}
          placeholder="選填"
          onChange={(e) => set({ description: e.target.value })}
        />
      </Field>
      <div className="eng-add-actions">
        {error && <span className="eng-danger-text">{error}</span>}
        <Button
          variant="primary"
          type="submit"
          icon="plus"
          disabled={!form.title.trim()}
          loading={save.isPending}
        >
          新增問題
        </Button>
      </div>
    </form>
  );
}

function IssueDialog({
  issue,
  listId,
  onClose,
}: {
  issue: ManualIssue;
  listId: string;
  onClose: () => void;
}) {
  const initial: Draft = {
    id: issue.id,
    title: issue.title,
    project: issue.project,
    status: issue.status,
    assigneeId: issue.assigneeId,
    url: issue.url ?? '',
    description: issue.description,
  };
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveIssue({ silent: true });
  const userOptions = useUserOptions(form.assigneeId);
  const set = (patch: Partial<Draft>) => setForm((f) => ({ ...f, ...patch }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || save.isPending) return;
    save.mutate(
      { id: issue.id, ...toInput(form) },
      { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
    );
  };

  return (
    <Dialog
      open
      size="md"
      title="編輯問題"
      dirty={dirty}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="eng-issue-form"
            disabled={!form.title.trim() || !dirty}
            loading={save.isPending}
          >
            儲存
          </Button>
        </>
      }
    >
      <form id="eng-issue-form" className="eng-form" onSubmit={submit}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="標題">
          <Input
            value={form.title}
            maxLength={200}
            onChange={(e) => set({ title: e.target.value })}
            data-autofocus
          />
        </Field>
        <Field label="專案 / Repo">
          <Input
            value={form.project}
            maxLength={100}
            list={listId}
            onChange={(e) => set({ project: e.target.value })}
          />
        </Field>
        <Field label="狀態">
          <Select
            options={STATUS_OPTIONS}
            value={form.status}
            onChange={(status) => set({ status })}
            aria-label="狀態"
          />
        </Field>
        <Field label="負責人">
          <Select
            options={userOptions}
            value={form.assigneeId ?? NONE}
            onChange={(v) => set({ assigneeId: v === NONE ? null : v })}
            aria-label="負責人"
          />
        </Field>
        <Field label="連結">
          <Input type="url" value={form.url} maxLength={500} onChange={(e) => set({ url: e.target.value })} />
        </Field>
        <Field label="說明">
          <Textarea
            rows={4}
            maxLength={5000}
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ issue, onClose }: { issue: ManualIssue; onClose: () => void }) {
  const del = useDeleteIssue();
  return (
    <Dialog
      open
      size="sm"
      role="alertdialog"
      title="刪除此問題？"
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={del.isPending}
            onClick={() => del.mutate(issue.id, { onSuccess: onClose })}
            data-autofocus
          >
            刪除
          </Button>
        </>
      }
    >
      {del.error != null && <Alert tone="danger">{errorMessage(del.error)}</Alert>}
      <p className="eng-dialog-text">「{issue.title}」將永久刪除；若只是處理完畢，請改用「結案」。</p>
    </Dialog>
  );
}

function IssueRow({
  issue,
  onEdit,
  onDelete,
}: {
  issue: ManualIssue;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const byId = useUsersById();
  const save = useSaveIssue();
  const assignee = issue.assigneeId != null ? byId.get(issue.assigneeId) : undefined;
  const setStatus = (status: IssueStatus) => {
    if (status !== issue.status) save.mutate({ id: issue.id, status });
  };
  const closed = issue.status === 'closed';
  const items: MenuItem[] = [
    { key: 'edit', label: '編輯', onSelect: onEdit },
    closed
      ? { key: 'reopen', label: '重新開啟', onSelect: () => setStatus('open') }
      : { key: 'close', label: '結案', onSelect: () => setStatus('closed') },
    { key: 'sep', separator: true },
    { key: 'delete', label: '刪除', danger: true, onSelect: onDelete },
  ];

  return (
    <tr className="eng-issue-row" data-status={issue.status} data-closed={closed || undefined}>
      <td className="eng-col-title">
        <div className="eng-two-line">
          <span className="eng-issue-title">
            <span className="eng-ellipsis">{issue.title}</span>
            {issue.url && (
              <a
                className="eng-link-icon"
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`開啟「${issue.title}」的連結`}
              >
                <ExternalIcon />
              </a>
            )}
          </span>
          {issue.description && (
            <Tooltip content={issue.description}>
              <span className="eng-sub eng-ellipsis" tabIndex={0}>
                {issue.description}
              </span>
            </Tooltip>
          )}
        </div>
      </td>
      <td className="eng-text-secondary">{issue.project || '—'}</td>
      <td>
        <span className="eng-status-select">
          <Select
            options={STATUS_OPTIONS}
            value={issue.status}
            onChange={setStatus}
            aria-label={`「${issue.title}」的狀態`}
            renderValue={(o) => (
              <Badge tone={ISSUE_TONE[issue.status]} dot>
                {o?.label ?? ''}
              </Badge>
            )}
          />
        </span>
      </td>
      <td>
        <span className="eng-owner">
          <Avatar user={assignee ?? null} size="sm" />
          <span className="eng-owner-name">{assignee?.displayName ?? '未指派'}</span>
        </span>
      </td>
      <td>
        <UpdatedAt at={issue.updatedAt} by={issue.updatedBy} />
      </td>
      <td className="eng-col-action">
        <Menu
          align="end"
          label={`「${issue.title}」的操作`}
          items={items}
          trigger={(p) => (
            <Button
              {...p}
              variant="ghost"
              size="sm"
              iconOnly
              icon={<MoreIcon />}
              aria-label={`「${issue.title}」的操作`}
            />
          )}
        />
      </td>
    </tr>
  );
}

/** 問題分頁：新增表單在最上面，下方為清單（預設隱藏已結案） */
export function IssuesTab({
  query,
  names,
}: {
  query: { data?: ManualIssue[]; error: unknown; refetch: () => void };
  names: string[];
}) {
  const listId = useId();
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<ManualIssue | null>(null);
  const [deleting, setDeleting] = useState<ManualIssue | null>(null);
  const all = query.data;
  const issues = all ? visibleIssues(all, showClosed) : undefined;
  const closedCount = all ? all.length - openIssueCount(all) : 0;

  return (
    <section className="eng-section" aria-label="問題">
      <NameList id={listId} names={names} />
      <AddIssueForm listId={listId} />

      <div className="eng-toolbar">
        <Checkbox
          label={`顯示已結案（${closedCount}）`}
          checked={showClosed}
          onChange={(e) => setShowClosed(e.target.checked)}
        />
      </div>

      {!all && query.error ? (
        <ErrorState error={query.error} onRetry={query.refetch} />
      ) : issues && issues.length === 0 ? (
        <div className="eng-card">
          <EmptyState
            icon="checkCircle"
            title={all && all.length > 0 ? '沒有未結案的問題' : '尚未記錄任何問題'}
            description="在上方輸入標題即可新增"
          />
        </div>
      ) : (
        <div className="eng-card eng-scroll">
          <table className="eng-table">
            <thead>
              <tr>
                <th scope="col">標題</th>
                <th scope="col">專案 / Repo</th>
                <th scope="col">狀態</th>
                <th scope="col">負責人</th>
                <th scope="col">更新</th>
                <th scope="col" className="eng-col-action">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {issues ? (
                issues.map((i) => (
                  <IssueRow
                    key={i.id}
                    issue={i}
                    onEdit={() => setEditing(i)}
                    onDelete={() => setDeleting(i)}
                  />
                ))
              ) : (
                <SkeletonRows rows={5} cols={6} />
              )}
            </tbody>
          </table>
        </div>
      )}
      {editing && <IssueDialog issue={editing} listId={listId} onClose={() => setEditing(null)} />}
      {deleting && <DeleteDialog issue={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}
