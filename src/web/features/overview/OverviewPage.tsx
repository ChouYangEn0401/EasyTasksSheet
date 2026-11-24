import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { OverviewResponse } from '../../../shared/overview.ts';
import { statusStyle, statusTone } from '../../lib/colors.ts';
import { todayString } from '../../lib/format.ts';
import { useStatusesById, useTasks } from '../../lib/hooks.ts';
import { Alert, EmptyState, ErrorState, Skeleton } from '../../ui/index.ts';
import { Gantt } from '../gantt/Gantt.tsx';
import { isScheduled } from '../gantt/timeline.ts';
import { MemberCard, UnassignedCard } from './MemberCard.tsx';
import { formatWeekRange, useOverview } from './useOverview.ts';
import './overview.css';

const IDLE_SECTION_ID = 'overview-idle';

/** 總覽主畫面（/）：統計列、成員卡片（目前無任務者在前）、精簡甘特圖 */
export function OverviewPage() {
  const overview = useOverview();

  return (
    <div className="ov-page">
      {overview.isPending ? (
        <OverviewSkeleton />
      ) : overview.isError && !overview.data ? (
        <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
      ) : (
        <OverviewBody data={overview.data!} />
      )}
      <CompactGantt members={overview.data?.members} />
    </div>
  );
}

function OverviewBody({ data }: { data: OverviewResponse }) {
  const { totals, members, unassigned, today } = data;
  const idle = members.filter((m) => m.idle);
  const busy = members.filter((m) => !m.idle);
  const totalTasks = totals.byStatus.reduce((n, s) => n + s.count, 0);

  return (
    <>
      <StatsRow data={data} />
      {totalTasks === 0 ? (
        <EmptyState title="還沒有任務" description="按 N 快速新增任務" />
      ) : (
        <>
          <section className="ov-section" id={IDLE_SECTION_ID} aria-labelledby="ov-idle-title" tabIndex={-1}>
            {idle.length > 0 ? (
              <>
                <h2 className="ov-section-title" id="ov-idle-title">
                  目前無任務<span className="ov-section-count">（{idle.length}）</span>
                </h2>
                <div className="ov-grid">
                  {idle.map((m) => (
                    <MemberCard key={m.user.id} member={m} statuses={totals.byStatus} today={today} />
                  ))}
                </div>
              </>
            ) : (
              <>
                <h2 className="sr-only" id="ov-idle-title">
                  目前無任務
                </h2>
                <Alert tone="success">所有成員都有進行中的任務</Alert>
              </>
            )}
          </section>
          <section className="ov-section" aria-labelledby="ov-busy-title">
            <h2 className="ov-section-title" id="ov-busy-title">
              進行中<span className="ov-section-count">（{busy.length}）</span>
            </h2>
            <div className="ov-grid">
              {busy.map((m) => (
                <MemberCard key={m.user.id} member={m} statuses={totals.byStatus} today={today} />
              ))}
              {unassigned.openCount > 0 && <UnassignedCard data={unassigned} />}
            </div>
          </section>
        </>
      )}
    </>
  );
}

function StatsRow({ data }: { data: OverviewResponse }) {
  const { totals, weekRange } = data;
  const total = totals.byStatus.reduce((n, s) => n + s.count, 0);
  const idleCount = totals.idleMembers;

  return (
    <div className="ov-stats">
      <button
        type="button"
        className={`ov-stat ov-stat--button${idleCount > 0 ? ' ov-stat--warning' : ''}`}
        data-testid="stat-idle"
        onClick={() => {
          const el = document.getElementById(IDLE_SECTION_ID);
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          el?.focus({ preventScroll: true });
        }}
      >
        <span className="ov-stat-label">目前無任務</span>
        <span className="ov-stat-value">{idleCount} 人</span>
        <span className="ov-stat-hint">
          {idleCount > 0 ? `共 ${totals.activeMembers} 位成員` : '所有成員都有進行中的任務'}
        </span>
      </button>
      <div className="ov-stat" data-testid="stat-overdue">
        <span className="ov-stat-label">逾期</span>
        <span className={`ov-stat-value${totals.overdue > 0 ? ' is-danger' : ''}`}>{totals.overdue} 筆</span>
        <Link to="/tasks/list" className="ov-stat-hint ov-link">
          查看 →
        </Link>
      </div>
      <div className="ov-stat" data-testid="stat-done-week">
        <span className="ov-stat-label">本週完成</span>
        <span className="ov-stat-value">{totals.doneThisWeek} 筆</span>
        <span className="ov-stat-hint">{formatWeekRange(weekRange)}</span>
      </div>
      <div className="ov-stat ov-stat--wide" data-testid="stat-status">
        <span className="ov-stat-label">狀態分佈</span>
        <div
          className="ov-dist"
          role="img"
          aria-label={totals.byStatus.map((s) => `${s.name} ${s.count}`).join('、')}
        >
          {total === 0 ? (
            <span className="ov-dist-empty" />
          ) : (
            totals.byStatus
              .filter((s) => s.count > 0)
              .map((s) => (
                <span
                  key={s.statusId}
                  className="ov-dist-seg"
                  style={{ flexGrow: s.count, ...statusStyle(statusTone(s)) }}
                />
              ))
          )}
        </div>
        <div className="ov-legend">
          {totals.byStatus.map((s) => (
            <Link key={s.statusId} to={`/tasks/list?status=${s.statusId}`} className="ov-legend-item">
              <span className="ui-dot ui-dot--md ov-doing-dot" style={statusStyle(statusTone(s))} />
              {s.name} <strong>{s.count}</strong>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 精簡版甘特圖：負責人分組、週刻度、唯讀，只顯示未完成且已排程的任務 */
function CompactGantt({ members }: { members: OverviewResponse['members'] | undefined }) {
  const tasks = useTasks();
  const statusesById = useStatusesById();
  const [today] = useState(() => todayString());
  const open = useMemo(
    () =>
      (tasks.data ?? []).filter((t) => isScheduled(t) && statusesById.get(t.statusId)?.category !== 'done'),
    [tasks.data, statusesById],
  );
  const order = useMemo(
    () => (members ?? []).map((m) => ({ id: m.user.id, displayName: m.user.displayName })),
    [members],
  );

  return (
    <section className="ov-section" aria-labelledby="ov-gantt-title">
      <div className="ov-section-head">
        <h2 className="ov-section-title" id="ov-gantt-title">
          甘特圖進度
        </h2>
        <Link to="/tasks/gantt?group=assignee" className="ov-link">
          開啟完整 Gantt →
        </Link>
      </div>
      {tasks.isPending || !members ? (
        <div className="ov-gantt-skeleton">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={14} width={`${40 + ((i * 23) % 50)}%`} />
          ))}
        </div>
      ) : tasks.isError && !tasks.data ? (
        <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />
      ) : (
        <Gantt
          compact
          tasks={open}
          groupBy="assignee"
          scale="week"
          today={today}
          members={order}
          ariaLabel="甘特圖進度（精簡）"
        />
      )}
    </section>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <div className="ov-stats" aria-busy="true" aria-label="載入中">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`ov-stat${i === 3 ? ' ov-stat--wide' : ''}`}>
            <Skeleton width={64} />
            <Skeleton width={48} height={24} />
            <Skeleton width={80} />
          </div>
        ))}
      </div>
      <div className="ov-grid">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="ov-card">
            <Skeleton width="50%" height={16} />
            <Skeleton width="90%" />
            <Skeleton width="70%" />
            <Skeleton width="60%" />
          </div>
        ))}
      </div>
    </>
  );
}
