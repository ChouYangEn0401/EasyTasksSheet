import { createElement, Fragment } from 'preact';
import { useMemo, useState } from 'preact/compat';
import { useSearchParams } from '../../lib/router.js';
import { ApiError, errorMessage } from '../../lib/api.js';
import { useCurrentUser } from '../../lib/auth.js';
import { formatDateTime } from '../../lib/format.js';
import { useCan } from '../../lib/permissions.js';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Menu,
  Skeleton,
  UpdatedAt,
} from '../../ui/index.js';
import { NoPermission } from './AdminUsersPage.js';
import {
  useCreateSource,
  useDeleteSource,
  useRegenerateToken,
  useResolveBulk,
  useResolveConflict,
  useSyncConflict,
  useSyncConflicts,
  useSyncSources,
  useUpdateSource,
} from './syncApi.js';
import {
  allChoices,
  buildResolveInput,
  diffText,
  fieldText,
  pushCommand,
  RESOLUTION_TEXT,
  summaryText,
} from './syncModel.js';

import { BASE_PATH } from '../../lib/base.js';

/**
 * 資料同步（/admin/data/sync）。docs/design/sync.md、docs/sync.md：
 * 「同步來源」需 sync.manage；「待確認衝突」需 sync.resolve（預設皆為管理者以上）。
 */
export function SyncPage() {
  const me = useCurrentUser();
  const canManage = useCan('sync.manage');
  const canResolve = useCan('sync.resolve');
  const [params, setParams] = useSearchParams();
  const pending = useSyncConflicts('pending', canResolve);
  if (!me) return null;
  if (!canManage && !canResolve) return createElement(NoPermission, null);

  const tabs = [...(canManage ? ['sources'] : []), ...(canResolve ? ['conflicts'] : [])];
  const requested = params.get('tab');
  const tab = requested && tabs.includes(requested) ? requested : tabs[0];
  const setTab = (t) => setParams(t === tabs[0] ? {} : { tab: t }, { replace: true });
  const pendingCount = pending.data?.counts.pending ?? 0;

  const onKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.indexOf(tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`syn-tab-${next}`)?.focus());
  };

  return createElement(
    'div',
    { className: 'adm-page syn-page' },
    createElement(
      'div',
      { className: 'syn-tabs', role: 'tablist', 'aria-label': '資料同步', onKeyDown: onKey },
      tabs.map((t) =>
        createElement(
          'button',
          {
            key: t,
            id: `syn-tab-${t}`,
            type: 'button',
            role: 'tab',
            className: 'syn-tab',
            'aria-selected': tab === t,
            'aria-controls': `syn-panel-${t}`,
            tabIndex: tab === t ? 0 : -1,
            onClick: () => setTab(t),
          },
          t === 'sources' ? '同步來源' : '待確認衝突',
          t === 'conflicts' &&
            pendingCount > 0 &&
            createElement(Badge, { tone: 'warning', count: true }, pendingCount),
        ),
      ),
    ),
    createElement(
      'div',
      {
        role: 'tabpanel',
        id: `syn-panel-${tab}`,
        'aria-labelledby': `syn-tab-${tab}`,
        className: 'syn-panel',
      },
      tab === 'sources' ? createElement(SourcesPanel, null) : createElement(ConflictsPanel, null),
    ),
  );
}

function SourcesPanel() {
  const query = useSyncSources();
  const update = useUpdateSource();
  const [dialog, setDialog] = useState(null);

  const menuItems = (s) => [
    {
      key: 'toggle',
      label: s.isActive ? '停用' : '重新啟用',
      onSelect: () => update.mutate({ id: s.id, isActive: !s.isActive }),
    },
    {
      key: 'auto',
      label: s.autoCreateUsers ? '關閉自動建立缺少的成員' : '開啟自動建立缺少的成員',
      onSelect: () => update.mutate({ id: s.id, autoCreateUsers: !s.autoCreateUsers }),
    },
    { key: 'regen', label: '重新產生金鑰…', onSelect: () => setDialog({ kind: 'regenerate', source: s }) },
    { key: 'sep', separator: true },
    {
      key: 'delete',
      label: '刪除來源…',
      danger: true,
      onSelect: () => setDialog({ kind: 'delete', source: s }),
    },
  ];

  return createElement(
    'section',
    { className: 'syn-section', 'aria-labelledby': 'syn-sources-title' },
    createElement(
      'div',
      { className: 'syn-head' },
      createElement(
        'div',
        { className: 'syn-head-text' },
        createElement('h2', { id: 'syn-sources-title', className: 'dat-title' }, '同步來源'),
        createElement(
          'p',
          { className: 'dat-desc' },
          '每台電腦一個來源、一組金鑰。電腦上的資料會增量上傳到這裡，只會新增與更新，不會因為資料不見而刪除。',
        ),
      ),
      createElement(
        Button,
        { variant: 'primary', icon: 'plus', onClick: () => setDialog({ kind: 'create' }) },
        '新增同步來源',
      ),
    ),

    query.isPending
      ? createElement(
          'div',
          { className: 'adm-card', 'aria-label': '載入中' },
          [0, 1, 2].map((i) =>
            createElement(
              'div',
              { key: i, className: 'adm-skeleton-row' },
              createElement(Skeleton, { width: 160, height: 14 }),
              createElement(Skeleton, { width: 240, height: 12 }),
            ),
          ),
        )
      : query.isError
        ? createElement(ErrorState, { error: query.error, onRetry: () => void query.refetch() })
        : query.data.length === 0
          ? createElement(
              'div',
              { className: 'adm-card' },
              createElement(EmptyState, {
                icon: 'refresh',
                title: '還沒有同步來源',
                description: '為每台要上傳資料的電腦建立一個來源，取得金鑰後在那台電腦執行上傳命令。',
              }),
            )
          : createElement(
              'div',
              { className: 'adm-card syn-table-wrap' },
              createElement(
                'table',
                { className: 'adm-table syn-table' },
                createElement(
                  'thead',
                  null,
                  createElement(
                    'tr',
                    null,
                    createElement('th', { scope: 'col' }, '名稱'),
                    createElement('th', { scope: 'col', className: 'syn-col-time' }, '最後同步'),
                    createElement('th', { scope: 'col', className: 'syn-col-summary' }, '最後一次摘要'),
                    createElement('th', { scope: 'col' }, '狀態'),
                    createElement(
                      'th',
                      { scope: 'col', className: 'adm-col-actions' },
                      createElement('span', { className: 'sr-only' }, '操作'),
                    ),
                  ),
                ),
                createElement(
                  'tbody',
                  null,
                  query.data.map((s) =>
                    createElement(
                      'tr',
                      { key: s.id, 'data-state': s.isActive ? 'active' : 'disabled' },
                      createElement(
                        'td',
                        null,
                        createElement('div', { className: 'syn-name' }, s.name),
                        createElement(
                          'div',
                          { className: 'adm-sub' },
                          '金鑰末碼 …',
                          s.tokenHint,
                          s.autoCreateUsers && ' · 自動建立缺少的成員',
                        ),
                      ),
                      createElement(
                        'td',
                        { className: 'syn-col-time' },
                        s.lastPushAt
                          ? createElement(UpdatedAt, { at: s.lastPushAt })
                          : createElement('span', { className: 'dat-muted' }, '尚未同步'),
                      ),
                      createElement(
                        'td',
                        { className: 'syn-col-summary' },
                        s.lastPushSummary
                          ? createElement(
                              Fragment,
                              null,
                              createElement(
                                'div',
                                { className: 'syn-summary' },
                                summaryText(s.lastPushSummary.totals),
                              ),
                              createElement(
                                'div',
                                { className: 'adm-sub' },
                                s.lastPushSummary.machineName,
                                s.lastPushSummary.full ? ' · 全量' : ' · 增量',
                                s.pendingConflicts > 0 && ` · 待確認 ${s.pendingConflicts}`,
                              ),
                            )
                          : createElement('span', { className: 'dat-muted' }, '—'),
                      ),
                      createElement(
                        'td',
                        null,
                        createElement(
                          Badge,
                          { tone: s.isActive ? 'success' : 'neutral', dot: true },
                          s.isActive ? '啟用中' : '已停用',
                        ),
                      ),
                      createElement(
                        'td',
                        { className: 'adm-col-actions' },
                        createElement(Menu, {
                          align: 'end',
                          width: 220,
                          label: `${s.name} 的操作`,
                          items: menuItems(s),
                          trigger: (p) =>
                            createElement(Button, {
                              ...p,
                              variant: 'ghost',
                              size: 'sm',
                              iconOnly: true,
                              icon: 'more',
                              'aria-label': `${s.name} 的操作`,
                            }),
                        }),
                      ),
                    ),
                  ),
                ),
              ),
            ),
    dialog?.kind === 'create' &&
      createElement(CreateSourceDialog, {
        onClose: () => setDialog(null),
        onCreated: (data) => setDialog({ kind: 'token', data, regenerated: false }),
      }),
    dialog?.kind === 'token' &&
      createElement(TokenDialog, {
        data: dialog.data,
        regenerated: dialog.regenerated,
        onClose: () => setDialog(null),
      }),
    dialog?.kind === 'regenerate' &&
      createElement(RegenerateDialog, {
        source: dialog.source,
        onClose: () => setDialog(null),
        onDone: (data) => setDialog({ kind: 'token', data, regenerated: true }),
      }),
    dialog?.kind === 'delete' &&
      createElement(DeleteDialog, { source: dialog.source, onClose: () => setDialog(null) }),
  );
}

function CreateSourceDialog({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [autoCreate, setAutoCreate] = useState(false);
  const create = useCreateSource();
  const submit = () => {
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), autoCreateUsers: autoCreate }, { onSuccess: onCreated });
  };
  return createElement(
    Dialog,
    {
      open: true,
      onClose: onClose,
      dirty: name.length > 0,
      title: '新增同步來源',
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        createElement(
          Button,
          { variant: 'primary', loading: create.isPending, disabled: !name.trim(), onClick: submit },
          '建立並產生金鑰',
        ),
      ),
    },
    createElement(
      'form',
      {
        className: 'adm-form',
        onSubmit: (e) => {
          e.preventDefault();
          submit();
        },
      },
      createElement(
        Field,
        { label: '名稱', hint: '例如「小明的筆電」，方便辨識是哪台電腦' },
        createElement(Input, {
          value: name,
          maxLength: 100,
          onChange: (e) => setName(e.target.value),
          'aria-label': '名稱',
          'data-autofocus': true,
        }),
      ),
      createElement(Checkbox, {
        checked: autoCreate,
        onChange: (e) => setAutoCreate(e.target.checked),
        label: '自動建立中央缺少的成員（預設不建立，改為略過指派）',
      }),
      create.isError && createElement(Alert, { tone: 'danger' }, errorMessage(create.error)),
    ),
  );
}

function TokenDialog({ data, regenerated, onClose }) {
  const command = pushCommand(window.location.origin + BASE_PATH, data.token);
  const [copied, setCopied] = useState(null);
  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  };
  return createElement(
    Dialog,
    {
      open: true,
      size: 'md',
      role: 'alertdialog',
      onClose: onClose,
      dismissible: false,
      showClose: true,
      title: regenerated ? `「${data.source.name}」的新金鑰` : `已建立「${data.source.name}」`,
      actions: createElement(Button, { variant: 'primary', onClick: onClose }, '我已妥善保存'),
    },
    createElement(
      'div',
      { className: 'syn-token' },
      createElement(
        Alert,
        { tone: 'warning' },
        '金鑰只會顯示這一次，關閉後無法再查看；遺失時可重新產生（舊金鑰會立即失效）。',
      ),
      createElement(
        'div',
        { className: 'syn-copy-row' },
        createElement('span', { className: 'syn-copy-label' }, '金鑰'),
        createElement('code', { className: 'syn-code', 'aria-label': '同步金鑰' }, data.token),
        createElement(
          Button,
          {
            size: 'sm',
            icon: copied === 'token' ? 'check' : undefined,
            onClick: () => void copy(data.token, 'token'),
          },
          copied === 'token' ? '已複製' : '複製金鑰',
        ),
      ),
      createElement(
        'p',
        { className: 'dat-desc' },
        '在那台電腦的專案目錄執行（會自動只上傳自上次之後的變動）：',
      ),
      createElement(
        'div',
        { className: 'syn-copy-row' },
        createElement('code', { className: 'syn-code syn-code--block', 'aria-label': '上傳命令' }, command),
        createElement(
          Button,
          {
            size: 'sm',
            icon: copied === 'command' ? 'check' : undefined,
            onClick: () => void copy(command, 'command'),
          },
          copied === 'command' ? '已複製' : '複製命令',
        ),
      ),
      createElement(
        'p',
        { className: 'dat-meta' },
        '加上 ',
        createElement('code', null, '--dry-run'),
        ' 可先看會上傳幾筆；',
        createElement('code', null, '--full'),
        ' ',
        '重新全量上傳（重複上傳不會產生重複資料）。',
      ),
    ),
  );
}

function RegenerateDialog({ source, onClose, onDone }) {
  const regen = useRegenerateToken();
  return createElement(
    Dialog,
    {
      open: true,
      role: 'alertdialog',
      onClose: onClose,
      title: '重新產生金鑰？',
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        createElement(
          Button,
          {
            variant: 'primary',
            loading: regen.isPending,
            onClick: () => regen.mutate(source.id, { onSuccess: onDone }),
          },
          '重新產生',
        ),
      ),
    },
    createElement(
      'p',
      { className: 'adm-text' },
      '「',
      source.name,
      '」目前的金鑰會立即失效，那台電腦需改用新金鑰才能繼續上傳。',
    ),
  );
}

function DeleteDialog({ source, onClose }) {
  const del = useDeleteSource();
  return createElement(
    Dialog,
    {
      open: true,
      role: 'alertdialog',
      onClose: onClose,
      title: `刪除「${source.name}」？`,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        createElement(
          Button,
          {
            variant: 'danger',
            loading: del.isPending,
            onClick: () => del.mutate(source.id, { onSuccess: onClose }),
          },
          '刪除來源',
        ),
      ),
    },
    createElement(
      'p',
      { className: 'adm-text' },
      '金鑰會立即失效。已經上傳的資料不受影響，衝突紀錄也會保留。',
    ),
    source.pendingConflicts > 0 &&
      createElement(
        'p',
        { className: 'adm-text' },
        '這個來源還有 ',
        source.pendingConflicts,
        ' 筆待確認衝突，刪除後仍可在衝突清單處理。',
      ),
  );
}

// ── 待確認衝突 ──────────────────────────────────────────────

function ConflictsPanel() {
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get('conflict')) || null;
  const [view, setView] = useState('pending');
  const pending = useSyncConflicts('pending');
  const resolved = useSyncConflicts('resolved', view === 'resolved');
  const query = view === 'pending' ? pending : resolved;
  const [selected, setSelected] = useState(new Set());
  const [bulk, setBulk] = useState(null);
  const bulkMut = useResolveBulk();
  const [notice, setNotice] = useState(null);

  const open = (id) => {
    const next = new URLSearchParams(params);
    if (id === null) next.delete('conflict');
    else next.set('conflict', String(id));
    setParams(next, { replace: false });
  };

  if (openId !== null) {
    return createElement(ConflictCompare, {
      id: openId,
      onBack: () => open(null),
      onResolved: (msg) => {
        setNotice(msg);
        open(null);
      },
    });
  }

  const list = query.data?.conflicts ?? [];
  const pendingIds = view === 'pending' ? list.map((c) => c.id) : [];
  const chosen = pendingIds.filter((id) => selected.has(id));
  const allChecked = pendingIds.length > 0 && chosen.length === pendingIds.length;

  return createElement(
    'section',
    { className: 'syn-section', 'aria-labelledby': 'syn-conflicts-title' },
    createElement(
      'div',
      { className: 'syn-head' },
      createElement(
        'div',
        { className: 'syn-head-text' },
        createElement('h2', { id: 'syn-conflicts-title', className: 'dat-title' }, '待確認衝突'),
        createElement(
          'p',
          { className: 'dat-desc' },
          '這些資料在兩邊幾乎同時被修改，系統不會自行決定，請確認要保留哪一份。',
        ),
      ),
      createElement(
        'div',
        { className: 'syn-seg', role: 'group', 'aria-label': '顯示' },
        createElement(
          Button,
          {
            size: 'sm',
            variant: view === 'pending' ? 'primary' : 'secondary',
            onClick: () => setView('pending'),
          },
          '待處理（',
          pending.data?.counts.pending ?? 0,
          '）',
        ),
        createElement(
          Button,
          {
            size: 'sm',
            variant: view === 'resolved' ? 'primary' : 'secondary',
            onClick: () => setView('resolved'),
          },
          '已處理紀錄',
        ),
      ),
    ),
    notice && createElement(Alert, { tone: 'success', onClose: () => setNotice(null) }, notice),
    bulkMut.isError && createElement(Alert, { tone: 'danger' }, errorMessage(bulkMut.error)),
    view === 'pending' &&
      chosen.length > 0 &&
      createElement(
        'div',
        { className: 'syn-bulkbar', role: 'region', 'aria-label': '批次處理' },
        createElement('span', null, '已選 ', chosen.length, ' 筆'),
        createElement(Button, { size: 'sm', onClick: () => setBulk('keep_local') }, '全部保留中央'),
        createElement(Button, { size: 'sm', onClick: () => setBulk('use_incoming') }, '全部採用上傳'),
        createElement(
          Button,
          { size: 'sm', variant: 'ghost', onClick: () => setSelected(new Set()) },
          '取消選取',
        ),
      ),
    query.isPending
      ? createElement(
          'div',
          { className: 'adm-card', 'aria-label': '載入中' },
          [0, 1, 2].map((i) =>
            createElement(
              'div',
              { key: i, className: 'adm-skeleton-row' },
              createElement(Skeleton, { width: 200, height: 14 }),
              createElement(Skeleton, { width: 160, height: 12 }),
            ),
          ),
        )
      : query.isError
        ? createElement(ErrorState, { error: query.error, onRetry: () => void query.refetch() })
        : list.length === 0
          ? createElement(
              'div',
              { className: 'adm-card' },
              createElement(EmptyState, {
                icon: 'checkCircle',
                title: view === 'pending' ? '目前沒有待確認的衝突' : '還沒有處理紀錄',
                description: view === 'pending' ? '各台電腦上傳的資料都已自動合併。' : undefined,
              }),
            )
          : createElement(
              'div',
              { className: 'adm-card syn-table-wrap' },
              createElement(
                'table',
                { className: 'adm-table syn-table' },
                createElement(
                  'thead',
                  null,
                  createElement(
                    'tr',
                    null,
                    view === 'pending' &&
                      createElement(
                        'th',
                        { scope: 'col', className: 'syn-col-check' },
                        createElement(Checkbox, {
                          'aria-label': '全選',
                          checked: allChecked,
                          onChange: (e) => setSelected(e.target.checked ? new Set(pendingIds) : new Set()),
                        }),
                      ),
                    createElement('th', { scope: 'col' }, '資料'),
                    createElement('th', { scope: 'col' }, '來源'),
                    createElement('th', { scope: 'col', className: 'syn-col-summary' }, '更新時間'),
                    view === 'resolved' && createElement('th', { scope: 'col' }, '處理'),
                    createElement(
                      'th',
                      { scope: 'col', className: 'syn-col-open' },
                      createElement('span', { className: 'sr-only' }, '開啟'),
                    ),
                  ),
                ),
                createElement(
                  'tbody',
                  null,
                  list.map((c) =>
                    createElement(ConflictRow, {
                      key: c.id,
                      c: c,
                      view: view,
                      checked: selected.has(c.id),
                      onCheck: (v) => {
                        const next = new Set(selected);
                        if (v) next.add(c.id);
                        else next.delete(c.id);
                        setSelected(next);
                      },
                      onOpen: () => open(c.id),
                    }),
                  ),
                ),
              ),
            ),
    bulk &&
      createElement(
        Dialog,
        {
          open: true,
          role: 'alertdialog',
          onClose: () => !bulkMut.isPending && setBulk(null),
          title:
            bulk === 'keep_local' ? `保留中央的 ${chosen.length} 筆？` : `採用上傳的 ${chosen.length} 筆？`,
          actions: createElement(
            Fragment,
            null,
            createElement(
              Button,
              { variant: 'secondary', disabled: bulkMut.isPending, onClick: () => setBulk(null) },
              '取消',
            ),
            createElement(
              Button,
              {
                variant: 'primary',
                loading: bulkMut.isPending,
                onClick: () =>
                  bulkMut.mutate(
                    { ids: chosen, resolution: bulk },
                    {
                      onSuccess: (r) => {
                        setBulk(null);
                        setSelected(new Set());
                        setNotice(
                          `已處理 ${r.resolved.length} 筆${r.skipped.length ? `，${r.skipped.length} 筆先前已處理` : ''}。`,
                        );
                      },
                      onError: () => setBulk(null),
                    },
                  ),
              },
              RESOLUTION_TEXT[bulk],
            ),
          ),
        },
        createElement(
          'p',
          { className: 'adm-text' },
          bulk === 'keep_local'
            ? '中央現有資料維持不變，上傳的版本不採用。'
            : '以各台電腦上傳的版本覆蓋中央現有資料（所有差異欄位）。',
        ),
      ),
  );
}

function ConflictRow({ c, view, checked, onCheck, onOpen }) {
  return createElement(
    'tr',
    { 'data-conflict': c.id },
    view === 'pending' &&
      createElement(
        'td',
        { className: 'syn-col-check' },
        createElement(Checkbox, {
          'aria-label': `選取「${c.title}」`,
          checked: checked,
          onChange: (e) => onCheck(e.target.checked),
        }),
      ),
    createElement(
      'td',
      null,
      createElement(
        'div',
        { className: 'syn-row-title' },
        createElement(Badge, null, c.categoryLabel),
        createElement('span', { className: 'syn-name' }, c.title || '（無標題）'),
      ),
      createElement('div', { className: 'adm-sub' }, c.diffFields.map((f) => f.label).join('、'), ' 不同'),
    ),
    createElement(
      'td',
      null,
      c.sourceId === null
        ? createElement('span', { className: 'dat-muted' }, c.sourceName, '（已刪除）')
        : c.sourceName,
    ),
    createElement(
      'td',
      { className: 'syn-col-summary' },
      createElement(
        'div',
        { className: 'syn-times' },
        createElement('span', null, '中央 ', c.localUpdatedAt ? formatDateTime(c.localUpdatedAt) : '—'),
        createElement('span', null, '上傳 ', c.incomingUpdatedAt ? formatDateTime(c.incomingUpdatedAt) : '—'),
      ),
      createElement(Badge, { tone: 'warning' }, diffText(c.diffMinutes)),
    ),
    view === 'resolved' &&
      createElement(
        'td',
        null,
        createElement('div', null, c.resolution ? RESOLUTION_TEXT[c.resolution] : '—'),
        createElement(
          'div',
          { className: 'adm-sub' },
          c.resolvedByName ?? '系統（之後的上傳已取代）',
          c.resolvedAt && ` · ${formatDateTime(c.resolvedAt)}`,
        ),
      ),
    createElement(
      'td',
      { className: 'syn-col-open' },
      createElement(
        Button,
        { size: 'sm', onClick: onOpen, 'aria-label': `比較「${c.title}」` },
        view === 'pending' ? '比較' : '檢視',
      ),
    ),
  );
}

// ── 並排比較 ────────────────────────────────────────────────

function ConflictCompare({ id, onBack, onResolved }) {
  const query = useSyncConflict(id);
  return createElement(
    'section',
    { className: 'syn-section', 'aria-label': '並排比較' },
    createElement(
      'div',
      null,
      createElement(
        Button,
        { variant: 'ghost', size: 'sm', icon: 'chevronsLeft', onClick: onBack },
        '返回衝突清單',
      ),
    ),
    query.isPending
      ? createElement(
          'div',
          { className: 'adm-card syn-compare-loading', 'aria-label': '載入中' },
          createElement(Skeleton, { width: 240, height: 16 }),
          createElement(Skeleton, { width: 320, height: 12 }),
        )
      : query.isError
        ? query.error instanceof ApiError && query.error.status === 404
          ? createElement(EmptyState, {
              icon: 'info',
              title: '找不到這筆衝突',
              description: '可能已被刪除，請回到清單重新選擇。',
            })
          : createElement(ErrorState, { error: query.error, onRetry: () => void query.refetch() })
        : createElement(CompareView, { key: query.data.id, c: query.data, onResolved: onResolved }),
  );
}

function CompareView({ c, onResolved }) {
  const [choices, setChoices] = useState(() => (c.status === 'resolved' && c.choices ? c.choices : {}));
  const resolve = useResolveConflict();
  const pending = c.status === 'pending';
  const input = useMemo(() => buildResolveInput(c.fields, choices), [c.fields, choices]);
  const incomingCount = c.fields.filter((f) => choices[f.name] === 'incoming').length;

  const apply = () =>
    resolve.mutate(
      { id: c.id, ...input },
      { onSuccess: () => onResolved(`「${c.title}」已處理（${RESOLUTION_TEXT[input.resolution]}）。`) },
    );

  return createElement(
    'div',
    { className: 'syn-compare' },
    createElement(
      'div',
      { className: 'syn-compare-head' },
      createElement(
        'div',
        { className: 'syn-row-title' },
        createElement(Badge, null, c.categoryLabel),
        createElement('h2', { className: 'dat-title syn-compare-title' }, c.title || '（無標題）'),
      ),
      createElement(
        'p',
        { className: 'dat-desc' },
        pending
          ? '這筆資料兩邊幾乎同時被修改，請決定要保留哪一份。只列出內容不同的欄位，可以逐欄位選擇。'
          : `已於 ${c.resolvedAt ? formatDateTime(c.resolvedAt) : '—'} 由 ${c.resolvedByName ?? '系統'} 處理：${c.resolution ? RESOLUTION_TEXT[c.resolution] : '—'}`,
      ),
      createElement(
        'p',
        { className: 'dat-meta' },
        '來源：',
        c.sourceName,
        ' · 中央更新 ',
        c.localUpdatedAt ? formatDateTime(c.localUpdatedAt) : '—',
        ' · 上傳更新 ',
        c.incomingUpdatedAt ? formatDateTime(c.incomingUpdatedAt) : '—',
        '（',
        diffText(c.diffMinutes),
        '）',
      ),
      !c.centralExists &&
        pending &&
        createElement(Alert, { tone: 'info' }, '中央已經沒有這筆資料；採用上傳會重新建立。'),
    ),

    pending &&
      c.fields.length > 0 &&
      createElement(
        'div',
        { className: 'dat-actions' },
        createElement(
          Button,
          { size: 'sm', onClick: () => setChoices(allChoices(c.fields, 'local')) },
          '全部保留中央',
        ),
        createElement(
          Button,
          { size: 'sm', onClick: () => setChoices(allChoices(c.fields, 'incoming')) },
          '全部採用上傳',
        ),
      ),
    c.fields.length === 0
      ? createElement(Alert, { tone: 'info' }, '目前兩邊內容已經相同，可以直接標記為保留中央。')
      : createElement(
          'div',
          { className: 'adm-card syn-diff-wrap' },
          createElement(
            'table',
            { className: 'syn-diff' },
            createElement(
              'thead',
              null,
              createElement(
                'tr',
                null,
                createElement('th', { scope: 'col', className: 'syn-diff-field' }, '欄位'),
                createElement('th', { scope: 'col' }, '中央現有'),
                createElement('th', { scope: 'col' }, '來源上傳'),
              ),
            ),
            createElement(
              'tbody',
              null,
              c.fields.map((f) => {
                const pick = choices[f.name] ?? 'local';
                return createElement(
                  'tr',
                  { key: f.name, 'data-field': f.name },
                  createElement('th', { scope: 'row', className: 'syn-diff-field' }, f.label),
                  ['local', 'incoming'].map((side) =>
                    createElement(
                      'td',
                      { key: side, className: 'syn-cell', 'data-picked': pick === side || undefined },
                      createElement(
                        'label',
                        { className: 'syn-pick' },
                        createElement('input', {
                          type: 'radio',
                          name: `pick-${f.name}`,
                          value: side,
                          checked: pick === side,
                          disabled: !pending,
                          onChange: () => setChoices({ ...choices, [f.name]: side }),
                          'aria-label': `${f.label}：${side === 'local' ? '保留中央' : '採用上傳'}`,
                        }),
                        createElement(
                          'span',
                          { className: 'syn-value' },
                          side === 'local'
                            ? fieldText(f.local, f.localDisplay)
                            : fieldText(f.incoming, f.incomingDisplay),
                        ),
                      ),
                    ),
                  ),
                );
              }),
            ),
          ),
        ),
    resolve.isError && createElement(Alert, { tone: 'danger' }, errorMessage(resolve.error)),
    pending &&
      createElement(
        'div',
        { className: 'syn-apply' },
        createElement(
          'span',
          { className: 'dat-desc' },
          input.resolution === 'keep_local'
            ? '將保留中央現有資料'
            : input.resolution === 'use_incoming'
              ? '將全部採用上傳的版本'
              : `將採用上傳的 ${incomingCount} 個欄位，其餘保留中央`,
        ),
        createElement(Button, { variant: 'primary', loading: resolve.isPending, onClick: apply }, '套用決定'),
      ),
  );
}
