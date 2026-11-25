import { useId, useState, type FormEvent } from 'react';
import {
  WORKTREE_RECORD_STATUS_LABELS,
  WORKTREE_RECORD_STATUSES,
  type MachineGroup,
  type WorktreeRecord,
  type WorktreeRecordStatus,
  type WorktreeReport,
  type WorktreesOverview,
} from '../../../shared/engManual.ts';
import { errorMessage } from '../../lib/api.ts';
import { useUsersById } from '../../lib/hooks.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Menu,
  Select,
  Skeleton,
  Textarea,
  Tooltip,
  UpdatedAt,
  type MenuItem,
  type SelectOption,
} from '../../ui/index.ts';
import { useDeleteRecord, useSaveRecord } from './api.ts';
import { MoreIcon, NameList } from './bits.tsx';
import { NONE, useUserOptions } from './userOptions.ts';
import { MACHINE_STORAGE_KEY, RECORD_TONE, reportFor, reportSummary } from './model.ts';

const STATUS_OPTIONS: SelectOption<WorktreeRecordStatus>[] = WORKTREE_RECORD_STATUSES.map((s) => ({
  value: s,
  label: WORKTREE_RECORD_STATUS_LABELS[s],
}));

type Draft = {
  machine: string;
  path: string;
  branch: string;
  ownerId: number | null;
  purpose: string;
  status: WorktreeRecordStatus;
  note: string;
};

const trimDraft = (d: Draft) => ({
  machine: d.machine.trim(),
  path: d.path.trim(),
  branch: d.branch.trim(),
  ownerId: d.ownerId,
  purpose: d.purpose.trim(),
  status: d.status,
  note: d.note.trim(),
});

const blank = (machine = ''): Draft => ({
  machine,
  path: '',
  branch: '',
  ownerId: null,
  purpose: '',
  status: 'active',
  note: '',
});

/** 頂部的新增表單：電腦 + 路徑即可送出；電腦名稱記在本機供下次預填 */
function AddRecordForm({ machineListId }: { machineListId: string }) {
  const [form, setForm] = useState(() => blank(readStorage(MACHINE_STORAGE_KEY) ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const save = useSaveRecord({ silent: true });
  const userOptions = useUserOptions(form.ownerId);
  const set = (patch: Partial<Draft>) => setForm((f) => ({ ...f, ...patch }));
  const ready = form.machine.trim() !== '' && form.path.trim() !== '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || save.isPending) return;
    setError(null);
    setPathError(null);
    save.mutate(trimDraft(form), {
      onSuccess: (rec) => {
        writeStorage(MACHINE_STORAGE_KEY, rec.machine);
        setForm((f) => ({ ...blank(rec.machine), ownerId: f.ownerId }));
      },
      onError: (err) => {
        const msg = errorMessage(err);
        if (/路徑/.test(msg)) setPathError(msg);
        else setError(msg);
      },
    });
  };

  return (
    <form className="eng-card eng-add" aria-label="新增 worktree 紀錄" onSubmit={submit}>
      <div className="eng-add-grid eng-add-grid--wt">
        <Field label="電腦">
          <Input
            value={form.machine}
            maxLength={100}
            list={machineListId}
            placeholder="電腦名稱"
            onChange={(e) => set({ machine: e.target.value })}
          />
        </Field>
        <Field label="路徑" error={pathError} className="eng-add-path">
          <Input
            className="eng-mono"
            value={form.path}
            maxLength={500}
            placeholder="C:\work\repo-feature"
            onChange={(e) => {
              setPathError(null);
              set({ path: e.target.value });
            }}
          />
        </Field>
        <Field label="分支">
          <Input
            className="eng-mono"
            value={form.branch}
            maxLength={200}
            placeholder="feat/…"
            onChange={(e) => set({ branch: e.target.value })}
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
        <Field label="用途">
          <Input
            value={form.purpose}
            maxLength={200}
            placeholder="選填"
            onChange={(e) => set({ purpose: e.target.value })}
          />
        </Field>
      </div>
      <div className="eng-add-actions">
        {error && <span className="eng-danger-text">{error}</span>}
        <Button variant="primary" type="submit" icon="plus" disabled={!ready} loading={save.isPending}>
          新增紀錄
        </Button>
      </div>
    </form>
  );
}

function RecordDialog({
  record,
  machineListId,
  onClose,
}: {
  record: WorktreeRecord;
  machineListId: string;
  onClose: () => void;
}) {
  const initial: Draft = {
    machine: record.machine,
    path: record.path,
    branch: record.branch,
    ownerId: record.ownerId,
    purpose: record.purpose,
    status: record.status,
    note: record.note,
  };
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveRecord({ silent: true });
  const userOptions = useUserOptions(form.ownerId);
  const set = (patch: Partial<Draft>) => setForm((f) => ({ ...f, ...patch }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const ready = form.machine.trim() !== '' && form.path.trim() !== '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || save.isPending) return;
    save.mutate(
      { id: record.id, ...trimDraft(form) },
      { onSuccess: onClose, onError: (err) => setError(errorMessage(err)) },
    );
  };

  return (
    <Dialog
      open
      size="md"
      title="編輯 worktree 紀錄"
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
            form="eng-record-form"
            disabled={!ready || !dirty}
            loading={save.isPending}
          >
            儲存
          </Button>
        </>
      }
    >
      <form id="eng-record-form" className="eng-form" onSubmit={submit}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="電腦">
          <Input
            value={form.machine}
            maxLength={100}
            list={machineListId}
            onChange={(e) => set({ machine: e.target.value })}
            data-autofocus
          />
        </Field>
        <Field label="路徑">
          <Input
            className="eng-mono"
            value={form.path}
            maxLength={500}
            onChange={(e) => set({ path: e.target.value })}
          />
        </Field>
        <Field label="分支">
          <Input
            className="eng-mono"
            value={form.branch}
            maxLength={200}
            onChange={(e) => set({ branch: e.target.value })}
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
            value={form.ownerId ?? NONE}
            onChange={(v) => set({ ownerId: v === NONE ? null : v })}
            aria-label="負責人"
          />
        </Field>
        <Field label="用途">
          <Input value={form.purpose} maxLength={200} onChange={(e) => set({ purpose: e.target.value })} />
        </Field>
        <Field label="備註">
          <Textarea
            rows={3}
            maxLength={2000}
            value={form.note}
            onChange={(e) => set({ note: e.target.value })}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ record, onClose }: { record: WorktreeRecord; onClose: () => void }) {
  const del = useDeleteRecord();
  return (
    <Dialog
      open
      size="sm"
      role="alertdialog"
      title="刪除此紀錄？"
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={del.isPending}
            onClick={() => del.mutate(record.id, { onSuccess: onClose })}
            data-autofocus
          >
            刪除
          </Button>
        </>
      }
    >
      {del.error != null && <Alert tone="danger">{errorMessage(del.error)}</Alert>}
      <p className="eng-dialog-text">只會刪除這筆紀錄，不會變更任何電腦上的 worktree 或分支。</p>
    </Dialog>
  );
}

function PathCell({ branch, path }: { branch: string | null; path: string }) {
  return (
    <div className="eng-two-line">
      <span className="eng-mono">{branch || '（無分支）'}</span>
      <Tooltip content={path}>
        <span className="eng-path eng-ellipsis" tabIndex={0} aria-label={`路徑 ${path}`}>
          {path}
        </span>
      </Tooltip>
    </div>
  );
}

function SnapshotCell({ report, missing }: { report: WorktreeReport | undefined; missing: boolean }) {
  if (missing) return <Badge tone="danger">可能遺失</Badge>;
  if (!report) return <span className="eng-text-tertiary">—</span>;
  return <span className="eng-sub">{reportSummary(report)}</span>;
}

function RecordRow({
  record,
  group,
  onEdit,
  onDelete,
}: {
  record: MachineGroup['records'][number];
  group: MachineGroup;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const byId = useUsersById();
  const save = useSaveRecord();
  const owner = record.ownerId != null ? byId.get(record.ownerId) : undefined;
  const name = record.branch || record.path;
  const items: MenuItem[] = [
    { key: 'edit', label: '編輯', onSelect: onEdit },
    { key: 'sep', separator: true },
    { key: 'delete', label: '刪除', danger: true, onSelect: onDelete },
  ];
  const detail = [record.purpose, record.note].filter(Boolean).join(' · ');
  return (
    <tr className="eng-wt-row" data-kind="record" data-hint={record.hint ?? undefined}>
      <td>
        <span className="eng-status-select">
          <Select
            options={STATUS_OPTIONS}
            value={record.status}
            onChange={(status) => {
              if (status !== record.status) save.mutate({ id: record.id, status });
            }}
            aria-label={`「${name}」的狀態`}
            renderValue={(o) => (
              <Badge tone={RECORD_TONE[record.status]} dot>
                {o?.label ?? ''}
              </Badge>
            )}
          />
        </span>
      </td>
      <td className="eng-col-path">
        <PathCell branch={record.branch} path={record.path} />
      </td>
      <td>
        <span className="eng-owner">
          <Avatar user={owner ?? null} size="sm" />
          <span className="eng-owner-name">{owner?.displayName ?? '未指派'}</span>
        </span>
      </td>
      <td className="eng-col-detail">
        {detail ? (
          <Tooltip content={detail}>
            <span className="eng-ellipsis eng-text-secondary" tabIndex={0}>
              {detail}
            </span>
          </Tooltip>
        ) : (
          <span className="eng-text-tertiary">—</span>
        )}
      </td>
      <td>
        <SnapshotCell report={reportFor(group, record.path)} missing={record.hint === 'missing'} />
      </td>
      <td>
        <UpdatedAt at={record.updatedAt} by={record.updatedBy} />
      </td>
      <td className="eng-col-action">
        <Menu
          align="end"
          label={`「${name}」的操作`}
          items={items}
          trigger={(p) => (
            <Button
              {...p}
              variant="ghost"
              size="sm"
              iconOnly
              icon={<MoreIcon />}
              aria-label={`「${name}」的操作`}
            />
          )}
        />
      </td>
    </tr>
  );
}

/** 回報有、紀錄沒有：標「未登記」，一鍵登記為紀錄 */
function UnregisteredRow({ report, machine }: { report: WorktreeReport; machine: string }) {
  const save = useSaveRecord();
  return (
    <tr className="eng-wt-row" data-kind="report" data-hint="unregistered">
      <td>
        <Badge tone="warning" dot>
          未登記
        </Badge>
      </td>
      <td className="eng-col-path">
        <PathCell branch={report.branch} path={report.path} />
      </td>
      <td>
        <span className="eng-text-tertiary">—</span>
      </td>
      <td className="eng-col-detail">
        <span className="eng-text-tertiary">{report.repo || '—'}</span>
      </td>
      <td>
        <SnapshotCell report={report} missing={false} />
      </td>
      <td>
        <UpdatedAt at={report.reportedAt} prefix="回報於" />
      </td>
      <td className="eng-col-action">
        <Button
          size="sm"
          variant="secondary"
          loading={save.isPending}
          onClick={() =>
            save.mutate({
              machine,
              path: report.path,
              branch: report.branch ?? '',
              status: report.isMerged ? 'merged' : 'active',
            })
          }
        >
          登記
        </Button>
      </td>
    </tr>
  );
}

function MachineSection({
  group,
  onEdit,
  onDelete,
}: {
  group: MachineGroup;
  onEdit: (r: WorktreeRecord) => void;
  onDelete: (r: WorktreeRecord) => void;
}) {
  const unregistered = group.reports.filter((r) => !r.registered);
  return (
    <section className="eng-card eng-machine" aria-label={`電腦 ${group.machine}`}>
      <header className="eng-machine-head">
        <h3 className="eng-machine-name">{group.machine}</h3>
        <span className="eng-sync eng-text-secondary">
          {group.reportedAt != null ? (
            <UpdatedAt at={group.reportedAt} prefix="回報於" />
          ) : (
            '尚未回報（僅手動紀錄）'
          )}
        </span>
      </header>
      <div>
        <table className="eng-table eng-table--wt">
          <thead>
            <tr>
              <th scope="col">狀態</th>
              <th scope="col">分支 / 路徑</th>
              <th scope="col">負責人</th>
              <th scope="col">用途 / 備註</th>
              <th scope="col">回報快照</th>
              <th scope="col">更新</th>
              <th scope="col" className="eng-col-action">
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {group.records.map((r) => (
              <RecordRow
                key={`rec-${r.id}`}
                record={r}
                group={group}
                onEdit={() => onEdit(r)}
                onDelete={() => onDelete(r)}
              />
            ))}
            {unregistered.map((r) => (
              <UnregisteredRow key={`rep-${r.id}`} report={r} machine={group.machine} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Worktree 分頁：新增表單在最上面；下方依電腦分組，並列手動紀錄與回報快照（僅供參考） */
export function WorktreesTab({
  query,
}: {
  query: { data?: WorktreesOverview; error: unknown; refetch: () => void };
}) {
  const machineListId = useId();
  const [editing, setEditing] = useState<WorktreeRecord | null>(null);
  const [deleting, setDeleting] = useState<WorktreeRecord | null>(null);
  const data = query.data;
  const machines = data?.machines ?? [];

  return (
    <section className="eng-section" aria-label="工作樹">
      <NameList id={machineListId} names={machines.map((m) => m.machine)} />
      <AddRecordForm machineListId={machineListId} />

      {data && !data.reportEnabled && (
        <p className="eng-help">
          伺服器未設定 <code>WORKTREE_REPORT_TOKEN</code>，各電腦的自動回報目前停用；手動紀錄不受影響。
        </p>
      )}
      {data?.reportEnabled && (
        <p className="eng-help">
          在各人電腦的 repo 目錄執行 <code>node scripts/report-worktrees.mjs --server &lt;網址&gt;</code>{' '}
          即可回報該電腦的 worktree；比對結果僅供參考。
        </p>
      )}

      {!data && query.error ? (
        <ErrorState error={query.error} onRetry={query.refetch} />
      ) : !data ? (
        <div className="eng-card eng-machine" aria-busy="true">
          <Skeleton height={160} />
        </div>
      ) : machines.length === 0 ? (
        <div className="eng-card">
          <EmptyState
            icon="branch"
            title="尚未記錄任何 worktree"
            description="在上方填入電腦與路徑即可新增"
          />
        </div>
      ) : (
        machines.map((g) => (
          <MachineSection key={g.machine} group={g} onEdit={setEditing} onDelete={setDeleting} />
        ))
      )}
      {editing && (
        <RecordDialog record={editing} machineListId={machineListId} onClose={() => setEditing(null)} />
      )}
      {deleting && <DeleteDialog record={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}
