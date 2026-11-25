import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type {
  DependencyDirection,
  DependencyItem,
  DependencyProjection,
} from '../../../shared/dependencies.ts';
import type { Task } from '../../../shared/tasks.ts';
import { api, errorMessage } from '../../lib/api.ts';
import { queryClient, queryKeys } from '../../lib/queryClient.ts';
import { statusStyle, statusTone } from '../../lib/colors.ts';
import { emptyFilters } from '../../lib/filters.ts';
import { todayString } from '../../lib/format.ts';
import { useStatusesById, useTasks, useUsersById } from '../../lib/hooks.ts';
import { openTask } from '../../lib/openTask.ts';
import { useCan } from '../../lib/permissions.ts';
import { toast, truncate } from '../../lib/toast.ts';
import { Button, Icon, Input, Skeleton } from '../../ui/index.ts';
import { Popover } from '../tasks/Popover.tsx';
import { useCreateDependency, useDeleteDependency, useTaskDependencies } from './api.ts';
import { delayPhrase, lagLabel, shortDate } from './depText.ts';
import './dependency.css';

/**
 * 任務詳情的「依賴」區（TaskDrawer 最小接入：<DependenciesSection task={task} />）。
 * 兩小節：「等待這些任務完成」（前置任務）與「完成後可開始的任務」。
 * 新增：輕量搜尋選單（標題關鍵字、排除自己與已存在者、最多 8 筆、鍵盤選擇；lag 天數在「進階」）。
 * 移除：一鍵移除，toast 可復原。建立失敗（例如會形成循環）在選單內顯示中文訊息。
 */
export function DependenciesSection({ task }: { task: Task }) {
  const q = useTaskDependencies(task.id);
  const canEdit = useCan('tasks.edit');
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [initialDir, setInitialDir] = useState<DependencyDirection>('blocked_by');
  const today = todayString();
  const data = q.data;
  const self = data?.self;

  const open = (dir: DependencyDirection, el: HTMLElement) => {
    setInitialDir(dir);
    setAnchor(anchor ? null : el);
  };

  return (
    <section
      className="task-drawer-section"
      aria-labelledby={`dep-title-${task.id}`}
      data-testid="dep-section"
    >
      <div className="tl-section-title">
        <span id={`dep-title-${task.id}`}>依賴</span>
      </div>
      {self?.isBlocked && <SelfNotice self={self} today={today} />}
      {q.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="載入依賴中">
          <Skeleton height={14} width="60%" />
          <Skeleton height={14} width="45%" />
        </div>
      ) : q.isError && !data ? (
        <div className="dep-none" role="alert">
          無法載入依賴：{errorMessage(q.error)}{' '}
          <button type="button" className="tl-linkbtn" onClick={() => void q.refetch()}>
            重試
          </button>
        </div>
      ) : (
        <>
          <DepGroup
            title="等待這些任務完成"
            empty="沒有前置任務"
            items={data?.blockedBy ?? []}
            taskId={task.id}
            canEdit={canEdit}
            today={today}
            onAdd={(el) => open('blocked_by', el)}
            addLabel="新增前置任務"
          />
          <DepGroup
            title="完成後可開始的任務"
            empty="沒有等待此任務的任務"
            items={data?.blocks ?? []}
            taskId={task.id}
            canEdit={canEdit}
            today={today}
            onAdd={(el) => open('blocks', el)}
            addLabel="新增後續任務"
          />
        </>
      )}
      {anchor && canEdit && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={340} label="新增依賴">
          <DependencyPicker
            task={task}
            initialDirection={initialDir}
            existing={[...(data?.blockedBy ?? []), ...(data?.blocks ?? [])].map((d) => d.task.id)}
            onDone={() => setAnchor(null)}
          />
        </Popover>
      )}
    </section>
  );
}

function SelfNotice({ self, today }: { self: DependencyProjection; today: string }) {
  const text = self.unknownBlockerDate
    ? '等待中（前置任務尚未排程，暫時無法推算）'
    : self.delayDays && self.delayDays > 0
      ? `等待中 · 依前置任務的時程，預計延後 ${self.delayDays} 天（到 ${shortDate(self.projectedEnd, today)}）`
      : self.projectedEnd
        ? `等待中 · 依前置任務的時程，預計 ${shortDate(self.projectedEnd, today)} 完成`
        : '等待中';
  return (
    <div className="dep-self" data-testid="dep-self">
      <Icon name="lock" size={14} />
      <span>{text}</span>
    </div>
  );
}

function DepGroup({
  title,
  empty,
  items,
  taskId,
  canEdit,
  today,
  onAdd,
  addLabel,
}: {
  title: string;
  empty: string;
  items: DependencyItem[];
  taskId: number;
  canEdit: boolean;
  today: string;
  onAdd: (el: HTMLElement) => void;
  addLabel: string;
}) {
  const headingId = useId();
  return (
    <div className="dep-section-group">
      <div className="dep-subtitle">
        <span id={headingId}>{title}</span>
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            icon="plus"
            aria-label={addLabel}
            onClick={(e) => onAdd(e.currentTarget)}
          >
            新增
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="dep-none">{empty}</div>
      ) : (
        <ul className="dep-list" aria-labelledby={headingId}>
          {items.map((d) => (
            <DepRow key={d.id} item={d} taskId={taskId} canEdit={canEdit} today={today} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DepRow({
  item,
  taskId,
  canEdit,
  today,
}: {
  item: DependencyItem;
  taskId: number;
  canEdit: boolean;
  today: string;
}) {
  const statuses = useStatusesById();
  const users = useUsersById();
  const del = useDeleteDependency(taskId);
  const t = item.task;
  const status = statuses.get(t.statusId);
  const tone = status ? statusTone(status) : 'todo';
  const assignee = t.assigneeId != null ? users.get(t.assigneeId)?.displayName : undefined;
  const dates =
    t.startDate && t.dueDate
      ? `${shortDate(t.startDate, today)}–${shortDate(t.dueDate, today)}`
      : shortDate(t.dueDate ?? t.startDate, today);
  const phrase = t.isDone ? '已完成的前置任務' : delayPhrase(item.projection, today);
  const delayed = !t.isDone && (item.projection.delayDays ?? 0) > 0;

  const remove = () =>
    del.mutate(item.id, {
      onSuccess: (res) => {
        const r = res.removed;
        toast({
          tone: 'success',
          title: `已移除依賴「${truncate(t.title)}」`,
          action: {
            label: '復原',
            // 列已卸載，直接呼叫 API（不依賴元件內的 mutation）
            onClick: () =>
              api
                .post(`/tasks/${taskId}/dependencies`, {
                  direction: r.direction,
                  targetId: r.targetId,
                  lagDays: r.lagDays,
                  note: r.note,
                })
                .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all }))
                .catch((err: unknown) =>
                  toast({ tone: 'warning', title: '無法復原依賴', description: errorMessage(err) }),
                ),
          },
        });
      },
    });

  return (
    <li className={`dep-row${t.isDone ? ' is-done' : ''}`} data-testid="dep-row">
      <span
        className="dep-row-status"
        style={statusStyle(tone)}
        role="img"
        aria-label={`狀態：${status?.name ?? '—'}`}
      />
      <span className="dep-row-main">
        <button type="button" className="dep-row-title" onClick={() => openTask(t.id)} title={t.title}>
          {t.title}
        </button>
        <span className="dep-row-meta">
          {[assignee ?? '未指派', dates].filter(Boolean).join('・')}
          {phrase && (
            <>
              {'・'}
              <span
                className={
                  delayed ? 'dep-delay' : item.projection.delayDays === 0 && !t.isDone ? 'dep-ok' : ''
                }
              >
                {phrase}
              </span>
            </>
          )}
          {item.lagDays > 0 && `・完成後再等 ${item.lagDays} 天`}
        </span>
      </span>
      {item.lagDays > 0 ? <span className="dep-option-hint">{lagLabel(item.lagDays)}</span> : <span />}
      {canEdit ? (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="x"
          className="dep-row-remove"
          aria-label={`移除依賴「${t.title}」`}
          loading={del.isPending}
          onClick={remove}
        />
      ) : (
        <span />
      )}
    </li>
  );
}

const MAX_OPTIONS = 8;

function DependencyPicker({
  task,
  initialDirection,
  existing,
  onDone,
}: {
  task: Task;
  initialDirection: DependencyDirection;
  existing: number[];
  onDone: () => void;
}) {
  const [direction, setDirection] = useState<DependencyDirection>(initialDirection);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [lag, setLag] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const all = useTasks(emptyFilters());
  const statuses = useStatusesById();
  const create = useCreateDependency(task.id);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const options = useMemo(() => {
    const skip = new Set([task.id, ...existing]);
    const kw = query.trim().toLowerCase();
    return (all.data ?? [])
      .filter((t) => t.id > 0 && !skip.has(t.id) && (!kw || t.title.toLowerCase().includes(kw)))
      .slice(0, MAX_OPTIONS);
  }, [all.data, existing, query, task.id]);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  const pick = (target: Task) => {
    setError(null);
    create.mutate(
      { direction, targetId: target.id, ...(lag > 0 && { lagDays: lag }) },
      {
        onSuccess: () => {
          toast({
            tone: 'success',
            title: direction === 'blocked_by' ? '已加入前置任務' : '已加入後續任務',
            description: truncate(target.title),
          });
          onDone();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = options[activeIndex];
      if (target && !create.isPending) pick(target);
    }
  };

  return (
    <div className="dep-picker">
      <div className="dep-picker-dir" role="group" aria-label="依賴方向">
        <button
          type="button"
          aria-pressed={direction === 'blocked_by'}
          onClick={() => setDirection('blocked_by')}
        >
          等待它完成（前置）
        </button>
        <button type="button" aria-pressed={direction === 'blocks'} onClick={() => setDirection('blocks')}>
          完成後它才開始（後續）
        </button>
      </div>
      <Input
        ref={inputRef}
        size="sm"
        icon="search"
        placeholder="搜尋任務標題…"
        aria-label="搜尋要連結的任務"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={options[activeIndex] ? `${listId}-${options[activeIndex].id}` : undefined}
        aria-autocomplete="list"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setError(null);
        }}
        onKeyDown={onKeyDown}
      />
      <ul className="dep-options" role="listbox" id={listId} aria-label="符合的任務">
        {options.length === 0 && (
          <li className="dep-none" role="presentation">
            {all.isPending ? '載入中…' : '沒有符合的任務'}
          </li>
        )}
        {options.map((t, i) => {
          const s = statuses.get(t.statusId);
          return (
            <li
              key={t.id}
              id={`${listId}-${t.id}`}
              role="option"
              aria-selected={i === activeIndex}
              className="dep-option"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => !create.isPending && pick(t)}
            >
              <span
                className="dep-row-status"
                style={statusStyle(s ? statusTone(s) : 'todo')}
                aria-hidden="true"
              />
              <span className="dep-option-title">{t.title}</span>
              {t.dueDate && <span className="dep-option-hint">{shortDate(t.dueDate, todayString())}</span>}
            </li>
          );
        })}
      </ul>
      <details className="dep-advanced">
        <summary>進階：完成後再等幾天</summary>
        <label className="dep-advanced-body">
          前置任務完成後，至少再等
          <Input
            size="sm"
            type="number"
            min={0}
            max={365}
            value={lag}
            aria-label="等待天數"
            onChange={(e) => setLag(Math.max(0, Math.min(365, Math.floor(Number(e.target.value) || 0))))}
          />
          天
        </label>
      </details>
      {error && (
        <div className="dep-error" role="alert">
          {error}
        </div>
      )}
      {create.isPending && <div className="dep-none">建立中…</div>}
    </div>
  );
}
