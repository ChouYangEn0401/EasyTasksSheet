import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { errorMessage } from '../../lib/api.js';
import { useCan } from '../../lib/permissions.js';
import { Alert, Button, Dialog, Input } from '../../ui/index.js';
import { useImportIssues, useSaveGithubLinks } from './api.js';

let seq = 0;
const toRows = (links) => links.map((l) => ({ ...l, key: ++seq }));
const clean = (rows) =>
  rows
    .map((r) => ({ project: r.project.trim(), githubRepo: r.githubRepo.trim() }))
    .filter((r) => r.project || r.githubRepo);

/**
 * GitHub 連動（githubEnabled 時才出現）：專案 ↔ repo 對應（需 github.manage：manager 以上可編輯、整批儲存；其他成員唯讀），
 * 已儲存的對應可「從 GitHub 匯入」開啟中的 issue（以 repo + 編號去重）。
 */
export function GithubDialog({ links, listId, onClose }) {
  const [rows, setRows] = useState(() => toRows(links.length ? links : [{ project: '', githubRepo: '' }]));
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const canEdit = useCan('github.manage');
  const save = useSaveGithubLinks();
  const importIssues = useImportIssues();
  const dirty = JSON.stringify(clean(rows)) !== JSON.stringify(links);
  const set = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const submit = () => {
    setError(null);
    setNotice(null);
    save.mutate(clean(rows), {
      onSuccess: (res) => {
        setRows(toRows(res.links.length ? res.links : [{ project: '', githubRepo: '' }]));
        setNotice('已儲存');
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const runImport = (project) => {
    setError(null);
    setNotice(null);
    // mutateAsync：連續匯入多個專案時每一筆的結果都會顯示（mutate 的呼叫層回呼只保留最後一次）
    importIssues.mutateAsync(project).then(
      (res) =>
        setNotice(
          `從 ${res.repo} 匯入 ${res.created} 筆` + (res.skipped ? `（${res.skipped} 筆已存在，略過）` : ''),
        ),
      (err) => setError(errorMessage(err)),
    );
  };

  return createElement(
    Dialog,
    {
      open: true,
      size: 'md',
      title: 'GitHub 連動',
      dirty: dirty,
      onClose: onClose,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '關閉'),
        canEdit &&
          createElement(
            Button,
            { variant: 'primary', disabled: !dirty, loading: save.isPending, onClick: submit },
            '儲存連動',
          ),
      ),
    },
    createElement(
      'div',
      { className: 'eng-form' },
      createElement(
        'p',
        { className: 'eng-dialog-text' },
        '把問題的「專案 / Repo」對應到 GitHub repo（',
        createElement('code', null, 'owner/name'),
        '）後，可匯入該 repo 開啟中的 issue，或從問題的「⋯」選單在 GitHub 建立 issue。',
      ),
      !canEdit &&
        createElement(
          Alert,
          { tone: 'info' },
          '連動設定僅管理者以上可修改；你仍可從已設定的 repo 匯入 issue。',
        ),
      error && createElement(Alert, { tone: 'danger' }, error),
      notice && createElement(Alert, { tone: 'success' }, notice),
      createElement(
        'ul',
        { className: 'eng-gh-links', 'aria-label': '專案連動' },
        rows.map((r, idx) => {
          const saved = links.find((l) => l.project.toLowerCase() === r.project.trim().toLowerCase());
          const canImport = !dirty && saved != null;
          return createElement(
            'li',
            { key: r.key, className: 'eng-gh-link' },
            createElement(Input, {
              value: r.project,
              maxLength: 100,
              list: listId,
              placeholder: '專案名稱',
              readOnly: !canEdit,
              'aria-label': `第 ${idx + 1} 列的專案`,
              onChange: (e) => set(r.key, { project: e.target.value }),
            }),
            createElement('span', { className: 'eng-text-tertiary', 'aria-hidden': 'true' }, '→'),
            createElement(Input, {
              value: r.githubRepo,
              maxLength: 200,
              placeholder: 'owner/name',
              readOnly: !canEdit,
              'aria-label': `第 ${idx + 1} 列的 GitHub repo`,
              onChange: (e) => set(r.key, { githubRepo: e.target.value }),
            }),
            createElement(
              Button,
              {
                variant: 'secondary',
                size: 'sm',
                disabled: !canImport,
                loading: importIssues.isPending && importIssues.variables === saved?.project,
                onClick: () => saved && runImport(saved.project),
                title: canImport ? undefined : '先儲存連動',
              },
              '從 GitHub 匯入',
            ),
            canEdit &&
              createElement(Button, {
                variant: 'ghost',
                size: 'sm',
                iconOnly: true,
                icon: 'x',
                'aria-label': `移除第 ${idx + 1} 列`,
                onClick: () => setRows((rs) => rs.filter((x) => x.key !== r.key)),
              }),
          );
        }),
      ),
      canEdit &&
        createElement(
          'div',
          null,
          createElement(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              icon: 'plus',
              onClick: () => setRows((rs) => [...rs, ...toRows([{ project: '', githubRepo: '' }])]),
            },
            '新增連動',
          ),
        ),
    ),
  );
}
