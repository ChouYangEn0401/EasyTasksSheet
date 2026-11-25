import { useState } from 'react';
import { Link } from 'react-router';
import type {
  ActivityResponse,
  MemberActivityWeek,
  MemberSummary,
  OverviewResponse,
  StatusTotal,
} from '../../../shared/overview.ts';
import type { StatusCategory } from '../../../shared/projects.ts';
import { statusStyle, statusTone } from '../../lib/colors.ts';
import { openTask } from '../../lib/openTask.ts';
import { Avatar, Badge, Button, Tooltip, UpdatedAt } from '../../ui/index.ts';
import { formatHours, shortDate } from './useOverview.ts';
import { MemberWeeks } from './WeeksActivity.tsx';

const DOING_LIMIT = 3;
const CATEGORY_LABEL: Record<StatusCategory, string> = { todo: '待辦', doing: '進行中', done: '完成' };

function listUrl(params: { assignee?: string; status?: number[] }) {
  const sp = new URLSearchParams();
  if (params.assignee) sp.set('assignee', params.assignee);
  if (params.status?.length) sp.set('status', params.status.join(','));
  const s = sp.toString();
  return `/tasks/list${s ? `?${s}` : ''}`;
}

function RemainingHours({ hours, unestimated }: { hours: number; unestimated: number }) {
  const text = <span className="ov-card-hours">未完成預估 {formatHours(hours)}</span>;
  return unestimated > 0 ? (
    <Tooltip content={`${unestimated} 筆未填預估工時`}>
      <span tabIndex={0}>{text}</span>
    </Tooltip>
  ) : (
    text
  );
}

/** 成員卡片（docs/design/gantt-overview.md §B3） */
export function MemberCard({
  member,
  statuses,
  today,
  activity,
}: {
  member: MemberSummary;
  statuses: StatusTotal[];
  today: string;
  /** 近三週（§B5）；尚未載入或失敗時不顯示 */
  activity?: { weeks: MemberActivityWeek[]; meta: ActivityResponse['weeks']; max: number };
}) {
  const [expanded, setExpanded] = useState(false);
  const { user, doing, counts, overdue, idle } = member;
  const statusById = new Map(statuses.map((s) => [s.statusId, s]));
  const idsOf = (cat: StatusCategory) => statuses.filter((s) => s.category === cat).map((s) => s.statusId);
  const shown = expanded ? doing : doing.slice(0, DOING_LIMIT);
  const rest = doing.length - shown.length;

  return (
    <article
      className={`ov-card${idle ? ' ov-card--idle' : ''}`}
      aria-label={`${user.displayName}${idle ? '（目前無任務）' : ''}`}
      data-testid={`member-card-${user.id}`}
    >
      <header className="ov-card-head">
        <Avatar user={user} size="md" tooltip={false} />
        <Link className="ov-card-name" to={listUrl({ assignee: String(user.id) })}>
          {user.displayName}
        </Link>
        {idle ? (
          <Badge tone="warning">目前無任務</Badge>
        ) : overdue > 0 ? (
          <Badge tone="danger">逾期 {overdue}</Badge>
        ) : null}
      </header>

      {idle ? (
        <p className="ov-card-empty">沒有進行中的任務</p>
      ) : (
        <ul className="ov-card-doing">
          {shown.map((t) => {
            const s = statusById.get(t.statusId);
            const tone = s ? statusTone(s) : 'doing';
            const late = !!t.dueDate && t.dueDate < today;
            return (
              <li key={t.id} className="ov-doing-row">
                <span className="ui-dot ui-dot--md ov-doing-dot" style={statusStyle(tone)} />
                <button
                  type="button"
                  className="ov-doing-title"
                  onClick={() => openTask(t.id)}
                  title={t.title}
                >
                  {t.title}
                </button>
                {t.dueDate && (
                  <span className={`ov-doing-due${late ? ' is-overdue' : ''}`}>{shortDate(t.dueDate)}</span>
                )}
                <UpdatedAt at={t.updatedAt} by={t.updatedBy} />
              </li>
            );
          })}
          {rest > 0 && (
            <li>
              <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
                + 另外 {rest} 筆
              </Button>
            </li>
          )}
        </ul>
      )}

      <p className="ov-card-counts">
        {(['todo', 'doing', 'done'] as const).map((cat, i) => (
          <span key={cat}>
            {i > 0 && <span className="ov-sep"> · </span>}
            <Link to={listUrl({ assignee: String(user.id), status: idsOf(cat) })}>
              {CATEGORY_LABEL[cat]} <strong>{counts[cat]}</strong>
            </Link>
          </span>
        ))}
      </p>

      {activity && (
        <MemberWeeks
          name={user.displayName}
          weeks={activity.weeks}
          meta={activity.meta}
          max={activity.max}
          statuses={statuses}
        />
      )}

      <footer className="ov-card-foot">
        <RemainingHours hours={member.remainingHours} unestimated={member.unestimatedCount} />
        {member.lastUpdatedAt != null && <UpdatedAt at={member.lastUpdatedAt} prefix="最近更新" />}
      </footer>
    </article>
  );
}

/** 未指派卡（虛線邊、固定排最後） */
export function UnassignedCard({ data }: { data: OverviewResponse['unassigned'] }) {
  return (
    <article className="ov-card ov-card--unassigned" aria-label="未指派" data-testid="member-card-unassigned">
      <header className="ov-card-head">
        <Avatar user={null} size="md" tooltip={false} />
        <span className="ov-card-name">未指派</span>
      </header>
      <p className="ov-card-empty">{data.openCount} 筆未完成任務尚未指派</p>
      <footer className="ov-card-foot">
        <RemainingHours hours={data.remainingHours} unestimated={data.unestimatedCount} />
        <Link to="/tasks/list?assignee=none" className="ov-link">
          前往指派 →
        </Link>
      </footer>
    </article>
  );
}
