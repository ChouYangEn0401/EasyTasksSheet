import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { PasteItem, PastePreview } from '../../../shared/engManual.ts';
import { errorMessage } from '../../lib/api.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
import { notifySuccess } from '../../lib/toast.ts';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Spinner,
  Textarea,
  Tooltip,
} from '../../ui/index.ts';
import { usePasteApply, usePastePreview } from './api.ts';
import { NameList } from './bits.tsx';
import { StatusSelect } from './EngStatus.tsx';
import { MACHINE_STORAGE_KEY } from './model.ts';
import {
  defaultPicked,
  DEFAULT_PASTE_MACHINE,
  dropUnpickable,
  isPickable,
  middleEllipsis,
  pasteSummary,
  pasteTags,
  pickAll,
  pickedLines,
  pickNone,
  pickNonTemp,
  togglePick,
} from './pasteModel.ts';

const PREVIEW_DELAY_MS = 350;

/**
 * 貼上 git worktree list 輸出：貼上文字 → 自動預覽（新增 / 已存在 / 可能搬動）→ 勾選 → 登記。
 * 只解析文字，不執行任何 git，不需要資料夾路徑；需 eng.edit。
 */
export function PasteDialog({
  machineNames,
  onClose,
  onDone,
}: {
  machineNames: string[];
  onClose: () => void;
  /** 登記完成：帶回電腦名稱（工作樹分頁據此套用電腦篩選） */
  onDone: (machine: string) => void;
}) {
  const listId = useId();
  const [text, setText] = useState('');
  const [machine, setMachine] = useState(() => readStorage(MACHINE_STORAGE_KEY) ?? DEFAULT_PASTE_MACHINE);
  const [repo, setRepo] = useState('');
  const [repoEdited, setRepoEdited] = useState(false);
  const [status, setStatus] = useState('active');
  const [updateExisting, setUpdateExisting] = useState(false);
  const [preview, setPreview] = useState<PastePreview | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<number>>(pickNone);
  const run = usePastePreview();
  const apply = usePasteApply();
  const seq = useRef(0);

  const machineName = machine.trim() || DEFAULT_PASTE_MACHINE;
  const repoArg = repoEdited ? repo.trim() || undefined : undefined;
  const { mutate: runPreview } = run;

  // 貼上 / 修改內容、電腦名稱、Repo 名稱後稍待片刻自動預覽（只送文字，不寫入任何資料）
  useEffect(() => {
    if (!text.trim()) return;
    const id = ++seq.current;
    const timer = window.setTimeout(() => {
      runPreview(
        { text, machine: machineName, repo: repoArg },
        {
          onSuccess: (res) => {
            if (id !== seq.current) return; // 已有較新的請求
            setPreview(res);
            setPicked(defaultPicked(res.items));
            if (!repoEdited) setRepo(res.repoGuess);
          },
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text, machineName, repoArg, repoEdited, runPreview]);

  const items = useMemo(() => preview?.items ?? [], [preview]);
  const lines = pickedLines(items, picked, updateExisting);
  const canApply = preview != null && lines.length > 0 && !apply.isPending && !run.isPending;

  const doApply = () => {
    if (!canApply) return;
    apply.mutate(
      {
        text,
        machine: machineName,
        repo: repo.trim() || undefined,
        selected: lines,
        updateExisting,
        status,
      },
      {
        onSuccess: (res) => {
          writeStorage(MACHINE_STORAGE_KEY, machineName);
          notifySuccess(pasteSummary(res));
          onDone(machineName);
          onClose();
        },
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doApply();
    }
  };

  const toggleExisting = (v: boolean) => {
    setUpdateExisting(v);
    if (!v) setPicked((p) => dropUnpickable(items, p, v));
  };

  const loading = run.isPending && preview == null;
  return (
    <Dialog
      open
      size="lg"
      title="貼上 git worktree list"
      onClose={onClose}
      dirty={text.trim() !== ''}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!canApply} loading={apply.isPending} onClick={doApply}>
            登記 {lines.length} 筆
          </Button>
        </>
      }
    >
      <div className="eng-paste" onKeyDown={onKeyDown}>
        <p className="eng-help">
          在專案資料夾執行 <code>git worktree list</code>，把輸出整段貼到下面即可（也支援{' '}
          <code>--porcelain</code>）。PowerShell 可用 <code>git worktree list | Set-Clipboard</code>{' '}
          直接複製。這裡只解析文字，不會執行任何指令。
        </p>
        <Field label="git worktree list 輸出">
          <Textarea
            className="eng-mono eng-paste-text"
            data-autofocus
            data-testid="paste-text"
            rows={6}
            spellCheck={false}
            value={text}
            maxLength={200_000}
            placeholder={'C:/work/my-repo  80a0d97a [main]\nC:/work/my-repo-wt  16687b8d [feat/x]'}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <NameList id={listId} names={machineNames} />
        <div className="eng-paste-fields">
          <Field label="電腦名稱" hint="必填；會記住上次輸入">
            <Input
              list={listId}
              value={machine}
              maxLength={100}
              placeholder={DEFAULT_PASTE_MACHINE}
              onChange={(e) => setMachine(e.target.value)}
            />
          </Field>
          <Field label="專案 / Repo 名稱" hint="預設取第一筆（主 worktree）的資料夾名稱">
            <Input
              value={repo}
              maxLength={100}
              onChange={(e) => {
                setRepo(e.target.value);
                setRepoEdited(true);
              }}
            />
          </Field>
        </div>

        {run.error != null && <Alert tone="danger">{errorMessage(run.error)}</Alert>}
        {apply.error != null && <Alert tone="danger">{errorMessage(apply.error)}</Alert>}
        {loading && (
          <p className="eng-help eng-paste-loading" role="status">
            <Spinner /> 解析中…
          </p>
        )}

        {preview && (
          <div className="eng-scan" data-testid="paste-preview" aria-busy={run.isPending}>
            <p className="eng-scan-summary" data-testid="paste-summary">
              <strong>{preview.repo || '（未命名）'}</strong>（{preview.machine}）：新增 {preview.counts.new}
              、已存在 {preview.counts.existing}、可能搬動 {preview.counts.moved}
              {preview.truncated && '（超過 500 筆，只列出前 500 筆）'}
            </p>
            <div className="eng-paste-bar">
              <span className="eng-paste-bulk">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setPicked(pickAll(items, updateExisting))}
                >
                  全選
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setPicked(pickNonTemp(items, updateExisting))}
                >
                  只選非暫時性
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setPicked(pickNone())}>
                  全不選
                </Button>
                <span className="eng-help" data-testid="paste-count">
                  已選 {lines.length} / {items.length}
                </span>
              </span>
              <span className="eng-paste-status">
                <span className="eng-help">登記為</span>
                <StatusSelect kind="worktree" value={status} onChange={setStatus} label="登記狀態" />
              </span>
            </div>
            <Checkbox
              label="同時更新已存在的紀錄（分支、HEAD、貼上匯入的備註）"
              checked={updateExisting}
              onChange={(e) => toggleExisting(e.target.checked)}
            />
            {items.length === 0 ? (
              <p className="eng-help">沒有辨識到任何 worktree。</p>
            ) : (
              <div className="eng-paste-scroll">
                <table className="eng-paste-table">
                  <thead>
                    <tr>
                      <th scope="col" className="eng-paste-col-check" aria-label="勾選" />
                      <th scope="col">路徑</th>
                      <th scope="col">分支</th>
                      <th scope="col" className="eng-paste-col-sha">
                        sha
                      </th>
                      <th scope="col">標籤</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <PasteRow
                        key={i.lineNo}
                        item={i}
                        checked={picked.has(i.lineNo)}
                        disabled={!isPickable(i, updateExisting)}
                        onToggle={() => setPicked((p) => togglePick(p, i.lineNo))}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.unparsedCount > 0 && (
              <details className="eng-paste-unparsed">
                <summary data-testid="paste-unparsed">有 {preview.unparsedCount} 行無法辨識</summary>
                <ul>
                  {preview.unparsed.map((u) => (
                    <li key={u.lineNo}>
                      <span className="eng-help">第 {u.lineNo} 行</span>{' '}
                      <code className="eng-mono">{u.text}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="eng-help">Ctrl+Enter 登記 · Esc 關閉 · 「暫時性」只是提示，仍可手動勾選</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function PasteRow({
  item,
  checked,
  disabled,
  onToggle,
}: {
  item: PasteItem;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const label = item.branch ?? item.path;
  return (
    <tr className="eng-paste-row" data-action={item.action} data-temp={item.isTemp || undefined}>
      <td className="eng-paste-col-check">
        <input
          type="checkbox"
          className="ui-checkbox"
          checked={checked && !disabled}
          disabled={disabled}
          onChange={onToggle}
          aria-label={`登記 ${label}`}
        />
      </td>
      <td>
        <span className="eng-path eng-mono eng-paste-path" title={item.path}>
          {middleEllipsis(item.path)}
        </span>
      </td>
      <td className="eng-mono">{item.branch ?? <span className="eng-text-secondary">（無）</span>}</td>
      <td className="eng-mono eng-paste-col-sha">{item.sha ? item.sha.slice(0, 8) : '—'}</td>
      <td>
        <span className="eng-paste-tags">
          {pasteTags(item).map((t) => (
            <Tooltip key={t.label} content={t.title}>
              <Badge tone={t.tone}>{t.label}</Badge>
            </Tooltip>
          ))}
        </span>
      </td>
    </tr>
  );
}
