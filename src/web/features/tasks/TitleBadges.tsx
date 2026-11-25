import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Task } from '../../../shared/tasks.ts';
import { Tooltip } from '../../ui/index.ts';
import { BlockedLock } from '../delay-link/DependencyBadge.tsx';
import type { Depish } from '../delay-link/depFields.ts';
import { TaskPresenceDots } from '../presence/TaskPresence.tsx';
import { ChecklistBadge } from './ChecklistBadge.tsx';
import { RelationBadge } from './RelationBadge.tsx';
import { TaskBadges } from './TaskBadges.tsx';

/*
 * 清單標題欄的徽章區（docs/design/task-list.md）：標題文字保底寬度（tasks.css .tl-cell--title），
 * 徽章依優先序排列（未讀留言 > 等待中 > 有人在看 > 待辦進度 > 相關任務 > 留言數 > 描述鎖定）；
 * 放不下的徽章整顆換到看不見的第二行（不會被切一半），改以「+N」表示，其 Tooltip 與 aria-label 列出被收合的項目。
 * 看板卡片不使用（維持原樣）。
 */

type Props = { task: Task & Depish };

export function TitleBadges({ task }: Props) {
  const unread = (task.unreadComments ?? 0) > 0;
  const items: { key: string; node: ReactNode }[] = [
    { key: 'unread', node: unread ? <TaskBadges task={task} part="comments" /> : null },
    { key: 'waiting', node: <BlockedLock task={task} mode="list" /> },
    { key: 'presence', node: <TaskPresenceDots taskId={task.id} /> },
    { key: 'checklist', node: <ChecklistBadge task={task} /> },
    { key: 'relation', node: <RelationBadge count={task.relationCount} /> },
    { key: 'comments', node: unread ? null : <TaskBadges task={task} part="comments" /> },
    { key: 'lock', node: <TaskBadges task={task} part="lock" /> },
  ];
  const boxRef = useRef<HTMLSpanElement>(null);
  const [hidden, setHidden] = useState<string[]>([]);

  // 量測換到第二行（被隱藏）的徽章；欄寬改變、徽章增減時重算
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const kids = ([...box.children] as HTMLElement[]).filter((k) => k.querySelector('[aria-label]'));
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

  return (
    <>
      <span className="tl-tbadges" ref={boxRef} data-testid="title-badges">
        {items.map(({ key, node }) => (
          <span key={key} className="tl-tbadge" data-badge={key}>
            {node}
          </span>
        ))}
      </span>
      {hidden.length > 0 && (
        <Tooltip content={`其他：${labels.join('、')}`}>
          <span
            className="tl-tbadge-more"
            role="img"
            aria-label={`另有 ${labels.length} 項：${labels.join('、')}`}
            data-unread={hiddenKeys.includes('unread') || undefined}
            data-testid="title-badges-more"
          >
            +{labels.length}
          </span>
        </Tooltip>
      )}
    </>
  );
}
