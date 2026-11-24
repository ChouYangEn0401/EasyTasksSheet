import { useEffect, useRef, useState, type MouseEvent, type SyntheticEvent } from 'react';
import { useCurrentUser } from '../../lib/auth.ts';
import { notifySuccess } from '../../lib/toast.ts';
import { Button, Tooltip } from '../../ui/index.ts';
import { usePins, useTogglePin } from './api.ts';
import { BookmarkIcon } from './icons.tsx';
import './personal.css';

const LABEL_ON = '移出我的標記';
const LABEL_OFF = '加入我的標記';
const LABEL_FAIL = '標記失敗，請再試一次';

const stop = (e: SyntheticEvent) => e.stopPropagation();

/**
 * 標記按鈕（docs/design/personal.md §4）：把任務加入 / 移出登入者自己的標記清單。
 * 全站共用同一個「我的標記」查詢並樂觀更新；查詢載入中或未登入時不渲染。
 * 點擊與按下皆 stopPropagation，不觸發所在列 / 卡片的點擊或拖曳。
 */
export function PinButton({ taskId, size = 'sm' }: { taskId: number; size?: 'sm' | 'md' }) {
  const me = useCurrentUser();
  const pins = usePins(me?.id);
  const toggle = useTogglePin();
  const [failed, setFailed] = useState(false);
  const failTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(failTimer.current), []);

  if (!me || !pins.data) return null;

  const fromQuery = pins.data.some((p) => p.task.id === taskId);
  const pending = toggle.isPending;
  const pinned = pending && toggle.variables ? toggle.variables.pinned : fromQuery;
  const label = pinned ? LABEL_ON : LABEL_OFF;

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (pending) return;
    setFailed(false);
    window.clearTimeout(failTimer.current);
    toggle.mutate(
      { taskId, pinned: !pinned },
      {
        onSuccess: (_r, vars) => notifySuccess(vars.pinned ? '已加入我的標記' : '已移出我的標記'),
        onError: () => {
          setFailed(true);
          failTimer.current = window.setTimeout(() => setFailed(false), 3000);
        },
      },
    );
  };

  return (
    <span
      className="pin-wrap"
      onPointerDown={stop}
      onMouseDown={stop}
      onTouchStart={stop}
      onKeyDown={(e) => {
        // Enter / Space 只作用在按鈕本身，不讓外層列（開啟詳情、鍵盤拖曳）接手
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      }}
    >
      <Tooltip content={failed ? null : label}>
        <Button
          variant="ghost"
          size={size}
          iconOnly
          icon={<BookmarkIcon filled={pinned} />}
          aria-label={label}
          aria-pressed={pinned}
          aria-busy={pending || undefined}
          data-pinned={pinned || undefined}
          className={`pin-btn${pinned ? ' is-pinned' : ''}`}
          onClick={onClick}
        />
      </Tooltip>
      <span className="pin-live" aria-live="polite">
        {failed && <span className="ui-tooltip pin-error">{LABEL_FAIL}</span>}
      </span>
    </span>
  );
}
