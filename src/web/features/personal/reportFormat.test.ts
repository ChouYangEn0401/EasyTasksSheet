import { describe, expect, it } from 'vitest';
import type { PersonalReport, ReportTask, ReportTodo } from '../../../shared/personal.ts';
import {
  CSV_BOM,
  DEFAULT_REPORT_OPTIONS,
  EMPTY_TEXT,
  buildReportModel,
  csvCell,
  formatCsv,
  formatMarkdown,
  formatOneLine,
  formatPlain,
  formatRangeLabel,
  formatTable,
  inclusiveDays,
  presetRange,
  reportFileName,
  type ReportOptions,
} from './reportFormat.ts';

const task = (id: number, title: string, over: Partial<ReportTask> = {}): ReportTask => ({
  id,
  title,
  projectId: 1,
  projectName: '官網改版',
  projectColor: 'blue',
  statusName: '完成',
  completedDate: '2026-11-18',
  startDate: null,
  dueDate: null,
  estimateHours: null,
  priority: 'none',
  ...over,
});
const todo = (id: number, title: string, over: Partial<ReportTodo> = {}): ReportTodo => ({
  id,
  title,
  note: '',
  detail: '',
  status: 'done',
  doneDate: '2026-11-19',
  dueDate: null,
  ...over,
});
const data = (over: Partial<PersonalReport> = {}): PersonalReport => ({
  from: '2026-11-17',
  to: '2026-11-23',
  timeZone: 'Asia/Taipei',
  user: null,
  summary: { completedTaskCount: 0, completedTodoCount: 0, byProject: [] },
  completedTasks: [],
  completedTodos: [],
  ...over,
});
const flags = { showDate: true, showHours: false };
const opts = (o: Partial<ReportOptions> = {}): ReportOptions => ({ ...DEFAULT_REPORT_OPTIONS, ...o });

const sample = data({
  completedTasks: [
    task(1, '整理需求', { completedDate: '2026-11-18' }),
    task(2, '部署', { completedDate: '2026-11-17', projectId: 2, projectName: '內部工具' }),
  ],
  completedTodos: [todo(5, '訂購試劑', { note: '週五前' })],
});

describe('日期', () => {
  it('presetRange：本週 / 上週（週一至週日）', () => {
    expect(presetRange('week', '2026-11-25')).toEqual({ from: '2026-11-23', to: '2026-11-29' });
    expect(presetRange('week', '2026-11-29')).toEqual({ from: '2026-11-23', to: '2026-11-29' });
    expect(presetRange('week', '2026-11-23')).toEqual({ from: '2026-11-23', to: '2026-11-29' });
    expect(presetRange('lastWeek', '2026-11-25')).toEqual({ from: '2026-11-16', to: '2026-11-22' });
  });
  it('presetRange：近兩週 / 近三週 / 本月 / 上月 / 自訂', () => {
    expect(presetRange('twoWeeks', '2026-11-25')).toEqual({ from: '2026-11-12', to: '2026-11-25' });
    expect(presetRange('threeWeeks', '2026-11-25')).toEqual({ from: '2026-11-05', to: '2026-11-25' });
    expect(presetRange('month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(presetRange('lastMonth', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presetRange('custom', '2026-01-15')).toBeNull();
  });
  it('inclusiveDays 含頭尾、反向或格式錯誤為 0', () => {
    expect(inclusiveDays('2026-11-17', '2026-11-17')).toBe(1);
    expect(inclusiveDays('2026-11-17', '2026-11-23')).toBe(7);
    expect(inclusiveDays('2026-11-23', '2026-11-17')).toBe(0);
    expect(inclusiveDays('', '2026-11-17')).toBe(0);
  });
  it('formatRangeLabel：同年 MM/DD、單日、跨年完整', () => {
    expect(formatRangeLabel('2026-11-17', '2026-11-23')).toBe('11/17–11/23');
    expect(formatRangeLabel('2026-11-17', '2026-11-17')).toBe('11/17');
    expect(formatRangeLabel('2025-12-29', '2026-01-04')).toBe('2025/12/29–2026/01/04');
  });
});

describe('buildReportModel', () => {
  it('彙總以納入的項目重算、依專案分組並排序', () => {
    const m = buildReportModel(sample, opts());
    expect(m.summary).toBe('11/17–11/23 完成任務 2 件、待辦 1 件');
    expect(m.sections[0]!.groups.map((g) => g.name)).toEqual(['內部工具', '官網改版']);
    expect(m.empty).toBe(false);
  });
  it('排除項目後彙總與內容同步更新', () => {
    const m = buildReportModel(sample, opts(), new Set(['completedTasks:1', 'completedTodos:5']));
    expect(m.summary).toBe('11/17–11/23 完成任務 1 件、待辦 0 件');
    expect(m.sections.map((s) => s.key)).toEqual(['completedTasks']);
  });
  it('不依專案分組時為單一組、依日期排序', () => {
    const m = buildReportModel(sample, opts({ groupByProject: false }));
    expect(m.sections[0]!.groups).toHaveLength(1);
    expect(m.sections[0]!.groups[0]!.items.map((i) => i.title)).toEqual(['部署', '整理需求']);
  });
  it('空資料：empty 與空狀態文案，語氣中性', () => {
    const m = buildReportModel(data(), opts());
    expect(m.empty).toBe(true);
    for (const f of [formatPlain, formatMarkdown, formatTable, formatOneLine]) {
      const text = f(m, flags);
      expect(text).toContain(EMPTY_TEXT);
      expect(text).not.toMatch(/沒做事|零產出|績效/);
    }
  });
  it('可選區段：延後 / 取消、進行中、新建立', () => {
    const m = buildReportModel(
      data({
        deferredTodos: [todo(9, '寫文件', { status: 'deferred', doneDate: null, detail: '第一行\n第二行' })],
        inProgress: [task(3, '進行中的事', { completedDate: null })],
        createdTasks: [task(4, '新任務', { completedDate: null, createdDate: '2026-11-20' })],
      }),
      opts({ inProgress: true, deferredTodos: true, createdTasks: true }),
    );
    expect(m.sections.map((s) => s.key)).toEqual(['inProgress', 'deferredTodos', 'createdTasks']);
    expect(m.sections[1]!.groups[0]!.items[0]!.note).toBe('延後：第一行');
    // 未勾選時不輸出
    expect(buildReportModel(data({ inProgress: [task(3, 'x')] }), opts()).sections).toHaveLength(0);
  });
  it('預估工時只加總有填的', () => {
    const d = data({
      completedTasks: [
        task(1, 'a', { estimateHours: 2.5 }),
        task(2, 'b'),
        task(3, 'c', { estimateHours: 1 }),
      ],
    });
    const m = buildReportModel(d, opts());
    expect(m.hoursTotal).toBe(3.5);
    expect(m.hoursKnown).toBe(2);
    expect(buildReportModel(data({ completedTasks: [task(1, 'a')] }), opts()).hoursTotal).toBeNull();
  });
});

describe('輸出格式', () => {
  const m = buildReportModel(sample, opts());
  it('純文字條列', () => {
    expect(formatPlain(m, flags)).toBe(
      [
        '匯報報告',
        '11/17–11/23 完成任務 2 件、待辦 1 件',
        '',
        '【已完成的任務】',
        '內部工具',
        '- 11/17 部署',
        '官網改版',
        '- 11/18 整理需求',
        '',
        '【已完成的待辦】',
        '- 11/19 訂購試劑（週五前）',
      ].join('\n'),
    );
  });
  it('不顯示日期、顯示預估工時', () => {
    const mh = buildReportModel(data({ completedTasks: [task(1, '寫程式', { estimateHours: 2 })] }), opts());
    const text = formatPlain(mh, { showDate: false, showHours: true });
    expect(text).toContain('- 寫程式（預估 2 小時）');
    expect(text).toContain('預估工時合計 2 小時（1 件有填）');
    expect(formatPlain(mh, flags)).not.toContain('預估');
  });
  it('Markdown 與標題含成員名稱', () => {
    const md = formatMarkdown(
      buildReportModel({ ...sample, user: { id: 2, displayName: '王小明' } }, opts()),
      flags,
    );
    expect(md.startsWith('# 匯報報告：王小明\n')).toBe(true);
    expect(md).toContain('## 已完成的任務');
    expect(md).toContain('### 官網改版');
    expect(md).toContain('- 11/18 整理需求');
  });
  it('Markdown 表格：跳脫 | 與換行', () => {
    const d = data({ completedTasks: [task(1, 'a|b\nc', { estimateHours: 1.5 })] });
    const t = formatTable(buildReportModel(d, opts()), { showDate: true, showHours: true });
    expect(t).toContain('| 類型 | 日期 | 專案 | 項目 | 備註 | 預估工時（小時） |');
    expect(t).toContain('| 已完成的任務 | 11/18 | 官網改版 | a\\|b c |  | 1.5 |');
  });
  it('一行摘要', () => {
    expect(formatOneLine(m, flags)).toBe('11/17–11/23 完成任務 2 件、待辦 1 件：部署、整理需求、訂購試劑');
  });
  it('跨年區間日期顯示完整年份', () => {
    const d = data({
      from: '2025-12-29',
      to: '2026-01-04',
      completedTasks: [task(1, 'x', { completedDate: '2025-12-30' })],
    });
    expect(formatPlain(buildReportModel(d, opts()), flags)).toContain('- 2025/12/30 x');
  });
  it('無專案名稱時不顯示空括號', () => {
    const d = data({ completedTasks: [task(1, 'x', { projectName: '' })] });
    expect(formatPlain(buildReportModel(d, opts({ groupByProject: false })), flags)).toContain('- 11/18 x');
  });
});

describe('CSV', () => {
  it('csvCell 跳脫逗號、引號、換行與公式字元', () => {
    expect(csvCell('普通')).toBe('普通');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('他說"好"')).toBe('"他說""好"""');
    expect(csvCell('第一行\n第二行')).toBe('"第一行\n第二行"');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell('-cmd|calc')).toBe("'-cmd|calc");
    expect(csvCell('- 條列項目')).toBe("'- 條列項目");
    expect(csvCell('-3')).toBe('-3');
    expect(csvCell('-2.5')).toBe('-2.5');
    expect(csvCell(-1)).toBe('-1');
    expect(csvCell(null)).toBe('');
    expect(csvCell(2.5)).toBe('2.5');
  });
  it('formatCsv：UTF-8 BOM、CRLF、中文、特殊字元', () => {
    const d = data({
      completedTasks: [task(1, '修正 "登入", 逾時\n問題', { estimateHours: 3 })],
      completedTodos: [todo(2, '請款', { note: '含逗號,與引號"' })],
    });
    const csv = formatCsv(buildReportModel(d, opts()), { showDate: true, showHours: true });
    expect(csv.startsWith(CSV_BOM + '類型,日期,專案,項目,備註,預估工時（小時）\r\n')).toBe(true);
    expect(csv).toContain('已完成的任務,11/18,官網改版,"修正 ""登入"", 逾時\n問題",,3\r\n');
    expect(csv).toContain('已完成的待辦,11/19,,請款,"含逗號,與引號""",\r\n');
  });
  it('空資料只有標題列', () => {
    expect(formatCsv(buildReportModel(data(), opts()), flags)).toBe(
      `${CSV_BOM}類型,日期,專案,項目,備註,預估工時（小時）\r\n`,
    );
  });
});

describe('檔名', () => {
  it('含區間與成員、移除不合法字元', () => {
    expect(reportFileName('2026-11-17', '2026-11-23', 'md')).toBe('匯報報告_2026-11-17_2026-11-23.md');
    expect(reportFileName('2026-11-17', '2026-11-23', 'csv', 'A/B 小明')).toBe(
      '匯報報告_AB小明_2026-11-17_2026-11-23.csv',
    );
  });
});
