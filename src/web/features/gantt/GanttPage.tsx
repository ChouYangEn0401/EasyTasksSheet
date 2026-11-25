import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useSearchParams } from 'react-router';
import type { Task } from '../../../shared/tasks.ts';
import { errorMessage } from '../../lib/api.ts';
import { statusTone } from '../../lib/colors.ts';
import { hasActiveFilters } from '../../lib/filters.ts';
import { todayString } from '../../lib/format.ts';
import { useStatusesById, useTasks, useUpdateTask, useUsers, useUsersById } from '../../lib/hooks.ts';
import { useCan } from '../../lib/permissions.ts';
import { isEditableTarget } from '../../lib/shortcuts.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
import { newUndoGroup } from '../../lib/taskUndo.ts';
import { toast, truncate } from '../../lib/toast.ts';
import { performUndo, undoManager } from '../../lib/undo.ts';
import { useTaskFilters } from '../../lib/useTaskFilters.ts';
import { NoFilterResults } from '../../shell/FilterBar.tsx';
import { ViewTabsActions } from '../../shell/ViewTabs.tsx';
import { Alert, Badge, Button, EmptyState, ErrorState, Icon, Select, Skeleton } from '../../ui/index.ts';
import { DatePopover, type DatePopoverState } from './DatePopover.tsx';
import { Gantt, type GanttHandle } from './Gantt.tsx';
import { GROUP_OPTIONS, parseGroupBy, type GroupBy } from './grouping.ts';
import {
  formatScheduleRange,
  scheduleBefore,
  scheduleFieldNote,
  schedulePatch,
  scheduleUndoLabel,
  type ScheduleTarget,
} from './scheduleDrop.ts';
import { ScheduleDnd, UnscheduledRow } from './ScheduleDnd.tsx';
import { useScheduleDnd } from './useScheduleDnd.ts';
import { autoScale, isScheduled, parseScale, SCALE_LABEL, SCALES, type Scale } from './timeline.ts';
import './gantt.css';

const UNSCHEDULED_KEY = 'gantt.unscheduled.collapsed';
const SCALE_KEY = 'gantt.scale';
const ERROR_HIDE_MS = 8000;
const FLASH_MS = 1500;
const SCHEDULED_TOAST_MS = 5000;

/** 樂觀更新的覆寫欄位（拖曳改日期 / 拖曳排程） */
type TaskOverride = Partial<Pick<Task, 'startDate' | 'dueDate' | 'assigneeId' | 'projectId'>>;
type SaveError = { task: Task; patch: TaskOverride; message: string };

/** Gantt 檢視（/tasks/gantt）：分組、日 / 週 / 月刻度、拖曳改日期、未排程區 */
export function GanttPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const groupBy = parseGroupBy(searchParams.get('group'));
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
  const usersById = useUsersById();
  // 失敗由頁面頂部提示列（含重試）呈現，不另發全域 toast
  const update = useUpdateTask({ silentError: true });
  const [today] = useState(() => todayString());
  const ganttRef = useRef<GanttHandle>(null);

  // 樂觀更新：送出期間以覆寫值顯示新日期
  const [overrides, setOverrides] = useState<Map<number, TaskOverride>>(() => new Map());
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [popover, setPopover] = useState<DatePopoverState | null>(null);
  const pendingScrollId = useRef<number | null>(null);
  /** 鍵盤拖曳排程放下後，焦點移到新長條所在列 */
  const pendingFocus = useRef(false);
  const canEdit = useCan('tasks.edit');
  const [unscheduledCollapsed, setUnscheduledCollapsed] = useState(
    () => readStorage(UNSCHEDULED_KEY) === '1',
  );

  const statusesById = useStatusesById();
  const [storedScale, setStoredScale] = useState(() => parseScale(readStorage(SCALE_KEY)));
  const [autoPicked, setAutoPicked] = useState<Scale | null>(null);
  const [flashAssignee, setFlashAssignee] = useState<number | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const unscheduledHeadRef = useRef<HTMLButtonElement>(null);

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
  // 未排程任務可拖到時間軸排程：需 tasks.edit，且時間軸已顯示（全部未排程時只能用「排入日期」）
  const dragEnabled = canEdit && scheduled.length > 0;
  const unscheduledByAssignee = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of unscheduled)
      if (t.assigneeId != null) m.set(t.assigneeId, (m.get(t.assigneeId) ?? 0) + 1);
    return m;
  }, [unscheduled]);

  // 預設刻度：URL > localStorage（手動切換時寫入）> 自動（依首次載入的排程跨度，之後不隨資料跳動；不寫入 URL）
  if (autoPicked === null && tasksQuery.data) setAutoPicked(autoScale(scheduled, today));
  const scale: Scale = parseScale(searchParams.get('scale')) ?? storedScale ?? autoPicked ?? 'week';
  const changeScale = useCallback(
    (s: Scale) => {
      setParam('scale', s);
      setStoredScale(s);
      writeStorage(SCALE_KEY, s);
    },
    [setParam],
  );

  const setUnscheduledOpen = useCallback((open: boolean) => {
    setUnscheduledCollapsed(!open);
    writeStorage(UNSCHEDULED_KEY, open ? '0' : '1');
  }, []);

  /** 展開未排程區並聚焦其標題列（U、「查看未排程」） */
  const revealUnscheduled = useCallback(() => {
    setUnscheduledOpen(true);
    window.requestAnimationFrame(() => {
      const el = unscheduledHeadRef.current;
      el?.scrollIntoView({ block: 'nearest' });
      el?.focus({ preventScroll: true });
    });
  }, [setUnscheduledOpen]);

  /** 空分組摘要列：展開未排程區並標示該成員的列 1.5 秒 */
  const showUnscheduledOf = useCallback(
    (assigneeId: number) => {
      revealUnscheduled();
      window.clearTimeout(flashTimer.current);
      setFlashAssignee(assigneeId);
      flashTimer.current = window.setTimeout(() => setFlashAssignee(null), FLASH_MS);
      window.requestAnimationFrame(() =>
        document
          .querySelector(`.gantt-unscheduled-row[data-assignee="${assigneeId}"]`)
          ?.scrollIntoView({ block: 'nearest' }),
      );
    },
    [revealUnscheduled],
  );
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

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
    (task: Task, patch: TaskOverride) => {
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

  // 排入日期 / 拖曳排程後捲到該長條並標示 1.5 秒
  useEffect(() => {
    const id = pendingScrollId.current;
    if (id != null && scheduled.some((t) => t.id === id)) {
      pendingScrollId.current = null;
      ganttRef.current?.scrollToTask(id);
      ganttRef.current?.flashTask(id);
      if (pendingFocus.current) ganttRef.current?.focusTask(id);
      pendingFocus.current = false;
    }
  }, [scheduled]);

  /** 未排程任務拖到時間軸放下：樂觀更新 + PATCH（日期與依分組的欄位），一次放下 = 一筆復原紀錄 */
  const scheduleDrop = useCallback(
    (task: Task, target: ScheduleTarget, keyboard: boolean) => {
      const patch = schedulePatch(target);
      const title = truncate(task.title);
      const label = scheduleUndoLabel(title, target.start, target.end);
      const note = scheduleFieldNote(target);
      pendingScrollId.current = task.id;
      pendingFocus.current = keyboard;
      ganttRef.current?.expandGroup(target.groupKey);
      setSaveError(null);
      setOverrides((m) => new Map(m).set(task.id, { ...m.get(task.id), ...patch }));
      // mutateAsync：連續放下多筆時每一筆的成功 / 失敗處理都會執行（mutate 的回呼只保留最後一次）
      update
        .mutateAsync({
          id: task.id,
          ...patch,
          undo: { group: newUndoGroup('gantt'), label, before: scheduleBefore(task) },
        })
        .then(
          () =>
            toast({
              tone: 'success',
              title: `已排程『${title}』：${formatScheduleRange(target.start, target.end)}`,
              description: note ?? undefined,
              action: {
                label: '復原',
                onClick: () => {
                  if (undoManager.getSnapshot().nextUndoLabel === label) void performUndo('undo');
                },
              },
              duration: SCHEDULED_TOAST_MS,
            }),
          (err: unknown) => {
            if (pendingScrollId.current === task.id) pendingScrollId.current = null;
            setSaveError({ task, patch, message: errorMessage(err) });
          },
        )
        .finally(() =>
          setOverrides((m) => {
            const next = new Map(m);
            next.delete(task.id);
            return next;
          }),
        );
    },
    [update],
  );
  const schedDnd = useScheduleDnd({ ganttRef, onDrop: scheduleDrop });

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
            <button key={s} type="button" aria-pressed={s === scale} onClick={() => changeScale(s)}>
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

  const onPageKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === 'u' || e.key === 'U') && unscheduled.length > 0) {
      e.preventDefault();
      revealUnscheduled();
    }
  };

  return (
    <div className="gantt-page" onKeyDown={onPageKeyDown}>
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

      <ScheduleDnd dnd={schedDnd}>
        <div className="gantt-stack">
          {scheduled.length === 0 ? (
            <EmptyState
              icon="gantt"
              title="尚無已排程的任務"
              description="設定開始日與到期日後會顯示在這裡"
              action={
                <Button variant="secondary" onClick={revealUnscheduled}>
                  查看未排程（{unscheduled.length}）
                </Button>
              }
            />
          ) : (
            <Gantt
              tasks={scheduled}
              groupBy={groupBy}
              scale={scale}
              today={today}
              members={members}
              onChangeDates={changeDates}
              onRequestDates={requestDates}
              onScaleChange={changeScale}
              handleRef={ganttRef}
              unscheduledCountByAssignee={unscheduledByAssignee}
              onShowUnscheduled={showUnscheduledOf}
              scheduleDrag={schedDnd.drag}
              onScheduleTarget={schedDnd.onScheduleTarget}
            />
          )}

          {unscheduled.length > 0 && (
            <section className="gantt-unscheduled" aria-label="未排程">
              <div className="gantt-unscheduled-head">
                <button
                  ref={unscheduledHeadRef}
                  type="button"
                  className="gantt-unscheduled-toggle"
                  aria-expanded={!unscheduledCollapsed}
                  onClick={() => setUnscheduledOpen(unscheduledCollapsed)}
                >
                  <Icon name={unscheduledCollapsed ? 'chevronRight' : 'chevronDown'} size={16} />
                  未排程
                  <Badge count>{unscheduled.length}</Badge>
                </button>
                <span className="gantt-unscheduled-desc">尚未設定日期，不會出現在時間軸</span>
              </div>
              {!unscheduledCollapsed && (
                <div className="gantt-unscheduled-list">
                  {unscheduled.map((t) => {
                    const status = statusesById.get(t.statusId);
                    const name =
                      t.assigneeId == null ? '未指派' : (usersById.get(t.assigneeId)?.displayName ?? '—');
                    return (
                      <UnscheduledRow
                        key={t.id}
                        task={t}
                        tone={status ? statusTone(status) : 'todo'}
                        statusName={status?.name}
                        assigneeName={name}
                        flash={flashAssignee != null && flashAssignee === t.assigneeId}
                        draggable={dragEnabled}
                        onRequestDates={(anchor) => openPopover(t, anchor)}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </div>
      </ScheduleDnd>

      {popover && (
        <DatePopover
          key={popover.task.id}
          state={popover}
          today={today}
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
      <div className="gantt-skeleton-head" />
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="gantt-skeleton-row">
          <span>
            <Skeleton width={`${50 + ((i * 17) % 40)}%`} />
          </span>
          <Skeleton width={80 + ((i * 53) % 160)} height={24} style={{ marginLeft: 20 + ((i * 37) % 200) }} />
        </div>
      ))}
    </div>
  );
}
