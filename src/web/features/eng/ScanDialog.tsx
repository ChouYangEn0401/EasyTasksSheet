import { useId, useState, type FormEvent } from 'react';
import type { ScanAction, ScanItem, ScanPreview, WorktreesOverview } from '../../../shared/engManual.ts';
import { errorMessage } from '../../lib/api.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
import { notifySuccess } from '../../lib/toast.ts';
import { Alert, Badge, Button, Dialog, Field, Input, Select } from '../../ui/index.ts';
import { NONE, useUserOptions } from './userOptions.ts';
import { useScanApply, useScanPreview } from './api.ts';
import { NameList } from './bits.tsx';
import { pathKey, rememberPath, reportSummary, SCAN_PATHS_KEY } from './model.ts';

const ACTION_LABEL: Record<ScanAction, string> = {
  new: '新發現',
  moved: '可能搬動',
  existing: '已登記',
};
const ACTION_TONE = { new: 'success', moved: 'accent', existing: 'neutral' } as const;

function readPaths(): string[] {
  try {
    const v = JSON.parse(readStorage(SCAN_PATHS_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 掃描本機專案：輸入資料夾 → 預覽（新增 / 已存在 / 可能搬動）→ 勾選後登記。需 eng.scan */
export function ScanDialog({
  scan,
  defaultOwnerId,
  onClose,
}: {
  scan: WorktreesOverview['scan'];
  /** 負責人預設（目前登入者） */
  defaultOwnerId: number;
  onClose: () => void;
}) {
  const listId = useId();
  const [recent, setRecent] = useState(readPaths);
  const [path, setPath] = useState(() => recent[0] ?? '');
  const [machine, setMachine] = useState(scan.machine ?? '');
  const [ownerId, setOwnerId] = useState(defaultOwnerId);
  const ownerOptions = useUserOptions(ownerId).filter((o) => o.value !== NONE);
  const [preview, setPreview] = useState<ScanPreview | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const run = useScanPreview();
  const apply = useScanApply();

  const doPreview = (e?: FormEvent) => {
    e?.preventDefault();
    const p = path.trim();
    if (!p || run.isPending) return;
    run.mutate(
      { path: p, machine: machine.trim() || undefined },
      {
        onSuccess: (res) => {
          const next = rememberPath(recent, p);
          setRecent(next);
          writeStorage(SCAN_PATHS_KEY, JSON.stringify(next));
          setPreview(res);
          setPicked(new Set(res.items.filter((i) => i.action !== 'existing').map((i) => pathKey(i.path))));
        },
      },
    );
  };

  const toggle = (item: ScanItem) =>
    setPicked((s) => {
      const next = new Set(s);
      const k = pathKey(item.path);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const doApply = () => {
    if (!preview || picked.size === 0) return;
    apply.mutate(
      {
        path: path.trim(),
        machine: machine.trim() || undefined,
        paths: preview.items.filter((i) => picked.has(pathKey(i.path))).map((i) => i.path),
        ownerId,
      },
      {
        onSuccess: (res) => {
          notifySuccess(`已登記 ${res.created} 筆${res.moved ? `、更新路徑 ${res.moved} 筆` : ''}`);
          onClose();
        },
      },
    );
  };

  const disabled = !scan.enabled;
  return (
    <Dialog
      open
      size="md"
      title="掃描本機專案"
      onClose={onClose}
      dirty={preview != null}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          {preview ? (
            <Button
              variant="primary"
              disabled={picked.size === 0}
              loading={apply.isPending}
              onClick={doApply}
            >
              登記（{picked.size}）
            </Button>
          ) : (
            <Button
              variant="primary"
              type="submit"
              form="eng-scan-form"
              disabled={disabled || !path.trim()}
              loading={run.isPending}
            >
              預覽
            </Button>
          )}
        </>
      }
    >
      {disabled ? (
        <Alert tone="info">
          <span data-testid="scan-disabled">
            此功能目前停用。管理員在伺服器的 <code>.env</code> 設定 <code>WORKTREE_SCAN_ROOTS</code>
            （允許掃描的資料夾，逗號分隔，例如 <code>C:\work,D:\repos</code>）並重新啟動後即可使用；
            也可以在自己的電腦執行 <code>python -m server.cli scan-worktrees &lt;專案資料夾&gt;</code>。
          </span>
        </Alert>
      ) : (
        <form id="eng-scan-form" className="eng-form" onSubmit={doPreview}>
          <NameList id={listId} names={recent} />
          <Field
            label="專案資料夾"
            hint={scan.roots?.length ? `允許的範圍：${scan.roots.join('、')}` : undefined}
          >
            <Input
              className="eng-mono"
              data-autofocus
              list={listId}
              value={path}
              maxLength={1000}
              placeholder="C:\work\my-repo"
              onChange={(e) => {
                setPath(e.target.value);
                setPreview(null);
              }}
            />
          </Field>
          <Field label="電腦名稱" hint="登記到哪台電腦（預設為伺服器這台）">
            <Input
              value={machine}
              maxLength={100}
              onChange={(e) => {
                setMachine(e.target.value);
                setPreview(null);
              }}
            />
          </Field>
          <Field label="負責人" hint="新登記的紀錄會歸給這位成員（預設是你）">
            <Select options={ownerOptions} value={ownerId} onChange={setOwnerId} aria-label="登記的負責人" />
          </Field>
          <p className="eng-help">只會讀取 git 資訊（不 fetch、不執行 hook），預覽不會寫入任何資料。</p>
        </form>
      )}
      {run.error != null && <Alert tone="danger">{errorMessage(run.error)}</Alert>}
      {apply.error != null && <Alert tone="danger">{errorMessage(apply.error)}</Alert>}
      {preview && (
        <div className="eng-scan" data-testid="scan-preview">
          <p className="eng-scan-summary">
            <strong>{preview.repo}</strong>（{preview.machine}）：新增 {preview.counts.new}、已存在{' '}
            {preview.counts.existing}、可能搬動 {preview.counts.moved}
            {preview.truncated && '（數量過多，只列出前 200 個）'}
          </p>
          {preview.items.length === 0 ? (
            <p className="eng-help">這個專案沒有其他 worktree。</p>
          ) : (
            <ul className="eng-scan-list">
              {preview.items.map((i) => {
                const k = pathKey(i.path);
                const existing = i.action === 'existing';
                return (
                  <li key={k} className="eng-scan-item" data-action={i.action}>
                    <label className="eng-scan-label">
                      <input
                        type="checkbox"
                        className="ui-checkbox"
                        checked={picked.has(k)}
                        disabled={existing}
                        onChange={() => toggle(i)}
                        aria-label={`登記 ${i.branch ?? i.path}`}
                      />
                      <span className="eng-two-line">
                        <span className="eng-scan-head">
                          <Badge tone={ACTION_TONE[i.action]}>{ACTION_LABEL[i.action]}</Badge>
                          <span className="eng-mono">{i.branch ?? '（分離 HEAD）'}</span>
                        </span>
                        <span className="eng-path eng-ellipsis" title={i.path}>
                          {i.path}
                        </span>
                        <span className="eng-sub">
                          {i.action === 'moved' ? `原路徑 ${i.recordPath} · ` : ''}
                          {reportSummary(i)}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
