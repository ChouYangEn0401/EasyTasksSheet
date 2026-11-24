import { useEffect, useState } from 'react';
import { formatDateTime, formatRelative } from '../lib/format.ts';
import { useUsersById } from '../lib/hooks.ts';
import { Tooltip } from './Tooltip.tsx';

/**
 * 最後更新時間：相對時間（剛剛、N 分鐘前…），hover / focus 顯示「2026/11/24 14:32 · 由 王小明 更新」。
 * by 可給使用者 id（自動查顯示名稱）或名稱字串；每 60 秒自行重算。
 */
export function UpdatedAt({
  at,
  by,
  prefix,
  className = '',
}: {
  at: number;
  by?: number | string | null;
  prefix?: string;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const byId = useUsersById();
  const name = typeof by === 'number' ? byId.get(by)?.displayName : by || undefined;
  const full = `${formatDateTime(at)}${name ? ` · 由 ${name} 更新` : ''}`;
  return (
    <Tooltip content={full}>
      <time
        className={`ui-updated-at ${className}`}
        dateTime={new Date(at).toISOString()}
        tabIndex={0}
        aria-label={`${prefix ?? '更新於'} ${full}`}
      >
        {prefix ? `${prefix} ` : ''}
        {formatRelative(at, Math.max(now, at))}
      </time>
    </Tooltip>
  );
}
