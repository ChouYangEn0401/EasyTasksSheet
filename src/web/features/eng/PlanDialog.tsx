import { useMemo, useState, type FormEvent } from 'react';
import type { Repo } from '../../../shared/eng.ts';
import type { Task } from '../../../shared/tasks.ts';
import { ApiError, errorMessage } from '../../lib/api.ts';
import { useUsers } from '../../lib/hooks.ts';
import {
  Alert,
  Avatar,
  Button,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
  type SelectOption,
} from '../../ui/index.ts';
import { useSavePlan } from './api.ts';
import type { PlanDraft } from './model.ts';

const PURPOSE_MAX = 200;
const NONE = 0;

/** 新增 / 編輯 / 登記 worktree 安排（design §3.3） */
export function PlanDialog({
  draft,
  repos,
  tasks,
  onClose,
}: {
  draft: PlanDraft;
  repos: Repo[];
  tasks: Task[];
  onClose: () => void;
}) {
  const [form, setForm] = useState(draft);
  const [pathError, setPathError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useSavePlan();
  const users = useUsers();
  const set = (patch: Partial<PlanDraft>) => setForm((f) => ({ ...f, ...patch }));

  const repoOptions: SelectOption<number>[] = repos.map((r) => ({ value: r.id, label: r.name }));
  const userOptions = useMemo<SelectOption<number>[]>(
    () => [
      { value: NONE, label: '未指派', leading: <Avatar user={null} size="xs" tooltip={false} /> },
      ...(users.data ?? [])
        .filter((u) => u.isActive || u.id === form.ownerId)
        .map((u) => ({
          value: u.id,
          label: u.displayName,
          leading: <Avatar user={u} size="xs" tooltip={false} />,
        })),
    ],
    [users.data, form.ownerId],
  );
  const taskOptions = useMemo<SelectOption<number>[]>(
    () => [
      { value: NONE, label: '無' },
      ...tasks.map((t) => ({ value: t.id, label: `#${t.id} ${t.title}` })),
    ],
    [tasks],
  );

  const ready = form.repoId > 0 && form.branch.trim() !== '' && form.path.trim() !== '';
  const dirty = JSON.stringify(form) !== JSON.stringify(draft);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || save.isPending) return;
    setError(null);
    setPathError(null);
    save.mutate(
      {
        id: form.id,
        repoId: form.repoId,
        branch: form.branch.trim(),
        path: form.path.trim(),
        ownerId: form.ownerId,
        taskId: form.taskId,
        purpose: form.purpose.trim(),
      },
      {
        onSuccess: onClose,
        onError: (err) => {
          const field =
            err instanceof ApiError ? (err.details as { field?: string } | undefined)?.field : undefined;
          if (field === 'path') setPathError(err.message);
          else setError(errorMessage(err));
        },
      },
    );
  };

  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      dirty={dirty}
      title={form.id ? '編輯 worktree 安排' : '新增 worktree 安排'}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="eng-plan-form"
            disabled={!ready}
            loading={save.isPending}
          >
            儲存
          </Button>
        </>
      }
    >
      <form id="eng-plan-form" className="eng-form" onSubmit={submit}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Repo">
          <Select
            options={repoOptions}
            value={form.repoId}
            onChange={(repoId) => set({ repoId })}
            aria-label="Repo"
          />
        </Field>
        <Field label="分支">
          <Input
            className="eng-mono"
            value={form.branch}
            placeholder="feat/…"
            maxLength={200}
            onChange={(e) => set({ branch: e.target.value })}
            data-autofocus
          />
        </Field>
        <Field label="路徑" hint="相對於 repo 或絕對路徑" error={pathError}>
          <Input
            className="eng-mono"
            value={form.path}
            placeholder="../repo-feature"
            maxLength={500}
            onChange={(e) => {
              setPathError(null);
              set({ path: e.target.value });
            }}
          />
        </Field>
        <Field label="負責人">
          <Select
            options={userOptions}
            value={form.ownerId ?? NONE}
            onChange={(v) => set({ ownerId: v === NONE ? null : v })}
            aria-label="負責人"
          />
        </Field>
        <Field label="關聯任務">
          <Select
            options={taskOptions}
            value={form.taskId ?? NONE}
            onChange={(v) => set({ taskId: v === NONE ? null : v })}
            aria-label="關聯任務"
          />
        </Field>
        <Field
          label="用途"
          hint={
            <span className="eng-counter tabular-nums">
              {form.purpose.length}/{PURPOSE_MAX}
            </span>
          }
        >
          <Textarea
            rows={3}
            maxLength={PURPOSE_MAX}
            value={form.purpose}
            onChange={(e) => set({ purpose: e.target.value })}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/** 刪除安排確認 */
export function DeletePlanDialog({
  pending,
  error,
  onConfirm,
  onClose,
}: {
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      size="sm"
      role="alertdialog"
      onClose={onClose}
      title="刪除此安排？"
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="danger" loading={pending} onClick={onConfirm} data-autofocus>
            刪除
          </Button>
        </>
      }
    >
      {error != null && <Alert tone="danger">{errorMessage(error)}</Alert>}
      <p className="eng-dialog-text">只會移除安排紀錄，不會變更磁碟上的 worktree 或分支。</p>
    </Dialog>
  );
}
