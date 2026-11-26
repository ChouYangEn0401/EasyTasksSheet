import { createElement, Fragment } from 'preact';
import { useRef, useState } from 'preact/compat';
import { IMPORT_STRATEGIES, REPLACE_CONFIRM_TEXT } from '../../shared/dataTransfer.js';
import { ApiError, errorMessage } from '../../lib/api.js';
import { useCurrentUser } from '../../lib/auth.js';
import { useCan } from '../../lib/permissions.js';
import { formatDateTime } from '../../lib/format.js';
import { Alert, Badge, Button, Dialog, Field, Input, Select } from '../../ui/index.js';
import { NoPermission } from './AdminUsersPage.js';
import { SitePackSection } from './SitePackSection.js';
import {
  DATA_BACKUP_URL,
  DATA_EXPORT_URL,
  startDownload,
  useImportApply,
  useImportPreview,
} from './dataApi.js';
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
} from './dataModel.js';

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
  if (!canExport && !canImport) return createElement(NoPermission, null);
  return createElement(
    'div',
    { className: 'adm-page dat-page' },
    (canBackup || canReplace) &&
      createElement(SitePackSection, { canExport: canBackup, canRestore: canReplace }),
    canExport && createElement(ExportSection, { canBackup: canBackup }),
    canImport && createElement(ImportSection, { canReplace: canReplace }),
  );
}

// ── 匯出 ────────────────────────────────────────────────────

function ExportSection({ canBackup }) {
  const [confirmBackup, setConfirmBackup] = useState(false);
  return createElement(
    'section',
    { className: 'dat-card', 'aria-labelledby': 'dat-export-title' },
    createElement('h2', { id: 'dat-export-title', className: 'dat-title' }, '匯出'),
    createElement(
      'p',
      { className: 'dat-desc' },
      createElement('strong', null, 'JSON 匯出檔'),
      '：全部任務、專案、狀態、自訂欄位、問題回饋、個人清單、工程追蹤與 GitHub 連動設定，可匯入另一套系統；不含密碼與登入紀錄。',
    ),
    canBackup &&
      createElement(
        'p',
        { className: 'dat-desc' },
        createElement('strong', null, '完整備份（.db）'),
        '：資料庫原樣快照，',
        createElement('span', { className: 'dat-warn' }, '含密碼雜湊與登入 session，屬敏感檔案'),
        '，請妥善保管（僅超級管理員可下載）。',
      ),
    createElement(
      'p',
      { className: 'dat-desc' },
      '附件（問題的圖片、影片、檔案）：JSON 與下方 .db 只含附件清單，不含檔案本體。附件檔案請用完整備份帶走——在伺服器執行',
      ' ',
      createElement('code', null, 'python -m server.cli backup'),
      '，會把附件目錄一併備份。',
    ),
    createElement(
      'div',
      { className: 'dat-actions' },
      createElement(
        Button,
        { variant: 'primary', icon: 'inbox', onClick: () => startDownload(DATA_EXPORT_URL) },
        '下載 JSON 匯出檔',
      ),
      canBackup &&
        createElement(
          Button,
          { variant: 'secondary', icon: 'lock', onClick: () => setConfirmBackup(true) },
          '下載完整備份',
        ),
    ),
    confirmBackup &&
      createElement(
        Dialog,
        {
          open: true,
          role: 'alertdialog',
          onClose: () => setConfirmBackup(false),
          title: '下載完整備份？',
          actions: createElement(
            Fragment,
            null,
            createElement(Button, { variant: 'secondary', onClick: () => setConfirmBackup(false) }, '取消'),
            createElement(
              Button,
              {
                variant: 'primary',
                onClick: () => {
                  startDownload(DATA_BACKUP_URL);
                  setConfirmBackup(false);
                },
              },
              '我了解，下載',
            ),
          ),
        },
        createElement(
          'p',
          { className: 'adm-text' },
          '備份檔包含所有成員的密碼雜湊與登入 session。請只存放在安全的位置，不要寄送或上傳到公開空間。',
        ),
        createElement(
          'p',
          { className: 'adm-text' },
          '還原方式：停止服務後執行 ',
          createElement('code', null, 'python -m server.cli restore <備份檔> --yes'),
          '。',
        ),
      ),
  );
}

function ImportSection({ canReplace }) {
  const fileRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [strategy, setStrategy] = useState('keep_newer');
  const [overrides, setOverrides] = useState({});
  const [missingUsers, setMissingUsers] = useState('skip');
  const [confirming, setConfirming] = useState(null);
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

  const showError = (err) => {
    const details =
      err instanceof ApiError && Array.isArray(err.details)
        ? err.details.slice(0, 5).map((d) => (typeof d === 'string' ? d : formatValue(d.message ?? d)))
        : [];
    setError({ message: errorMessage(err), details });
  };

  const onFile = async (e) => {
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

  const runApply = (mode) => {
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

  return createElement(
    Fragment,
    null,
    createElement(
      'section',
      { className: 'dat-card', 'aria-labelledby': 'dat-import-title' },
      createElement('h2', { id: 'dat-import-title', className: 'dat-title' }, '匯入'),
      createElement(
        'p',
        { className: 'dat-desc' },
        '選擇 JSON 匯出檔後會先預覽差異，不會修改資料；確認後才套用。套用前系統會自動備份目前的資料庫。',
      ),
      createElement(
        'div',
        { className: 'dat-actions' },
        createElement('input', {
          ref: fileRef,
          type: 'file',
          accept: '.json,application/json',
          className: 'sr-only',
          'aria-label': '選擇匯出檔',
          onChange: (e) => void onFile(e),
        }),
        createElement(
          Button,
          { variant: 'secondary', icon: 'plus', loading: busy, onClick: () => fileRef.current?.click() },
          '選擇匯出檔',
        ),
        fileName && createElement('span', { className: 'dat-file' }, fileName),
      ),

      busy && createElement('p', { className: 'dat-desc' }, '正在分析檔案…'),
      error &&
        createElement(
          Alert,
          { tone: 'danger', onClose: () => setError(null) },
          error.message,
          error.details.length > 0 &&
            createElement(
              'ul',
              { className: 'dat-details' },
              error.details.map((d, i) => createElement('li', { key: i }, d)),
            ),
        ),
      result && createElement(ResultView, { result: result, onDone: reset }),
      !result &&
        !preview &&
        !busy &&
        !error &&
        createElement('p', { className: 'dat-empty' }, '尚未選擇檔案'),
      preview &&
        createElement(PreviewView, {
          preview: preview,
          strategy: strategy,
          setStrategy: setStrategy,
          overrides: overrides,
          setOverrides: setOverrides,
          missingUsers: missingUsers,
          setMissingUsers: setMissingUsers,
          onCancel: reset,
          onApply: () => setConfirming({ mode: 'merge' }),
        }),
    ),

    canReplace &&
      createElement(
        'section',
        { className: 'dat-card dat-card--danger', 'aria-labelledby': 'dat-replace-title' },
        createElement('h2', { id: 'dat-replace-title', className: 'dat-title' }, '取代全部資料'),
        createElement(
          'p',
          { className: 'dat-desc' },
          '先刪除本機所有任務、專案、狀態、自訂欄位、問題回饋、個人清單與工程追蹤資料，再匯入檔案內容（成員帳號保留）。 此操作會先自動備份，但仍請謹慎使用。',
        ),
        preview
          ? createElement(
              'div',
              { className: 'dat-replace' },
              createElement(
                Field,
                { label: `請輸入「${REPLACE_CONFIRM_TEXT}」以確認` },
                createElement(Input, {
                  value: replaceText,
                  onChange: (e) => setReplaceText(e.target.value),
                  'aria-label': '取代確認字樣',
                  autoComplete: 'off',
                }),
              ),
              createElement(
                Button,
                {
                  variant: 'danger',
                  disabled: replaceText.trim() !== REPLACE_CONFIRM_TEXT,
                  loading: applyMut.isPending && confirming?.mode === 'replace',
                  onClick: () => setConfirming({ mode: 'replace' }),
                },
                '取代並匯入',
              ),
            )
          : createElement('p', { className: 'dat-empty' }, '請先在上方選擇匯出檔並完成預覽'),
      ),
    confirming &&
      preview &&
      createElement(
        Dialog,
        {
          open: true,
          role: 'alertdialog',
          onClose: () => !applyMut.isPending && setConfirming(null),
          title: confirming.mode === 'replace' ? '確定取代全部資料？' : '確定套用匯入？',
          actions: createElement(
            Fragment,
            null,
            createElement(
              Button,
              { variant: 'secondary', disabled: applyMut.isPending, onClick: () => setConfirming(null) },
              '取消',
            ),
            createElement(
              Button,
              {
                variant: confirming.mode === 'replace' ? 'danger' : 'primary',
                loading: applyMut.isPending,
                onClick: () => runApply(confirming.mode),
              },
              confirming.mode === 'replace' ? '取代' : '套用',
            ),
          ),
        },
        confirming.mode === 'replace'
          ? createElement('p', { className: 'adm-text' }, '本機業務資料將全部刪除後改為檔案內容。')
          : createElement(
              'p',
              { className: 'adm-text' },
              '將新增 ',
              totalNew(preview),
              ' 筆，',
              preview.conflicts.length,
              ' 筆衝突中有',
              ' ',
              countUseImport(preview.conflicts, strategy, overrides),
              ' 筆採用匯入檔。',
            ),
        createElement(
          'p',
          { className: 'adm-text' },
          '套用前會自動備份目前資料庫；',
          missingUsers === 'create' && preview.missingUsers.length > 0
            ? `會建立 ${preview.missingUsers.length} 位缺少的成員。`
            : '缺少的成員會略過指派。',
        ),
      ),
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
}) {
  const nothing =
    totalNew(preview) === 0 && preview.conflicts.length === 0 && preview.missingUsers.length === 0;
  return createElement(
    'div',
    { className: 'dat-preview', 'aria-label': '匯入預覽' },
    createElement('p', { className: 'dat-meta' }, '匯出時間：', formatDateTime(preview.file.exportedAt)),
    createElement(
      'table',
      { className: 'adm-table dat-table' },
      createElement(
        'thead',
        null,
        createElement(
          'tr',
          null,
          createElement('th', { scope: 'col' }, '類別'),
          createElement('th', { scope: 'col', className: 'dat-num' }, '檔案'),
          createElement('th', { scope: 'col', className: 'dat-num' }, '新增'),
          createElement('th', { scope: 'col', className: 'dat-num' }, '相同（略過）'),
          createElement('th', { scope: 'col', className: 'dat-num' }, '衝突'),
        ),
      ),
      createElement(
        'tbody',
        null,
        preview.categories.map((c) =>
          createElement(
            'tr',
            { key: c.key, 'data-category': c.key },
            createElement('td', null, c.label),
            createElement('td', { className: 'dat-num' }, c.total),
            createElement('td', { className: 'dat-num' }, c.new),
            createElement('td', { className: 'dat-num' }, c.same),
            createElement(
              'td',
              { className: 'dat-num' },
              c.conflict > 0 ? createElement(Badge, { tone: 'warning' }, c.conflict) : 0,
            ),
          ),
        ),
        createElement(
          'tr',
          null,
          createElement('td', null, '成員'),
          createElement('td', { className: 'dat-num' }, preview.users.total),
          createElement('td', { className: 'dat-num' }, '—'),
          createElement('td', { className: 'dat-num' }, preview.users.existing),
          createElement(
            'td',
            { className: 'dat-num' },
            preview.users.missing > 0 ? `缺少 ${preview.users.missing}` : 0,
          ),
        ),
      ),
    ),

    preview.missingUsers.length > 0 &&
      createElement(
        'div',
        { className: 'dat-block' },
        createElement('h3', { className: 'dat-subtitle' }, '缺少成員（', preview.missingUsers.length, '）'),
        createElement('p', { className: 'dat-desc' }, '以下帳號在本系統不存在：'),
        createElement(
          'ul',
          { className: 'dat-users' },
          preview.missingUsers.map((m) =>
            createElement(
              'li',
              { key: m.username },
              m.displayName,
              ' ',
              createElement('span', { className: 'dat-muted' }, '@', m.username),
              m.references > 0 &&
                createElement('span', { className: 'dat-muted' }, '（', m.references, ' 處引用）'),
            ),
          ),
        ),
        createElement(
          Field,
          { label: '處理方式' },
          createElement(Select, {
            'aria-label': '缺少成員的處理方式',
            className: 'dat-select',
            value: missingUsers,
            onChange: setMissingUsers,
            options: [
              { value: 'skip', label: '略過指派（相關欄位留空）' },
              { value: 'create', label: '自動建立成員（臨時密碼）' },
            ],
          }),
        ),
      ),
    createElement(
      'div',
      { className: 'dat-block' },
      createElement('h3', { className: 'dat-subtitle' }, '衝突（', preview.conflicts.length, '）'),
      preview.conflicts.length === 0
        ? createElement('p', { className: 'dat-desc' }, '沒有衝突：兩邊都有的資料內容皆相同。')
        : createElement(
            Fragment,
            null,
            createElement(
              Field,
              { label: '全域策略', hint: '可在下方逐筆覆寫' },
              createElement(Select, {
                'aria-label': '全域策略',
                className: 'dat-select',
                value: strategy,
                onChange: setStrategy,
                options: IMPORT_STRATEGIES.map((s) => ({
                  value: s,
                  label: s === 'keep_newer' ? `${STRATEGY_LABELS[s]}（預設）` : STRATEGY_LABELS[s],
                })),
              }),
            ),
            createElement(
              'ul',
              { className: 'dat-conflicts' },
              preview.conflicts.map((c) =>
                createElement(ConflictRow, {
                  key: c.key,
                  conflict: c,
                  strategy: strategy,
                  override: overrides[c.key],
                  onChange: (v) => {
                    const next = { ...overrides };
                    if (v === 'default') delete next[c.key];
                    else next[c.key] = v;
                    setOverrides(next);
                  },
                }),
              ),
            ),
          ),
    ),

    nothing && createElement(Alert, { tone: 'info' }, '檔案內容與目前資料相同，不需要匯入。'),
    createElement(
      'div',
      { className: 'dat-actions' },
      createElement(Button, { variant: 'secondary', onClick: onCancel }, '取消'),
      createElement(Button, { variant: 'primary', disabled: nothing, onClick: onApply }, '套用匯入'),
    ),
  );
}

function ConflictRow({ conflict: c, strategy, override, onChange }) {
  const auto = effectiveResolution(strategy, undefined, c.newer);
  return createElement(
    'li',
    { className: 'dat-conflict', 'data-key': c.key },
    createElement(
      'div',
      { className: 'dat-conflict-head' },
      createElement(Badge, null, c.categoryLabel),
      createElement('span', { className: 'dat-conflict-title' }, c.title),
      createElement(Select, {
        'aria-label': `「${c.title}」的處理方式`,
        className: 'dat-select dat-select--sm',
        value: override ?? 'default',
        onChange: onChange,
        options: [
          { value: 'default', label: `依全域策略（${RESOLUTION_LABELS[auto]}）` },
          { value: 'keep_local', label: RESOLUTION_LABELS.keep_local },
          { value: 'use_import', label: RESOLUTION_LABELS.use_import },
        ],
      }),
    ),
    createElement(
      'p',
      { className: 'dat-meta' },
      '本機更新：',
      c.localUpdatedAt ? formatDateTime(c.localUpdatedAt) : '—',
      ' · 匯入檔更新：',
      c.importUpdatedAt ? formatDateTime(c.importUpdatedAt) : '—',
      '（',
      NEWER_LABELS[c.newer],
      '）',
    ),
    createElement(
      'table',
      { className: 'dat-diff' },
      createElement(
        'thead',
        null,
        createElement(
          'tr',
          null,
          createElement('th', { scope: 'col' }, '欄位'),
          createElement('th', { scope: 'col' }, '本機'),
          createElement('th', { scope: 'col' }, '匯入檔'),
        ),
      ),
      createElement(
        'tbody',
        null,
        c.fields.map((f) =>
          createElement(
            'tr',
            { key: f.name },
            createElement('td', null, f.label),
            createElement('td', null, formatValue(f.local)),
            createElement('td', null, formatValue(f.import)),
          ),
        ),
      ),
    ),
  );
}

// ── 結果 ────────────────────────────────────────────────────

function ResultView({ result, onDone }) {
  const t = resultTotals(result);
  return createElement(
    'div',
    { className: 'dat-result', 'aria-label': '匯入結果' },
    createElement(
      Alert,
      { tone: 'success', role: 'status' },
      '匯入完成：新增 ',
      t.created,
      '、更新 ',
      t.updated,
      t.deleted > 0 && `、刪除 ${t.deleted}`,
      t.skipped > 0 && `、略過 ${t.skipped}`,
      ' 筆。',
      result.backupFile && ` 匯入前的備份：${result.backupFile}`,
    ),
    createElement(
      'table',
      { className: 'adm-table dat-table' },
      createElement(
        'thead',
        null,
        createElement(
          'tr',
          null,
          createElement('th', { scope: 'col' }, '類別'),
          createElement('th', { scope: 'col', className: 'dat-num' }, '新增'),
          createElement('th', { scope: 'col', className: 'dat-num' }, '更新'),
          createElement('th', { scope: 'col', className: 'dat-num' }, '未變更'),
          createElement('th', { scope: 'col', className: 'dat-num' }, '略過'),
          result.mode === 'replace' && createElement('th', { scope: 'col', className: 'dat-num' }, '刪除'),
        ),
      ),
      createElement(
        'tbody',
        null,
        result.categories.map((c) =>
          createElement(
            'tr',
            { key: c.key, 'data-category': c.key },
            createElement('td', null, c.label),
            createElement('td', { className: 'dat-num' }, c.created),
            createElement('td', { className: 'dat-num' }, c.updated),
            createElement('td', { className: 'dat-num' }, c.unchanged),
            createElement('td', { className: 'dat-num' }, c.skipped),
            result.mode === 'replace' && createElement('td', { className: 'dat-num' }, c.deleted),
          ),
        ),
      ),
    ),
    result.createdUsers.length > 0 &&
      createElement(
        'div',
        { className: 'dat-block' },
        createElement('h3', { className: 'dat-subtitle' }, '已建立的成員'),
        createElement(
          Alert,
          { tone: 'warning' },
          '臨時密碼只會顯示這一次，請立即轉交本人；首次登入須變更密碼。',
        ),
        createElement(
          'table',
          { className: 'dat-diff' },
          createElement(
            'thead',
            null,
            createElement(
              'tr',
              null,
              createElement('th', { scope: 'col' }, '成員'),
              createElement('th', { scope: 'col' }, '帳號'),
              createElement('th', { scope: 'col' }, '臨時密碼'),
            ),
          ),
          createElement(
            'tbody',
            null,
            result.createdUsers.map((u) =>
              createElement(
                'tr',
                { key: u.username },
                createElement('td', null, u.displayName),
                createElement('td', null, '@', u.username),
                createElement(
                  'td',
                  null,
                  createElement('code', { className: 'dat-password' }, u.tempPassword),
                ),
              ),
            ),
          ),
        ),
      ),
    result.missingUsersSkipped.length > 0 &&
      createElement(
        'p',
        { className: 'dat-desc' },
        '已略過指派的成員：',
        result.missingUsersSkipped.join('、'),
      ),
    createElement(
      'div',
      { className: 'dat-actions' },
      createElement(Button, { variant: 'primary', onClick: onDone }, '完成'),
    ),
  );
}
