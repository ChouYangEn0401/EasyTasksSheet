import { forwardRef, type ButtonHTMLAttributes } from 'react';
import type { Status } from '../../shared/projects.ts';
import { statusStyle, statusTone } from '../lib/colors.ts';
import { useStatusesById } from '../lib/hooks.ts';
import { Icon } from './Icon.tsx';

type StatusLike = Pick<Status, 'name' | 'color' | 'category'>;

export type StatusBadgeProps = {
  /** 直接給狀態物件，或給 statusId 由共用 hook 查找 */
  status?: StatusLike | null;
  statusId?: number | null;
  /** 互動版：渲染為按鈕（hover 顯示邊框與 chevron），點擊行為由使用者處理（T1 開 Select） */
  interactive?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

/** 狀態膠囊：前置圓點，顏色依 category（審查中用 review 色） */
export const StatusBadge = forwardRef<HTMLButtonElement, StatusBadgeProps>(function StatusBadge(
  { status, statusId, interactive, className = '', style, ...rest },
  ref,
) {
  const byId = useStatusesById();
  const s = status ?? (statusId != null ? byId.get(statusId) : undefined);
  const tone = s ? statusTone(s) : 'todo';
  const label = s?.name ?? '—';
  const merged = { ...statusStyle(tone), ...style };
  if (interactive) {
    return (
      <button
        ref={ref}
        type="button"
        className={`ui-status-badge ${className}`}
        style={merged}
        aria-label={`狀態：${label}`}
        {...rest}
      >
        <span className="ui-dot" />
        {label}
        <Icon name="chevronDown" size={12} />
      </button>
    );
  }
  return (
    <span className={`ui-status-badge ${className}`} style={merged}>
      <span className="ui-dot" />
      {label}
    </span>
  );
});
