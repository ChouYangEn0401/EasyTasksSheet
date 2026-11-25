import { useId, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import type {
  MachineGroup,
  MachineRepo,
  WorktreeRecord,
  WorktreeReport,
  WorktreesOverview,
} from '../../../shared/engManual.ts';
import { errorMessage } from '../../lib/api.ts';
import { useCurrentUser } from '../../lib/auth.ts';
import { useUsers, useUsersById } from '../../lib/hooks.ts';
import { useCan } from '../../lib/permissions.ts';
import { notifySuccess } from '../../lib/toast.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
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
  type SelectOption,
  Skeleton,
  Textarea,
  Tooltip,
  UpdatedAt,
  type MenuItem,
} from '../../ui/index.ts';
import { useDeleteRecord, usePendingReport, useSaveRecord, useTrash } from './api.ts';
import { EngIcon, MoreIcon, NameList } from './bits.tsx';
import { ManageStatusesButton, StatusSelect } from './EngStatus.tsx';
import { useStatusList } from './statusHooks.ts';
import { PasteDialog } from './PasteDialog.tsx';
import { ScanDialog } from './ScanDialog.tsx';
import { TrashDialog } from './TrashDialog.tsx';
import { NONE, useUserOptions } from './userOptions.ts';
import {
  ago,
  isDoneRecord,
  MACHINE_STORAGE_KEY,
  reportFor,
  reportSummary,
  statusView,
  unregisteredReports,
} from './model.ts';
import {
  countByStatus,
  extrasCount,
  groupByOwner,
  inView,
  readPersonView,
  unassignedCount,
  VIEW_ALL,
  VIEW_PARAM,
  writePersonView,
  type MachineSlice,
  type OwnerBucket,
} from './personView.ts';

type Draft = {
  machine: string;
  path: string;
  branch: string;
  ownerId: number | null;
  purpose: string;
  status: string;
  note: string;
};

const trimDraft = (d: Draft) => ({
  machine: d.machine.trim(),
  path: d.path.trim(),
  branch: d.branch.trim(),
  ownerId: d.ownerId,
  purpose: d.purpose.trim(),
  ...(d.status ? { status: d.status } : {}),
  note: d.note.trim(),
});

/** 新增時 status 留空 → 由後端套用預設狀態 */
const blank = (machine = '', ownerId: number | null = null): Draft => ({
  machine,
  path: '',
  branch: '',
  ownerId,
  purpose: '',
  status: '',
  note: '',
});

/** 頂部的新增表單：電腦 + 路徑即可送出；電腦名稱記在本機供下次預填 */
function AddRecordForm({ machineListId, defaultOwnerId }: { machineListId: string; defaultOwnerId: number }) {
  const [form, setForm] = useState(() => blank(readStorage(MACHINE_STORAGE_KEY) ?? '', defaultOwnerId));
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
          <StatusSelect
            kind="worktree"
            value={form.status}
            onChange={(status) => set({ status })}
            label="狀態"
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

function TrashConfirm({ record, onClose }: { record: WorktreeRecord; onClose: () => void }) {
  const del = useDeleteRecord();
  return (
    <Dialog
      open
      size="sm"
      role="alertdialog"
      title="移到回收區？"
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={del.isPending}
            onClick={() =>
              del.mutate(record.id, {
                onSuccess: () => {
                  notifySuccess('已移到回收區，可在「回收區」還原');
                  onClose();
                },
              })
            }
            data-autofocus
          >
            移到回收區
          </Button>
        </>
      }
    >
      {del.error != null && <Alert tone="danger">{errorMessage(del.error)}</Alert>}
      <p className="eng-dialog-text">
        紀錄會移到回收區，隨時可以還原；不會變更任何電腦上的 worktree 或分支。
      </p>
    </Dialog>
  );
}

function PathCell({ branch, path, sub }: { branch: string | null; path: string; sub?: string }) {
  return (
    <div className="eng-two-line">
      <span className="eng-mono">{branch || '（無分支）'}</span>
      <Tooltip content={path}>
        <span className="eng-path eng-ellipsis" tabIndex={0} aria-label={`路徑 ${path}`}>
          {path}
        </span>
      </Tooltip>
      {sub && <span className="eng-sub eng-ellipsis">{sub}</span>}
    </div>
  );
}

function HintCell({
  record,
  report,
  readOnly,
}: {
  record: MachineGroup['records'][number];
  report: WorktreeReport | undefined;
  readOnly: boolean;
}) {
  const save = useSaveRecord();
  if (record.hint === 'moved' && record.moveTo) {
    const to = record.moveTo.path;
    return (
      <div className="eng-hint">
        <Badge tone="accent">可能是搬動 / 改名</Badge>
        <Tooltip content={to}>
          <span className="eng-path eng-ellipsis" tabIndex={0}>
            → {to}
          </span>
        </Tooltip>
        {!readOnly && (
          <Button
            size="sm"
            variant="secondary"
            loading={save.isPending}
            onClick={() =>
              save.mutate({ id: record.id, path: to }, { onSuccess: () => notifySuccess('已更新路徑') })
            }
          >
            更新路徑
          </Button>
        )}
      </div>
    );
  }
  if (record.hint === 'vanished') {
    return (
      <Badge tone="warning">
        回報中找不到（上次看到 {record.lastSeenAt != null ? ago(record.lastSeenAt) : '—'}）
      </Badge>
    );
  }
  if (record.hint === 'missing') return <Badge tone="danger">可能遺失</Badge>;
  if (!report) return <span className="eng-text-tertiary">—</span>;
  return <span className="eng-sub">{reportSummary(report)}</span>;
}

function RecordRow({
  record,
  group,
  readOnly,
  onEdit,
  onDelete,
}: {
  record: MachineGroup['records'][number];
  group: MachineGroup;
  readOnly: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const byId = useUsersById();
  const statusList = useStatusList('worktree');
  const save = useSaveRecord();
  const owner = record.ownerId != null ? byId.get(record.ownerId) : undefined;
  const name = record.branch || record.path;
  const items: MenuItem[] = [
    { key: 'edit', label: '編輯', onSelect: onEdit },
    { key: 'sep', separator: true },
    { key: 'delete', label: '移到回收區', danger: true, onSelect: onDelete },
  ];
  const detail = [record.purpose, record.note].filter(Boolean).join(' · ');
  const sub = [
    record.repo,
    record.source === 'scan'
      ? '掃描登記'
      : record.source === 'report'
        ? '由回報登記'
        : record.source === 'paste'
          ? '貼上登記'
          : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <tr className="eng-wt-row" data-kind="record" data-hint={record.hint ?? undefined}>
      <td>
        {readOnly ? (
          <Badge tone={statusView(statusList, 'worktree', record.status).color} dot>
            {statusView(statusList, 'worktree', record.status).label}
          </Badge>
        ) : (
          <span className="eng-status-select">
            <StatusSelect
              kind="worktree"
              badge
              value={record.status}
              onChange={(status) => save.mutate({ id: record.id, status })}
              label={`「${name}」的狀態`}
            />
          </span>
        )}
      </td>
      <td className="eng-col-path">
        <PathCell branch={record.branch} path={record.path} sub={sub || undefined} />
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
        <HintCell record={record} report={reportFor(group, record.path)} readOnly={readOnly} />
      </td>
      <td>
        <UpdatedAt at={record.updatedAt} by={record.updatedBy} />
      </td>
      <td className="eng-col-action">
        {!readOnly && (
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
        )}
      </td>
    </tr>
  );
}

/** 回報有、紀錄沒有：標「未登記」，一鍵登記為紀錄（帶入電腦識別碼與 HEAD） */
function UnregisteredRow({
  report,
  group,
  readOnly,
}: {
  report: WorktreeReport;
  group: MachineGroup;
  readOnly: boolean;
}) {
  const save = useSaveRecord();
  const me = useCurrentUser();
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
        <span className="eng-sub">{reportSummary(report)}</span>
      </td>
      <td>
        <UpdatedAt at={report.reportedAt} prefix="回報於" />
      </td>
      <td className="eng-col-action">
        {!readOnly && (
          <Button
            size="sm"
            variant="secondary"
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                machine: group.machine,
                machineId: report.machineId ?? group.machineId ?? undefined,
                path: report.path,
                branch: report.branch ?? '',
                repo: report.repo,
                headSha: report.headSha,
                source: 'report',
                ...(me ? { ownerId: me.id } : {}),
                ...(report.isMerged ? { status: 'merged' } : {}),
              })
            }
          >
            登記
          </Button>
        )}
      </td>
    </tr>
  );
}

const PENDING_TEXT = (r: MachineRepo) =>
  r.pending?.reason === 'empty'
    ? `「${r.repo || '（未命名 repo）'}」最新回報為空清單（先前 ${r.pending.previous} 筆），已保留舊資料。`
    : `「${r.repo || '（未命名 repo）'}」回報筆數驟減（${r.pending?.previous} → ${r.pending?.count}），已保留舊資料。`;

function PendingNotice({ repo, readOnly }: { repo: MachineRepo; readOnly: boolean }) {
  const act = usePendingReport();
  const canEdit = useCan('eng.edit');
  return (
    <Alert tone="warning">
      <div className="eng-pending" data-testid="pending-report">
        <span>
          <strong>可疑回報：</strong>
          {PENDING_TEXT(repo)}
          {repo.pending && <span className="eng-text-secondary">（{ago(repo.pending.at)}）</span>}
          確認是真的清掉了才採用；採用後不見的項目只會標示「回報中找不到」，紀錄不會被刪除。
        </span>
        {canEdit && !readOnly && (
          <span className="eng-pending-actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={act.isPending}
              onClick={() => act.mutate({ sourceId: repo.sourceId, action: 'discard' })}
            >
              保留舊資料
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={act.isPending}
              onClick={() =>
                act.mutate(
                  { sourceId: repo.sourceId, action: 'accept' },
                  { onSuccess: () => notifySuccess('已採用這次回報') },
                )
              }
            >
              確認採用這次回報
            </Button>
          </span>
        )}
      </div>
    </Alert>
  );
}

function MachineSection({
  slice,
  showDone,
  readOnly,
  onEdit,
  onDelete,
}: {
  slice: MachineSlice;
  showDone: boolean;
  readOnly: boolean;
  onEdit: (r: WorktreeRecord) => void;
  onDelete: (r: WorktreeRecord) => void;
}) {
  const { group } = slice;
  const statuses = useStatusList('worktree');
  const unregistered = slice.extras ? unregisteredReports(group) : [];
  const records = showDone ? slice.records : slice.records.filter((r) => !isDoneRecord(statuses, r.status));
  const pending = slice.extras ? group.repos.filter((r) => r.pending) : [];
  return (
    <section
      className="eng-card eng-machine"
      aria-label={`電腦 ${group.machine}`}
      data-stale={group.stale || undefined}
    >
      <header className="eng-machine-head">
        <h4 className="eng-machine-name">
          {group.machine}
          {group.machineId && (
            <span className="eng-machine-id" title={`電腦識別碼 ${group.machineId}`}>
              #{group.machineId.slice(0, 6)}
            </span>
          )}
        </h4>
        {pending.length > 0 && <Badge tone="danger">可疑回報待確認</Badge>}
        {group.stale && group.reportedAt != null && (
          <Badge tone="warning">未回報（最後看到 {ago(group.reportedAt)}）</Badge>
        )}
        <span className="eng-sync eng-text-secondary">
          {group.reportedAt != null ? (
            <UpdatedAt at={group.reportedAt} prefix="回報於" />
          ) : (
            '尚未回報（僅手動紀錄）'
          )}
        </span>
      </header>
      {pending.map((r) => (
        <PendingNotice key={r.sourceId} repo={r} readOnly={readOnly} />
      ))}
      {records.length + unregistered.length === 0 ? (
        <p className="eng-help eng-machine-empty">
          {slice.records.length > 0 ? '這台電腦的紀錄都已結束（勾選「顯示已清理」查看）' : '沒有紀錄'}
        </p>
      ) : (
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
              {records.map((r) => (
                <RecordRow
                  key={`rec-${r.id}`}
                  record={r}
                  group={group}
                  readOnly={readOnly}
                  onEdit={() => onEdit(r)}
                  onDelete={() => onDelete(r)}
                />
              ))}
              {unregistered.map((r) => (
                <UnregisteredRow key={`rep-${r.id}`} report={r} group={group} readOnly={readOnly} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function OwnerTitle({ owner, title }: { owner: Parameters<typeof Avatar>[0]['user']; title: string }) {
  return (
    <>
      <Avatar user={owner} size="sm" tooltip={false} />
      <h3 className="eng-owner-name-title">{title}</h3>
    </>
  );
}

/** 成員卡片：第一層是成員（負責人），內含以電腦分組的第二層；全部成員檢視時可摺疊 */
function OwnerCard({
  bucket,
  me,
  showDone,
  readOnly,
  collapsible,
  collapsed,
  onToggle,
  onEdit,
  onDelete,
}: {
  bucket: OwnerBucket;
  me: number;
  showDone: boolean;
  readOnly: boolean;
  collapsible: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onEdit: (r: WorktreeRecord) => void;
  onDelete: (r: WorktreeRecord) => void;
}) {
  const byId = useUsersById();
  const statuses = useStatusList('worktree');
  const bodyId = useId();
  const owner = bucket.ownerId != null ? byId.get(bucket.ownerId) : undefined;
  const title =
    bucket.ownerId == null
      ? '未指派'
      : bucket.ownerId === me
        ? '我自己'
        : (owner?.displayName ?? `使用者 ${bucket.ownerId}`);
  const summary = countByStatus(bucket.slices.flatMap((s) => s.records));
  return (
    <section
      className="eng-card eng-owner-card"
      aria-label={`成員 ${title}`}
      data-owner={bucket.key}
      data-collapsed={collapsed || undefined}
    >
      <header className="eng-owner-head">
        {collapsible ? (
          <button
            type="button"
            className="eng-owner-toggle"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={onToggle}
          >
            <span className="eng-owner-chevron" aria-hidden="true">
              {collapsed ? '▸' : '▾'}
            </span>
            <OwnerTitle owner={owner ?? null} title={title} />
          </button>
        ) : (
          <span className="eng-owner-toggle eng-owner-toggle--static">
            <OwnerTitle owner={owner ?? null} title={title} />
          </span>
        )}
        <span className="eng-owner-count tabular-nums" data-testid="owner-count">
          {bucket.count} 筆
        </span>
        <span className="eng-owner-summary">
          {summary.map((c) => (
            <Badge key={c.status} tone={statusView(statuses, 'worktree', c.status).color} dot>
              {statusView(statuses, 'worktree', c.status).label} {c.count}
            </Badge>
          ))}
        </span>
      </header>
      {!collapsed && (
        <div className="eng-owner-body" id={bodyId}>
          {bucket.slices.length === 0 ? (
            <p className="eng-help eng-machine-empty">沒有紀錄</p>
          ) : (
            bucket.slices.map((s) => (
              <MachineSection
                key={s.group.key}
                slice={s}
                showDone={showDone}
                readOnly={readOnly}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 工作樹分頁：「檢視」切換成員（?user=<id|all>，預設我自己）。
 * 第一層是成員（負責人）、第二層是電腦；檢視他人時為唯讀（只是前端模式，權限仍由 eng.edit 決定）。
 */
export function WorktreesTab({
  query,
}: {
  query: { data?: WorktreesOverview; error: unknown; refetch: () => void };
}) {
  const machineListId = useId();
  const me = useCurrentUser();
  const users = useUsers();
  const [sp, setSp] = useSearchParams();
  const [editing, setEditing] = useState<WorktreeRecord | null>(null);
  const [deleting, setDeleting] = useState<WorktreeRecord | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  /** 電腦篩選（'' = 全部）；貼上登記後自動套用 */
  const [machineFilter, setMachineFilter] = useState('');
  const [trashOpen, setTrashOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const canScan = useCan('eng.scan');
  const canEdit = useCan('eng.edit');
  const statuses = useStatusList('worktree');
  const data = query.data;
  const meId = me?.id ?? 0;
  const view = readPersonView(sp.get(VIEW_PARAM), meId);
  const trash = useTrash(view.kind === 'user');
  const allMachines = useMemo(() => data?.machines ?? [], [data]);
  const filterKey = machineFilter.trim().toLowerCase();
  const machines = useMemo(
    () => (filterKey ? allMachines.filter((g) => g.machine.trim().toLowerCase() === filterKey) : allMachines),
    [allMachines, filterKey],
  );
  const machineOptions = useMemo(
    () => [
      { value: '', label: '全部電腦' },
      ...allMachines.map((g) => ({ value: g.machine.trim().toLowerCase(), label: g.machine })),
    ],
    [allMachines],
  );
  const nameById = useMemo(() => new Map((users.data ?? []).map((u) => [u.id, u.displayName])), [users.data]);
  const nameOf = (id: number) => nameById.get(id) ?? `使用者 ${id}`;
  const buckets =
    view.kind === 'invalid'
      ? []
      : groupByOwner(machines, view.kind === 'all' ? { kind: 'all' } : view, meId, nameOf);
  const viewOptions = useMemo<SelectOption<string>[]>(() => {
    if (!me) return [];
    const others = (users.data ?? [])
      .filter((u) => u.isActive && u.id !== me.id)
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hant'));
    return [
      { value: String(me.id), label: '我自己', leading: <Avatar user={me} size="xs" tooltip={false} /> },
      ...others.map((u) => ({
        value: String(u.id),
        label: u.displayName,
        leading: <Avatar user={u} size="xs" tooltip={false} />,
      })),
      { value: VIEW_ALL, label: '全部成員' },
    ];
  }, [me, users.data]);

  if (!me) return null;

  const otherId = view.kind === 'user' && view.id !== me.id ? view.id : null;
  const other = otherId != null ? users.data?.find((u) => u.id === otherId) : undefined;
  const notFound =
    view.kind === 'invalid' || (otherId != null && users.data != null && (!other || !other.isActive));
  const readOnly = otherId != null;
  const switchTo = (value: string) => setSp(writePersonView(sp, value, me.id));

  if (notFound) {
    return (
      <section className="eng-section" aria-label="工作樹">
        <div className="eng-card">
          <EmptyState
            icon="user"
            title="找不到此成員"
            action={
              <Button variant="secondary" onClick={() => switchTo(String(me.id))}>
                回到我自己
              </Button>
            }
          />
        </div>
      </section>
    );
  }

  const doneCount = buckets.reduce(
    (n, b) =>
      n + b.slices.reduce((m, s) => m + s.records.filter((r) => isDoneRecord(statuses, r.status)).length, 0),
    0,
  );
  const scopeTotal = buckets.reduce((n, b) => n + b.count, 0);
  const selfView = view.kind === 'user' && view.id === me.id;
  const unassigned = data ? unassignedCount(allMachines) : 0;
  const extras = data ? extrasCount(allMachines) : 0;
  const trashCount =
    view.kind === 'user'
      ? trash.data
        ? inView(trash.data.records, view).length
        : undefined
      : data?.trashCount;
  const viewLabel =
    view.kind === 'all' ? '全部成員' : otherId != null ? (other?.displayName ?? '…') : '我自己';
  const hrefOf = (value: string) => `?${writePersonView(sp, value, me.id).toString()}`;

  return (
    <section className="eng-section" aria-label="工作樹">
      <NameList id={machineListId} names={allMachines.map((m) => m.machine)} />
      <div className="eng-viewbar">
        {readOnly && (
          <Alert
            tone="info"
            className="eng-viewbar-note"
            action={
              <a
                href={hrefOf(String(me.id))}
                className="eng-link"
                onClick={(e) => {
                  e.preventDefault();
                  switchTo(String(me.id));
                }}
              >
                回到我自己
              </a>
            }
          >
            <span data-testid="readonly-note">正在檢視 {other?.displayName ?? '…'} 的工作樹（唯讀）</span>
          </Alert>
        )}
        <div className="eng-viewbar-switch">
          <span className="eng-viewbar-label" aria-hidden="true">
            檢視：
          </span>
          <Select
            aria-label="檢視成員的工作樹"
            className="eng-viewbar-select"
            align="end"
            placeholder={viewLabel}
            options={viewOptions}
            value={view.kind === 'all' ? VIEW_ALL : String(view.kind === 'user' ? view.id : me.id)}
            onChange={switchTo}
          />
        </div>
      </div>
      {selfView && (unassigned > 0 || extras > 0) && (
        <p className="eng-help eng-unassigned-note" data-testid="unassigned-note">
          {unassigned > 0 && <>有 {unassigned} 筆未指派的工作樹</>}
          {unassigned > 0 && extras > 0 && '，'}
          {extras > 0 && <>另有 {extras} 筆未登記 / 待確認的回報</>}。{' '}
          <a
            href={hrefOf(VIEW_ALL)}
            className="eng-link"
            onClick={(e) => {
              e.preventDefault();
              switchTo(VIEW_ALL);
            }}
          >
            前往「全部成員」
          </a>
        </p>
      )}
      {!readOnly && <AddRecordForm machineListId={machineListId} defaultOwnerId={me.id} />}

      <div className="eng-toolbar">
        <Checkbox
          label={`顯示已清理（${doneCount}）`}
          checked={showDone}
          onChange={(e) => setShowDone(e.target.checked)}
        />
        {allMachines.length > 0 && (
          <span className="eng-machine-filter">
            <Select
              options={machineOptions}
              value={machineOptions.some((o) => o.value === filterKey) ? filterKey : ''}
              onChange={setMachineFilter}
              aria-label="依電腦篩選"
            />
          </span>
        )}
        {data && (
          <span className="eng-help tabular-nums" data-testid="scope-total">
            共 {scopeTotal} 筆
          </span>
        )}
        <span className="eng-toolbar-end">
          {!readOnly && <ManageStatusesButton kind="worktree" />}
          <Button
            variant="ghost"
            size="sm"
            icon={<EngIcon name="trash" />}
            onClick={() => setTrashOpen(true)}
          >
            回收區{trashCount != null ? `（${trashCount}）` : ''}
          </Button>
          {canEdit && !readOnly && (
            <Button variant="secondary" size="sm" icon="plus" onClick={() => setPasteOpen(true)}>
              貼上 git worktree list
            </Button>
          )}
          {canScan && !readOnly && (
            <Button variant="secondary" size="sm" icon="refresh" onClick={() => setScanOpen(true)}>
              掃描本機專案
            </Button>
          )}
        </span>
      </div>

      {data && !data.reportEnabled && (
        <p className="eng-help">
          伺服器未設定 <code>WORKTREE_REPORT_TOKEN</code>，各電腦的自動回報目前停用；手動紀錄不受影響。
        </p>
      )}
      {data?.reportEnabled && (
        <p className="eng-help">
          在各人電腦的 repo 目錄執行 <code>node scripts/report-worktrees.mjs --server &lt;網址&gt;</code>{' '}
          即可回報；每台電腦以識別碼區分（改名不影響）。回報中不見的項目只會標示，紀錄一律保留；空清單或筆數驟減的回報需要確認才採用。
        </p>
      )}

      {!data && query.error ? (
        <ErrorState error={query.error} onRetry={query.refetch} />
      ) : !data || (otherId != null && !users.data) ? (
        <div className="eng-card eng-machine" aria-busy="true">
          <Skeleton height={160} />
        </div>
      ) : buckets.every((b) => b.slices.length === 0) ? (
        <div className="eng-card">
          <EmptyState
            icon="branch"
            title={
              readOnly ? `${other?.displayName ?? '此成員'} 尚未記錄任何 worktree` : '尚未記錄任何 worktree'
            }
            description={
              readOnly
                ? undefined
                : canEdit
                  ? '在上方填入電腦與路徑，或按「貼上 git worktree list」一次登記'
                  : '在上方填入電腦與路徑即可新增'
            }
          />
        </div>
      ) : (
        buckets.map((b) => (
          <OwnerCard
            key={b.key}
            bucket={b}
            me={me.id}
            showDone={showDone}
            readOnly={readOnly}
            collapsible={view.kind === 'all'}
            collapsed={view.kind === 'all' && collapsed.has(b.key)}
            onToggle={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(b.key)) next.delete(b.key);
                else next.add(b.key);
                return next;
              })
            }
            onEdit={setEditing}
            onDelete={setDeleting}
          />
        ))
      )}
      {editing && (
        <RecordDialog record={editing} machineListId={machineListId} onClose={() => setEditing(null)} />
      )}
      {deleting && <TrashConfirm record={deleting} onClose={() => setDeleting(null)} />}
      {pasteOpen && (
        <PasteDialog
          machineNames={allMachines.map((m) => m.machine)}
          defaultOwnerId={me.id}
          onClose={() => setPasteOpen(false)}
          onDone={(m) => setMachineFilter(m.trim().toLowerCase())}
        />
      )}
      {scanOpen && data && (
        <ScanDialog scan={data.scan} defaultOwnerId={me.id} onClose={() => setScanOpen(false)} />
      )}
      {trashOpen && (
        <TrashDialog
          view={view.kind === 'user' ? view : { kind: 'all' }}
          onClose={() => setTrashOpen(false)}
        />
      )}
    </section>
  );
}
