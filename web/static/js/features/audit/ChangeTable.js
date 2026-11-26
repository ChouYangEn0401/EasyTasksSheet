import { createElement, Fragment } from 'preact';
import { useMemo } from 'preact/compat';
import { inlineDiff, sideOf } from './model.js';

/** 「修改前 / 修改後」只列有差異的欄位；長文字以行內差異高亮（刪除：灰底刪除線；新增：accent 底） */
export function ChangeTable({ changes, stacked = false }) {
  if (changes.length === 0) return createElement('p', { className: 'aud-muted' }, '這筆紀錄沒有欄位內容。');
  const hasBefore = changes.some((c) => c.beforeText != null);
  const hasAfter = changes.some((c) => c.afterText != null);
  if (stacked)
    return createElement(
      'dl',
      { className: 'aud-stack' },
      changes.map((c) =>
        createElement(
          'div',
          { key: c.field, className: 'aud-stack-item' },
          createElement('dt', { className: 'aud-stack-label' }, c.label),
          createElement(
            'dd',
            { className: 'aud-stack-values' },
            createElement(ChangeValues, {
              change: c,
              hasBefore: hasBefore,
              hasAfter: hasAfter,
              labelled: true,
            }),
          ),
        ),
      ),
    );
  return createElement(
    'div',
    { className: 'aud-diff-wrap' },
    createElement(
      'table',
      { className: 'aud-diff' },
      createElement(
        'thead',
        null,
        createElement(
          'tr',
          null,
          createElement('th', { scope: 'col', className: 'aud-diff-field' }, '欄位'),
          hasBefore && createElement('th', { scope: 'col' }, '修改前'),
          hasAfter && createElement('th', { scope: 'col' }, '修改後'),
        ),
      ),
      createElement(
        'tbody',
        null,
        changes.map((c) =>
          createElement(
            'tr',
            { key: c.field },
            createElement('th', { scope: 'row' }, c.label),
            createElement(ChangeValues, { change: c, hasBefore: hasBefore, hasAfter: hasAfter }),
          ),
        ),
      ),
    ),
  );
}

function ChangeValues({ change, hasBefore, hasAfter, labelled = false }) {
  const segments = useMemo(
    () =>
      change.long && change.beforeText != null && change.afterText != null
        ? inlineDiff(change.beforeText, change.afterText)
        : null,
    [change],
  );
  const cell = (side) => {
    const text = side === 'before' ? change.beforeText : change.afterText;
    const body = segments
      ? createElement(Segments, { segments: sideOf(segments, side) })
      : createElement(
          'span',
          { className: text == null || text === '（空）' ? 'aud-muted' : undefined },
          text ?? '—',
        );
    const content = createElement(
      'div',
      { className: `aud-value${change.long ? ' aud-value--long' : ''}` },
      body,
      change.truncated && createElement('span', { className: 'aud-muted' }, '（內容過長，只保存了部分）'),
    );
    if (labelled)
      return createElement(
        'div',
        { key: side, className: 'aud-stack-side', 'data-side': side },
        createElement('span', { className: 'aud-stack-side-label' }, side === 'before' ? '修改前' : '修改後'),
        content,
      );
    return createElement('td', { key: side, 'data-side': side }, content);
  };
  return createElement(Fragment, null, hasBefore && cell('before'), hasAfter && cell('after'));
}

function Segments({ segments }) {
  if (segments.length === 0) return createElement('span', { className: 'aud-muted' }, '（空）');
  return createElement(
    Fragment,
    null,
    segments.map((s, i) =>
      s.type === 'same'
        ? createElement('span', { key: i }, s.text)
        : s.type === 'del'
          ? createElement('del', { key: i, className: 'aud-del' }, s.text)
          : createElement('ins', { key: i, className: 'aud-ins' }, s.text),
    ),
  );
}
