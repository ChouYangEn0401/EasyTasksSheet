import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage } from '../../lib/api.ts';
import { formatBytes, setupStatusKey, uploadPack, type RestoreResult } from '../../lib/sitePack.ts';
import { Alert, Button, Field, Textarea } from '../../ui/index.ts';

/**
 * 登入頁的「全新安裝：從搬家包還原」。
 * 只在後端回報 pristine（只有一個尚未完成首次改密碼的帳號、沒有任務）時顯示；
 * 後端同樣只在 pristine 時接受，前端隱藏只是介面上的整理，不是安全機制。
 */
export function SetupRestorePanel({
  maxUploadMb,
  onDone,
}: {
  maxUploadMb: number;
  onDone: (r: RestoreResult) => void;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const busy = progress !== null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !passphrase.trim()) return;
    setError('');
    setProgress(0);
    try {
      const result = await uploadPack('/setup/restore', file, { passphrase }, setProgress);
      setProgress(null);
      await qc.invalidateQueries({ queryKey: setupStatusKey });
      onDone(result);
    } catch (err) {
      setProgress(null);
      setError(err instanceof ApiError ? err.message : errorMessage(err));
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label="從搬家包還原">
      <p className="m-0 text-sm text-secondary">
        這台 server 是全新安裝。可以上傳從另一台匯出的<strong>整站搬家包</strong>
        ，直接還原所有帳號、任務與附件；還原後用原本的帳號密碼登入。
      </p>
      {error && (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      )}
      <Field label={`搬家包檔案（.etpack，上限 ${maxUploadMb} MB）`}>
        <div className="flex flex-wrap items-center gap-2">
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
          <span className="text-sm text-secondary">
            {file ? `${file.name}（${formatBytes(file.size)}）` : '尚未選擇'}
          </span>
        </div>
      </Field>
      <Field label="解鎖密語">
        <Textarea
          rows={2}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          disabled={busy}
        />
      </Field>
      <Button type="submit" variant="primary" fullWidth loading={busy} disabled={!file || !passphrase.trim()}>
        還原
      </Button>
      {busy && (
        <p className="m-0 text-xs text-tertiary">
          {progress !== null && progress < 1
            ? `上傳中 ${Math.round(progress * 100)}%`
            : '解密並還原中，請勿關閉頁面…'}
        </p>
      )}
    </form>
  );
}
