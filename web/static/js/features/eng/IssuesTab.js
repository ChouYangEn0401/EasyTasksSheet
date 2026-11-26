import { createElement, Fragment } from 'preact';
import { useQueryClient } from '../../lib/query.js';
import { createContext, useContext, useEffect, useId, useRef, useState } from 'preact/compat';

import { errorMessage } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { useUsersById } from '../../lib/hooks.js';
import { notifySuccess, toast } from '../../lib/toast.js';
import {
  Alert,
  Avatar,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  Menu,
  Select,
  Textarea,
  Tooltip,
  UpdatedAt,
} from '../../ui/index.js';
import { ManageStatusesButton, StatusSelect } from './EngStatus.js';
import { useStatusList } from './statusHooks.js';
import { engKeys, useDeleteIssue, usePublishIssue, useSaveIssue, useSyncIssues } from './api.js';
import {
  ACCEPT,
  DEFAULT_LIMITS,
  checkFile,
  formatBytes,
  imagesFromClipboard,
  middleEllipsis,
} from './attachModel.js';
import { AttachmentPanel } from './Attachments.js';
import { EngIcon, ExternalIcon, MoreIcon, NameList, SkeletonRows } from './bits.js';
import { LinkPreviewCard } from './LinkPreviewCard.js';
import {
  UploadContext,
  UploadStore,
  useBeforeUnloadWhileUploading,
  useUploads,
  useUploadStore,
} from './uploads.js';
import { GithubDialog } from './GithubDialog.js';
import { NONE, useUserOptions } from './userOptions.js';
import {
  firstInCategory,
  isClosedIssue,
  linkedRepo,
  needsGithubSync,
  openIssueCount,
  visibleIssues,
} from './model.js';
const GithubContext = createContext({ enabled: false, links: [], syncOne: () => {} });
const ExtrasContext = createContext({
  attachments: {},
  previews: {},
  limits: DEFAULT_LIMITS,
  previewEnabled: false,
  expand: () => {},
});
const NO_ATTACHMENTS = [];

/** 存檔後：若連結是尚未同步的 GitHub issue，立即同步一次（取得狀態與編號確認） */
function useSyncAfterSave() {
  const { enabled, syncOne } = useContext(GithubContext);
  return (issue) => {
    if (enabled && issue.githubNumber != null && issue.syncedAt == null) syncOne(issue);
  };
}

/** 新增時 status 留空 → 由後端套用預設狀態 */
const emptyDraft = () => ({
  title: '',
  project: '',
  status: '',
  assigneeId: null,
  url: '',
  description: '',
});

const toInput = (d) => ({
  title: d.title.trim(),
  project: d.project.trim(),
  ...(d.status ? { status: d.status } : {}),
  assigneeId: d.assigneeId,
  url: d.url.trim() || null,
  description: d.description.trim(),
});

/** 頂部的新增表單：填標題即可送出（Enter），其餘欄位選填 */
function AddIssueForm({ listId }) {
  const [form, setForm] = useState(emptyDraft);
  const [error, setError] = useState(null);
  // 建立問題前先選好 / 貼上的附件：建立成功後自動上傳
  const [pending, setPending] = useState([]);
  const fileRef = useRef(null);
  const save = useSaveIssue({ silent: true });
  const afterSave = useSyncAfterSave();
  const store = useUploadStore();
  const { limits, expand } = useContext(ExtrasContext);
  const userOptions = useUserOptions(form.assigneeId);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const addPending = (files) => {
    const bad = files.map((f) => [f, checkFile(f, limits)]).filter(([, e]) => e);
    if (bad.length) setError(`「${bad[0][0].name}」：${bad[0][1]}`);
    else setError(null);
    setPending((p) => [...p, ...files.filter((f) => !checkFile(f, limits))].slice(0, limits.maxFiles));
  };
  const onPaste = (e) => {
    const files = imagesFromClipboard(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      addPending(files);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (!form.title.trim() || save.isPending) return;
    setError(null);
    save.mutate(toInput(form), {
      // 保留專案與負責人，方便連續登錄同一專案的問題
      onSuccess: (issue) => {
        setForm((f) => ({ ...emptyDraft(), project: f.project, assigneeId: f.assigneeId }));
        if (pending.length) {
          store.add(issue.id, pending, limits, 0);
          setPending([]);
          expand(issue.id);
        }
        afterSave(issue);
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return createElement(
    'form',
    { className: 'eng-card eng-add', 'aria-label': '新增問題', onSubmit: submit },
    createElement(
      'div',
      { className: 'eng-add-grid eng-add-grid--issue' },
      createElement(
        Field,
        { label: '標題', className: 'eng-add-title' },
        createElement(Input, {
          value: form.title,
          maxLength: 200,
          placeholder: '發生了什麼問題？',
          onChange: (e) => set({ title: e.target.value }),
        }),
      ),
      createElement(
        Field,
        { label: '專案 / Repo' },
        createElement(Input, {
          value: form.project,
          maxLength: 100,
          list: listId,
          placeholder: '選填',
          onChange: (e) => set({ project: e.target.value }),
        }),
      ),
      createElement(
        Field,
        { label: '負責人' },
        createElement(Select, {
          options: userOptions,
          value: form.assigneeId ?? NONE,
          onChange: (v) => set({ assigneeId: v === NONE ? null : v }),
          'aria-label': '負責人',
        }),
      ),
      createElement(
        Field,
        { label: '連結' },
        createElement(Input, {
          type: 'url',
          value: form.url,
          maxLength: 500,
          placeholder: 'https://…（選填，可貼 GitHub issue）',
          onChange: (e) => set({ url: e.target.value }),
        }),
      ),
    ),
    createElement(
      Field,
      { label: '說明' },
      createElement(Textarea, {
        rows: 2,
        maxLength: 5000,
        value: form.description,
        placeholder: '選填；可直接貼上截圖（Ctrl+V）作為附件',
        onChange: (e) => set({ description: e.target.value }),
        onPaste: onPaste,
      }),
    ),
    createElement(
      'div',
      { className: 'eng-add-actions' },
      createElement(
        'div',
        { className: 'eng-add-files' },
        createElement(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            icon: createElement(EngIcon, { name: 'paperclip' }),
            onClick: () => fileRef.current?.click(),
          },
          '附件',
        ),
        createElement('input', {
          ref: fileRef,
          type: 'file',
          multiple: true,
          hidden: true,
          accept: ACCEPT,
          'aria-label': '選擇附件',
          onChange: (e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            addPending(files);
          },
        }),
        pending.map((f, i) =>
          createElement(
            'span',
            { key: `${f.name}-${i}`, className: 'eng-chip', title: f.name },
            middleEllipsis(f.name, 22),
            createElement('span', { className: 'eng-text-tertiary tabular-nums' }, formatBytes(f.size)),
            createElement(
              'button',
              {
                type: 'button',
                className: 'eng-chip-x',
                'aria-label': `移除「${f.name}」`,
                onClick: () => setPending((p) => p.filter((_, j) => j !== i)),
              },
              '×',
            ),
          ),
        ),
      ),
      error && createElement('span', { className: 'eng-danger-text' }, error),
      createElement(
        Button,
        {
          variant: 'primary',
          type: 'submit',
          icon: 'plus',
          disabled: !form.title.trim(),
          loading: save.isPending,
        },
        '新增問題',
      ),
    ),
  );
}

function IssueDialog({ issue, listId, onClose }) {
  const initial = {
    id: issue.id,
    title: issue.title,
    project: issue.project,
    status: issue.status,
    assigneeId: issue.assigneeId,
    url: issue.url ?? '',
    description: issue.description,
  };
  const [form, setForm] = useState(initial);
  const [error, setError] = useState(null);
  const save = useSaveIssue({ silent: true });
  const afterSave = useSyncAfterSave();
  const store = useUploadStore();
  const extras = useContext(ExtrasContext);
  const attachments = extras.attachments[String(issue.id)] ?? NO_ATTACHMENTS;
  const userOptions = useUserOptions(form.assigneeId);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  // 說明欄貼上圖片 → 直接上傳為此問題的附件
  const onPaste = (e) => {
    const files = imagesFromClipboard(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      store.add(issue.id, files, extras.limits, attachments.length);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (!form.title.trim() || save.isPending) return;
    save.mutate(
      { id: issue.id, ...toInput(form) },
      {
        onSuccess: (saved) => {
          onClose();
          afterSave(saved);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return createElement(
    Dialog,
    {
      open: true,
      size: 'md',
      title: '編輯問題',
      dirty: dirty,
      onClose: onClose,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        createElement(
          Button,
          {
            variant: 'primary',
            type: 'submit',
            form: 'eng-issue-form',
            disabled: !form.title.trim() || !dirty,
            loading: save.isPending,
          },
          '儲存',
        ),
      ),
    },
    createElement(
      'form',
      { id: 'eng-issue-form', className: 'eng-form', onSubmit: submit },
      error && createElement(Alert, { tone: 'danger' }, error),
      createElement(
        Field,
        { label: '標題' },
        createElement(Input, {
          value: form.title,
          maxLength: 200,
          onChange: (e) => set({ title: e.target.value }),
          'data-autofocus': true,
        }),
      ),
      createElement(
        Field,
        { label: '專案 / Repo' },
        createElement(Input, {
          value: form.project,
          maxLength: 100,
          list: listId,
          onChange: (e) => set({ project: e.target.value }),
        }),
      ),
      createElement(
        Field,
        { label: '狀態' },
        createElement(StatusSelect, {
          kind: 'issue',
          value: form.status,
          onChange: (status) => set({ status }),
          label: '狀態',
        }),
      ),
      createElement(
        Field,
        { label: '負責人' },
        createElement(Select, {
          options: userOptions,
          value: form.assigneeId ?? NONE,
          onChange: (v) => set({ assigneeId: v === NONE ? null : v }),
          'aria-label': '負責人',
        }),
      ),
      createElement(
        Field,
        { label: '連結' },
        createElement(Input, {
          type: 'url',
          value: form.url,
          maxLength: 500,
          onChange: (e) => set({ url: e.target.value }),
        }),
      ),
      createElement(
        Field,
        { label: '說明' },
        createElement(Textarea, {
          rows: 4,
          maxLength: 5000,
          value: form.description,
          placeholder: '可直接貼上截圖（Ctrl+V）作為附件',
          onChange: (e) => set({ description: e.target.value }),
          onPaste: onPaste,
        }),
      ),
    ),
    createElement(
      'div',
      { className: 'eng-dialog-attach' },
      createElement(AttachmentPanel, { issueId: issue.id, attachments: attachments, limits: extras.limits }),
    ),
  );
}

function DeleteDialog({ issue, onClose }) {
  const del = useDeleteIssue();
  return createElement(
    Dialog,
    {
      open: true,
      size: 'sm',
      role: 'alertdialog',
      title: '刪除此問題？',
      onClose: onClose,
      actions: createElement(
        Fragment,
        null,
        createElement(Button, { variant: 'secondary', onClick: onClose }, '取消'),
        createElement(
          Button,
          {
            variant: 'danger',
            loading: del.isPending,
            onClick: () => del.mutate(issue.id, { onSuccess: onClose }),
            'data-autofocus': true,
          },
          '刪除',
        ),
      ),
    },
    del.error != null && createElement(Alert, { tone: 'danger' }, errorMessage(del.error)),
    createElement(
      'p',
      { className: 'eng-dialog-text' },
      '「',
      issue.title,
      '」與它的附件將永久刪除；若只是處理完畢，請改用「結案」。',
    ),
  );
}

/** GitHub 小標記：#編號；滑過顯示 repo、GitHub 狀態與同步時間 */
function GithubTag({ issue }) {
  const state =
    issue.githubState === 'closed' ? 'GitHub 已關閉' : issue.githubState === 'open' ? 'GitHub 開啟中' : null;
  const tip = [
    issue.githubRepo,
    state,
    issue.syncedAt != null ? `同步於 ${formatDateTime(issue.syncedAt)}` : '尚未同步',
  ]
    .filter(Boolean)
    .join(' · ');
  return createElement(
    Tooltip,
    { content: tip },
    createElement(
      'span',
      {
        className: 'eng-gh-tag tabular-nums',
        'data-state': issue.githubState ?? undefined,
        tabIndex: 0,
        'aria-label': `GitHub #${issue.githubNumber}（${tip}）`,
      },
      '#',
      issue.githubNumber,
    ),
  );
}

/** 展開後的詳細：完整說明、連結預覽、附件區 */
function IssueDetail({ issue }) {
  const extras = useContext(ExtrasContext);
  const attachments = extras.attachments[String(issue.id)] ?? NO_ATTACHMENTS;
  return createElement(
    'div',
    { className: 'eng-detail' },
    issue.description && createElement('p', { className: 'eng-detail-desc' }, issue.description),
    createElement(LinkPreviewCard, {
      issue: issue,
      preview: extras.previews[String(issue.id)],
      enabled: extras.previewEnabled,
    }),
    createElement(AttachmentPanel, { issueId: issue.id, attachments: attachments, limits: extras.limits }),
  );
}

function IssueRow({ issue, expanded, onToggle, onEdit, onDelete }) {
  const extras = useContext(ExtrasContext);
  const fileCount = (extras.attachments[String(issue.id)] ?? NO_ATTACHMENTS).length;
  const uploading = useUploads(issue.id).filter((u) => u.status === 'uploading').length;
  const detailId = useId();
  const byId = useUsersById();
  const save = useSaveIssue();
  const publish = usePublishIssue();
  const github = useContext(GithubContext);
  const statuses = useStatusList('issue');
  const assignee = issue.assigneeId != null ? byId.get(issue.assigneeId) : undefined;
  const setStatus = (status) => {
    if (status && status !== issue.status) save.mutate({ id: issue.id, status });
  };
  const closed = isClosedIssue(statuses, issue.status);
  const publishRepo =
    github.enabled && issue.githubNumber == null ? linkedRepo(github.links, issue.project) : undefined;
  const items = [
    { key: 'edit', label: '編輯', onSelect: onEdit },
    closed
      ? {
          key: 'reopen',
          label: '重新開啟',
          onSelect: () => setStatus(firstInCategory(statuses, 'open', 'open')),
        }
      : {
          key: 'close',
          label: '結案',
          onSelect: () => setStatus(firstInCategory(statuses, 'closed', 'closed')),
        },
    ...(publishRepo
      ? [
          {
            key: 'publish',
            label: `在 GitHub 建立（${publishRepo}）`,
            onSelect: () =>
              publish.mutate(issue.id, {
                onSuccess: (res) => notifySuccess(`已在 GitHub 建立 #${res.githubNumber}`),
              }),
          },
        ]
      : []),
    { key: 'sep', separator: true },
    { key: 'delete', label: '刪除', danger: true, onSelect: onDelete },
  ];

  return createElement(
    Fragment,
    null,
    createElement(
      'tr',
      {
        className: 'eng-issue-row',
        'data-status': issue.status,
        'data-closed': closed || undefined,
        'data-expanded': expanded || undefined,
      },
      createElement(
        'td',
        { className: 'eng-col-expand' },
        createElement(
          'button',
          {
            type: 'button',
            className: 'eng-expand',
            'aria-expanded': expanded,
            'aria-controls': expanded ? detailId : undefined,
            'aria-label': `${expanded ? '收合' : '展開'}「${issue.title}」的附件與詳細`,
            onClick: onToggle,
          },
          createElement(Icon, { name: 'chevronRight' }),
        ),
      ),
      createElement(
        'td',
        { className: 'eng-col-title' },
        createElement(
          'div',
          { className: 'eng-two-line' },
          createElement(
            'span',
            { className: 'eng-issue-title' },
            createElement(
              'button',
              { type: 'button', className: 'eng-title-btn eng-ellipsis', onClick: onToggle, tabIndex: -1 },
              issue.title,
            ),
            (fileCount > 0 || uploading > 0) &&
              createElement(
                'span',
                {
                  className: 'eng-att-badge tabular-nums',
                  'aria-label': `${fileCount} 個附件${uploading ? `，${uploading} 個上傳中` : ''}`,
                  title: `${fileCount} 個附件${uploading ? `，${uploading} 個上傳中` : ''}`,
                },
                createElement(EngIcon, { name: 'paperclip', size: 13 }),
                fileCount,
                uploading > 0 && createElement('span', { className: 'eng-att-badge-up' }, '+', uploading),
              ),
            issue.url &&
              createElement(
                'a',
                {
                  className: 'eng-link-icon',
                  href: issue.url,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  'aria-label': `開啟「${issue.title}」的連結`,
                },
                createElement(ExternalIcon, null),
              ),
            issue.githubNumber != null && createElement(GithubTag, { issue: issue }),
          ),
          issue.description &&
            createElement(
              Tooltip,
              { content: issue.description },
              createElement('span', { className: 'eng-sub eng-ellipsis', tabIndex: 0 }, issue.description),
            ),
        ),
      ),
      createElement('td', { className: 'eng-text-secondary' }, issue.project || '—'),
      createElement(
        'td',
        null,
        createElement(
          'span',
          { className: 'eng-status-select' },
          createElement(StatusSelect, {
            kind: 'issue',
            badge: true,
            value: issue.status,
            onChange: setStatus,
            label: `「${issue.title}」的狀態`,
          }),
        ),
      ),
      createElement(
        'td',
        null,
        createElement(
          'span',
          { className: 'eng-owner' },
          createElement(Avatar, { user: assignee ?? null, size: 'sm' }),
          createElement('span', { className: 'eng-owner-name' }, assignee?.displayName ?? '未指派'),
        ),
      ),
      createElement('td', null, createElement(UpdatedAt, { at: issue.updatedAt, by: issue.updatedBy })),
      createElement(
        'td',
        { className: 'eng-col-action' },
        createElement(Menu, {
          align: 'end',
          label: `「${issue.title}」的操作`,
          items: items,
          trigger: (p) =>
            createElement(Button, {
              ...p,
              variant: 'ghost',
              size: 'sm',
              iconOnly: true,
              icon: createElement(MoreIcon, null),
              'aria-label': `「${issue.title}」的操作`,
            }),
        }),
      ),
    ),
    expanded &&
      createElement(
        'tr',
        { className: 'eng-detail-row', id: detailId },
        createElement('td', { colSpan: 7 }, createElement(IssueDetail, { issue: issue })),
      ),
  );
}

/** 問題分頁：新增表單在最上面，下方為清單（預設隱藏已結案） */
export function IssuesTab({ query, names }) {
  const listId = useId();
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [githubOpen, setGithubOpen] = useState(false);
  const statuses = useStatusList('issue');
  const all = query.data?.issues;
  const issues = all ? visibleIssues(all, showClosed, statuses) : undefined;
  const closedCount = all ? all.length - openIssueCount(all, statuses) : 0;

  const qc = useQueryClient();
  const [store] = useState(
    () => new UploadStore(() => void qc.invalidateQueries({ queryKey: engKeys.issues() })),
  );
  useBeforeUnloadWhileUploading(store);
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (id) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const extras = {
    attachments: query.data?.attachments ?? {},
    previews: query.data?.previews ?? {},
    limits: query.data?.attachmentLimits ?? DEFAULT_LIMITS,
    previewEnabled: query.data?.linkPreviewEnabled ?? false,
    expand: (id) => setExpanded((s) => new Set(s).add(id)),
  };

  const githubEnabled = query.data?.githubEnabled ?? false;
  const links = query.data?.links ?? [];
  const sync = useSyncIssues();
  const autoSync = useSyncIssues({ auto: true });
  const { mutate: autoMutate, isPending: autoPending } = autoSync;
  const github = { enabled: githubEnabled, links, syncOne: (i) => autoMutate(i.id) };

  // 列表載入時若距上次同步超過設定分鐘數，自動同步一次（同一頁面停留期間最多每 syncMinutes 一次，失敗不重試轟炸）
  const lastAuto = useRef(0);
  useEffect(() => {
    const data = query.data;
    if (!data?.githubEnabled || autoPending || sync.isPending) return;
    const now = Date.now();
    if (now - lastAuto.current < data.syncMinutes * 60_000) return;
    if (!needsGithubSync(data.issues, data.syncMinutes, now)) return;
    lastAuto.current = now;
    autoMutate(undefined);
  }, [query.data, autoPending, autoMutate, sync.isPending]);

  const runSync = () =>
    sync.mutate(undefined, {
      onSuccess: (res) => {
        if (res.failed.length > 0) {
          toast({
            tone: 'warning',
            title: `${res.failed.length} 筆無法同步`,
            description: res.failed[0]?.message,
          });
        } else {
          notifySuccess(res.updated.length ? `已同步，${res.updated.length} 筆狀態更新` : '已同步');
        }
      },
    });

  return createElement(
    UploadContext.Provider,
    { value: store },
    createElement(
      ExtrasContext.Provider,
      { value: extras },
      createElement(
        GithubContext.Provider,
        { value: github },
        createElement(
          'section',
          { className: 'eng-section', 'aria-label': '問題' },
          createElement(NameList, { id: listId, names: names }),
          createElement(AddIssueForm, { listId: listId }),

          createElement(
            'div',
            { className: 'eng-toolbar' },
            createElement(Checkbox, {
              label: `顯示已結案（${closedCount}）`,
              checked: showClosed,
              onChange: (e) => setShowClosed(e.target.checked),
            }),
            createElement(
              'span',
              { className: 'eng-toolbar-end' },
              createElement(ManageStatusesButton, { kind: 'issue' }),
              githubEnabled &&
                createElement(
                  Fragment,
                  null,
                  createElement(
                    Button,
                    {
                      variant: 'ghost',
                      size: 'sm',
                      icon: 'refresh',
                      loading: sync.isPending || autoSync.isPending,
                      onClick: runSync,
                    },
                    '同步 GitHub',
                  ),
                  createElement(
                    Button,
                    { variant: 'ghost', size: 'sm', icon: 'branch', onClick: () => setGithubOpen(true) },
                    'GitHub 連動 / 匯入',
                  ),
                ),
            ),
          ),

          !all && query.error
            ? createElement(ErrorState, { error: query.error, onRetry: query.refetch })
            : issues && issues.length === 0
              ? createElement(
                  'div',
                  { className: 'eng-card' },
                  createElement(EmptyState, {
                    icon: 'checkCircle',
                    title: all && all.length > 0 ? '沒有未結案的問題' : '尚未記錄任何問題',
                    description: '在上方輸入標題即可新增',
                  }),
                )
              : createElement(
                  'div',
                  { className: 'eng-card' },
                  createElement(
                    'table',
                    { className: 'eng-table eng-table--issues' },
                    createElement(
                      'thead',
                      null,
                      createElement(
                        'tr',
                        null,
                        createElement(
                          'th',
                          { scope: 'col', className: 'eng-col-expand' },
                          createElement('span', { className: 'sr-only' }, '展開'),
                        ),
                        createElement('th', { scope: 'col' }, '標題'),
                        createElement('th', { scope: 'col' }, '專案 / Repo'),
                        createElement('th', { scope: 'col' }, '狀態'),
                        createElement('th', { scope: 'col' }, '負責人'),
                        createElement('th', { scope: 'col' }, '更新'),
                        createElement(
                          'th',
                          { scope: 'col', className: 'eng-col-action' },
                          createElement('span', { className: 'sr-only' }, '操作'),
                        ),
                      ),
                    ),
                    createElement(
                      'tbody',
                      null,
                      issues
                        ? issues.map((i) =>
                            createElement(IssueRow, {
                              key: i.id,
                              issue: i,
                              expanded: expanded.has(i.id),
                              onToggle: () => toggle(i.id),
                              onEdit: () => setEditing(i),
                              onDelete: () => setDeleting(i),
                            }),
                          )
                        : createElement(SkeletonRows, { rows: 5, cols: 7 }),
                    ),
                  ),
                ),
          editing &&
            createElement(IssueDialog, { issue: editing, listId: listId, onClose: () => setEditing(null) }),
          deleting && createElement(DeleteDialog, { issue: deleting, onClose: () => setDeleting(null) }),
          githubOpen &&
            createElement(GithubDialog, {
              links: links,
              listId: listId,
              onClose: () => setGithubOpen(false),
            }),
        ),
      ),
    ),
  );
}
