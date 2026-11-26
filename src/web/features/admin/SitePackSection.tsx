import { useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage } from '../../lib/api.ts';
import { withBase } from '../../lib/base.ts';
import { formatDateTime } from '../../lib/format.ts';
import {
  createPack,
  formatBytes,
  packDownloadUrl,
  uploadPack,
  useSetupStatus,
  type CreatedPack,
} from '../../lib/sitePack.ts';
import { Alert, Button, Dialog, Field, Input, Textarea } from '../../ui/index.ts';
import { startDownload } from './dataApi.ts';

/**
 * 整站搬家包（資料管理頁）：root 專屬。
 * - 匯出：再次輸入密碼 → 建立加密搬家包 → 顯示一次性解鎖密語 → 下載（只能下載一次）
 * - 覆蓋：需 server 本機開啟「還原解鎖」，並再次輸入密碼與確認字樣；判斷全在後端
 */
export function SitePackSection({ canExport, canRestore }: { canExport: boolean; canRestore: boolean }) {
  return (
    <section className="dat-card" aria-labelledby="dat-pack-title">
      <h2 id="dat-pack-title" className="dat-title">
        整站搬家包
      </h2>
      <p className="dat-desc">
        把整個網站（所有帳號與密碼、任務、設定、附件檔案）打包成一個加密檔，搬到另一台 server
        還原。檔案以系統產生的英文密語加密，沒有密語就打不開。
      </p>
      {canExport && <ExportPack />}
      {canRestore && <RestorePack />}
    </section>
  );
}

// ── 匯出 ────────────────────────────────────────────────────

function ExportPack() {
  const [open, setOpen] = useState(false);
  return (
    <div className="dat-block">
      <h3 className="dat-subtitle">匯出</h3>
      <div className="dat-actions">
        <Button variant="primary" icon="lock" onClick={() => setOpen(true)}>
          建立整站搬家包
        </Button>
      </div>
      {open && <ExportDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pack, setPack] = useState<CreatedPack | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      setPack(await createPack(password));
      setPassword('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!pack) return;
    try {
      await navigator.clipboard.writeText(pack.passphrase);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (!pack) {
    return (
      <Dialog
        open
        onClose={busy ? () => undefined : onClose}
        title="建立整站搬家包"
        actions={
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="dat-pack-export"
              loading={busy}
              disabled={!password}
            >
              建立
            </Button>
          </>
        }
      >
        <form id="dat-pack-export" onSubmit={submit} className="dat-block">
          <p className="adm-text">
            搬家包含有<strong>所有成員的密碼雜湊</strong>與全部資料。請再輸入一次你的密碼確認身分。
          </p>
          {error && (
            <Alert tone="danger" role="alert">
              {error}
            </Alert>
          )}
          <Field label="你的密碼">
            <Input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </Field>
          {busy && <p className="dat-meta">正在打包與加密，資料或附件多時需要一點時間…</p>}
        </form>
      </Dialog>
    );
  }

  const c = pack.manifest.counts;
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      title="搬家包已建立"
      actions={
        <Button variant={downloaded && copied ? 'primary' : 'secondary'} onClick={onClose}>
          完成
        </Button>
      }
    >
      <div className="dat-block">
        <Alert tone="warning">
          解鎖密語<strong>只顯示這一次</strong>，伺服器不會保存。請複製後和搬家包<strong>分開保存</strong>
          ；遺失密語就無法開啟搬家包。
        </Alert>
        <Field label="解鎖密語">
          <code className="dat-passphrase" data-testid="pack-passphrase">
            {pack.passphrase}
          </code>
        </Field>
        <div className="dat-actions">
          <Button variant="secondary" icon={copied ? 'check' : 'key'} onClick={copy}>
            {copied ? '已複製密語' : '複製密語'}
          </Button>
          <Button
            variant="primary"
            icon="inbox"
            disabled={downloaded}
            onClick={() => {
              startDownload(packDownloadUrl(pack.id));
              setDownloaded(true);
            }}
          >
            {downloaded ? '已開始下載' : `下載搬家包（${formatBytes(pack.size)}）`}
          </Button>
        </div>
        <p className="dat-meta">
          {pack.filename}：帳號 {c.users}、專案 {c.projects}、任務 {c.tasks}、附件 {c.attachments}
          。下載連結只能使用一次，30 分鐘內有效。
        </p>
        {pack.manifest.missingAttachments.length > 0 && (
          <Alert tone="warning">
            有 {pack.manifest.missingAttachments.length}{' '}
            個附件在資料庫有紀錄但檔案已不存在，搬家包中不含這些檔案。
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

// ── 覆蓋 ────────────────────────────────────────────────────

function RestorePack() {
  const status = useSetupStatus();
  const s = status.data;
  return (
    <div className="dat-block">
      <h3 className="dat-subtitle">以搬家包取代全部資料</h3>
      <p className="dat-desc">
        <span className="dat-warn">會取代這台 server 上的所有資料與帳號</span>
        。還原前系統會自動把現有資料完整備份到 server 的備份資料夾；還原後所有人都要重新登入。
      </p>
      {status.isPending ? (
        <p className="dat-meta">讀取中…</p>
      ) : !s?.restoreUnlocked ? (
        <Alert tone="info">
          <p className="m-0">
            為了避免遠端被惡意或誤操作覆蓋，這個功能要先在 <strong>server 本機</strong> 開啟「還原解鎖」：
            用遠端桌面登入 server，在專案資料夾執行 <code>deploy\windows\allow_restore.bat</code>（或{' '}
            <code>python -m server.cli allow-restore</code>）。解鎖 30 分鐘內有效，還原一次後自動關閉。
          </p>
          <div className="dat-actions mt-2">
            <Button variant="secondary" size="sm" icon="refresh" onClick={() => void status.refetch()}>
              我已開啟，重新檢查
            </Button>
          </div>
        </Alert>
      ) : (
        <RestoreForm confirmText={s.confirmText} expiresAt={s.unlockExpiresAt} maxUploadMb={s.maxUploadMb} />
      )}
    </div>
  );
}

function RestoreForm({
  confirmText,
  expiresAt,
  maxUploadMb,
}: {
  confirmText: string;
  expiresAt: number | null;
  maxUploadMb: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');

  const ready = !!file && passphrase.trim() !== '' && password !== '' && confirm.trim() === confirmText;
  const busy = progress !== null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !ready) return;
    setError('');
    setProgress(0);
    try {
      await uploadPack('/admin/data/pack/restore', file, { passphrase, password, confirm }, setProgress);
      // 所有 session 已失效：整頁導向登入頁
      window.location.assign(withBase('/login?reason=restored'));
    } catch (err) {
      setProgress(null);
      setError(err instanceof ApiError ? err.message : errorMessage(err));
    }
  };

  return (
    <form className="dat-block" onSubmit={submit} aria-label="以搬家包取代全部資料">
      <Alert tone="warning">
        還原解鎖已開啟{expiresAt ? `，到 ${formatDateTime(expiresAt)} 為止` : ''}。
      </Alert>
      {error && (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      )}
      <Field label={`搬家包檔案（.etpack，網頁上傳上限 ${maxUploadMb} MB）`}>
        <div className="dat-actions">
          <input
            ref={fileRef}
            type="file"
            accept=".etpack"
            hidden
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button
            type="button"
            variant="secondary"
            icon="inbox"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            選擇檔案
          </Button>
          <span className="dat-file">{file ? `${file.name}（${formatBytes(file.size)}）` : '尚未選擇'}</span>
        </div>
      </Field>
      <Field label="解鎖密語（建立搬家包時顯示的英文單字）">
        <Textarea
          rows={2}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          disabled={busy}
        />
      </Field>
      <Field label="你的密碼">
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
      </Field>
      <Field label={`輸入「${confirmText}」確認`}>
        <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
      </Field>
      <div className="dat-actions">
        <Button type="submit" variant="danger" icon="alert" loading={busy} disabled={!ready}>
          取代全部資料
        </Button>
        {busy && (
          <span className="dat-meta">
            {progress !== null && progress < 1
              ? `上傳中 ${Math.round(progress * 100)}%`
              : '解密並還原中，請勿關閉頁面…'}
          </span>
        )}
      </div>
    </form>
  );
}
