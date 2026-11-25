import { useId, useState } from 'react';
import type {
  ActivityResponse,
  ActivityWeekStats,
  MemberActivityWeek,
  StatusTotal,
} from '../../../shared/overview.ts';
import { statusStyle, statusTone } from '../../lib/colors.ts';
import { openTask } from '../../lib/openTask.ts';
import { Icon, Tooltip } from '../../ui/index.ts';
import {
  barHeights,
  countsText,
  describeWeek,
  hoursText,
  shortDay,
  sumWeeks,
  weekLabel,
} from './activity.ts';
import { formatWeekRange } from './useOverview.ts';

type WeekMeta = ActivityResponse['weeks'][number];

/** 三個小直條（由舊到新；本週深一階；沒有紀錄畫淡灰虛線） */
export function MiniBars({
  weeks,
  meta,
  max,
}: {
  weeks: readonly ActivityWeekStats[];
  meta: readonly WeekMeta[];
  max: number;
}) {
  const heights = barHeights(
    weeks.map((w) => w.involved),
    max,
  );
  return (
    <span className="ov-bars" aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={meta[i]?.start ?? i}
          className={`ov-bar${meta[i]?.current ? ' is-current' : ''}${h === 0 ? ' is-empty' : ''}`}
          style={h > 0 ? { height: `${h}%` } : undefined}
        />
      ))}
    </span>
  );
}

/** 成員卡片內的「近三週」：迷你直條 + 小字；點擊在卡片下方展開各週任務清單 */
export function MemberWeeks({
  name,
  weeks,
  meta,
  max,
  statuses,
}: {
  name: string;
  weeks: MemberActivityWeek[];
  meta: WeekMeta[];
  max: number;
  statuses: StatusTotal[];
}) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(weeks.length - 1);
  const panelId = useId();
  const labels = weeks.map((_, i) => weekLabel(i, weeks.length));
  const lines = weeks.map((w, i) => describeWeek(labels[i]!, w));

  return (
    <div className="ov-weeks">
      <Tooltip
        content={
          <span className="ov-weeks-tip">
            {lines.map((l) => (
              <span key={l}>{l}</span>
            ))}
          </span>
        }
      >
        <button
          type="button"
          className="ov-weeks-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`近三週：${lines.join('；')}。${open ? '收合' : '展開'}詳情`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="ov-weeks-label">近三週</span>
          <MiniBars weeks={weeks} meta={meta} max={max} />
          <span className="ov-weeks-text">{countsText(sumWeeks(weeks))}</span>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="ov-weeks-chevron" />
        </button>
      </Tooltip>
      {open && (
        <div className="ov-weeks-panel" id={panelId} role="region" aria-label={`${name} 近三週的任務`}>
          <div className="ov-weeks-seg" role="group" aria-label="選擇週">
            {weeks.map((_, i) => (
              <button
                key={meta[i]?.start ?? i}
                type="button"
                className="ov-weeks-seg-btn"
                aria-pressed={sel === i}
                onClick={() => setSel(i)}
              >
                {labels[i]}
              </button>
            ))}
          </div>
          <WeekDetail week={weeks[sel]!} meta={meta[sel]} statuses={statuses} />
        </div>
      )}
    </div>
  );
}

function WeekDetail({
  week,
  meta,
  statuses,
}: {
  week: MemberActivityWeek;
  meta: WeekMeta | undefined;
  statuses: StatusTotal[];
}) {
  const statusById = new Map(statuses.map((s) => [s.statusId, s]));
  const hours = hoursText(week);
  const rest = week.itemsTotal - week.items.length;
  return (
    <div className="ov-week-detail">
      <p className="ov-week-meta">
        {meta && <span>{formatWeekRange(meta)}</span>}
        {week.involved > 0 && (
          <span>
            完成 {week.completed} 件・處理 {week.touched} 件
          </span>
        )}
      </p>
      {hours && <p className="ov-week-hours">{hours}</p>}
      {week.items.length === 0 ? (
        <p className="ov-week-empty">這週沒有紀錄</p>
      ) : (
        <ul className="ov-week-items">
          {week.items.map((t) => {
            const s = statusById.get(t.statusId);
            return (
              <li key={t.id} className="ov-week-item">
                <span
                  className="ui-dot ui-dot--md ov-doing-dot"
                  style={statusStyle(s ? statusTone(s) : 'todo')}
                  title={s?.name}
                />
                <button
                  type="button"
                  className="ov-doing-title"
                  onClick={() => openTask(t.id)}
                  title={t.title}
                >
                  {t.title}
                </button>
                <span className="ov-week-tag">{t.completed ? '完成' : '處理'}</span>
                <span className="ov-week-date">{shortDay(t.at)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {rest > 0 && <p className="ov-week-note">另有 {rest} 件未列出</p>}
      {meta?.touchedPartial && <p className="ov-week-note">較早的處理紀錄已不保留，件數可能偏少</p>}
    </div>
  );
}

/** 統計列下方的全隊合計（中性呈現，不分人） */
export function TeamWeeks({ data }: { data: ActivityResponse }) {
  const { weeks, teamWeeks } = data;
  const max = Math.max(0, ...teamWeeks.map((w) => w.involved));
  return (
    <section className="ov-team-weeks" aria-labelledby="ov-team-weeks-title" data-testid="team-weeks">
      <div className="ov-team-weeks-head">
        <h2 className="ov-team-weeks-title" id="ov-team-weeks-title">
          近三週團隊進展
        </h2>
        <span className="ov-stat-hint">大約的數字，方便了解大家在忙什麼</span>
      </div>
      <div className="ov-team-weeks-body">
        <MiniBars weeks={teamWeeks} meta={weeks} max={max} />
        <ul className="ov-team-weeks-list">
          {teamWeeks.map((w, i) => {
            const meta = weeks[i]!;
            const hours = hoursText(w);
            return (
              <li key={meta.start} className="ov-team-week">
                <span className="ov-team-week-label">
                  {weekLabel(i, teamWeeks.length)}
                  <span className="ov-stat-hint"> {formatWeekRange(meta)}</span>
                </span>
                <span className="ov-team-week-value">
                  {w.involved === 0 ? '沒有紀錄' : `完成 ${w.completed} 件・處理 ${w.touched} 件`}
                </span>
                {hours && <span className="ov-stat-hint">{hours}</span>}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
