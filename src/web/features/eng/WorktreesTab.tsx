import { useId, useMemo, useState, type FormEvent } from 'react';
import type {
  MachineGroup,
  MachineRepo,
  WorktreeRecord,
  WorktreeReport,
  WorktreesOverview,
} from '../../../shared/engManual.ts';
import { errorMessage } from '../../lib/api.ts';
import { useUsersById } from '../../lib/hooks.ts';
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
  Skeleton,
  Textarea,
  Tooltip,
  UpdatedAt,
  type MenuItem,
} from '../../ui/index.ts';
import { useDeleteRecord, usePendingReport, useSaveRecord } from './api.ts';
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
  unregisteredReports,
} from './model.ts';

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
const blank = (machine = ''): Draft => ({
  machine,
  path: '',
  branch: '',
  ownerId: null,
  purpose: '',
  status: '',
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
}: {
  record: MachineGroup['records'][number];
  report: WorktreeReport | undefined;
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
        <span className="eng-status-select">
          <StatusSelect
            kind="worktree"
            badge
            value={record.status}
            onChange={(status) => save.mutate({ id: record.id, status })}
            label={`「${name}」的狀態`}
          />
        </span>
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
        <HintCell record={record} report={reportFor(group, record.path)} />
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

/** 回報有、紀錄沒有：標「未登記」，一鍵登記為紀錄（帶入電腦識別碼與 HEAD） */
function UnregisteredRow({ report, group }: { report: WorktreeReport; group: MachineGroup }) {
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
        <span className="eng-sub">{reportSummary(report)}</span>
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
              machine: group.machine,
              machineId: report.machineId ?? group.machineId ?? undefined,
              path: report.path,
              branch: report.branch ?? '',
              repo: report.repo,
              headSha: report.headSha,
              source: 'report',
              ...(report.isMerged ? { status: 'merged' } : {}),
            })
          }
        >
          登記
        </Button>
      </td>
    </tr>
  );
}

const PENDING_TEXT = (r: MachineRepo) =>
  r.pending?.reason === 'empty'
    ? `「${r.repo || '（未命名 repo）'}」最新回報為空清單（先前 ${r.pending.previous} 筆），已保留舊資料。`
    : `「${r.repo || '（未命名 repo）'}」回報筆數驟減（${r.pending?.previous} → ${r.pending?.count}），已保留舊資料。`;

function PendingNotice({ repo }: { repo: MachineRepo }) {
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
        {canEdit && (
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
  group,
  showDone,
  onEdit,
  onDelete,
}: {
  group: MachineGroup;
  showDone: boolean;
  onEdit: (r: WorktreeRecord) => void;
  onDelete: (r: WorktreeRecord) => void;
}) {
  const statuses = useStatusList('worktree');
  const unregistered = unregisteredReports(group);
  const records = showDone ? group.records : group.records.filter((r) => !isDoneRecord(statuses, r.status));
  const pending = group.repos.filter((r) => r.pending);
  return (
    <section
      className="eng-card eng-machine"
      aria-label={`電腦 ${group.machine}`}
      data-stale={group.stale || undefined}
    >
      <header className="eng-machine-head">
        <h3 className="eng-machine-name">
          {group.machine}
          {group.machineId && (
            <span className="eng-machine-id" title={`電腦識別碼 ${group.machineId}`}>
              #{group.machineId.slice(0, 6)}
            </span>
          )}
        </h3>
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
        <PendingNotice key={r.sourceId} repo={r} />
      ))}
      {records.length + unregistered.length === 0 ? (
        <p className="eng-help eng-machine-empty">
          {group.records.length > 0 ? '這台電腦的紀錄都已結束（勾選「顯示已清理」查看）' : '沒有紀錄'}
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
                  onEdit={() => onEdit(r)}
                  onDelete={() => onDelete(r)}
                />
              ))}
              {unregistered.map((r) => (
                <UnregisteredRow key={`rep-${r.id}`} report={r} group={group} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** 工作樹分頁：新增表單在最上面；下方依電腦分組，並列手動紀錄與回報快照（僅供參考） */
export function WorktreesTab({
  query,
}: {
  query: { data?: WorktreesOverview; error: unknown; refetch: () => void };
}) {
  const machineListId = useId();
  const [editing, setEditing] = useState<WorktreeRecord | null>(null);
  const [deleting, setDeleting] = useState<WorktreeRecord | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  /** 電腦篩選（'' = 全部）；貼上登記後自動套用 */
  const [machineFilter, setMachineFilter] = useState('');
  const [trashOpen, setTrashOpen] = useState(false);
  const canScan = useCan('eng.scan');
  const canEdit = useCan('eng.edit');
  const statuses = useStatusList('worktree');
  const data = query.data;
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
  const doneCount = machines.reduce(
    (n, g) => n + g.records.filter((r) => isDoneRecord(statuses, r.status)).length,
    0,
  );

  return (
    <section className="eng-section" aria-label="工作樹">
      <NameList id={machineListId} names={allMachines.map((m) => m.machine)} />
      <AddRecordForm machineListId={machineListId} />

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
        <span className="eng-toolbar-end">
          <ManageStatusesButton kind="worktree" />
          <Button
            variant="ghost"
            size="sm"
            icon={<EngIcon name="trash" />}
            onClick={() => setTrashOpen(true)}
          >
            回收區{data ? `（${data.trashCount}）` : ''}
          </Button>
          {canEdit && (
            <Button variant="secondary" size="sm" icon="plus" onClick={() => setPasteOpen(true)}>
              貼上 git worktree list
            </Button>
          )}
          {canScan && (
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
      ) : !data ? (
        <div className="eng-card eng-machine" aria-busy="true">
          <Skeleton height={160} />
        </div>
      ) : machines.length === 0 ? (
        <div className="eng-card">
          <EmptyState
            icon="branch"
            title="尚未記錄任何 worktree"
            description={
              canEdit
                ? '在上方填入電腦與路徑，或按「貼上 git worktree list」一次登記'
                : '在上方填入電腦與路徑即可新增'
            }
          />
        </div>
      ) : (
        machines.map((g) => (
          <MachineSection
            key={g.key}
            group={g}
            showDone={showDone}
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
          onClose={() => setPasteOpen(false)}
          onDone={(m) => setMachineFilter(m.trim().toLowerCase())}
        />
      )}
      {scanOpen && data && <ScanDialog scan={data.scan} onClose={() => setScanOpen(false)} />}
      {trashOpen && <TrashDialog onClose={() => setTrashOpen(false)} />}
    </section>
  );
}
