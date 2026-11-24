import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Task } from '../../../shared/tasks.ts';
import { errorMessage } from '../../lib/api.ts';
import { hasActiveFilters } from '../../lib/filters.ts';
import { todayString } from '../../lib/format.ts';
import { useTasks, useUpdateTask, useUsers } from '../../lib/hooks.ts';
import { openTask } from '../../lib/openTask.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
import { useTaskFilters } from '../../lib/useTaskFilters.ts';
import { NoFilterResults } from '../../shell/FilterBar.tsx';
import { ViewTabsActions } from '../../shell/ViewTabs.tsx';
import {
  Alert,
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Select,
  Skeleton,
  StatusBadge,
  UpdatedAt,
} from '../../ui/index.ts';
import { DatePopover, type DatePopoverState } from './DatePopover.tsx';
import { Gantt, type DatePatch, type GanttHandle } from './Gantt.tsx';
import { GROUP_OPTIONS, parseGroupBy, type GroupBy } from './grouping.ts';
import { isScheduled, SCALE_LABEL, SCALES, type Scale } from './timeline.ts';
import './gantt.css';

const UNSCHEDULED_KEY = 'gantt.unscheduled.collapsed';
const ERROR_HIDE_MS = 8000;

const parseScale = (raw: string | null): Scale => (raw === 'day' || raw === 'month' ? raw : 'week');

type SaveError = { task: Task; patch: DatePatch; message: string };

/** Gantt 檢視（/tasks/gantt）：分組、日 / 週 / 月刻度、拖曳改日期、未排程區 */
export function GanttPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const groupBy = parseGroupBy(searchParams.get('group'));
  const scale = parseScale(searchParams.get('scale'));
  const setParam = useCallback(
    (key: string, value: string) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(key, value);
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
  );

  const { filters } = useTaskFilters();
  const tasksQuery = useTasks(filters);
  const users = useUsers();
  const update = useUpdateTask();
  const [today] = useState(() => todayString());
  const ganttRef = useRef<GanttHandle>(null);

  // 樂觀更新：送出期間以覆寫值顯示新日期
  const [overrides, setOverrides] = useState<Map<number, DatePatch>>(() => new Map());
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [popover, setPopover] = useState<DatePopoverState | null>(null);
  const pendingScrollId = useRef<number | null>(null);
  const [unscheduledCollapsed, setUnscheduledCollapsed] = useState(
    () => readStorage(UNSCHEDULED_KEY) === '1',
  );

  const tasks = useMemo(() => {
    const list = tasksQuery.data ?? [];
    if (!overrides.size) return list;
    return list.map((t) => {
      const o = overrides.get(t.id);
      return o ? { ...t, ...o } : t;
    });
  }, [tasksQuery.data, overrides]);

  const scheduled = useMemo(() => tasks.filter(isScheduled), [tasks]);
  const unscheduled = useMemo(() => tasks.filter((t) => !isScheduled(t)), [tasks]);

  const members = useMemo(() => {
    const active = (users.data ?? []).filter((u) => u.isActive);
    const picked = filters.assignee.filter((a): a is number => a !== 'none');
    // 有負責人篩選時只列出被篩選的成員
    const list = filters.assignee.length ? active.filter((u) => picked.includes(u.id)) : active;
    return list
      .map((u) => ({ id: u.id, displayName: u.displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hant'));
  }, [users.data, filters.assignee]);

  const changeDates = useCallback(
    (task: Task, patch: DatePatch) => {
      setSaveError(null);
      setOverrides((m) => new Map(m).set(task.id, { ...m.get(task.id), ...patch }));
      update.mutate(
        { id: task.id, ...patch },
        {
          onError: (err) => setSaveError({ task, patch, message: errorMessage(err) }),
          onSettled: () =>
            setOverrides((m) => {
              const next = new Map(m);
              next.delete(task.id);
              return next;
            }),
        },
      );
    },
    [update],
  );

  useEffect(() => {
    if (!saveError) return;
    const t = window.setTimeout(() => setSaveError(null), ERROR_HIDE_MS);
    return () => window.clearTimeout(t);
  }, [saveError]);

  // 排入日期後捲到該長條
  useEffect(() => {
    const id = pendingScrollId.current;
    if (id != null && scheduled.some((t) => t.id === id)) {
      pendingScrollId.current = null;
      ganttRef.current?.scrollToTask(id);
    }
  }, [scheduled]);

  const openPopover = (task: Task, anchor: HTMLElement | null) => {
    if (!anchor) return;
    setPopover({ task, anchor: anchor.getBoundingClientRect() });
  };
  const closePopover = useCallback(() => setPopover(null), []);

  const requestDates = useCallback((task: Task) => {
    const el = document.querySelector<HTMLElement>(`[data-row-key="t${task.id}"] .gantt-cell-left`);
    if (el) setPopover({ task, anchor: el.getBoundingClientRect() });
  }, []);

  const controls = (
    <ViewTabsActions>
      <div className="gantt-actions">
        <Select<GroupBy>
          className="gantt-group-select"
          aria-label="分組"
          options={GROUP_OPTIONS.map((o) => ({ value: o.value, label: `分組：${o.label}` }))}
          value={groupBy}
          onChange={(v) => setParam('group', v)}
          align="end"
        />
        <div className="gantt-scale" role="group" aria-label="時間刻度">
          {SCALES.map((s) => (
            <button key={s} type="button" aria-pressed={s === scale} onClick={() => setParam('scale', s)}>
              {SCALE_LABEL[s]}
            </button>
          ))}
        </div>
        <Button
          className="gantt-page-nav"
          variant="ghost"
          size="sm"
          iconOnly
          icon={<Icon name="chevronsLeft" />}
          aria-label="往前"
          onClick={() => ganttRef.current?.scrollPage(-1)}
        />
        <Button variant="secondary" size="sm" onClick={() => ganttRef.current?.scrollToToday()}>
          今天
        </Button>
        <Button
          className="gantt-page-nav"
          variant="ghost"
          size="sm"
          iconOnly
          icon={<Icon name="chevronsRight" />}
          aria-label="往後"
          onClick={() => ganttRef.current?.scrollPage(1)}
        />
      </div>
    </ViewTabsActions>
  );

  if (tasksQuery.isPending) {
    return (
      <div className="gantt-page" aria-busy="true">
        {controls}
        <GanttSkeleton />
      </div>
    );
  }
  if (tasksQuery.isError && !tasksQuery.data) {
    return (
      <div className="gantt-page">
        {controls}
        <ErrorState error={tasksQuery.error} onRetry={() => tasksQuery.refetch()} />
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <div className="gantt-page">
        {controls}
        {hasActiveFilters(filters) ? (
          <NoFilterResults />
        ) : (
          <EmptyState icon="gantt" title="還沒有任務" description="按 N 快速新增任務" />
        )}
      </div>
    );
  }

  return (
    <div className="gantt-page">
      {controls}
      {saveError && (
        <Alert
          tone="danger"
          onClose={() => setSaveError(null)}
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const { task, patch } = saveError;
                changeDates(task, patch);
              }}
            >
              重試
            </Button>
          }
        >
          無法更新「{saveError.task.title}」的日期，已還原（{saveError.message}）
        </Alert>
      )}

      {scheduled.length === 0 ? (
        <div className="gantt-unscheduled">
          <EmptyState icon="gantt" title="尚無已排程的任務" description="設定開始日與到期日後會顯示在這裡" />
        </div>
      ) : (
        <Gantt
          tasks={scheduled}
          groupBy={groupBy}
          scale={scale}
          today={today}
          members={members}
          onChangeDates={changeDates}
          onRequestDates={requestDates}
          onScaleChange={(s) => setParam('scale', s)}
          handleRef={ganttRef}
        />
      )}

      {unscheduled.length > 0 && (
        <section className="gantt-unscheduled" aria-label="未排程">
          <button
            type="button"
            className="gantt-unscheduled-head"
            aria-expanded={!unscheduledCollapsed}
            onClick={() => {
              const next = !unscheduledCollapsed;
              setUnscheduledCollapsed(next);
              writeStorage(UNSCHEDULED_KEY, next ? '1' : '0');
            }}
          >
            <Icon name={unscheduledCollapsed ? 'chevronRight' : 'chevronDown'} />
            未排程（{unscheduled.length}）
          </button>
          {!unscheduledCollapsed && (
            <div className="gantt-unscheduled-list">
              {unscheduled.map((t) => (
                <div key={t.id} className="gantt-unscheduled-row" data-testid={`unscheduled-${t.id}`}>
                  <button type="button" className="gantt-unscheduled-title" onClick={() => openTask(t.id)}>
                    {t.title}
                  </button>
                  <Avatar userId={t.assigneeId} size="sm" />
                  <StatusBadge statusId={t.statusId} />
                  <UpdatedAt at={t.updatedAt} by={t.updatedBy} />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={(e) => openPopover(t, e.currentTarget)}
                    aria-haspopup="dialog"
                  >
                    排入日期
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {popover && (
        <DatePopover
          key={popover.task.id}
          state={popover}
          saving={update.isPending}
          onClose={closePopover}
          onSave={(patch) => {
            const { task } = popover;
            // 成功後任務清單重抓時捲到新長條（需在 invalidate 前設定）
            pendingScrollId.current = task.id;
            update.mutate(
              { id: task.id, ...patch },
              {
                onSuccess: () => setPopover(null),
                onError: (err) =>
                  setSaveError({
                    task,
                    patch: {
                      ...(patch.startDate ? { startDate: patch.startDate } : {}),
                      ...(patch.dueDate ? { dueDate: patch.dueDate } : {}),
                    },
                    message: errorMessage(err),
                  }),
              },
            );
          }}
        />
      )}
    </div>
  );
}

function GanttSkeleton() {
  return (
    <div className="gantt" aria-label="載入中">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="gantt-skeleton-row">
          <span>
            <Skeleton width={`${50 + ((i * 17) % 40)}%`} />
          </span>
          <Skeleton width={80 + ((i * 53) % 160)} height={16} style={{ marginLeft: 20 + ((i * 37) % 200) }} />
        </div>
      ))}
    </div>
  );
}
