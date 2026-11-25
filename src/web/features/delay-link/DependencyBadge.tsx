import { todayString } from '../../lib/format.ts';
import { Icon, Tooltip } from '../../ui/index.ts';
import { depFields, type Depish } from './depFields.ts';
import { blockedBadgeText, blockedTooltip, blocksBadgeText, blocksTooltip } from './depText.ts';
import { setShowDependencyMarks, useShowDependencyMarks } from './prefs.ts';
import './dependency.css';

/*
 * 看板 / 清單上的依賴標示（小元件，最小接入既有卡片與列；共用邏輯在 depFields.ts）。
 * 被擋住：琥珀色左側色條 + 淡琥珀底 + 鎖頭 +「等待中」徽章；正在擋住別人：中性小徽章「擋住 N」。
 */

/** 標題旁的鎖頭（被擋住時）；mode = list 時用於清單列 */
export function BlockedLock({ task, mode = 'kanban' }: { task: Depish; mode?: 'kanban' | 'list' }) {
  const show = useShowDependencyMarks();
  const d = depFields(task);
  if (!d.isBlocked || (mode === 'kanban' && !show)) return null;
  const tip = blockedTooltip({ ...d, dueDate: task.dueDate }, todayString());
  return (
    <span className={`dep-lock dep-lock--${mode}`} data-testid="dep-lock">
      <Tooltip content={tip}>
        <span className="dep-lock-icon" role="img" aria-label={`等待中：${tip}`}>
          <Icon name="lock" size={14} />
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
