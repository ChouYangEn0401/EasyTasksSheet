import { createElement, Fragment } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/compat';
import { errorMessage } from '../../lib/api.js';
import { readStorage, writeStorage } from '../../lib/storage.js';
import { notifySuccess } from '../../lib/toast.js';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
  Tooltip,
} from '../../ui/index.js';
import { usePasteApply, usePastePreview } from './api.js';
import { NameList } from './bits.js';
import { StatusSelect } from './EngStatus.js';
import { MACHINE_STORAGE_KEY } from './model.js';
import { NONE, useUserOptions } from './userOptions.js';
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
} from './pasteModel.js';

const PREVIEW_DELAY_MS = 350;

/**
 * 貼上 git worktree list 輸出：貼上文字 → 自動預覽（新增 / 已存在 / 可能搬動）→ 勾選 → 登記。
 * 只解析文字，不執行任何 git，不需要資料夾路徑；需 eng.edit。
 */
export function PasteDialog({ machineNames, defaultOwnerId, onClose, onDone }) {
  const listId = useId();
  const [text, setText] = useState('');
  const [machine, setMachine] = useState(() => readStorage(MACHINE_STORAGE_KEY) ?? DEFAULT_PASTE_MACHINE);
  const [repo, setRepo] = useState('');
  const [repoEdited, setRepoEdited] = useState(false);
  const [status, setStatus] = useState('active');
  const [ownerId, setOwnerId] = useState(defaultOwnerId);
  const ownerOptions = useUserOptions(ownerId).filter((o) => o.value !== NONE);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [preview, setPreview] = useState(null);
  const [picked, setPicked] = useState(pickNone);
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
        ownerId,
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

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doApply();
    }
  };

  const toggleExisting = (v) => {
    setUpdateExisting(v);
    if (!v) setPicked((p) => dropUnpickable(items, p, v));
  };

  const loading = run.isPending && preview == null;
  return createElement(
    Dialog,
    {
      open: true,
      size: 'lg',
      title: '貼上 git worktree list',
      onClose: onClose,
      dirty: text.trim() !== '',
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        createElement(
          Button,
          { variant: 'primary', disabled: !canApply, loading: apply.isPending, onClick: doApply },
          '登記 ',
          lines.length,
          ' 筆',
        ),
      ),
    },
    createElement(
      'div',
      { className: 'eng-paste', onKeyDown: onKeyDown },
      createElement(
        'p',
        { className: 'eng-help' },
        '在專案資料夾執行 ',
        createElement('code', null, 'git worktree list'),
        '，把輸出整段貼到下面即可（也支援',
        ' ',
        createElement('code', null, '--porcelain'),
        '）。PowerShell 可用 ',
        createElement('code', null, 'git worktree list | Set-Clipboard'),
        ' ',
        '直接複製。這裡只解析文字，不會執行任何指令。',
      ),
      createElement(
        Field,
        { label: 'git worktree list 輸出' },
        createElement(Textarea, {
          className: 'eng-mono eng-paste-text',
          'data-autofocus': true,
          'data-testid': 'paste-text',
          rows: 6,
          spellCheck: false,
          value: text,
          maxLength: 200_000,
          placeholder: 'C:/work/my-repo  80a0d97a [main]\nC:/work/my-repo-wt  16687b8d [feat/x]',
          onChange: (e) => setText(e.target.value),
        }),
      ),
      createElement(NameList, { id: listId, names: machineNames }),
      createElement(
        'div',
        { className: 'eng-paste-fields' },
        createElement(
          Field,
          { label: '電腦名稱', hint: '必填；會記住上次輸入' },
          createElement(Input, {
            list: listId,
            value: machine,
            maxLength: 100,
            placeholder: DEFAULT_PASTE_MACHINE,
            onChange: (e) => setMachine(e.target.value),
          }),
        ),
        createElement(
          Field,
          { label: '專案 / Repo 名稱', hint: '預設取第一筆（主 worktree）的資料夾名稱' },
          createElement(Input, {
            value: repo,
            maxLength: 100,
            onChange: (e) => {
              setRepo(e.target.value);
              setRepoEdited(true);
            },
          }),
        ),
        createElement(
          Field,
          { label: '負責人', hint: '新登記的紀錄會歸給這位成員（預設是你）' },
          createElement(Select, {
            options: ownerOptions,
            value: ownerId,
            onChange: setOwnerId,
            'aria-label': '登記的負責人',
          }),
        ),
      ),

      run.error != null && createElement(Alert, { tone: 'danger' }, errorMessage(run.error)),
      apply.error != null && createElement(Alert, { tone: 'danger' }, errorMessage(apply.error)),
      loading &&
        createElement(
          'p',
          { className: 'eng-help eng-paste-loading', role: 'status' },
          createElement(Spinner, null),
          ' 解析中…',
        ),
      preview &&
        createElement(
          'div',
          { className: 'eng-scan', 'data-testid': 'paste-preview', 'aria-busy': run.isPending },
          createElement(
            'p',
            { className: 'eng-scan-summary', 'data-testid': 'paste-summary' },
            createElement('strong', null, preview.repo || '（未命名）'),
            '（',
            preview.machine,
            '）：新增 ',
            preview.counts.new,
            '、已存在 ',
            preview.counts.existing,
            '、可能搬動 ',
            preview.counts.moved,
            preview.truncated && '（超過 500 筆，只列出前 500 筆）',
          ),
          createElement(
            'div',
            { className: 'eng-paste-bar' },
            createElement(
              'span',
              { className: 'eng-paste-bulk' },
              createElement(
                Button,
                {
                  size: 'sm',
                  variant: 'secondary',
                  onClick: () => setPicked(pickAll(items, updateExisting)),
                },
                '全選',
              ),
              createElement(
                Button,
                {
                  size: 'sm',
                  variant: 'secondary',
                  onClick: () => setPicked(pickNonTemp(items, updateExisting)),
                },
                '只選非暫時性',
              ),
              createElement(
                Button,
                { size: 'sm', variant: 'secondary', onClick: () => setPicked(pickNone()) },
                '全不選',
              ),
              createElement(
                'span',
                { className: 'eng-help', 'data-testid': 'paste-count' },
                '已選 ',
                lines.length,
                ' / ',
                items.length,
              ),
            ),
            createElement(
              'span',
              { className: 'eng-paste-status' },
              createElement('span', { className: 'eng-help' }, '登記為'),
              createElement(StatusSelect, {
                kind: 'worktree',
                value: status,
                onChange: setStatus,
                label: '登記狀態',
              }),
            ),
          ),
          createElement(Checkbox, {
            label: '同時更新已存在的紀錄（分支、HEAD、貼上匯入的備註）',
            checked: updateExisting,
            onChange: (e) => toggleExisting(e.target.checked),
          }),
          items.length === 0
            ? createElement('p', { className: 'eng-help' }, '沒有辨識到任何 worktree。')
            : createElement(
                'div',
                { className: 'eng-paste-scroll' },
                createElement(
                  'table',
                  { className: 'eng-paste-table' },
                  createElement(
                    'thead',
                    null,
                    createElement(
                      'tr',
                      null,
                      createElement('th', {
                        scope: 'col',
                        className: 'eng-paste-col-check',
                        'aria-label': '勾選',
                      }),
                      createElement('th', { scope: 'col' }, '路徑'),
                      createElement('th', { scope: 'col' }, '分支'),
                      createElement('th', { scope: 'col', className: 'eng-paste-col-sha' }, 'sha'),
                      createElement('th', { scope: 'col' }, '標籤'),
                    ),
                  ),
                  createElement(
                    'tbody',
                    null,
                    items.map((i) =>
                      createElement(PasteRow, {
                        key: i.lineNo,
                        item: i,
                        checked: picked.has(i.lineNo),
                        disabled: !isPickable(i, updateExisting),
                        onToggle: () => setPicked((p) => togglePick(p, i.lineNo)),
                      }),
                    ),
                  ),
                ),
              ),
          preview.unparsedCount > 0 &&
            createElement(
              'details',
              { className: 'eng-paste-unparsed' },
              createElement(
                'summary',
                { 'data-testid': 'paste-unparsed' },
                '有 ',
                preview.unparsedCount,
                ' 行無法辨識',
              ),
              createElement(
                'ul',
                null,
                preview.unparsed.map((u) =>
                  createElement(
                    'li',
                    { key: u.lineNo },
                    createElement('span', { className: 'eng-help' }, '第 ', u.lineNo, ' 行'),
                    ' ',
                    createElement('code', { className: 'eng-mono' }, u.text),
                  ),
                ),
              ),
            ),
          createElement(
            'p',
            { className: 'eng-help' },
            'Ctrl+Enter 登記 · Esc 關閉 · 「暫時性」只是提示，仍可手動勾選',
          ),
        ),
    ),
  );
}

function PasteRow({ item, checked, disabled, onToggle }) {
  const label = item.branch ?? item.path;
  return createElement(
    'tr',
    { className: 'eng-paste-row', 'data-action': item.action, 'data-temp': item.isTemp || undefined },
    createElement(
      'td',
      { className: 'eng-paste-col-check' },
      createElement('input', {
        type: 'checkbox',
        className: 'ui-checkbox',
        checked: checked && !disabled,
        disabled: disabled,
        onChange: onToggle,
        'aria-label': `登記 ${label}`,
      }),
    ),
    createElement(
      'td',
      null,
      createElement(
        'span',
        { className: 'eng-path eng-mono eng-paste-path', title: item.path },
        middleEllipsis(item.path),
      ),
    ),
    createElement(
      'td',
      { className: 'eng-mono' },
      item.branch ?? createElement('span', { className: 'eng-text-secondary' }, '（無）'),
    ),
    createElement('td', { className: 'eng-mono eng-paste-col-sha' }, item.sha ? item.sha.slice(0, 8) : '—'),
    createElement(
      'td',
      null,
      createElement(
        'span',
        { className: 'eng-paste-tags' },
        pasteTags(item).map((t) =>
          createElement(
            Tooltip,
            { key: t.label, content: t.title },
            createElement(Badge, { tone: t.tone }, t.label),
          ),
        ),
      ),
    ),
  );
}
