import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { errorMessage } from '../../lib/api.js';
import { formatDateTime } from '../../lib/format.js';
import { Button } from '../../ui/index.js';
import { useRefreshPreview } from './api.js';
import { EngIcon } from './bits.js';

function hostOf(url) {
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
export function LinkPreviewCard({ issue, preview, enabled }) {
  const refresh = useRefreshPreview();
  const [imgOk, setImgOk] = useState(true);
  const [iconOk, setIconOk] = useState(true);
  if (!issue.url || issue.githubNumber != null) return null;
  const current = preview && preview.url === issue.url ? preview : undefined;
  const host = hostOf(issue.url);

  const refreshBtn =
    enabled &&
    createElement(
      Button,
      {
        size: 'sm',
        variant: 'ghost',
        icon: 'refresh',
        loading: refresh.isPending,
        onClick: () => refresh.mutate(issue.id),
      },
      '重新取得預覽',
    );

  if (!current || current.status === 'error') {
    const text = !enabled
      ? '伺服器未啟用連結預覽'
      : !current
        ? '正在取得預覽…'
        : `無法取得預覽（${current.error ?? '未知原因'}）`;
    return createElement(
      'div',
      { className: 'eng-preview eng-preview--empty' },
      createElement(
        'span',
        { className: 'eng-preview-fallback' },
        createElement(EngIcon, { name: 'globe' }),
        createElement(
          'a',
          { href: issue.url, target: '_blank', rel: 'noopener noreferrer', className: 'eng-preview-host' },
          host,
        ),
        createElement('span', { className: 'eng-text-tertiary' }, text),
      ),
      refresh.error != null &&
        createElement('span', { className: 'eng-danger-text' }, errorMessage(refresh.error)),
      refreshBtn,
    );
  }

  const nonHtml = current.contentType && !/html/.test(current.contentType);
  return createElement(
    'div',
    { className: 'eng-preview' },
    createElement(
      'a',
      {
        className: 'eng-preview-card',
        href: issue.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        'aria-label': `開啟連結：${current.title ?? host}`,
      },
      current.imageUrl &&
        imgOk &&
        createElement(
          'span',
          { className: 'eng-preview-image' },
          createElement('img', {
            src: current.imageUrl,
            alt: '',
            loading: 'lazy',
            referrerPolicy: 'no-referrer',
            onError: () => setImgOk(false),
          }),
        ),
      createElement(
        'span',
        { className: 'eng-preview-text' },
        createElement(
          'span',
          { className: 'eng-preview-site' },
          current.faviconUrl && iconOk
            ? createElement('img', {
                src: current.faviconUrl,
                alt: '',
                width: 14,
                height: 14,
                referrerPolicy: 'no-referrer',
                onError: () => setIconOk(false),
              })
            : createElement(EngIcon, { name: 'globe', size: 14 }),
          createElement('span', null, current.siteName || host),
        ),
        createElement(
          'span',
          { className: 'eng-preview-title' },
          current.title ?? (nonHtml ? `${current.contentType} 檔案` : host),
        ),
        (current.description || current.summary) &&
          createElement('span', { className: 'eng-preview-desc' }, current.description || current.summary),
      ),
    ),
    createElement(
      'span',
      { className: 'eng-preview-foot' },
      createElement(
        'span',
        { className: 'eng-text-tertiary' },
        '網頁資訊取得於 ',
        formatDateTime(current.fetchedAt),
      ),
      refresh.error != null &&
        createElement('span', { className: 'eng-danger-text' }, errorMessage(refresh.error)),
      refreshBtn,
    ),
  );
}
