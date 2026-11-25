import { useState } from 'react';
import type { LinkPreview, ManualIssue } from '../../../shared/engManual.ts';
import { errorMessage } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { Button } from '../../ui/index.ts';
import { useRefreshPreview } from './api.ts';
import { EngIcon } from './bits.tsx';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * 連結的網頁預覽卡片（metadata：標題、說明、og:image、favicon、網域；不含整頁截圖）。
 * 外部圖片以 no-referrer 載入、載入失敗就隱藏；所有文字皆以純文字顯示。
 */
export function LinkPreviewCard({
  issue,
  preview,
  enabled,
}: {
  issue: ManualIssue;
  preview: LinkPreview | undefined;
  enabled: boolean;
}) {
  const refresh = useRefreshPreview();
  const [imgOk, setImgOk] = useState(true);
  const [iconOk, setIconOk] = useState(true);
  if (!issue.url || issue.githubNumber != null) return null;
  const current = preview && preview.url === issue.url ? preview : undefined;
  const host = hostOf(issue.url);

  const refreshBtn = enabled && (
    <Button
      size="sm"
      variant="ghost"
      icon="refresh"
      loading={refresh.isPending}
      onClick={() => refresh.mutate(issue.id)}
    >
      重新取得預覽
    </Button>
  );

  if (!current || current.status === 'error') {
    const text = !enabled
      ? '伺服器未啟用連結預覽'
      : !current
        ? '正在取得預覽…'
        : `無法取得預覽（${current.error ?? '未知原因'}）`;
    return (
      <div className="eng-preview eng-preview--empty">
        <span className="eng-preview-fallback">
          <EngIcon name="globe" />
          <a href={issue.url} target="_blank" rel="noopener noreferrer" className="eng-preview-host">
            {host}
          </a>
          <span className="eng-text-tertiary">{text}</span>
        </span>
        {refresh.error != null && <span className="eng-danger-text">{errorMessage(refresh.error)}</span>}
        {refreshBtn}
      </div>
    );
  }

  const nonHtml = current.contentType && !/html/.test(current.contentType);
  return (
    <div className="eng-preview">
      <a
        className="eng-preview-card"
        href={issue.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`開啟連結：${current.title ?? host}`}
      >
        {current.imageUrl && imgOk && (
          <span className="eng-preview-image">
            <img
              src={current.imageUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setImgOk(false)}
            />
          </span>
        )}
        <span className="eng-preview-text">
          <span className="eng-preview-site">
            {current.faviconUrl && iconOk ? (
              <img
                src={current.faviconUrl}
                alt=""
                width={14}
                height={14}
                referrerPolicy="no-referrer"
                onError={() => setIconOk(false)}
              />
            ) : (
              <EngIcon name="globe" size={14} />
            )}
            <span>{current.siteName || host}</span>
          </span>
          <span className="eng-preview-title">
            {current.title ?? (nonHtml ? `${current.contentType} 檔案` : host)}
          </span>
          {(current.description || current.summary) && (
            <span className="eng-preview-desc">{current.description || current.summary}</span>
          )}
        </span>
      </a>
      <span className="eng-preview-foot">
        <span className="eng-text-tertiary">網頁資訊取得於 {formatDateTime(current.fetchedAt)}</span>
        {refresh.error != null && <span className="eng-danger-text">{errorMessage(refresh.error)}</span>}
        {refreshBtn}
      </span>
    </div>
  );
}
