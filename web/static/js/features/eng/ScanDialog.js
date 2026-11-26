import { createElement, Fragment } from 'preact';
import { useId, useState } from 'preact/compat';
import { errorMessage } from '../../lib/api.js';
import { readStorage, writeStorage } from '../../lib/storage.js';
import { notifySuccess } from '../../lib/toast.js';
import { Alert, Badge, Button, Dialog, Field, Input, Select } from '../../ui/index.js';
import { NONE, useUserOptions } from './userOptions.js';
import { useScanApply, useScanPreview } from './api.js';
import { NameList } from './bits.js';
import { pathKey, rememberPath, reportSummary, SCAN_PATHS_KEY } from './model.js';

const ACTION_LABEL = {
  new: '新發現',
  moved: '可能搬動',
  existing: '已登記',
};
const ACTION_TONE = { new: 'success', moved: 'accent', existing: 'neutral' };

function readPaths() {
  try {
    const v = JSON.parse(readStorage(SCAN_PATHS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 掃描本機專案：輸入資料夾 → 預覽（新增 / 已存在 / 可能搬動）→ 勾選後登記。需 eng.scan */
export function ScanDialog({ scan, defaultOwnerId, onClose }) {
  const listId = useId();
  const [recent, setRecent] = useState(readPaths);
  const [path, setPath] = useState(() => recent[0] ?? '');
  const [machine, setMachine] = useState(scan.machine ?? '');
  const [ownerId, setOwnerId] = useState(defaultOwnerId);
  const ownerOptions = useUserOptions(ownerId).filter((o) => o.value !== NONE);
  const [preview, setPreview] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const run = useScanPreview();
  const apply = useScanApply();

  const doPreview = (e) => {
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

  const toggle = (item) =>
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
  return createElement(
    Dialog,
    {
      open: true,
      size: 'md',
      title: '掃描本機專案',
      onClose: onClose,
      dirty: preview != null,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        preview
          ? createElement(
              Button,
              { variant: 'primary', disabled: picked.size === 0, loading: apply.isPending, onClick: doApply },
              '登記（',
              picked.size,
              '）',
            )
          : createElement(
              Button,
              {
                variant: 'primary',
                type: 'submit',
                form: 'eng-scan-form',
                disabled: disabled || !path.trim(),
                loading: run.isPending,
              },
              '預覽',
            ),
      ),
    },
    disabled
      ? createElement(
          Alert,
          { tone: 'info' },
          createElement(
            'span',
            { 'data-testid': 'scan-disabled' },
            '此功能目前停用。管理員在伺服器的 ',
            createElement('code', null, '.env'),
            ' 設定 ',
            createElement('code', null, 'WORKTREE_SCAN_ROOTS'),
            '（允許掃描的資料夾，逗號分隔，例如 ',
            createElement('code', null, 'C:\\work,D:\\repos'),
            '）並重新啟動後即可使用； 也可以在自己的電腦執行 ',
            createElement('code', null, 'python -m server.cli scan-worktrees <專案資料夾>'),
            '。',
          ),
        )
      : createElement(
          'form',
          { id: 'eng-scan-form', className: 'eng-form', onSubmit: doPreview },
          createElement(NameList, { id: listId, names: recent }),
          createElement(
            Field,
            {
              label: '專案資料夾',
              hint: scan.roots?.length ? `允許的範圍：${scan.roots.join('、')}` : undefined,
            },
            createElement(Input, {
              className: 'eng-mono',
              'data-autofocus': true,
              list: listId,
              value: path,
              maxLength: 1000,
              placeholder: 'C:\\work\\my-repo',
              onChange: (e) => {
                setPath(e.target.value);
                setPreview(null);
              },
            }),
          ),
          createElement(
            Field,
            { label: '電腦名稱', hint: '登記到哪台電腦（預設為伺服器這台）' },
            createElement(Input, {
              value: machine,
              maxLength: 100,
              onChange: (e) => {
                setMachine(e.target.value);
                setPreview(null);
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
          createElement(
            'p',
            { className: 'eng-help' },
            '只會讀取 git 資訊（不 fetch、不執行 hook），預覽不會寫入任何資料。',
          ),
        ),
    run.error != null && createElement(Alert, { tone: 'danger' }, errorMessage(run.error)),
    apply.error != null && createElement(Alert, { tone: 'danger' }, errorMessage(apply.error)),
    preview &&
      createElement(
        'div',
        { className: 'eng-scan', 'data-testid': 'scan-preview' },
        createElement(
          'p',
          { className: 'eng-scan-summary' },
          createElement('strong', null, preview.repo),
          '（',
          preview.machine,
          '）：新增 ',
          preview.counts.new,
          '、已存在',
          ' ',
          preview.counts.existing,
          '、可能搬動 ',
          preview.counts.moved,
          preview.truncated && '（數量過多，只列出前 200 個）',
        ),
        preview.items.length === 0
          ? createElement('p', { className: 'eng-help' }, '這個專案沒有其他 worktree。')
          : createElement(
              'ul',
              { className: 'eng-scan-list' },
              preview.items.map((i) => {
                const k = pathKey(i.path);
                const existing = i.action === 'existing';
                return createElement(
                  'li',
                  { key: k, className: 'eng-scan-item', 'data-action': i.action },
                  createElement(
                    'label',
                    { className: 'eng-scan-label' },
                    createElement('input', {
                      type: 'checkbox',
                      className: 'ui-checkbox',
                      checked: picked.has(k),
                      disabled: existing,
                      onChange: () => toggle(i),
                      'aria-label': `登記 ${i.branch ?? i.path}`,
                    }),
                    createElement(
                      'span',
                      { className: 'eng-two-line' },
                      createElement(
                        'span',
                        { className: 'eng-scan-head' },
                        createElement(Badge, { tone: ACTION_TONE[i.action] }, ACTION_LABEL[i.action]),
                        createElement('span', { className: 'eng-mono' }, i.branch ?? '（分離 HEAD）'),
                      ),
                      createElement('span', { className: 'eng-path eng-ellipsis', title: i.path }, i.path),
                      createElement(
                        'span',
                        { className: 'eng-sub' },
                        i.action === 'moved' ? `原路徑 ${i.recordPath} · ` : '',
                        reportSummary(i),
                      ),
                    ),
                  ),
                );
              }),
            ),
      ),
  );
}
