import { createElement, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/compat';
import { errorMessage } from '../../lib/api.js';
import { formatDateTime, formatRelative } from '../../lib/format.js';
import { useUsersById } from '../../lib/hooks.js';
import { Alert, Button, Dialog, Icon } from '../../ui/index.js';
import { useDeleteAttachment } from './api.js';
import {
  ACCEPT,
  extOf,
  formatBytes,
  formatDuration,
  imagesFromClipboard,
  kindOfName,
  middleEllipsis,
} from './attachModel.js';
import { EngIcon } from './bits.js';
import { useUploads, useUploadStore } from './uploads.js';

const KIND_ICON = {
  image: 'image',
  video: 'film',
  audio: 'music',
  pdf: 'fileText',
  text: 'fileText',
  archive: 'archive',
  document: 'file',
  file: 'file',
};

const KIND_LABEL = {
  image: '圖片',
  video: '影片',
  audio: '音訊',
  pdf: 'PDF',
  text: '文字',
  archive: '壓縮檔',
  document: '文件',
  file: '檔案',
};

/** 依類型顯示的大圖示 + 副檔名標籤（非圖片 / 影片的縮圖） */
function KindIcon({ kind, name, size = 28 }) {
  const ext = extOf(name).toUpperCase();
  return createElement(
    'span',
    { className: 'eng-kind', 'data-kind': kind },
    createElement(EngIcon, { name: KIND_ICON[kind], size: size }),
    ext && createElement('span', { className: 'eng-kind-ext' }, ext.slice(0, 4)),
  );
}

/** 影片縮圖：第一幀 + 播放圖示 + 時長（不做伺服器端轉檔或縮圖） */
function VideoThumb({ src }) {
  const [duration, setDuration] = useState(null);
  return createElement(
    Fragment,
    null,
    createElement('video', {
      className: 'eng-tile-media',
      src: `${src}#t=0.1`,
      preload: 'metadata',
      muted: true,
      playsInline: true,
      tabIndex: -1,
      'aria-hidden': 'true',
      onLoadedMetadata: (e) => setDuration(e.currentTarget.duration),
    }),
    createElement(
      'span',
      { className: 'eng-tile-play', 'aria-hidden': 'true' },
      createElement(EngIcon, { name: 'play', size: 16 }),
    ),
    duration != null &&
      Number.isFinite(duration) &&
      createElement('span', { className: 'eng-tile-duration tabular-nums' }, formatDuration(duration)),
  );
}

function AttachmentTile({ item, onOpen, onDelete }) {
  const byId = useUsersById();
  const uploader = item.uploadedBy != null ? byId.get(item.uploadedBy)?.displayName : undefined;
  return createElement(
    'li',
    { className: 'eng-tile', 'data-kind': item.kind },
    createElement(
      'button',
      {
        type: 'button',
        className: 'eng-tile-preview',
        onClick: onOpen,
        'aria-label': `預覽「${item.name}」`,
      },
      item.kind === 'image' && item.thumbUrl
        ? createElement('img', {
            className: 'eng-tile-media',
            src: item.thumbUrl,
            alt: '',
            loading: 'lazy',
            decoding: 'async',
          })
        : item.kind === 'video'
          ? createElement(VideoThumb, { src: item.url })
          : createElement(KindIcon, { kind: item.kind, name: item.name }),
    ),
    createElement(
      'div',
      { className: 'eng-tile-body' },
      createElement('span', { className: 'eng-tile-name', title: item.name }, middleEllipsis(item.name, 16)),
      createElement(
        'span',
        {
          className: 'eng-tile-meta',
          title: `${uploader ?? '未知成員'} · ${formatDateTime(item.createdAt)}`,
        },
        createElement('span', { className: 'tabular-nums' }, formatBytes(item.size)),
        uploader && createElement(Fragment, null, ' · ', uploader),
        ' · ',
        formatRelative(item.createdAt),
      ),
    ),
    createElement(
      'div',
      { className: 'eng-tile-actions' },
      createElement(
        'a',
        {
          className: 'ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon eng-tile-action',
          href: `${item.url}?download=1`,
          download: item.name,
          'aria-label': `下載「${item.name}」`,
          title: '下載',
        },
        createElement(EngIcon, { name: 'download' }),
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon eng-tile-action eng-tile-action--danger',
          onClick: onDelete,
          'aria-label': `刪除「${item.name}」`,
          title: '刪除',
        },
        createElement(EngIcon, { name: 'trash' }),
      ),
    ),
  );
}

/** 上傳中 / 失敗的佔位卡片 */
function UploadTile({ item }) {
  const store = useUploadStore();
  const kind = kindOfName(item.file.name);
  const [imgOk, setImgOk] = useState(true);
  const preview = imgOk ? item.previewUrl : undefined;
  const pct = Math.round(item.progress * 100);
  const failed = item.status === 'error';
  return createElement(
    'li',
    { className: 'eng-tile eng-tile--upload', 'data-status': item.status, 'aria-busy': !failed || undefined },
    createElement(
      'div',
      { className: 'eng-tile-preview', 'aria-hidden': 'true' },
      preview
        ? createElement('img', {
            className: 'eng-tile-media',
            src: preview,
            alt: '',
            onError: () => setImgOk(false),
          })
        : createElement(KindIcon, { kind: kind, name: item.file.name }),
      !failed &&
        createElement(
          'span',
          { className: 'eng-tile-progress' },
          createElement('span', { style: { width: `${pct}%` } }),
        ),
      failed &&
        createElement(
          'span',
          { className: 'eng-tile-failed' },
          createElement(Icon, { name: 'alertCircle', size: 22 }),
        ),
    ),
    createElement(
      'div',
      { className: 'eng-tile-body' },
      createElement(
        'span',
        { className: 'eng-tile-name', title: item.file.name },
        middleEllipsis(item.file.name, 16),
      ),
      failed
        ? createElement('span', { className: 'eng-tile-meta eng-tile-error', role: 'alert' }, item.error)
        : createElement(
            'span',
            { className: 'eng-tile-meta tabular-nums', 'aria-live': 'polite' },
            '上傳中 ',
            pct,
            '% · ',
            formatBytes(item.file.size),
          ),
    ),
    failed
      ? createElement(
          'div',
          { className: 'eng-tile-retry' },
          item.retryable &&
            createElement(
              Button,
              { size: 'sm', variant: 'secondary', icon: 'refresh', onClick: () => store.retry(item.key) },
              '重試',
            ),
          createElement(
            Button,
            { size: 'sm', variant: 'ghost', onClick: () => store.remove(item.key) },
            '移除',
          ),
        )
      : createElement(
          'div',
          { className: 'eng-tile-actions eng-tile-actions--always' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon eng-tile-action',
              onClick: () => store.remove(item.key),
              'aria-label': `取消上傳「${item.file.name}」`,
              title: '取消上傳',
            },
            createElement(
              'svg',
              {
                width: 14,
                height: 14,
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.8,
                'aria-hidden': 'true',
              },
              createElement('path', { d: 'M18 6L6 18M6 6l12 12' }),
            ),
          ),
        ),
  );
}

/** 燈箱：圖片 / 影片 / 音訊 / PDF 直接顯示，其他提供下載；← → 切換、Esc 關閉（影片會暫停） */
export function Lightbox({ items, index, onIndex, onClose }) {
  const ref = useRef(null);
  const item = items[index];
  const n = items.length;

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (back?.isConnected) back.focus();
    };
  }, []);

  const close = () => {
    ref.current?.querySelectorAll('video, audio').forEach((m) => m.pause());
    ref.current?.close();
    onClose();
  };
  const go = (d) => {
    ref.current?.querySelectorAll('video, audio').forEach((m) => m.pause());
    onIndex((index + d + n) % n);
  };
  const onKeyDown = (e) => {
    const target = e.target;
    if (target.tagName === 'VIDEO' || target.tagName === 'AUDIO') return; // 讓播放器自己處理方向鍵
    if (e.key === 'ArrowLeft' && n > 1) {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'ArrowRight' && n > 1) {
      e.preventDefault();
      go(1);
    }
  };

  if (!item) return null;
  return createElement(
    'dialog',
    {
      ref: ref,
      className: 'eng-lightbox',
      'aria-label': `附件預覽：${item.name}`,
      onCancel: (e) => {
        e.preventDefault();
        close();
      },
      onKeyDown: onKeyDown,
      onClick: (e) => {
        if (e.target === e.currentTarget || e.target.classList.contains('eng-lightbox-stage')) close();
      },
    },
    createElement(
      'div',
      { className: 'eng-lightbox-bar' },
      createElement('span', { className: 'eng-lightbox-name', title: item.name }, item.name),
      createElement(
        'span',
        { className: 'eng-lightbox-count tabular-nums' },
        index + 1,
        ' / ',
        n,
        ' · ',
        formatBytes(item.size),
      ),
      createElement(
        'a',
        {
          className: 'ui-btn ui-btn--ghost ui-btn--sm eng-lightbox-btn',
          href: `${item.url}?download=1`,
          download: item.name,
        },
        createElement(EngIcon, { name: 'download' }),
        ' 下載',
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon eng-lightbox-btn',
          onClick: close,
          'aria-label': '關閉預覽',
        },
        createElement(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            'aria-hidden': 'true',
          },
          createElement('path', { d: 'M18 6L6 18M6 6l12 12' }),
        ),
      ),
    ),
    createElement(
      'div',
      { className: 'eng-lightbox-stage', key: item.id },
      item.kind === 'image'
        ? createElement('img', { className: 'eng-lightbox-media', src: item.url, alt: item.name })
        : item.kind === 'video'
          ? createElement('video', {
              className: 'eng-lightbox-media',
              src: item.url,
              controls: true,
              preload: 'metadata',
              playsInline: true,
              autoPlay: true,
            })
          : item.kind === 'audio'
            ? createElement(
                'div',
                { className: 'eng-lightbox-file' },
                createElement(KindIcon, { kind: 'audio', name: item.name, size: 40 }),
                createElement('audio', { src: item.url, controls: true, preload: 'metadata' }),
              )
            : item.kind === 'pdf'
              ? createElement('iframe', { className: 'eng-lightbox-pdf', src: item.url, title: item.name })
              : createElement(
                  'div',
                  { className: 'eng-lightbox-file' },
                  createElement(KindIcon, { kind: item.kind, name: item.name, size: 40 }),
                  createElement('p', null, KIND_LABEL[item.kind], '無法在瀏覽器中預覽'),
                  createElement(
                    'a',
                    {
                      className: 'ui-btn ui-btn--primary',
                      href: `${item.url}?download=1`,
                      download: item.name,
                    },
                    createElement(EngIcon, { name: 'download' }),
                    ' 下載檔案',
                  ),
                ),
    ),
    n > 1 &&
      createElement(
        Fragment,
        null,
        createElement(
          'button',
          {
            type: 'button',
            className: 'eng-lightbox-nav eng-lightbox-nav--prev',
            onClick: () => go(-1),
            'aria-label': '上一個附件',
          },
          createElement(EngIcon, { name: 'chevronLeft', size: 22 }),
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: 'eng-lightbox-nav eng-lightbox-nav--next',
            onClick: () => go(1),
            'aria-label': '下一個附件',
          },
          createElement(EngIcon, { name: 'chevronRight', size: 22 }),
        ),
      ),
  );
}

function DeleteAttachmentDialog({ item, onClose }) {
  const del = useDeleteAttachment();
  return createElement(
    Dialog,
    {
      open: true,
      size: 'sm',
      role: 'alertdialog',
      title: '刪除附件？',
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
            onClick: () => del.mutate(item.id, { onSuccess: onClose }),
            'data-autofocus': true,
          },
          '刪除',
        ),
      ),
    },
    del.error != null && createElement(Alert, { tone: 'danger' }, errorMessage(del.error)),
    createElement('p', { className: 'eng-dialog-text' }, '「', item.name, '」將永久刪除，無法復原。'),
  );
}

/** 拖放 / 點選 / 貼上 的檔案輸入區（也用於新增問題表單的待上傳清單） */
export function DropZone({ onFiles, limits, disabled, disabledText, compact }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const open = () => {
    if (!disabled) inputRef.current?.click();
  };
  const hasFiles = (e) => Array.from(e.dataTransfer.types).includes('Files');
  return createElement(
    Fragment,
    null,
    createElement(
      'div',
      {
        className: 'eng-drop',
        'data-over': over || undefined,
        'data-compact': compact || undefined,
        role: 'button',
        tabIndex: disabled ? -1 : 0,
        'aria-disabled': disabled || undefined,
        'aria-label': '新增附件：拖放檔案，或按 Enter 選擇檔案；也可以直接貼上圖片',
        onClick: open,
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        },
        onDragEnter: (e) => {
          if (!hasFiles(e) || disabled) return;
          e.preventDefault();
          depth.current++;
          setOver(true);
        },
        onDragOver: (e) => {
          if (!hasFiles(e) || disabled) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: () => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        },
        onDrop: (e) => {
          if (disabled) return;
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) onFiles(files);
        },
      },
      createElement(
        'span',
        { className: 'eng-drop-icon', 'aria-hidden': 'true' },
        createElement(EngIcon, { name: 'upload', size: compact ? 16 : 20 }),
      ),
      createElement(
        'span',
        { className: 'eng-drop-text' },
        disabled
          ? createElement('span', { className: 'eng-drop-main' }, disabledText)
          : createElement(
              Fragment,
              null,
              createElement(
                'span',
                { className: 'eng-drop-main' },
                '拖放檔案到這裡，或',
                createElement('span', { className: 'eng-drop-link' }, '點此選擇'),
                createElement('span', { className: 'eng-drop-or' }, '；也可以直接貼上圖片'),
              ),
              !compact &&
                createElement(
                  'span',
                  { className: 'eng-drop-hint' },
                  '單檔 ',
                  formatBytes(limits.maxBytes),
                  '、影片 ',
                  formatBytes(limits.videoMaxBytes),
                  '，每筆最多',
                  ' ',
                  limits.maxFiles,
                  ' 個 · 圖片、影片、音訊、PDF、文字、壓縮檔、Office 文件',
                ),
            ),
      ),
    ),
    createElement('input', {
      ref: inputRef,
      type: 'file',
      multiple: true,
      hidden: true,
      accept: ACCEPT,
      tabIndex: -1,
      'aria-hidden': 'true',
      onChange: (e) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (files.length) onFiles(files);
      },
    }),
  );
}

/** 問題的附件區：拖放區 + 縮圖格（含上傳中 / 失敗卡片）+ 燈箱 */
export function AttachmentPanel({ issueId, attachments, limits }) {
  const store = useUploadStore();
  const uploads = useUploads(issueId);
  const [open, setOpen] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const full = attachments.length + uploads.filter((u) => u.status === 'uploading').length >= limits.maxFiles;
  const add = (files) => store.add(issueId, files, limits, attachments.length);
  const onPaste = (e) => {
    const files = imagesFromClipboard(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      add(files);
    }
  };

  return createElement(
    'div',
    { className: 'eng-att', onPaste: onPaste, 'aria-label': '附件' },
    createElement(
      'div',
      { className: 'eng-att-head' },
      createElement(
        'span',
        { className: 'eng-att-title' },
        createElement(EngIcon, { name: 'paperclip' }),
        '附件',
        createElement(
          'span',
          { className: 'eng-att-count tabular-nums' },
          attachments.length,
          ' / ',
          limits.maxFiles,
        ),
      ),
    ),
    createElement(DropZone, {
      onFiles: add,
      limits: limits,
      disabled: full,
      disabledText: `已達每筆 ${limits.maxFiles} 個附件的上限，請先刪除不需要的附件`,
      compact: attachments.length > 0,
    }),
    (attachments.length > 0 || uploads.length > 0) &&
      createElement(
        'ul',
        { className: 'eng-att-grid' },
        attachments.map((a, i) =>
          createElement(AttachmentTile, {
            key: a.id,
            item: a,
            onOpen: () => setOpen(i),
            onDelete: () => setDeleting(a),
          }),
        ),
        uploads.map((u) => createElement(UploadTile, { key: u.key, item: u })),
      ),
    open != null &&
      attachments[open] &&
      createElement(Lightbox, {
        items: attachments,
        index: open,
        onIndex: setOpen,
        onClose: () => setOpen(null),
      }),
    deleting && createElement(DeleteAttachmentDialog, { item: deleting, onClose: () => setDeleting(null) }),
  );
}
