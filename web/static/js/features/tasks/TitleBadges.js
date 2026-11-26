import { createElement, Fragment } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/compat';
import { Tooltip } from '../../ui/index.js';
import { BlockedLock } from '../delay-link/DependencyBadge.js';
import { TaskPresenceDots } from '../presence/TaskPresence.js';
import { ChecklistBadge } from './ChecklistBadge.js';
import { RelationBadge } from './RelationBadge.js';
import { TaskBadges } from './TaskBadges.js';

export function TitleBadges({ task }) {
  const unread = (task.unreadComments ?? 0) > 0;
  const items = [
    { key: 'unread', node: unread ? createElement(TaskBadges, { task: task, part: 'comments' }) : null },
    { key: 'waiting', node: createElement(BlockedLock, { task: task, mode: 'list' }) },
    { key: 'presence', node: createElement(TaskPresenceDots, { taskId: task.id }) },
    { key: 'checklist', node: createElement(ChecklistBadge, { task: task }) },
    { key: 'relation', node: createElement(RelationBadge, { count: task.relationCount }) },
    { key: 'comments', node: unread ? null : createElement(TaskBadges, { task: task, part: 'comments' }) },
    { key: 'lock', node: createElement(TaskBadges, { task: task, part: 'lock' }) },
  ];
  const boxRef = useRef(null);
  const [hidden, setHidden] = useState([]);

  // 量測換到第二行（被隱藏）的徽章；欄寬改變、徽章增減時重算
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const kids = [...box.children].filter((k) => k.querySelector('[aria-label]'));
      // 徽章區整個隱藏（窄寬，見 tasks.css）時全部算收合
      const collapsed = box.offsetWidth === 0;
      const top = kids.find((k) => k.offsetWidth > 0)?.offsetTop ?? 0;
      const labels = kids
        .filter((k) => collapsed || k.offsetWidth === 0 || k.offsetTop > top + 2)
        .map(
          (k) => `${k.dataset.badge}\t${k.querySelector('[aria-label]')?.getAttribute('aria-label') ?? ''}`,
        );
      setHidden((prev) => (prev.join('\n') === labels.join('\n') ? prev : labels));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    const mo = new MutationObserver(measure);
    mo.observe(box, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  const hiddenKeys = hidden.map((h) => h.split('\t')[0]);
  const labels = hidden.map((h) => h.split('\t')[1]).filter(Boolean);

  return createElement(
    Fragment,
    null,
    createElement(
      'span',
      { className: 'tl-tbadges', ref: boxRef, 'data-testid': 'title-badges' },
      items.map(({ key, node }) =>
        createElement('span', { key: key, className: 'tl-tbadge', 'data-badge': key }, node),
      ),
    ),
    hidden.length > 0 &&
      createElement(
        Tooltip,
        { content: `其他：${labels.join('、')}` },
        createElement(
          'span',
          {
            className: 'tl-tbadge-more',
            role: 'img',
            'aria-label': `另有 ${labels.length} 項：${labels.join('、')}`,
            'data-unread': hiddenKeys.includes('unread') || undefined,
            'data-testid': 'title-badges-more',
          },
          '+',
          labels.length,
        ),
      ),
  );
}
