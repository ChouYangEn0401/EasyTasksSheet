import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { Attachment, AttachmentKind, AttachmentLimits } from '../../../shared/engManual.ts';
import { errorMessage } from '../../lib/api.ts';
import { formatDateTime, formatRelative } from '../../lib/format.ts';
import { useUsersById } from '../../lib/hooks.ts';
import { Alert, Button, Dialog, Icon } from '../../ui/index.ts';
import { useDeleteAttachment } from './api.ts';
import {
  ACCEPT,
  extOf,
  formatBytes,
  formatDuration,
  imagesFromClipboard,
  kindOfName,
  middleEllipsis,
} from './attachModel.ts';
import { EngIcon, type EngIconName } from './bits.tsx';
import { useUploads, useUploadStore, type UploadItem } from './uploads.ts';

const KIND_ICON: Record<AttachmentKind, EngIconName> = {
  image: 'image',
  video: 'film',
  audio: 'music',
  pdf: 'fileText',
  text: 'fileText',
  archive: 'archive',
  document: 'file',
  file: 'file',
};

const KIND_LABEL: Record<AttachmentKind, string> = {
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
function KindIcon({ kind, name, size = 28 }: { kind: AttachmentKind; name: string; size?: number }) {
  const ext = extOf(name).toUpperCase();
  return (
    <span className="eng-kind" data-kind={kind}>
      <EngIcon name={KIND_ICON[kind]} size={size} />
      {ext && <span className="eng-kind-ext">{ext.slice(0, 4)}</span>}
    </span>
  );
}

/** 影片縮圖：第一幀 + 播放圖示 + 時長（不做伺服器端轉檔或縮圖） */
function VideoThumb({ src }: { src: string }) {
  const [duration, setDuration] = useState<number | null>(null);
  return (
    <>
      <video
        className="eng-tile-media"
        src={`${src}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        tabIndex={-1}
        aria-hidden="true"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />
      <span className="eng-tile-play" aria-hidden="true">
        <EngIcon name="play" size={16} />
      </span>
      {duration != null && Number.isFinite(duration) && (
        <span className="eng-tile-duration tabular-nums">{formatDuration(duration)}</span>
      )}
    </>
  );
}

function AttachmentTile({
  item,
  onOpen,
  onDelete,
}: {
  item: Attachment;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const byId = useUsersById();
  const uploader = item.uploadedBy != null ? byId.get(item.uploadedBy)?.displayName : undefined;
  return (
    <li className="eng-tile" data-kind={item.kind}>
      <button type="button" className="eng-tile-preview" onClick={onOpen} aria-label={`預覽「${item.name}」`}>
        {item.kind === 'image' && item.thumbUrl ? (
          <img className="eng-tile-media" src={item.thumbUrl} alt="" loading="lazy" decoding="async" />
        ) : item.kind === 'video' ? (
          <VideoThumb src={item.url} />
        ) : (
          <KindIcon kind={item.kind} name={item.name} />
        )}
      </button>
      <div className="eng-tile-body">
        <span className="eng-tile-name" title={item.name}>
          {middleEllipsis(item.name, 16)}
        </span>
        <span
          className="eng-tile-meta"
          title={`${uploader ?? '未知成員'} · ${formatDateTime(item.createdAt)}`}
        >
          <span className="tabular-nums">{formatBytes(item.size)}</span>
          {uploader && <> · {uploader}</>} · {formatRelative(item.createdAt)}
        </span>
      </div>
      <div className="eng-tile-actions">
        <a
          className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon eng-tile-action"
          href={`${item.url}?download=1`}
          download={item.name}
          aria-label={`下載「${item.name}」`}
          title="下載"
        >
          <EngIcon name="download" />
        </a>
        <button
          type="button"
          className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon eng-tile-action eng-tile-action--danger"
          onClick={onDelete}
          aria-label={`刪除「${item.name}」`}
          title="刪除"
        >
          <EngIcon name="trash" />
        </button>
      </div>
    </li>
  );
}

/** 上傳中 / 失敗的佔位卡片 */
function UploadTile({ item }: { item: UploadItem }) {
  const store = useUploadStore();
  const kind = kindOfName(item.file.name);
  const [imgOk, setImgOk] = useState(true);
  const preview = imgOk ? item.previewUrl : undefined;
  const pct = Math.round(item.progress * 100);
  const failed = item.status === 'error';
  return (
    <li className="eng-tile eng-tile--upload" data-status={item.status} aria-busy={!failed || undefined}>
      <div className="eng-tile-preview" aria-hidden="true">
        {preview ? (
          <img className="eng-tile-media" src={preview} alt="" onError={() => setImgOk(false)} />
        ) : (
          <KindIcon kind={kind} name={item.file.name} />
        )}
        {!failed && (
          <span className="eng-tile-progress">
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
        {failed && (
          <span className="eng-tile-failed">
            <Icon name="alertCircle" size={22} />
          </span>
        )}
      </div>
      <div className="eng-tile-body">
        <span className="eng-tile-name" title={item.file.name}>
          {middleEllipsis(item.file.name, 16)}
        </span>
        {failed ? (
          <span className="eng-tile-meta eng-tile-error" role="alert">
            {item.error}
          </span>
        ) : (
          <span className="eng-tile-meta tabular-nums" aria-live="polite">
            上傳中 {pct}% · {formatBytes(item.file.size)}
          </span>
        )}
      </div>
      {failed ? (
        <div className="eng-tile-retry">
          {item.retryable && (
            <Button size="sm" variant="secondary" icon="refresh" onClick={() => store.retry(item.key)}>
              重試
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => store.remove(item.key)}>
            移除
          </Button>
        </div>
      ) : (
        <div className="eng-tile-actions eng-tile-actions--always">
          <button
            type="button"
            className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon eng-tile-action"
            onClick={() => store.remove(item.key)}
            aria-label={`取消上傳「${item.file.name}」`}
            title="取消上傳"
          >
            <svg
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              aria-hidden="true"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </li>
  );
}

/** 燈箱：圖片 / 影片 / 音訊 / PDF 直接顯示，其他提供下載；← → 切換、Esc 關閉（影片會暫停） */
export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: Attachment[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
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
    ref.current?.querySelectorAll('video, audio').forEach((m) => (m as HTMLMediaElement).pause());
    ref.current?.close();
    onClose();
  };
  const go = (d: number) => {
    ref.current?.querySelectorAll('video, audio').forEach((m) => (m as HTMLMediaElement).pause());
    onIndex((index + d + n) % n);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
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
  return (
    <dialog
      ref={ref}
      className="eng-lightbox"
      aria-label={`附件預覽：${item.name}`}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if (
          e.target === e.currentTarget ||
          (e.target as HTMLElement).classList.contains('eng-lightbox-stage')
        )
          close();
      }}
    >
      <div className="eng-lightbox-bar">
        <span className="eng-lightbox-name" title={item.name}>
          {item.name}
        </span>
        <span className="eng-lightbox-count tabular-nums">
          {index + 1} / {n} · {formatBytes(item.size)}
        </span>
        <a
          className="ui-btn ui-btn--ghost ui-btn--sm eng-lightbox-btn"
          href={`${item.url}?download=1`}
          download={item.name}
        >
          <EngIcon name="download" /> 下載
        </a>
        <button
          type="button"
          className="ui-btn ui-btn--ghost ui-btn--sm ui-btn--icon eng-lightbox-btn"
          onClick={close}
          aria-label="關閉預覽"
        >
          <svg
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            aria-hidden="true"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="eng-lightbox-stage" key={item.id}>
        {item.kind === 'image' ? (
          <img className="eng-lightbox-media" src={item.url} alt={item.name} />
        ) : item.kind === 'video' ? (
          <video
            className="eng-lightbox-media"
            src={item.url}
            controls
            preload="metadata"
            playsInline
            autoPlay
          />
        ) : item.kind === 'audio' ? (
          <div className="eng-lightbox-file">
            <KindIcon kind="audio" name={item.name} size={40} />
            <audio src={item.url} controls preload="metadata" />
          </div>
        ) : item.kind === 'pdf' ? (
          <iframe className="eng-lightbox-pdf" src={item.url} title={item.name} />
        ) : (
          <div className="eng-lightbox-file">
            <KindIcon kind={item.kind} name={item.name} size={40} />
            <p>{KIND_LABEL[item.kind]}無法在瀏覽器中預覽</p>
            <a className="ui-btn ui-btn--primary" href={`${item.url}?download=1`} download={item.name}>
              <EngIcon name="download" /> 下載檔案
            </a>
          </div>
        )}
      </div>
      {n > 1 && (
        <>
          <button
            type="button"
            className="eng-lightbox-nav eng-lightbox-nav--prev"
            onClick={() => go(-1)}
            aria-label="上一個附件"
          >
            <EngIcon name="chevronLeft" size={22} />
          </button>
          <button
            type="button"
            className="eng-lightbox-nav eng-lightbox-nav--next"
            onClick={() => go(1)}
            aria-label="下一個附件"
          >
            <EngIcon name="chevronRight" size={22} />
          </button>
        </>
      )}
    </dialog>
  );
}

function DeleteAttachmentDialog({ item, onClose }: { item: Attachment; onClose: () => void }) {
  const del = useDeleteAttachment();
  return (
    <Dialog
      open
      size="sm"
      role="alertdialog"
      title="刪除附件？"
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={del.isPending}
            onClick={() => del.mutate(item.id, { onSuccess: onClose })}
            data-autofocus
          >
            刪除
          </Button>
        </>
      }
    >
      {del.error != null && <Alert tone="danger">{errorMessage(del.error)}</Alert>}
      <p className="eng-dialog-text">「{item.name}」將永久刪除，無法復原。</p>
    </Dialog>
  );
}

/** 拖放 / 點選 / 貼上 的檔案輸入區（也用於新增問題表單的待上傳清單） */
export function DropZone({
  onFiles,
  limits,
  disabled,
  disabledText,
  compact,
}: {
  onFiles: (files: File[]) => void;
  limits: AttachmentLimits;
  disabled?: boolean;
  disabledText?: string;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const open = () => {
    if (!disabled) inputRef.current?.click();
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  return (
    <>
      <div
        className="eng-drop"
        data-over={over || undefined}
        data-compact={compact || undefined}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        aria-label="新增附件：拖放檔案，或按 Enter 選擇檔案；也可以直接貼上圖片"
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
        onDragEnter={(e) => {
          if (!hasFiles(e) || disabled) return;
          e.preventDefault();
          depth.current++;
          setOver(true);
        }}
        onDragOver={(e) => {
          if (!hasFiles(e) || disabled) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={(e) => {
          if (disabled) return;
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) onFiles(files);
        }}
      >
        <span className="eng-drop-icon" aria-hidden="true">
          <EngIcon name="upload" size={compact ? 16 : 20} />
        </span>
        <span className="eng-drop-text">
          {disabled ? (
            <span className="eng-drop-main">{disabledText}</span>
          ) : (
            <>
              <span className="eng-drop-main">
                拖放檔案到這裡，或<span className="eng-drop-link">點此選擇</span>
                <span className="eng-drop-or">；也可以直接貼上圖片</span>
              </span>
              {!compact && (
                <span className="eng-drop-hint">
                  單檔 {formatBytes(limits.maxBytes)}、影片 {formatBytes(limits.videoMaxBytes)}，每筆最多{' '}
                  {limits.maxFiles} 個 · 圖片、影片、音訊、PDF、文字、壓縮檔、Office 文件
                </span>
              )}
            </>
          )}
        </span>
      </div>
      {/* 放在拖放區外：避免 input.click() 的 click 事件冒泡回拖放區再觸發一次 */}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** 問題的附件區：拖放區 + 縮圖格（含上傳中 / 失敗卡片）+ 燈箱 */
export function AttachmentPanel({
  issueId,
  attachments,
  limits,
}: {
  issueId: number;
  attachments: Attachment[];
  limits: AttachmentLimits;
}) {
  const store = useUploadStore();
  const uploads = useUploads(issueId);
  const [open, setOpen] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Attachment | null>(null);
  const full = attachments.length + uploads.filter((u) => u.status === 'uploading').length >= limits.maxFiles;
  const add = (files: File[]) => store.add(issueId, files, limits, attachments.length);
  const onPaste = (e: ClipboardEvent) => {
    const files = imagesFromClipboard(e.clipboardData);
    if (files.length) {
      e.preventDefault();
      add(files);
    }
  };

  return (
    <div className="eng-att" onPaste={onPaste} aria-label="附件">
      <div className="eng-att-head">
        <span className="eng-att-title">
          <EngIcon name="paperclip" />
          附件
          <span className="eng-att-count tabular-nums">
            {attachments.length} / {limits.maxFiles}
          </span>
        </span>
      </div>
      <DropZone
        onFiles={add}
        limits={limits}
        disabled={full}
        disabledText={`已達每筆 ${limits.maxFiles} 個附件的上限，請先刪除不需要的附件`}
        compact={attachments.length > 0}
      />
      {(attachments.length > 0 || uploads.length > 0) && (
        <ul className="eng-att-grid">
          {attachments.map((a, i) => (
            <AttachmentTile key={a.id} item={a} onOpen={() => setOpen(i)} onDelete={() => setDeleting(a)} />
          ))}
          {uploads.map((u) => (
            <UploadTile key={u.key} item={u} />
          ))}
        </ul>
      )}
      {open != null && attachments[open] && (
        <Lightbox items={attachments} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
      )}
      {deleting && <DeleteAttachmentDialog item={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}
