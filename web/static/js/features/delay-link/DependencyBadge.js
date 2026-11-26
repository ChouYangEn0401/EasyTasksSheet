import { createElement, Fragment } from 'preact';
import { useState } from 'preact/compat';
import { todayString, truncate } from '../../lib/format.js';
import { Icon, Tooltip } from '../../ui/index.js';
import { useTaskDependencies } from './api.js';
import { depFields } from './depFields.js';
import {
  blockedBadgeText,
  blockedMarkText,
  blockedTooltip,
  blocksBadgeText,
  blocksMarkText,
  blocksTooltip,
} from './depText.js';
import { setShowDependencyMarks, useShowDependencyMarks } from './prefs.js';

/*
 * 看板 / 清單上的依賴標示（小元件，最小接入既有卡片與列；共用邏輯在 depFields.ts）。
 * 被擋住：琥珀色左側色條 + 淡琥珀底 +「被擋 N」小 pill +「等待中」徽章；正在擋住別人：中性小 pill「擋著 N」（清單）／徽章「擋住 N」（看板底部）。
 * 圖示一律用線條 SVG，不用 emoji。
 */

/** 沙漏（等待中）：與描述鎖定的鎖頭區分，同一張卡片上不會出現兩個意義不同的鎖頭 */
export function HourglassIcon({ size = 14 }) {
  return createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    createElement('path', {
      d: 'M6 3h12M6 21h12M7 3v3.5a5 5 0 0 0 2.2 4.1L12 12l2.8 1.4A5 5 0 0 1 17 17.5V21M17 3v3.5a5 5 0 0 1-2.2 4.1L12 12l-2.8 1.4A5 5 0 0 0 7 17.5V21',
      stroke: 'currentColor',
      strokeWidth: '1.75',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  );
}

/** 鏈結（擋著別人）：線條圖示，與沙漏成對 */
function ChainIcon({ size = 12 }) {
  return createElement(Icon, { name: 'link', size: size });
}

const TIP_MAX = 6;

/**
 * 小標記的 Tooltip：先顯示一句說明，滑過（或鍵盤聚焦）時才去抓這個任務的相依，再列出標題。
 * 只讀既有 GET /api/tasks/:id/dependencies（與抽屜相依區同一個查詢鍵，抓過就有快取）。
 */
function DepMarkTip({ taskId, kind, head, children }) {
  const [want, setWant] = useState(false);
  const q = useTaskDependencies(taskId, want);
  const items = kind === 'blocked' ? q.data?.blockedBy : q.data?.blocks;
  const list = (items ?? []).filter((d) => kind !== 'blocked' || !d.task.isDone);
  const content = createElement(
    'span',
    { className: 'dep-tip' },
    createElement('span', { className: 'dep-tip-head' }, head),
    want &&
      (q.isPending
        ? createElement('span', { className: 'dep-tip-item' }, '載入中…')
        : list.length > 0 &&
          createElement(
            Fragment,
            null,
            createElement(
              'span',
              { className: 'dep-tip-label' },
              kind === 'blocked' ? '等待這些完成：' : '完成後可開始：',
            ),
            list
              .slice(0, TIP_MAX)
              .map((d) =>
                createElement(
                  'span',
                  { key: d.id, className: 'dep-tip-item' },
                  '・',
                  truncate(d.task.title, 24),
                ),
              ),
            list.length > TIP_MAX &&
              createElement('span', { className: 'dep-tip-item' }, `還有 ${list.length - TIP_MAX} 個`),
          )),
  );
  return createElement(
    'span',
    { className: 'dep-mark-wrap', onPointerEnter: () => setWant(true), onFocusCapture: () => setWant(true) },
    createElement(Tooltip, { content: content }, children),
  );
}

/**
 * 「被擋 N」：琥珀小 pill（沙漏＋數字），清單列標題旁與看板卡標題旁共用（docs/design/ui-refresh-2026-11-26.md §3.3）。
 * 保留 .dep-lock／data-testid="dep-lock"（E2E 與既有樣式靠它）。
 * 看板可聚焦（tabIndex 0，tooltip 以 aria-describedby 關聯）；清單列的格子由 grid 方向鍵導覽，不加 Tab 停駐點（tabIndex -1），
 * 說明由 aria-label 讀出。看板受「顯示依賴標示」開關控制；清單一律顯示（沿用既有行為）。
 */
export function BlockedLock({ task, mode = 'kanban' }) {
  const show = useShowDependencyMarks();
  const d = depFields(task);
  if (!d.isBlocked || (mode === 'kanban' && !show)) return null;
  const tip = blockedTooltip({ ...d, dueDate: task.dueDate }, todayString());
  const n = Math.max(1, d.blockedByCount);
  return createElement(
    'span',
    { className: `dep-lock dep-lock--${mode}`, 'data-testid': 'dep-lock' },
    createElement(
      DepMarkTip,
      { taskId: task.id, kind: 'blocked', head: tip },
      createElement(
        'span',
        {
          className: 'dep-lock-icon dep-mark dep-mark--blocked',
          role: 'img',
          'aria-label': `等待中：${tip}`,
          tabIndex: mode === 'kanban' ? 0 : -1,
        },
        createElement(HourglassIcon, { size: 12 }),
        createElement('span', { className: 'dep-mark-text' }, blockedMarkText(n)),
      ),
    ),
  );
}

/** 「擋著 N」：中性小 pill（鏈結＋數字），清單列標題旁；看板卡底部已有「擋住 N」徽章，看板不重複放 */
export function BlocksMark({ task }) {
  const d = depFields(task);
  if (d.blocksCount === 0) return null;
  const tip = blocksTooltip(d.blocksCount);
  return createElement(
    'span',
    { className: 'dep-blocks-mark', 'data-testid': 'dep-blocks-mark' },
    createElement(
      DepMarkTip,
      { taskId: task.id, kind: 'blocks', head: tip },
      createElement(
        'span',
        { className: 'dep-mark dep-mark--blocks', role: 'img', 'aria-label': tip, tabIndex: -1 },
        createElement(ChainIcon, { size: 12 }),
        createElement('span', { className: 'dep-mark-text' }, blocksMarkText(d.blocksCount)),
      ),
    ),
  );
}

/** 卡片底部徽章列：「等待中 · 預計延後 N 天 → 12/20」與「擋住 N」 */
export function DependencyBadges({ task, isDone = false }) {
  const show = useShowDependencyMarks();
  const d = depFields(task);
  if (!show || isDone || (!d.isBlocked && d.blocksCount === 0)) return null;
  const today = todayString();
  return createElement(
    'div',
    { className: 'dep-badges' },
    d.isBlocked &&
      createElement(
        Tooltip,
        { content: blockedTooltip({ ...d, dueDate: task.dueDate }, today) },
        createElement(
          'span',
          { className: 'dep-badge dep-badge--waiting', 'data-testid': 'dep-waiting' },
          createElement(Icon, { name: 'clock', size: 12 }),
          blockedBadgeText(d, today),
        ),
      ),
    d.blocksCount > 0 &&
      createElement(
        Tooltip,
        { content: blocksTooltip(d.blocksCount) },
        createElement(
          'span',
          { className: 'dep-badge dep-badge--blocks', 'data-testid': 'dep-blocks' },
          createElement(ChainIcon, { size: 12 }),
          blocksBadgeText(d.blocksCount),
        ),
      ),
  );
}

/** 看板右上「顯示依賴標示」開關 */
export function DependencyMarksToggle() {
  const show = useShowDependencyMarks();
  return createElement(
    'label',
    { className: 'dep-toggle' },
    createElement('input', {
      type: 'checkbox',
      className: 'ui-checkbox',
      checked: show,
      onChange: (e) => setShowDependencyMarks(e.target.checked),
    }),
    createElement('span', null, '顯示依賴標示'),
  );
}
