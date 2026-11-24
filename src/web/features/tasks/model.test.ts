import { describe, expect, it } from 'vitest';
import type { Project, Status } from '../../../shared/projects.ts';
import type { PropertyDef } from '../../../shared/properties.ts';
import type { Task } from '../../../shared/tasks.ts';
import { emptyFilters } from '../../lib/filters.ts';
import {
  allColumns,
  applicableProperties,
  applyPatch,
  checkDateRange,
  checkOptions,
  checkPropertyName,
  countOptionUsage,
  cycleSort,
  formatShortDate,
  getValue,
  groupDefaults,
  groupTasks,
  isApplicable,
  matchesFilters,
  newOptionId,
  parseGroup,
  parseHidden,
  parseNumber,
  parseSort,
  parseTitle,
  parseUrl,
  propertyColumn,
  sortTasks,
  toggleDoneStatus,
  toPatch,
  visibleColumns,
  type Lookups,
} from './model.ts';

const T0 = Date.UTC(2026, 10, 24);

function task(p: Partial<Task> & { id: number }): Task {
  return {
    projectId: 1,
    title: `任務 ${p.id}`,
    description: '',
    statusId: 1,
    assigneeId: null,
    priority: 'none',
    startDate: null,
    dueDate: null,
    estimateHours: null,
    progress: 0,
    sortOrder: p.id,
    custom: {},
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...p,
  };
}

const status = (id: number, name: string, category: Status['category'], sortOrder = id): Status => ({
  id,
  name,
  color: 'gray',
  category,
  sortOrder,
  createdAt: T0,
  updatedAt: T0,
});
const STATUSES = [
  status(1, '待辦', 'todo'),
  status(2, '進行中', 'doing'),
  status(3, '審查中', 'doing'),
  status(4, '完成', 'done'),
];

const prop = (p: Partial<PropertyDef> & { id: number }): PropertyDef => ({
  projectId: null,
  name: `欄位${p.id}`,
  type: 'text',
  options: [],
  sortOrder: p.id,
  createdAt: T0,
  updatedAt: T0,
  ...p,
});

const project = (id: number, sortOrder: number): Project => ({
  id,
  name: `專案${id}`,
  color: 'blue',
  isArchived: false,
  sortOrder,
  createdAt: T0,
  updatedAt: T0,
});

const lookups: Lookups = {
  statuses: new Map(STATUSES.map((s) => [s.id, s])),
  users: new Map([
    [1, { id: 1, displayName: 'Bob' }],
    [2, { id: 2, displayName: 'Alice' }],
  ]),
  projects: new Map([
    [1, project(1, 2)],
    [2, project(2, 1)],
  ]),
};

describe('輸入驗證', () => {
  it('標題：去除空白、換行轉空白、空白與超長回錯誤', () => {
    expect(parseTitle('  a\nb ')).toEqual({ ok: true, value: 'a b' });
    expect(parseTitle('   ').ok).toBe(false);
    expect(parseTitle('x'.repeat(501))).toEqual({ ok: false, error: '標題不可超過 500 字' });
  });

  it('數字：空白為清除，非數字回錯誤；工時限 ≥ 0 與 0.5 級距', () => {
    expect(parseNumber('')).toEqual({ ok: true, value: null });
    expect(parseNumber('3.25')).toEqual({ ok: true, value: 3.25 });
    expect(parseNumber('abc')).toEqual({ ok: false, error: '請輸入數字' });
    expect(parseNumber('1,000')).toEqual({ ok: true, value: 1000 });
    expect(parseNumber('2.5', { estimate: true })).toEqual({ ok: true, value: 2.5 });
    expect(parseNumber('-1', { estimate: true }).ok).toBe(false);
    expect(parseNumber('1.3', { estimate: true }).ok).toBe(false);
  });

  it('網址：需為 http(s)', () => {
    expect(parseUrl('https://example.com/a')).toEqual({ ok: true, value: 'https://example.com/a' });
    expect(parseUrl('')).toEqual({ ok: true, value: null });
    expect(parseUrl('example')).toEqual({ ok: false, error: '請輸入有效網址' });
    expect(parseUrl('javascript:alert(1)').ok).toBe(false);
  });

  it('到期日不可早於開始日', () => {
    expect(checkDateRange('2026-11-20', '2026-11-19')).toBe('到期日不可早於開始日');
    expect(checkDateRange('2026-11-20', '2026-11-20')).toBeNull();
    expect(checkDateRange(null, '2026-11-01')).toBeNull();
  });

  it('欄位名稱：空白、與內建或既有欄位重複', () => {
    const others = [{ id: 1, name: '實驗批次' }];
    expect(checkPropertyName(' ', others)).toBe('請輸入名稱');
    expect(checkPropertyName('實驗批次', others)).toBe('已有同名欄位');
    expect(checkPropertyName('實驗批次', others, 1)).toBeNull();
    expect(checkPropertyName('狀態', others)).toBe('已有同名欄位');
    expect(checkPropertyName('樣本', others)).toBeNull();
  });

  it('選項：至少一個非空、不可重複', () => {
    expect(checkOptions([{ label: '' }])).toBe('至少需要一個選項');
    expect(checkOptions([{ label: 'A' }, { label: 'A ' }])).toBe('選項名稱不可重複');
    expect(checkOptions([{ label: 'A' }, { label: '' }])).toBeNull();
    expect(newOptionId([{ id: 'o1' }, { id: 'o3' }])).toBe('o4');
  });
});

describe('顯示', () => {
  it('日期：同年 MM/DD，跨年 YYYY/MM/DD', () => {
    const now = new Date(2026, 10, 24).getTime();
    expect(formatShortDate('2026-11-28', now)).toBe('11/28');
    expect(formatShortDate('2027-01-02', now)).toBe('2027/01/02');
    expect(formatShortDate(null, now)).toBe('');
  });
});

describe('欄位與讀寫', () => {
  const props = [prop({ id: 2, sortOrder: 2 }), prop({ id: 1, sortOrder: 1, projectId: 9 })];

  it('欄位順序：內建 → 自訂（sortOrder）→ 更新；隱藏清單不可隱藏標題', () => {
    const cols = allColumns(props);
    expect(cols.map((c) => c.key)).toEqual([
      'title',
      'status',
      'assignee',
      'startDate',
      'dueDate',
      'estimateHours',
      'p1',
      'p2',
      'updatedAt',
    ]);
    const hidden = parseHidden('["title","status","p2"]');
    expect(hidden).toEqual(['status', 'p2']);
    expect(visibleColumns(cols, hidden).map((c) => c.key)).not.toContain('p2');
    expect(parseHidden('not json')).toEqual([]);
  });

  it('專案限定欄位：其他專案的任務不適用', () => {
    const col = propertyColumn(props[1]!);
    expect(isApplicable(task({ id: 1, projectId: 9 }), col)).toBe(true);
    expect(isApplicable(task({ id: 1, projectId: 1 }), col)).toBe(false);
    expect(applicableProperties(props, 1).map((p) => p.id)).toEqual([2]);
  });

  it('PATCH 只送該欄位；自訂欄位空值送 null', () => {
    const col = propertyColumn(prop({ id: 5 }));
    expect(toPatch(col, 'x')).toEqual({ custom: { '5': 'x' } });
    expect(toPatch(col, [])).toEqual({ custom: { '5': null } });
    expect(toPatch({ kind: 'startDate' }, '')).toEqual({ startDate: null });
    expect(toPatch({ kind: 'assignee' }, null)).toEqual({ assigneeId: null });
    expect(getValue(task({ id: 1, custom: { '5': 'v' } }), col)).toBe('v');
  });

  it('樂觀更新：custom 逐鍵合併、null 清除，並更新時間與修改者', () => {
    const t = task({ id: 1, custom: { '1': 'a', '2': 'b' } });
    const next = applyPatch(t, { title: '新', custom: { '1': null, '3': true } }, T0 + 1, 7);
    expect(next.title).toBe('新');
    expect(next.custom).toEqual({ '2': 'b', '3': true });
    expect(next.updatedAt).toBe(T0 + 1);
    expect(next.updatedBy).toBe(7);
    expect(t.custom).toEqual({ '1': 'a', '2': 'b' });
  });

  it('選項使用數', () => {
    const tasks = [
      task({ id: 1, custom: { '4': 'o1' } }),
      task({ id: 2, custom: { '4': ['o1', 'o2'] } }),
      task({ id: 3 }),
    ];
    expect(countOptionUsage(tasks, 4, 'o1')).toBe(2);
    expect(countOptionUsage(tasks, 4, 'o2')).toBe(1);
  });
});

describe('排序', () => {
  const cols = allColumns([]);
  const tasks = [
    task({ id: 1, dueDate: '2026-11-30', sortOrder: 3 }),
    task({ id: 2, dueDate: null, sortOrder: 1 }),
    task({ id: 3, dueDate: '2026-11-01', sortOrder: 2 }),
  ];

  it('未排序時依 sortOrder', () => {
    expect(sortTasks(tasks, null, cols, lookups).map((t) => t.id)).toEqual([2, 3, 1]);
  });

  it('升冪 / 降冪，空值恆排最後', () => {
    expect(sortTasks(tasks, { key: 'dueDate', dir: 'asc' }, cols, lookups).map((t) => t.id)).toEqual([
      3, 1, 2,
    ]);
    expect(sortTasks(tasks, { key: 'dueDate', dir: 'desc' }, cols, lookups).map((t) => t.id)).toEqual([
      1, 3, 2,
    ]);
  });

  it('狀態依狀態順序、負責人依名稱排序', () => {
    const ts = [task({ id: 1, statusId: 4, assigneeId: 1 }), task({ id: 2, statusId: 2, assigneeId: 2 })];
    expect(sortTasks(ts, { key: 'status', dir: 'asc' }, cols, lookups).map((t) => t.id)).toEqual([2, 1]);
    expect(sortTasks(ts, { key: 'assignee', dir: 'asc' }, cols, lookups).map((t) => t.id)).toEqual([2, 1]);
  });

  it('自訂單選依選項順序', () => {
    const p = prop({
      id: 8,
      type: 'select',
      options: [
        { id: 'b', label: 'B' },
        { id: 'a', label: 'A' },
      ],
    });
    const ts = [
      task({ id: 1, custom: { '8': 'a' } }),
      task({ id: 2, custom: { '8': 'b' } }),
      task({ id: 3 }),
    ];
    const c = allColumns([p]);
    expect(sortTasks(ts, { key: 'p8', dir: 'asc' }, c, lookups).map((t) => t.id)).toEqual([2, 1, 3]);
  });

  it('點欄名循環：升冪 → 降冪 → 取消；URL 解析', () => {
    expect(cycleSort(null, 'title')).toEqual({ key: 'title', dir: 'asc' });
    expect(cycleSort({ key: 'title', dir: 'asc' }, 'title')).toEqual({ key: 'title', dir: 'desc' });
    expect(cycleSort({ key: 'title', dir: 'desc' }, 'title')).toBeNull();
    expect(cycleSort({ key: 'title', dir: 'desc' }, 'status')).toEqual({ key: 'status', dir: 'asc' });
    expect(parseSort(new URLSearchParams('sort=p3&dir=desc'))).toEqual({ key: 'p3', dir: 'desc' });
    expect(parseSort(new URLSearchParams(''))).toBeNull();
  });
});

describe('分組', () => {
  it('依狀態：空群組仍顯示、依狀態順序', () => {
    const g = groupTasks([task({ id: 1, statusId: 2 })], 'status', lookups, STATUSES);
    expect(g.map((x) => [x.key, x.tasks.length])).toEqual([
      ['status:1', 0],
      ['status:2', 1],
      ['status:3', 0],
      ['status:4', 0],
    ]);
    expect(groupDefaults(g[1]!)).toEqual({ statusId: 2 });
  });

  it('依負責人：只顯示有任務的群組，未指派排最後', () => {
    const g = groupTasks(
      [task({ id: 1, assigneeId: null }), task({ id: 2, assigneeId: 1 }), task({ id: 3, assigneeId: 2 })],
      'assignee',
      lookups,
      STATUSES,
    );
    expect(g.map((x) => x.key)).toEqual(['assignee:2', 'assignee:1', 'assignee:none']);
    expect(groupDefaults(g[2]!)).toEqual({ assigneeId: null });
  });

  it('依專案依專案順序；不分組為單一群組', () => {
    const ts = [task({ id: 1, projectId: 1 }), task({ id: 2, projectId: 2 })];
    expect(groupTasks(ts, 'project', lookups, STATUSES).map((x) => x.key)).toEqual([
      'project:2',
      'project:1',
    ]);
    expect(groupTasks(ts, 'none', lookups, STATUSES)).toHaveLength(1);
    expect(parseGroup(new URLSearchParams('group=assignee'))).toBe('assignee');
    expect(parseGroup(new URLSearchParams('group=bogus'))).toBe('status');
  });
});

describe('完成鈕與篩選', () => {
  it('未完成 → 第一個 done 類；已完成 → 第一個 todo 類', () => {
    expect(toggleDoneStatus(STATUSES, 2)).toBe(4);
    expect(toggleDoneStatus(STATUSES, 4)).toBe(1);
  });

  it('篩選比對與後端一致', () => {
    const t = task({ id: 1, title: 'Calibrate 光譜儀', projectId: 2, statusId: 1, assigneeId: null });
    expect(matchesFilters(t, emptyFilters())).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), q: 'calib' })).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), project: [1] })).toBe(false);
    expect(matchesFilters(t, { ...emptyFilters(), assignee: ['none'] })).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), assignee: [3] })).toBe(false);
    expect(matchesFilters(t, { ...emptyFilters(), status: [2] })).toBe(false);
  });
});
