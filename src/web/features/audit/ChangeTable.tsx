import { useMemo } from 'react';
import type { AuditChange } from '../../../shared/audit.ts';
import { inlineDiff, sideOf, type DiffSegment } from './model.ts';

/** 「修改前 / 修改後」只列有差異的欄位；長文字以行內差異高亮（刪除：灰底刪除線；新增：accent 底） */
export function ChangeTable({ changes, stacked = false }: { changes: AuditChange[]; stacked?: boolean }) {
  if (changes.length === 0) return <p className="aud-muted">這筆紀錄沒有欄位內容。</p>;
  const hasBefore = changes.some((c) => c.beforeText != null);
  const hasAfter = changes.some((c) => c.afterText != null);
  if (stacked)
    return (
      <dl className="aud-stack">
        {changes.map((c) => (
          <div key={c.field} className="aud-stack-item">
            <dt className="aud-stack-label">{c.label}</dt>
            <dd className="aud-stack-values">
              <ChangeValues change={c} hasBefore={hasBefore} hasAfter={hasAfter} labelled />
            </dd>
          </div>
        ))}
      </dl>
    );
  return (
    <div className="aud-diff-wrap">
      <table className="aud-diff">
        <thead>
          <tr>
            <th scope="col" className="aud-diff-field">
              欄位
            </th>
            {hasBefore && <th scope="col">修改前</th>}
            {hasAfter && <th scope="col">修改後</th>}
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.field}>
              <th scope="row">{c.label}</th>
              <ChangeValues change={c} hasBefore={hasBefore} hasAfter={hasAfter} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChangeValues({
  change,
  hasBefore,
  hasAfter,
  labelled = false,
}: {
  change: AuditChange;
  hasBefore: boolean;
  hasAfter: boolean;
  labelled?: boolean;
}) {
  const segments = useMemo(
    () =>
      change.long && change.beforeText != null && change.afterText != null
        ? inlineDiff(change.beforeText, change.afterText)
        : null,
    [change],
  );
  const cell = (side: 'before' | 'after') => {
    const text = side === 'before' ? change.beforeText : change.afterText;
    const body = segments ? (
      <Segments segments={sideOf(segments, side)} />
    ) : (
      <span className={text == null || text === '（空）' ? 'aud-muted' : undefined}>{text ?? '—'}</span>
    );
    const content = (
      <div className={`aud-value${change.long ? ' aud-value--long' : ''}`}>
        {body}
        {change.truncated && <span className="aud-muted">（內容過長，只保存了部分）</span>}
      </div>
    );
    if (labelled)
      return (
        <div key={side} className="aud-stack-side" data-side={side}>
          <span className="aud-stack-side-label">{side === 'before' ? '修改前' : '修改後'}</span>
          {content}
        </div>
      );
    return (
      <td key={side} data-side={side}>
        {content}
      </td>
    );
  };
  return (
    <>
      {hasBefore && cell('before')}
      {hasAfter && cell('after')}
    </>
  );
}

function Segments({ segments }: { segments: DiffSegment[] }) {
  if (segments.length === 0) return <span className="aud-muted">（空）</span>;
  return (
    <>
      {segments.map((s, i) =>
        s.type === 'same' ? (
          <span key={i}>{s.text}</span>
        ) : s.type === 'del' ? (
          <del key={i} className="aud-del">
            {s.text}
          </del>
        ) : (
          <ins key={i} className="aud-ins">
            {s.text}
          </ins>
        ),
      )}
    </>
  );
}
