import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Task } from '../../../shared/tasks.ts';
import type { TaskRelation } from '../../../shared/taskRelations.ts';
import { statusStyle, statusTone } from '../../lib/colors.ts';
import { formatDateOnly } from '../../lib/format.ts';
import { useProjectsById, useStatusesById } from '../../lib/hooks.ts';
import { toast, truncate } from '../../lib/toast.ts';
import {
  Avatar,
  Button,
  ColorDot,
  ErrorState,
  Icon,
  Skeleton,
  Spinner,
  StatusBadge,
} from '../../ui/index.ts';
import { recordRelationAdd, recordRelationRemove, undoFromToast } from '../undo/linkUndo.ts';
import { useDrawerActive } from './drawerActive.ts';
import { jumpToTask } from './drawerNav.ts';
import { Popover } from './Popover.tsx';
import { useAddRelation, useRelationSearch, useRemoveRelation, useTaskRelations } from './relationData.ts';
import { relationCandidates } from './relationModel.ts';
import './relations.css';

/** 任務詳情抽屜的「相關任務」區（docs/design/task-list.md §13） */
export function RelatedTasks({ task }: { task: Task }) {
  const query = useTaskRelations(task.id, useDrawerActive());
  const remove = useRemoveRelation(task.id);
  const add = useAddRelation(task.id);
  const qc = useQueryClient();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const relations = query.data ?? [];

  // mutateAsync().then：連續移除多筆時每一筆都會登記復原並顯示 toast（mutate 的呼叫層回呼只保留最後一次）
  const onRemove = (rel: TaskRelation) =>
    void remove
      .mutateAsync(rel)
      .then(() => {
        // 登記到全站復原堆疊（Ctrl+Z）；toast 的「復原」走同一筆
        const entry = recordRelationRemove(qc, task.id, rel);
        toast({
          tone: 'success',
          title: '已移除相關任務',
          description: truncate(rel.task.title),
          action: { label: '復原', onClick: () => undoFromToast(entry) },
          duration: 5000,
        });
      })
      .catch(() => undefined);

  return (
    <div className="task-drawer-section" data-testid="related-tasks">
      <div className="tl-section-title">
        <span>
          相關任務
          {relations.length > 0 && <span className="tr-count">{relations.length}</span>}
        </span>
      </div>
      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="載入相關任務">
          <Skeleton height={14} width="80%" />
          <Skeleton height={14} width="60%" />
        </div>
      ) : query.isError && !query.data ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : relations.length === 0 ? (
        <div className="tl-empty tl-drawer-none">還沒有相關任務，把相關的工作串起來吧</div>
      ) : (
        <ul className="tr-list" aria-label="相關任務">
          {relations.map((rel) => (
            <RelationRow key={rel.id} rel={rel} from={task} onRemove={() => onRemove(rel)} />
          ))}
        </ul>
      )}
      <Button
        variant="ghost"
        size="sm"
        icon="plus"
        className="tl-drawer-add"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        新增關聯
      </Button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={340} label="新增相關任務">
          <RelationSearch
            selfId={task.id}
            relatedIds={relations.map((r) => r.task.id)}
            onPick={(target) =>
              void add
                .mutateAsync({ targetId: target.id })
                .then((rel) => {
                  recordRelationAdd(qc, task.id, rel);
                  setAnchor(null);
                  anchor.focus();
                })
                .catch(() => undefined)
            }
            busy={add.isPending}
          />
        </Popover>
      )}
    </div>
  );
}

function StatusDot({ statusId }: { statusId: number }) {
  const status = useStatusesById().get(statusId);
  const tone = status ? statusTone(status) : 'todo';
  return <span className="tr-dot" style={statusStyle(tone)} title={status?.name} aria-hidden="true" />;
}

function RelationRow({ rel, from, onRemove }: { rel: TaskRelation; from: Task; onRemove: () => void }) {
  const t = rel.task;
  const statusName = useStatusesById().get(t.statusId)?.name;
  return (
    <li className="tr-row" data-deleted={t.deleted || undefined}>
      <StatusDot statusId={t.statusId} />
      {t.deleted ? (
        <span className="tr-title tr-title--deleted">
          <span className="truncate">{t.title}</span>
          <span className="tr-deleted-tag">已刪除</span>
        </span>
      ) : (
        <button
          type="button"
          className="tr-title tr-title--link"
          onClick={() => jumpToTask(from, t.id)}
          aria-label={`開啟相關任務「${t.title}」${statusName ? `，${statusName}` : ''}`}
        >
          <span className="truncate">{t.title}</span>
        </button>
      )}
      {t.dueDate && !t.deleted && <span className="tr-due">{formatDateOnly(t.dueDate)}</span>}
      {!t.deleted && <Avatar userId={t.assigneeId} size="xs" />}
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon="x"
        className="tr-remove"
        aria-label={`移除相關任務「${t.title}」`}
        onClick={onRemove}
      />
    </li>
  );
}

/** 輕量搜尋選單：輸入標題關鍵字即時搜尋；↑↓ 選擇、Enter 加入、Esc 關閉 */
function RelationSearch({
  selfId,
  relatedIds,
  onPick,
  busy,
}: {
  selfId: number;
  relatedIds: number[];
  onPick: (task: Task) => void;
  busy: boolean;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const projects = useProjectsById();

  // 輸入停頓 200ms 後查詢
  useEffect(() => {
    const h = window.setTimeout(() => setQ(text.trim()), 200);
    return () => window.clearTimeout(h);
  }, [text]);
  useEffect(() => inputRef.current?.focus(), []);

  const search = useRelationSearch(q);
  const results = useMemo(
    () => (q ? relationCandidates(search.data ?? [], selfId, relatedIds) : []),
    [q, search.data, selfId, relatedIds],
  );
  const idx = Math.min(active, Math.max(0, results.length - 1));
  const typing = text.trim() !== q;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = results.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setActive((idx + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setActive((idx - 1 + n) % n);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (results[idx] && !busy) onPick(results[idx]);
    }
  };

  let body;
  if (!text.trim()) body = <div className="ui-panel-empty">輸入標題關鍵字搜尋任務</div>;
  else if ((search.isPending && search.fetchStatus !== 'idle') || (typing && !search.data))
    body = (
      <div className="ui-panel-empty tr-search-state">
        <Spinner size={14} /> 搜尋中…
      </div>
    );
  else if (search.isError)
    body = (
      <div className="ui-panel-empty tr-search-state">
        搜尋失敗 ·{' '}
        <button type="button" className="tl-linkbtn" onClick={() => void search.refetch()}>
          重試
        </button>
      </div>
    );
  else if (results.length === 0) body = <div className="ui-panel-empty">找不到可關聯的任務</div>;
  else
    body = results.map((t, i) => {
      const project = projects.get(t.projectId);
      return (
        <div
          key={t.id}
          id={`${id}-o${i}`}
          role="option"
          aria-selected={i === idx}
          data-highlighted={i === idx}
          className="ui-option tr-option"
          onPointerMove={() => setActive(i)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => !busy && onPick(t)}
        >
          <span className="tr-option-main">
            <span className="tr-option-title">{t.title}</span>
            <span className="tr-option-meta">
              <ColorDot color={project?.color} />
              <span className="truncate">{project?.name ?? '—'}</span>
            </span>
          </span>
          <StatusBadge statusId={t.statusId} />
        </div>
      );
    });

  return (
    <div className="tr-search">
      <div className="ui-panel-search">
        <span className="tr-search-input">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            className="ui-input ui-input--sm"
            placeholder="搜尋任務標題…"
            value={text}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-label="搜尋要關聯的任務"
            aria-controls={id}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? `${id}-o${idx}` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          {busy && <Spinner size={14} />}
        </span>
      </div>
      <div id={id} role="listbox" aria-label="搜尋結果" className="ui-panel-list">
        {body}
      </div>
    </div>
  );
}
