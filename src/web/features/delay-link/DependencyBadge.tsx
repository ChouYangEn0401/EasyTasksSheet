import { todayString } from '../../lib/format.ts';
import { Icon, Tooltip } from '../../ui/index.ts';
import { depFields, type Depish } from './depFields.ts';
import { blockedBadgeText, blockedTooltip, blocksBadgeText, blocksTooltip } from './depText.ts';
import { setShowDependencyMarks, useShowDependencyMarks } from './prefs.ts';
import './dependency.css';

/*
 * 看板 / 清單上的依賴標示（小元件，最小接入既有卡片與列；共用邏輯在 depFields.ts）。
 * 被擋住：琥珀色左側色條 + 淡琥珀底 + 沙漏 +「等待中」徽章；正在擋住別人：中性小徽章「擋住 N」。
 */

/** 沙漏（等待中）：與描述鎖定的鎖頭區分，同一張卡片上不會出現兩個意義不同的鎖頭 */
export function HourglassIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 3h12M6 21h12M7 3v3.5a5 5 0 0 0 2.2 4.1L12 12l2.8 1.4A5 5 0 0 1 17 17.5V21M17 3v3.5a5 5 0 0 1-2.2 4.1L12 12l-2.8 1.4A5 5 0 0 0 7 17.5V21"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 標題旁的沙漏（被擋住時）；mode = list 時用於清單列。
 * 可聚焦（看板）：鍵盤 focus 時也會顯示 tooltip 並以 aria-describedby 關聯；aria-label 含完整說明。
 * 清單列的格子由 grid 方向鍵導覽，這裡不加額外的 Tab 停駐點（tabIndex -1），說明由 aria-label 讀出。
 */
export function BlockedLock({ task, mode = 'kanban' }: { task: Depish; mode?: 'kanban' | 'list' }) {
  const show = useShowDependencyMarks();
  const d = depFields(task);
  if (!d.isBlocked || (mode === 'kanban' && !show)) return null;
  const tip = blockedTooltip({ ...d, dueDate: task.dueDate }, todayString());
  return (
    <span className={`dep-lock dep-lock--${mode}`} data-testid="dep-lock">
      <Tooltip content={tip}>
        <span
          className="dep-lock-icon"
          role="img"
          aria-label={`等待中：${tip}`}
          tabIndex={mode === 'kanban' ? 0 : -1}
        >
          <HourglassIcon size={14} />
        </span>
      </Tooltip>
    </span>
  );
}

/** 卡片底部徽章列：「等待中 · 預計延後 N 天 → 12/20」與「擋住 N」 */
export function DependencyBadges({ task, isDone = false }: { task: Depish; isDone?: boolean }) {
  const show = useShowDependencyMarks();
  const d = depFields(task);
  if (!show || isDone || (!d.isBlocked && d.blocksCount === 0)) return null;
  const today = todayString();
  return (
    <div className="dep-badges">
      {d.isBlocked && (
        <Tooltip content={blockedTooltip({ ...d, dueDate: task.dueDate }, today)}>
          <span className="dep-badge dep-badge--waiting" data-testid="dep-waiting">
            <Icon name="clock" size={12} />
            {blockedBadgeText(d, today)}
          </span>
        </Tooltip>
      )}
      {d.blocksCount > 0 && (
        <Tooltip content={blocksTooltip(d.blocksCount)}>
          <span className="dep-badge dep-badge--blocks" data-testid="dep-blocks">
            {blocksBadgeText(d.blocksCount)}
          </span>
        </Tooltip>
      )}
    </div>
  );
}

/** 看板右上「顯示依賴標示」開關 */
export function DependencyMarksToggle() {
  const show = useShowDependencyMarks();
  return (
    <label className="dep-toggle">
      <input
        type="checkbox"
        className="ui-checkbox"
        checked={show}
        onChange={(e) => setShowDependencyMarks(e.target.checked)}
      />
      <span>顯示依賴標示</span>
    </label>
  );
}
