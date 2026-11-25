import type { Task } from '../../../shared/tasks.ts';
import { Tooltip } from '../../ui/index.ts';
import { badgeInfo } from './checklistModel.ts';
import './checklist.css';

/** 方框內打勾（☑）16px 線條圖示；tasks feature 內自繪，不改凍結的 ui */
function BoxCheck({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

/** 列表標題旁 / 看板卡片的待辦進度徽章：只在有清單時顯示；全部完成時變成綠色勾 */
export function ChecklistBadge({ task }: { task: Pick<Task, 'checklistTotal' | 'checklistDone'> }) {
  const info = badgeInfo(task);
  if (!info) return null;
  return (
    <Tooltip content={info.label}>
      <span
        className={`cl-badge${info.complete ? ' is-complete' : ''}`}
        role="img"
        aria-label={info.label}
        data-testid="checklist-badge"
      >
        {info.complete ? (
          <BoxCheck size={13} />
        ) : (
          <>
            <BoxCheck />
            {info.text}
          </>
        )}
      </span>
    </Tooltip>
  );
}
