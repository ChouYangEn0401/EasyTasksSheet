import {
  PERSONAL_STATUS_LABEL,
  type PersonalReport,
  type ReportTask,
  type ReportTodo,
} from '../../../shared/personal.ts';
import { toDateString } from '../../lib/format.ts';

/*
 * 個人頁「匯報報告」的純函式：日期區間、依專案分組、各輸出格式、CSV 跳脫、空狀態文案。
 * 不碰 DOM / 網路，方便單元測試（reportFormat.test.ts）。語氣中性：報告是讓人整理自己做了什麼。
 */

export const EMPTY_TEXT = '這段期間沒有紀錄';
export const REPORT_TITLE = '匯報報告';

/* ── 日期 ─────────────────────── */

export { toDateString };

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

export function addDays(date: string, n: number): string {
  const d = parseDate(date);
  d.setDate(d.getDate() + n);
  return toDateString(d);
}

/** 兩個 YYYY-MM-DD 之間的天數（含頭尾），反向或格式錯誤回 0 */
export function inclusiveDays(from: string, to: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 0;
  const diff = Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000);
  return diff < 0 ? 0 : diff + 1;
}

export type RangePreset = 'week' | 'lastWeek' | 'twoWeeks' | 'threeWeeks' | 'month' | 'lastMonth' | 'custom';

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'week', label: '本週' },
  { value: 'lastWeek', label: '上週' },
  { value: 'twoWeeks', label: '近兩週' },
  { value: 'threeWeeks', label: '近三週' },
  { value: 'month', label: '本月' },
  { value: 'lastMonth', label: '上月' },
  { value: 'custom', label: '自訂' },
];

/**
 * 快速區間（以 today 為準）：本週 / 上週為週一至週日；近兩週 / 近三週為含今天往前 14 / 21 天；
 * 本月為當月 1 日至月底，上月同理。custom 回 null（由使用者自填）。
 */
export function presetRange(preset: RangePreset, today: string): { from: string; to: string } | null {
  const t = parseDate(today);
  const monday = addDays(today, -((t.getDay() + 6) % 7));
  switch (preset) {
    case 'week':
      return { from: monday, to: addDays(monday, 6) };
    case 'lastWeek':
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case 'twoWeeks':
      return { from: addDays(today, -13), to: today };
    case 'threeWeeks':
      return { from: addDays(today, -20), to: today };
    case 'month':
      return {
        from: toDateString(new Date(t.getFullYear(), t.getMonth(), 1)),
        to: toDateString(new Date(t.getFullYear(), t.getMonth() + 1, 0)),
      };
    case 'lastMonth':
      return {
        from: toDateString(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
        to: toDateString(new Date(t.getFullYear(), t.getMonth(), 0)),
      };
    default:
      return null;
  }
}

/** 單日顯示：同年 MM/DD、跨年 YYYY/MM/DD */
export function formatReportDate(date: string, refYear?: number): string {
  const [y, m, d] = date.split('-');
  if (!y || !m || !d) return date;
  return refYear != null && Number(y) === refYear ? `${m}/${d}` : `${y}/${m}/${d}`;
}

/** 區間顯示：11/17–11/23；單日 11/17；跨年 2025/12/29–2026/01/04 */
export function formatRangeLabel(from: string, to: string): string {
  const fy = Number(from.slice(0, 4));
  const ty = Number(to.slice(0, 4));
  if (from === to) return formatReportDate(from, fy === ty ? fy : undefined);
  if (fy === ty) return `${formatReportDate(from, fy)}–${formatReportDate(to, fy)}`;
  return `${formatReportDate(from)}–${formatReportDate(to)}`;
}

function formatHours(h: number): string {
  return `${Math.round(h * 100) / 100}`;
}

/* ── 模型 ─────────────────────── */

export type ReportOptions = {
  completedTasks: boolean;
  completedTodos: boolean;
  inProgress: boolean;
  deferredTodos: boolean;
  createdTasks: boolean;
  groupByProject: boolean;
  showHours: boolean;
  showDate: boolean;
};

export const DEFAULT_REPORT_OPTIONS: ReportOptions = {
  completedTasks: true,
  completedTodos: true,
  inProgress: false,
  deferredTodos: false,
  createdTasks: false,
  groupByProject: true,
  showHours: false,
  showDate: true,
};

export type ReportItem = {
  /** 區段:id，供「取消勾選」排除 */
  key: string;
  /** 顯示用日期（YYYY-MM-DD），無則 null */
  date: string | null;
  title: string;
  projectName: string | null;
  projectColor: string | null;
  hours: number | null;
  /** 補充（待辦備註、延後 / 取消標示） */
  note: string;
};

export type ReportGroup = { name: string | null; color: string | null; items: ReportItem[] };
export type SectionKey =
  'completedTasks' | 'completedTodos' | 'inProgress' | 'deferredTodos' | 'createdTasks';
export type ReportSection = { key: SectionKey; heading: string; groups: ReportGroup[]; count: number };

export type ReportModel = {
  title: string;
  /** 例：11/17–11/23 */
  rangeLabel: string;
  memberName: string | null;
  /** 同年區間的日期顯示為 MM/DD；跨年區間為 undefined（顯示完整年份） */
  year: number | undefined;
  /** 彙總一句話，例：11/17–11/23 完成任務 5 件、待辦 3 件 */
  summary: string;
  sections: ReportSection[];
  /** 納入且未排除的項目數為 0 */
  empty: boolean;
  taskCount: number;
  todoCount: number;
  hoursTotal: number | null;
  hoursKnown: number;
};

export const SECTION_HEADING: Record<SectionKey, string> = {
  completedTasks: '已完成的任務',
  completedTodos: '已完成的待辦',
  inProgress: '進行中的任務',
  deferredTodos: '延後／取消的待辦',
  createdTasks: '期間新建立的任務',
};

const collator = new Intl.Collator('zh-Hant');

function todoNote(t: ReportTodo): string {
  if (t.note.trim()) return t.note.trim();
  const first = t.detail.split(/\r?\n/).find((l) => l.trim());
  if (!first) return '';
  const s = first.trim();
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

const taskItem = (sec: SectionKey, t: ReportTask, date: string | null): ReportItem => ({
  key: `${sec}:${t.id}`,
  date,
  title: t.title,
  projectName: t.projectName,
  projectColor: t.projectColor,
  hours: t.estimateHours,
  note: '',
});

const todoItem = (sec: SectionKey, t: ReportTodo, date: string | null, tag?: string): ReportItem => {
  const note = todoNote(t);
  return {
    key: `${sec}:${t.id}`,
    date,
    title: t.title,
    projectName: null,
    projectColor: null,
    hours: null,
    note: [tag, note].filter(Boolean).join('：'),
  };
};

/** 同一組內依日期（無日期在後）→ 標題排序；穩定 */
function sortItems(items: ReportItem[]): ReportItem[] {
  return [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date == null ? 1 : b.date == null ? -1 : a.date < b.date ? -1 : 1;
    return collator.compare(a.title, b.title);
  });
}

function group(items: ReportItem[], byProject: boolean): ReportGroup[] {
  if (items.length === 0) return [];
  if (!byProject) return [{ name: null, color: null, items: sortItems(items) }];
  const map = new Map<string, ReportGroup>();
  for (const it of items) {
    const name = it.projectName ?? '';
    let g = map.get(name);
    if (!g) {
      g = { name: it.projectName, color: it.projectColor, items: [] };
      map.set(name, g);
    }
    g.items.push(it);
  }
  return [...map.values()]
    .map((g) => ({ ...g, items: sortItems(g.items) }))
    .sort((a, b) => {
      // 無專案（待辦）排最後
      if ((a.name == null) !== (b.name == null)) return a.name == null ? 1 : -1;
      return collator.compare(a.name ?? '', b.name ?? '');
    });
}

export function summaryLine(
  rangeLabel: string,
  tasks: number,
  todos: number,
  includeTasks = true,
  includeTodos = true,
): string {
  const parts: string[] = [];
  if (includeTasks) parts.push(`完成任務 ${tasks} 件`);
  if (includeTodos) parts.push(`${includeTasks ? '' : '完成'}待辦 ${todos} 件`);
  if (parts.length === 0) return `${rangeLabel} 沒有選取要納入的內容`;
  return `${rangeLabel} ${parts.join('、')}`;
}

/** 由後端回傳資料 + 選項 + 使用者排除的項目，建立報告模型（彙總以實際納入的項目重算） */
export function buildReportModel(
  data: PersonalReport,
  opts: ReportOptions,
  excluded: ReadonlySet<string> = new Set(),
): ReportModel {
  const keep = (it: ReportItem) => !excluded.has(it.key);
  const rangeLabel = formatRangeLabel(data.from, data.to);
  const sections: ReportSection[] = [];
  const add = (key: SectionKey, items: ReportItem[], byProject: boolean) => {
    const kept = items.filter(keep);
    sections.push({ key, heading: SECTION_HEADING[key], groups: group(kept, byProject), count: kept.length });
  };

  if (opts.completedTasks)
    add(
      'completedTasks',
      data.completedTasks.map((t) => taskItem('completedTasks', t, t.completedDate)),
      opts.groupByProject,
    );
  if (opts.completedTodos)
    add(
      'completedTodos',
      data.completedTodos.map((t) => todoItem('completedTodos', t, t.doneDate)),
      false,
    );
  if (opts.inProgress && data.inProgress)
    add(
      'inProgress',
      data.inProgress.map((t) => taskItem('inProgress', t, null)),
      opts.groupByProject,
    );
  if (opts.deferredTodos && data.deferredTodos)
    add(
      'deferredTodos',
      data.deferredTodos.map((t) => todoItem('deferredTodos', t, null, PERSONAL_STATUS_LABEL[t.status])),
      false,
    );
  if (opts.createdTasks && data.createdTasks)
    add(
      'createdTasks',
      data.createdTasks.map((t) => taskItem('createdTasks', t, t.createdDate ?? null)),
      opts.groupByProject,
    );

  const nonEmpty = sections.filter((s) => s.count > 0);
  const count = (key: SectionKey) => sections.find((s) => s.key === key)?.count ?? 0;
  const doneTasks = sections.find((s) => s.key === 'completedTasks')?.groups.flatMap((g) => g.items) ?? [];
  const known = doneTasks.filter((i) => i.hours != null);
  return {
    title: REPORT_TITLE,
    rangeLabel,
    memberName: data.user?.displayName ?? null,
    year: data.from.slice(0, 4) === data.to.slice(0, 4) ? Number(data.from.slice(0, 4)) : undefined,
    summary: summaryLine(
      rangeLabel,
      count('completedTasks'),
      count('completedTodos'),
      opts.completedTasks,
      opts.completedTodos,
    ),
    sections: nonEmpty,
    empty: nonEmpty.length === 0,
    taskCount: count('completedTasks'),
    todoCount: count('completedTodos'),
    hoursTotal: known.length > 0 ? known.reduce((s, i) => s + (i.hours ?? 0), 0) : null,
    hoursKnown: known.length,
  };
}

/* ── 輸出格式 ─────────────────────── */

export type ReportFormat = 'plain' | 'markdown' | 'table' | 'oneline';

export const REPORT_FORMATS: { value: ReportFormat; label: string }[] = [
  { value: 'plain', label: '純文字條列' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'table', label: 'Markdown 表格' },
  { value: 'oneline', label: '一行摘要' },
];

export type FormatFlags = { showDate: boolean; showHours: boolean };

function lineOf(it: ReportItem, flags: FormatFlags, year: number | undefined, showProject: boolean): string {
  const head = flags.showDate && it.date ? `${formatReportDate(it.date, year)} ` : '';
  const bits: string[] = [];
  if (showProject && it.projectName) bits.push(it.projectName);
  if (it.note) bits.push(it.note);
  if (flags.showHours && it.hours != null) bits.push(`預估 ${formatHours(it.hours)} 小時`);
  return `${head}${it.title}${bits.length ? `（${bits.join('，')}）` : ''}`;
}

function titleLine(model: ReportModel): string {
  return model.memberName ? `${model.title}：${model.memberName}` : model.title;
}

function hoursLine(model: ReportModel, flags: FormatFlags): string | null {
  if (!flags.showHours || model.hoursTotal == null) return null;
  return `預估工時合計 ${formatHours(model.hoursTotal)} 小時（${model.hoursKnown} 件有填）`;
}

export function formatPlain(model: ReportModel, flags: FormatFlags): string {
  const year = model.year;
  const out: string[] = [titleLine(model), model.summary];
  const hours = hoursLine(model, flags);
  if (hours) out.push(hours);
  if (model.empty) {
    out.push('', EMPTY_TEXT);
    return out.join('\n');
  }
  for (const s of model.sections) {
    out.push('', `【${s.heading}】`);
    for (const g of s.groups) {
      if (g.name) out.push(g.name);
      for (const it of g.items) out.push(`- ${lineOf(it, flags, year, !g.name)}`);
    }
  }
  return out.join('\n');
}

export function formatMarkdown(model: ReportModel, flags: FormatFlags): string {
  const year = model.year;
  const out: string[] = [`# ${titleLine(model)}`, '', model.summary];
  const hours = hoursLine(model, flags);
  if (hours) out.push('', hours);
  if (model.empty) {
    out.push('', EMPTY_TEXT);
    return out.join('\n');
  }
  for (const s of model.sections) {
    out.push('', `## ${s.heading}`);
    for (const g of s.groups) {
      if (g.name) out.push('', `### ${g.name}`, '');
      else out.push('');
      for (const it of g.items) out.push(`- ${lineOf(it, flags, year, !g.name)}`);
    }
  }
  return out.join('\n');
}

const mdCell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function formatTable(model: ReportModel, flags: FormatFlags): string {
  const year = model.year;
  const out: string[] = [`# ${titleLine(model)}`, '', model.summary];
  if (model.empty) {
    out.push('', EMPTY_TEXT);
    return out.join('\n');
  }
  const cols = [
    '類型',
    ...(flags.showDate ? ['日期'] : []),
    '專案',
    '項目',
    '備註',
    ...(flags.showHours ? ['預估工時（小時）'] : []),
  ];
  out.push('', `| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`);
  for (const s of model.sections) {
    for (const g of s.groups) {
      for (const it of g.items) {
        const cells = [
          s.heading,
          ...(flags.showDate ? [it.date ? formatReportDate(it.date, year) : ''] : []),
          it.projectName ?? '',
          it.title,
          it.note,
          ...(flags.showHours ? [it.hours != null ? formatHours(it.hours) : ''] : []),
        ];
        out.push(`| ${cells.map(mdCell).join(' | ')} |`);
      }
    }
  }
  return out.join('\n');
}

export function formatOneLine(model: ReportModel, flags: FormatFlags): string {
  const who = model.memberName ? `${model.memberName} ` : '';
  if (model.empty) return `${who}${model.rangeLabel}：${EMPTY_TEXT}`;
  const done = model.sections
    .filter((s) => s.key === 'completedTasks' || s.key === 'completedTodos')
    .flatMap((s) => s.groups.flatMap((g) => g.items));
  const titles = done.map((i) => i.title).join('、');
  const hours = hoursLine(model, flags);
  return `${who}${model.summary}${titles ? `：${titles}` : ''}${hours ? `（${hours}）` : ''}`;
}

export function formatReport(model: ReportModel, format: ReportFormat, flags: FormatFlags): string {
  switch (format) {
    case 'markdown':
      return formatMarkdown(model, flags);
    case 'table':
      return formatTable(model, flags);
    case 'oneline':
      return formatOneLine(model, flags);
    default:
      return formatPlain(model, flags);
  }
}

/* ── CSV ─────────────────────── */

/** RFC 4180 跳脫；開頭為 = + @ 的文字，或 - 開頭但不是純數字（例如 -1+2、-A1）加前綴避免 Excel 當成公式 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value == null ? '' : String(value);
  if (/^[=+@\t\r]/.test(s) || (s.startsWith('-') && !/^-\d+(\.\d+)?$/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_BOM = '﻿';

/** CSV：UTF-8 BOM + CRLF，讓 Excel 正確顯示中文 */
export function formatCsv(model: ReportModel, flags: FormatFlags): string {
  const year = model.year;
  const header = ['類型', '日期', '專案', '項目', '備註', '預估工時（小時）'];
  const rows = [header.map(csvCell).join(',')];
  for (const s of model.sections) {
    for (const g of s.groups) {
      for (const it of g.items) {
        rows.push(
          [
            s.heading,
            flags.showDate && it.date ? formatReportDate(it.date, year) : '',
            it.projectName ?? '',
            it.title,
            it.note,
            flags.showHours && it.hours != null ? formatHours(it.hours) : '',
          ]
            .map(csvCell)
            .join(','),
        );
      }
    }
  }
  return CSV_BOM + rows.join('\r\n') + '\r\n';
}

/** 下載檔名：匯報報告_2026-11-17_2026-11-23（成員名稱可選） */
export function reportFileName(from: string, to: string, ext: string, member?: string | null): string {
  const who = member ? `_${member.replace(/[\\/:*?"<>|\s]+/g, '')}` : '';
  return `${REPORT_TITLE}${who}_${from}_${to}.${ext}`;
}
