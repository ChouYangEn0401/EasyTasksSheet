import { useRef, useState, type ChangeEvent } from 'react';
import {
  IMPORT_STRATEGIES,
  REPLACE_CONFIRM_TEXT,
  type ConflictResolution,
  type ImportConflict,
  type ImportMode,
  type ImportPreview,
  type ImportResult,
  type ImportStrategy,
  type MissingUsersPolicy,
} from '../../../shared/dataTransfer.ts';
import { ApiError, errorMessage } from '../../lib/api.ts';
import { useCurrentUser } from '../../lib/auth.ts';
import { useCan } from '../../lib/permissions.ts';
import { formatDateTime } from '../../lib/format.ts';
import { Alert, Badge, Button, Dialog, Field, Input, Select } from '../../ui/index.ts';
import { NoPermission } from './AdminUsersPage.tsx';
import {
  DATA_BACKUP_URL,
  DATA_EXPORT_URL,
  startDownload,
  useImportApply,
  useImportPreview,
} from './dataApi.ts';
import {
  countUseImport,
  effectiveResolution,
  formatValue,
  NEWER_LABELS,
  RESOLUTION_LABELS,
  resultTotals,
  STRATEGY_LABELS,
  totalNew,
  readJsonFile,
} from './dataModel.ts';
import './admin.css';

/**
 * 資料管理（/admin/data）。docs/design/data-export.md、docs/permissions.md：
 * JSON 匯出、合併匯入為 manager 以上；完整備份下載、取代全部只對 root（data.backup_db / data.import_replace）顯示。
 */
export function DataPage() {
  const me = useCurrentUser();
  const canExport = useCan('data.export_json');
  const canBackup = useCan('data.backup_db');
  const canImport = useCan('data.import_merge');
  const canReplace = useCan('data.import_replace');
  if (!me) return null;
  if (!canExport && !canImport) return <NoPermission />;
  return (
    <div className="adm-page dat-page">
      {canExport && <ExportSection canBackup={canBackup} />}
      {canImport && <ImportSection canReplace={canReplace} />}
    </div>
  );
}

// ── 匯出 ────────────────────────────────────────────────────

function ExportSection({ canBackup }: { canBackup: boolean }) {
  const [confirmBackup, setConfirmBackup] = useState(false);
  return (
    <section className="dat-card" aria-labelledby="dat-export-title">
      <h2 id="dat-export-title" className="dat-title">
        匯出
      </h2>
      <p className="dat-desc">
        <strong>JSON 匯出檔</strong>：全部任務、專案、狀態、自訂欄位、問題回饋、個人清單、工程追蹤與 GitHub
        連動設定，可匯入另一套系統；不含密碼與登入紀錄。
      </p>
      {canBackup && (
        <p className="dat-desc">
          <strong>完整備份（.db）</strong>：資料庫原樣快照，
          <span className="dat-warn">含密碼雜湊與登入 session，屬敏感檔案</span>
          ，請妥善保管（僅超級管理員可下載）。
        </p>
      )}
      <div className="dat-actions">
        <Button variant="primary" icon="inbox" onClick={() => startDownload(DATA_EXPORT_URL)}>
          下載 JSON 匯出檔
        </Button>
        {canBackup && (
          <Button variant="secondary" icon="lock" onClick={() => setConfirmBackup(true)}>
            下載完整備份
          </Button>
        )}
      </div>
      {confirmBackup && (
        <Dialog
          open
          role="alertdialog"
          onClose={() => setConfirmBackup(false)}
          title="下載完整備份？"
          actions={
            <>
              <Button variant="secondary" onClick={() => setConfirmBackup(false)}>
                取消
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  startDownload(DATA_BACKUP_URL);
                  setConfirmBackup(false);
                }}
              >
                我了解，下載
              </Button>
            </>
          }
        >
          <p className="adm-text">
            備份檔包含所有成員的密碼雜湊與登入 session。請只存放在安全的位置，不要寄送或上傳到公開空間。
          </p>
          <p className="adm-text">
            還原方式：停止服務後執行 <code>python -m server.cli restore &lt;備份檔&gt; --yes</code>。
          </p>
        </Dialog>
      )}
    </section>
  );
}

// ── 匯入 ────────────────────────────────────────────────────

type Applying = { mode: ImportMode } | null;

function ImportSection({ canReplace }: { canReplace: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [strategy, setStrategy] = useState<ImportStrategy>('keep_newer');
  const [overrides, setOverrides] = useState<Record<string, ConflictResolution>>({});
  const [missingUsers, setMissingUsers] = useState<MissingUsersPolicy>('skip');
  const [confirming, setConfirming] = useState<Applying>(null);
  const [replaceText, setReplaceText] = useState('');
  const [reading, setReading] = useState(false);
  const previewMut = useImportPreview();
  const applyMut = useImportApply();

  const reset = () => {
    setPreview(null);
    setResult(null);
    setError(null);
    setFileName('');
    setOverrides({});
    setStrategy('keep_newer');
    setMissingUsers('skip');
    setReplaceText('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const showError = (err: unknown) => {
    const details =
      err instanceof ApiError && Array.isArray(err.details)
        ? (err.details as unknown[])
            .slice(0, 5)
            .map((d) => (typeof d === 'string' ? d : formatValue((d as { message?: string }).message ?? d)))
        : [];
    setError({ message: errorMessage(err), details });
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPreview(null);
    setResult(null);
    setError(null);
    setOverrides({});
    setFileName(file.name);
    setReading(true);
    try {
      const doc = await readJsonFile(file);
      setPreview(await previewMut.mutateAsync(doc));
    } catch (err) {
      showError(err);
    } finally {
      setReading(false);
    }
  };

  const runApply = (mode: ImportMode) => {
    if (!preview) return;
    applyMut.mutate(
      {
        token: preview.token,
        mode,
        strategy,
        overrides,
        missingUsers,
        ...(mode === 'replace' && { confirm: replaceText.trim() }),
      },
      {
        onSuccess: (r) => {
          setConfirming(null);
          setPreview(null);
          setResult(r);
        },
        onError: (err) => {
          setConfirming(null);
          showError(err);
          if (err instanceof ApiError && err.code === 'PREVIEW_EXPIRED') setPreview(null);
        },
      },
    );
  };

  const busy = reading || previewMut.isPending;

  return (
    <>
      <section className="dat-card" aria-labelledby="dat-import-title">
        <h2 id="dat-import-title" className="dat-title">
          匯入
        </h2>
        <p className="dat-desc">
          選擇 JSON 匯出檔後會先預覽差異，不會修改資料；確認後才套用。套用前系統會自動備份目前的資料庫。
        </p>
        <div className="dat-actions">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            aria-label="選擇匯出檔"
            onChange={(e) => void onFile(e)}
          />
          <Button variant="secondary" icon="plus" loading={busy} onClick={() => fileRef.current?.click()}>
            選擇匯出檔
          </Button>
          {fileName && <span className="dat-file">{fileName}</span>}
        </div>

        {busy && <p className="dat-desc">正在分析檔案…</p>}
        {error && (
          <Alert tone="danger" onClose={() => setError(null)}>
            {error.message}
            {error.details.length > 0 && (
              <ul className="dat-details">
                {error.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        {result && <ResultView result={result} onDone={reset} />}
        {!result && !preview && !busy && !error && <p className="dat-empty">尚未選擇檔案</p>}
        {preview && (
          <PreviewView
            preview={preview}
            strategy={strategy}
            setStrategy={setStrategy}
            overrides={overrides}
            setOverrides={setOverrides}
            missingUsers={missingUsers}
            setMissingUsers={setMissingUsers}
            onCancel={reset}
            onApply={() => setConfirming({ mode: 'merge' })}
          />
        )}
      </section>

      {canReplace && (
        <section className="dat-card dat-card--danger" aria-labelledby="dat-replace-title">
          <h2 id="dat-replace-title" className="dat-title">
            取代全部資料
          </h2>
          <p className="dat-desc">
            先刪除本機所有任務、專案、狀態、自訂欄位、問題回饋、個人清單與工程追蹤資料，再匯入檔案內容（成員帳號保留）。
            此操作會先自動備份，但仍請謹慎使用。
          </p>
          {preview ? (
            <div className="dat-replace">
              <Field label={`請輸入「${REPLACE_CONFIRM_TEXT}」以確認`}>
                <Input
                  value={replaceText}
                  onChange={(e) => setReplaceText(e.target.value)}
                  aria-label="取代確認字樣"
                  autoComplete="off"
                />
              </Field>
              <Button
                variant="danger"
                disabled={replaceText.trim() !== REPLACE_CONFIRM_TEXT}
                loading={applyMut.isPending && confirming?.mode === 'replace'}
                onClick={() => setConfirming({ mode: 'replace' })}
              >
                取代並匯入
              </Button>
            </div>
          ) : (
            <p className="dat-empty">請先在上方選擇匯出檔並完成預覽</p>
          )}
        </section>
      )}

      {confirming && preview && (
        <Dialog
          open
          role="alertdialog"
          onClose={() => !applyMut.isPending && setConfirming(null)}
          title={confirming.mode === 'replace' ? '確定取代全部資料？' : '確定套用匯入？'}
          actions={
            <>
              <Button variant="secondary" disabled={applyMut.isPending} onClick={() => setConfirming(null)}>
                取消
              </Button>
              <Button
                variant={confirming.mode === 'replace' ? 'danger' : 'primary'}
                loading={applyMut.isPending}
                onClick={() => runApply(confirming.mode)}
              >
                {confirming.mode === 'replace' ? '取代' : '套用'}
              </Button>
            </>
          }
        >
          {confirming.mode === 'replace' ? (
            <p className="adm-text">本機業務資料將全部刪除後改為檔案內容。</p>
          ) : (
            <p className="adm-text">
              將新增 {totalNew(preview)} 筆，{preview.conflicts.length} 筆衝突中有{' '}
              {countUseImport(preview.conflicts, strategy, overrides)} 筆採用匯入檔。
            </p>
          )}
          <p className="adm-text">
            套用前會自動備份目前資料庫；
            {missingUsers === 'create' && preview.missingUsers.length > 0
              ? `會建立 ${preview.missingUsers.length} 位缺少的成員。`
              : '缺少的成員會略過指派。'}
          </p>
        </Dialog>
      )}
    </>
  );
}

// ── 預覽 ────────────────────────────────────────────────────

function PreviewView({
  preview,
  strategy,
  setStrategy,
  overrides,
  setOverrides,
  missingUsers,
  setMissingUsers,
  onCancel,
  onApply,
}: {
  preview: ImportPreview;
  strategy: ImportStrategy;
  setStrategy: (s: ImportStrategy) => void;
  overrides: Record<string, ConflictResolution>;
  setOverrides: (o: Record<string, ConflictResolution>) => void;
  missingUsers: MissingUsersPolicy;
  setMissingUsers: (m: MissingUsersPolicy) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const nothing =
    totalNew(preview) === 0 && preview.conflicts.length === 0 && preview.missingUsers.length === 0;
  return (
    <div className="dat-preview" aria-label="匯入預覽">
      <p className="dat-meta">匯出時間：{formatDateTime(preview.file.exportedAt)}</p>
      <table className="adm-table dat-table">
        <thead>
          <tr>
            <th scope="col">類別</th>
            <th scope="col" className="dat-num">
              檔案
            </th>
            <th scope="col" className="dat-num">
              新增
            </th>
            <th scope="col" className="dat-num">
              相同（略過）
            </th>
            <th scope="col" className="dat-num">
              衝突
            </th>
          </tr>
        </thead>
        <tbody>
          {preview.categories.map((c) => (
            <tr key={c.key} data-category={c.key}>
              <td>{c.label}</td>
              <td className="dat-num">{c.total}</td>
              <td className="dat-num">{c.new}</td>
              <td className="dat-num">{c.same}</td>
              <td className="dat-num">{c.conflict > 0 ? <Badge tone="warning">{c.conflict}</Badge> : 0}</td>
            </tr>
          ))}
          <tr>
            <td>成員</td>
            <td className="dat-num">{preview.users.total}</td>
            <td className="dat-num">—</td>
            <td className="dat-num">{preview.users.existing}</td>
            <td className="dat-num">{preview.users.missing > 0 ? `缺少 ${preview.users.missing}` : 0}</td>
          </tr>
        </tbody>
      </table>

      {preview.missingUsers.length > 0 && (
        <div className="dat-block">
          <h3 className="dat-subtitle">缺少成員（{preview.missingUsers.length}）</h3>
          <p className="dat-desc">以下帳號在本系統不存在：</p>
          <ul className="dat-users">
            {preview.missingUsers.map((m) => (
              <li key={m.username}>
                {m.displayName} <span className="dat-muted">@{m.username}</span>
                {m.references > 0 && <span className="dat-muted">（{m.references} 處引用）</span>}
              </li>
            ))}
          </ul>
          <Field label="處理方式">
            <Select<MissingUsersPolicy>
              aria-label="缺少成員的處理方式"
              className="dat-select"
              value={missingUsers}
              onChange={setMissingUsers}
              options={[
                { value: 'skip', label: '略過指派（相關欄位留空）' },
                { value: 'create', label: '自動建立成員（臨時密碼）' },
              ]}
            />
          </Field>
        </div>
      )}

      <div className="dat-block">
        <h3 className="dat-subtitle">衝突（{preview.conflicts.length}）</h3>
        {preview.conflicts.length === 0 ? (
          <p className="dat-desc">沒有衝突：兩邊都有的資料內容皆相同。</p>
        ) : (
          <>
            <Field label="全域策略" hint="可在下方逐筆覆寫">
              <Select<ImportStrategy>
                aria-label="全域策略"
                className="dat-select"
                value={strategy}
                onChange={setStrategy}
                options={IMPORT_STRATEGIES.map((s) => ({
                  value: s,
                  label: s === 'keep_newer' ? `${STRATEGY_LABELS[s]}（預設）` : STRATEGY_LABELS[s],
                }))}
              />
            </Field>
            <ul className="dat-conflicts">
              {preview.conflicts.map((c) => (
                <ConflictRow
                  key={c.key}
                  conflict={c}
                  strategy={strategy}
                  override={overrides[c.key]}
                  onChange={(v) => {
                    const next = { ...overrides };
                    if (v === 'default') delete next[c.key];
                    else next[c.key] = v;
                    setOverrides(next);
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      {nothing && <Alert tone="info">檔案內容與目前資料相同，不需要匯入。</Alert>}
      <div className="dat-actions">
        <Button variant="secondary" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" disabled={nothing} onClick={onApply}>
          套用匯入
        </Button>
      </div>
    </div>
  );
}

function ConflictRow({
  conflict: c,
  strategy,
  override,
  onChange,
}: {
  conflict: ImportConflict;
  strategy: ImportStrategy;
  override: ConflictResolution | undefined;
  onChange: (v: ConflictResolution | 'default') => void;
}) {
  const auto = effectiveResolution(strategy, undefined, c.newer);
  return (
    <li className="dat-conflict" data-key={c.key}>
      <div className="dat-conflict-head">
        <Badge>{c.categoryLabel}</Badge>
        <span className="dat-conflict-title">{c.title}</span>
        <Select<ConflictResolution | 'default'>
          aria-label={`「${c.title}」的處理方式`}
          className="dat-select dat-select--sm"
          value={override ?? 'default'}
          onChange={onChange}
          options={[
            { value: 'default', label: `依全域策略（${RESOLUTION_LABELS[auto]}）` },
            { value: 'keep_local', label: RESOLUTION_LABELS.keep_local },
            { value: 'use_import', label: RESOLUTION_LABELS.use_import },
          ]}
        />
      </div>
      <p className="dat-meta">
        本機更新：{c.localUpdatedAt ? formatDateTime(c.localUpdatedAt) : '—'} · 匯入檔更新：
        {c.importUpdatedAt ? formatDateTime(c.importUpdatedAt) : '—'}（{NEWER_LABELS[c.newer]}）
      </p>
      <table className="dat-diff">
        <thead>
          <tr>
            <th scope="col">欄位</th>
            <th scope="col">本機</th>
            <th scope="col">匯入檔</th>
          </tr>
        </thead>
        <tbody>
          {c.fields.map((f) => (
            <tr key={f.name}>
              <td>{f.label}</td>
              <td>{formatValue(f.local)}</td>
              <td>{formatValue(f.import)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </li>
  );
}

// ── 結果 ────────────────────────────────────────────────────

function ResultView({ result, onDone }: { result: ImportResult; onDone: () => void }) {
  const t = resultTotals(result);
  return (
    <div className="dat-result" aria-label="匯入結果">
      <Alert tone="success" role="status">
        匯入完成：新增 {t.created}、更新 {t.updated}
        {t.deleted > 0 && `、刪除 ${t.deleted}`}
        {t.skipped > 0 && `、略過 ${t.skipped}`} 筆。
        {result.backupFile && ` 匯入前的備份：${result.backupFile}`}
      </Alert>
      <table className="adm-table dat-table">
        <thead>
          <tr>
            <th scope="col">類別</th>
            <th scope="col" className="dat-num">
              新增
            </th>
            <th scope="col" className="dat-num">
              更新
            </th>
            <th scope="col" className="dat-num">
              未變更
            </th>
            <th scope="col" className="dat-num">
              略過
            </th>
            {result.mode === 'replace' && (
              <th scope="col" className="dat-num">
                刪除
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {result.categories.map((c) => (
            <tr key={c.key} data-category={c.key}>
              <td>{c.label}</td>
              <td className="dat-num">{c.created}</td>
              <td className="dat-num">{c.updated}</td>
              <td className="dat-num">{c.unchanged}</td>
              <td className="dat-num">{c.skipped}</td>
              {result.mode === 'replace' && <td className="dat-num">{c.deleted}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {result.createdUsers.length > 0 && (
        <div className="dat-block">
          <h3 className="dat-subtitle">已建立的成員</h3>
          <Alert tone="warning">臨時密碼只會顯示這一次，請立即轉交本人；首次登入須變更密碼。</Alert>
          <table className="dat-diff">
            <thead>
              <tr>
                <th scope="col">成員</th>
                <th scope="col">帳號</th>
                <th scope="col">臨時密碼</th>
              </tr>
            </thead>
            <tbody>
              {result.createdUsers.map((u) => (
                <tr key={u.username}>
                  <td>{u.displayName}</td>
                  <td>@{u.username}</td>
                  <td>
                    <code className="dat-password">{u.tempPassword}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.missingUsersSkipped.length > 0 && (
        <p className="dat-desc">已略過指派的成員：{result.missingUsersSkipped.join('、')}</p>
      )}
      <div className="dat-actions">
        <Button variant="primary" onClick={onDone}>
          完成
        </Button>
      </div>
    </div>
  );
}
