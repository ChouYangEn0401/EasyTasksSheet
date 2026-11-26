import { createElement, Fragment } from 'preact';
import { useRef, useState } from 'preact/compat';
import { useQueryClient } from '../../lib/query.js';
import { ApiError, errorMessage } from '../../lib/api.js';
import { formatBytes, setupStatusKey, uploadPack } from '../../lib/sitePack.js';
import { Alert, Button, Field, Textarea } from '../../ui/index.js';

/**
 * 登入頁的「全新安裝：從搬家包還原」。
 * 只在後端回報 pristine（只有一個尚未完成首次改密碼的帳號、沒有任務）時顯示；
 * 後端同樣只在 pristine 時接受，前端隱藏只是介面上的整理，不是安全機制。
 */
export function SetupRestorePanel({ maxUploadMb, onDone }) {
  const qc = useQueryClient();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [passphrase, setPassphrase] = useState('');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const busy = progress !== null;

  const submit = async (e) => {
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

  return createElement(
    'form',
    { onSubmit: submit, className: 'flex flex-col gap-3', 'aria-label': '從搬家包還原' },
    createElement(
      'p',
      { className: 'm-0 text-sm text-secondary' },
      '這台 server 是全新安裝。可以上傳從另一台匯出的',
      createElement('strong', null, '整站搬家包'),
      '，直接還原所有帳號、任務與附件；還原後用原本的帳號密碼登入。',
    ),
    error && createElement(Alert, { tone: 'danger', role: 'alert' }, error),
    createElement(
      Field,
      { label: `搬家包檔案（.etpack，上限 ${maxUploadMb} MB）` },
      createElement(
        'div',
        { className: 'flex flex-wrap items-center gap-2' },
        createElement('input', {
          ref: fileRef,
          type: 'file',
          accept: '.etpack',
          hidden: true,
          onChange: (e) => setFile(e.target.files?.[0] ?? null),
        }),
        createElement(
          Button,
          {
            type: 'button',
            variant: 'secondary',
            icon: 'inbox',
            onClick: () => fileRef.current?.click(),
            disabled: busy,
          },
          '選擇檔案',
        ),
        createElement(
          'span',
          { className: 'text-sm text-secondary' },
          file ? `${file.name}（${formatBytes(file.size)}）` : '尚未選擇',
        ),
      ),
    ),
    createElement(
      Field,
      { label: '解鎖密語' },
      createElement(Textarea, {
        rows: 2,
        value: passphrase,
        onChange: (e) => setPassphrase(e.target.value),
        disabled: busy,
      }),
    ),
    createElement(
      Button,
      {
        type: 'submit',
        variant: 'primary',
        fullWidth: true,
        loading: busy,
        disabled: !file || !passphrase.trim(),
      },
      '還原',
    ),
    busy &&
      createElement(
        'p',
        { className: 'm-0 text-xs text-tertiary' },
        progress !== null && progress < 1
          ? `上傳中 ${Math.round(progress * 100)}%`
          : '解密並還原中，請勿關閉頁面…',
      ),
  );
}
