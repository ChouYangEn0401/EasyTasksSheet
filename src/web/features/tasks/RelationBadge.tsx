import { Tooltip } from '../../ui/index.ts';
import { relationCountLabel } from './relationModel.ts';
import './relations.css';

/** 連結圖示（core Icon 尚無 link；同 Icon 的 1.5px 線條風格） */
export function LinkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}

/** 清單列 / 看板卡片：relationCount > 0 時顯示「🔗 N」（不可聚焦，避免破壞 roving tabindex） */
export function RelationBadge({ count }: { count: number | undefined }) {
  if (!count || count <= 0) return null;
  const label = relationCountLabel(count);
  return (
    <Tooltip content={label}>
      <span className="tr-badge" role="img" aria-label={label} data-testid="relation-badge">
        <LinkIcon size={12} />
        <span aria-hidden="true">{count}</span>
      </span>
    </Tooltip>
  );
}
