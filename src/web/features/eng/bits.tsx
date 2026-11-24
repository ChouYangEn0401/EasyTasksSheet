import { Skeleton } from '../../ui/index.ts';

/** ⋯ 圖示（core Icon 無此圖形，於本 feature 內自備） */
export function MoreIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

/** 外開連結圖示 */
export function ExternalIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

export function SkeletonRows({ rows, cols }: { rows: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} aria-hidden="true">
          {Array.from({ length: cols }, (_, j) => (
            <td key={j}>
              <Skeleton width={j === 0 ? '80%' : '60%'} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** 名稱建議清單（<input list>） */
export function NameList({ id, names }: { id: string; names: string[] }) {
  return (
    <datalist id={id}>
      {names.map((n) => (
        <option key={n} value={n} />
      ))}
    </datalist>
  );
}
