import { toDateString } from '../../lib/format.js';
import { addDays, formatRangeLabel, formatReportDate, inclusiveDays, presetRange } from './reportFormat.js';

/*
 * 匯報模版（docs/design/ui-refresh-2026-11-26.md §6、requirements R1～R4）的純函式。
 * 不碰 DOM / 網路：輸入「模版模型」＋選項，輸出 { text, html, md }。
 * tests/e2e/test_report_templates.py 在瀏覽器裡動態 import 這支、餵固定資料驗輸出。
 *
 * 資料流：
 *   GET /api/tasks?assignee=…（含 progress、description、completedAt、isBlocked）＋ statuses ＋ projects ＋ users
 *     → buildTemplateModel() → { from, to, members: [{ id, name, items, todos }] }
 *     → renderTemplate(template, model, opts) → { text, html, md }
 *   （/api/personal/report 一次只回一個人、也沒有進度％，所以模版改用任務清單 API 組；自由待辦才用 report API。）
 *
 * 顏色：HTML 版要貼進 Word／Google Docs／PPT，只能用 inline style，所以這裡允許寫死色碼；
 * 值取自 tokens.css（--color-warning-text、--color-danger-text、--color-text），兩邊一致。
 */

export const TEMPLATES = [
  { value: 'worklog', label: '工作日誌' },
  { value: 'weekly', label: '個人週報' },
  { value: 'pl', label: 'PL 匯報' },
  { value: 'decision', label: '設計決議' },
];

export const TEMPLATE_LABEL = Object.fromEntries(TEMPLATES.map((t) => [t.value, t.label]));

export const isTemplate = (v) => TEMPLATES.some((t) => t.value === v);

/** 工作日誌條列符號：➢（實驗室慣用）／●／1. */
export const BULLETS = [
  { value: 'arrow', label: '➢' },
  { value: 'dot', label: '●' },
  { value: 'number', label: '1.' },
];

export const DEFAULT_TEMPLATE_OPTIONS = {
  showProgress: true,
  showNote: false,
  includeTodos: false,
  bullet: 'arrow',
};

export const COLORS = {
  text: '#1c2024',
  secondary: '#5b636e',
  doing: '#8f5a06', // --color-warning-text（橘）
  paused: '#a82c26', // --color-danger-text（紅）
  border: '#d9dce2',
};

const collator = new Intl.Collator('zh-Hant');

/* ── 共用小工具 ─────────────────────── */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 毫秒時間 → 本地 YYYY-MM-DD；null 回 null */
export function localDate(ms) {
  return ms == null ? null : toDateString(new Date(ms));
}

/** 日期是否落在 [from, to]（字串比較即可：YYYY-MM-DD） */
export const inRange = (d, from, to) => !!d && d >= from && d <= to;

/**
 * 「暫停」判法（§1.3 paused tone）：狀態名稱含「暫停」「擱置」「hold」，或狀態顏色為 orange。
 * statuses.category 只有 todo／doing／done，暫停不是 category。
 */
export function isPausedStatus(status) {
  if (!status) return false;
  const name = String(status.name ?? '').toLowerCase();
  return name.includes('暫停') || name.includes('擱置') || name.includes('hold') || status.color === 'orange';
}

/** 工作日誌的三種狀態：done（category done）／paused（暫停 tone）／doing（其餘） */
export function worklogState(task) {
  if (task.category === 'done') return 'done';
  if (task.paused) return 'paused';
  return 'doing';
}

/** 描述第一行當備註：拿掉 Markdown 標記、最多 40 字 */
export function firstLineNote(description) {
  const line = String(description ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(#+|[-*+>]|\d+\.)\s*/, '').trim())
    .find(Boolean);
  if (!line) return '';
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/* ── 模型 ─────────────────────── */

/**
 * 由任務清單組模版模型。
 * @param {object} p
 * @param {Array} p.tasks          GET /api/tasks 的列
 * @param {Map|object} p.statuses  id → { name, color, category }
 * @param {Map|object} p.projects  id → { name, color }
 * @param {Array} p.members        [{ id, name }]（PL 匯報可多人；其他模版取第一位）
 * @param {string} p.from / p.to   YYYY-MM-DD（含頭尾）
 * @param {string} p.today         YYYY-MM-DD
 * @param {object} [p.todos]       memberId → [{ title, doneDate }]（含自由待辦時）
 * @param {object} [p.comments]    taskId → [留言內文]（設計決議用）
 */
export function buildTemplateModel({ tasks, statuses, projects, members, from, to, today, todos = {}, comments = {} }) {
  const get = (m, id) => (m instanceof Map ? m.get(id) : m?.[id]);
  const out = members.map((m) => ({ id: m.id, name: m.name, items: [], todos: todos[m.id] ?? [] }));
  const byId = new Map(out.map((m) => [m.id, m]));
  for (const t of tasks) {
    const m = byId.get(t.assigneeId);
    if (!m) continue;
    const st = get(statuses, t.statusId);
    const pj = get(projects, t.projectId);
    const category = st?.category ?? 'todo';
    const item = {
      id: t.id,
      title: t.title,
      projectName: pj?.name ?? '（無專案）',
      projectColor: pj?.color ?? null,
      statusName: st?.name ?? '',
      category,
      paused: category !== 'done' && isPausedStatus(st),
      progress: typeof t.progress === 'number' ? t.progress : 0,
      dueDate: t.dueDate ?? null,
      completedDate: category === 'done' ? localDate(t.completedAt ?? t.updatedAt) : null,
      createdDate: localDate(t.createdAt),
      updatedDate: localDate(t.updatedAt),
      description: t.description ?? '',
      isBlocked: !!t.isBlocked,
      blockedByCount: t.blockedByCount ?? 0,
      comments: comments[t.id] ?? [],
    };
    item.state = worklogState(item);
    m.items.push(item);
  }
  return {
    from,
    to,
    today,
    rangeLabel: formatRangeLabel(from, to),
    year: from.slice(0, 4) === to.slice(0, 4) ? Number(from.slice(0, 4)) : undefined,
    members: out.sort((a, b) => collator.compare(a.name, b.name)),
  };
}

/** 範圍內「做過的事」：範圍內完成的＋還在做的（進行中／暫停／已有進度的待辦） */
export function worklogItems(member, model) {
  const order = { doing: 0, paused: 1, done: 2 };
  return member.items
    .filter((it) =>
      it.state === 'done'
        ? inRange(it.completedDate, model.from, model.to)
        : it.category === 'doing' || it.paused || it.progress > 0,
    )
    .sort(
      (a, b) =>
        order[a.state] - order[b.state] ||
        (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') ||
        collator.compare(a.title, b.title),
    );
}

function groupByProject(items) {
  const map = new Map();
  for (const it of items) {
    if (!map.has(it.projectName)) map.set(it.projectName, []);
    map.get(it.projectName).push(it);
  }
  return [...map.entries()]
    .map(([name, list]) => ({ name, items: list }))
    .sort((a, b) => collator.compare(a.name, b.name));
}

/* ── 工作日誌 ─────────────────────── */

/**
 * 任務尾巴：完成 → `_完成`；進行中 → `: 進行中...(90%)`；暫停 → `: 暫停...(10%)`。
 * 沒有進度（0）不顯示 (0%)；備註：完成接在括號裡、其他接「 – 備註」。
 */
export function worklogTail(item, opts = DEFAULT_TEMPLATE_OPTIONS) {
  const pct = opts.showProgress && item.progress > 0 ? `(${item.progress}%)` : '';
  const note = opts.showNote ? firstLineNote(item.description) : '';
  if (item.state === 'done') return { status: '_完成', note: note ? `(${note})` : '', tone: 'done' };
  const word = item.state === 'paused' ? '暫停' : '進行中';
  return { status: `: ${word}...${pct}`, note: note ? ` – ${note}` : '', tone: item.state };
}

const bulletText = (opts, i) => (opts.bullet === 'number' ? `${i + 1}.` : opts.bullet === 'dot' ? '●' : '➢');

function worklogBlocks(member, model, opts) {
  const groups = groupByProject(worklogItems(member, model));
  if (opts.includeTodos && member.todos.length) {
    const done = member.todos.filter((t) => inRange(t.doneDate, model.from, model.to));
    if (done.length)
      groups.push({
        name: '自由待辦',
        items: done.map((t, i) => ({ id: `todo-${i}`, title: t.title, state: 'done', progress: 100, description: '' })),
      });
  }
  return groups;
}

function worklogText(member, model, opts) {
  const out = [];
  for (const g of worklogBlocks(member, model, opts)) {
    if (out.length) out.push('');
    out.push(`[${g.name}] - ${member.name}`);
    g.items.forEach((it, i) => {
      const tail = worklogTail(it, opts);
      out.push(`  ${bulletText(opts, i)} ${it.title}${tail.status}${tail.note}`);
    });
  }
  return out;
}

function worklogMd(member, model, opts) {
  const out = [];
  for (const g of worklogBlocks(member, model, opts)) {
    if (out.length) out.push('');
    out.push(`**[${mdKeep(g.name)}] - ${mdKeep(member.name)}**`, '');
    g.items.forEach((it, i) => {
      const tail = worklogTail(it, opts);
      const mark = opts.bullet === 'number' ? `${i + 1}.` : '-';
      out.push(`${mark} ${mdKeep(it.title)}${tail.status}${mdKeep(tail.note)}`);
    });
  }
  return out;
}

const P = `margin:12px 0 4px;font-weight:700;color:${COLORS.text}`;
const LI = 'margin:2px 0';

function listOpen(opts) {
  if (opts.bullet === 'number') return '<ol style="margin:0 0 8px;padding-left:28px">';
  if (opts.bullet === 'dot') return '<ul style="margin:0 0 8px;padding-left:28px;list-style-type:disc">';
  return '<ul style="margin:0 0 8px;padding-left:12px;list-style-type:none">';
}
const listClose = (opts) => (opts.bullet === 'number' ? '</ol>' : '</ul>');

function tailHtml(tail) {
  const status =
    tail.tone === 'done'
      ? `<span class="rp-done">${escapeHtml(tail.status)}</span>`
      : `<span class="rp-${tail.tone}" style="color:${tail.tone === 'paused' ? COLORS.paused : COLORS.doing}">${escapeHtml(tail.status)}</span>`;
  return status + escapeHtml(tail.note);
}

function worklogHtml(member, model, opts) {
  const out = [];
  for (const g of worklogBlocks(member, model, opts)) {
    out.push(`<p style="${P}">[${escapeHtml(g.name)}] - ${escapeHtml(member.name)}</p>`, listOpen(opts));
    for (const it of g.items) {
      const arrow = opts.bullet === 'arrow' ? '➢ ' : '';
      out.push(`<li style="${LI}" data-state="${it.state}">${arrow}${escapeHtml(it.title)}${tailHtml(worklogTail(it, opts))}</li>`);
    }
    out.push(listClose(opts));
  }
  return out;
}

/* ── 個人週報 ─────────────────────── */

/** 個人週報四段：本週完成／進行中／下週預計／卡住的事 */
export function weeklySections(member, model) {
  const nextTo = addDays(model.to, 7);
  const open = member.items.filter((it) => it.state !== 'done');
  const byDue = (a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || collator.compare(a.title, b.title);
  const done = member.items
    .filter((it) => it.state === 'done' && inRange(it.completedDate, model.from, model.to))
    .sort((a, b) => a.completedDate.localeCompare(b.completedDate) || collator.compare(a.title, b.title));
  const doing = open.filter((it) => it.state === 'doing' && (it.category === 'doing' || it.progress > 0)).sort(byDue);
  const next = open.filter((it) => it.dueDate && it.dueDate <= nextTo).sort(byDue);
  const stuck = open.filter((it) => it.isBlocked || it.paused).sort(byDue);
  return [
    { key: 'done', heading: '本週完成', items: done },
    { key: 'doing', heading: '進行中', items: doing },
    { key: 'next', heading: '下週預計', items: next },
    { key: 'stuck', heading: '卡住的事', items: stuck },
  ];
}

function weeklyLine(sec, it, model, opts) {
  const d = (s) => formatReportDate(s, model.year);
  let tail = '';
  if (sec === 'done') tail = it.completedDate ? `（${d(it.completedDate)}）` : '';
  else if (sec === 'doing') tail = opts.showProgress && it.progress > 0 ? ` (${it.progress}%)` : '';
  else if (sec === 'next')
    tail = it.dueDate < model.today ? `（已逾期，原訂 ${d(it.dueDate)}）` : `（到期 ${d(it.dueDate)}）`;
  else
    tail = it.isBlocked
      ? `：等待 ${it.blockedByCount || 1} 項前置任務`
      : `：暫停中${opts.showProgress && it.progress > 0 ? ` (${it.progress}%)` : ''}`;
  const note = opts.showNote ? firstLineNote(it.description) : '';
  return { project: it.projectName, title: it.title, tail, note: note ? ` – ${note}` : '' };
}

function weeklyTitle(member, model) {
  return `週報 ${model.rangeLabel} · ${member.name}`;
}

function weeklyTodos(member, model, opts) {
  if (!opts.includeTodos) return [];
  return member.todos.filter((t) => inRange(t.doneDate, model.from, model.to));
}

/* ── PL 匯報 ─────────────────────── */

export function memberStats(member, model) {
  const done = member.items.filter((it) => it.state === 'done' && inRange(it.completedDate, model.from, model.to)).length;
  const open = member.items.filter((it) => it.state !== 'done');
  return {
    done,
    doing: open.filter((it) => it.category === 'doing' || it.paused || it.progress > 0).length,
    overdue: open.filter((it) => it.dueDate && it.dueDate < model.today).length,
  };
}

/* ── 設計決議 ─────────────────────── */

const DECISION_RE = /決議|設計|決策/;

/**
 * 收進「設計決議」的任務：標題或專案名稱含「決議」「設計」「決策」，或描述裡有「決議：」那一行；
 * 且範圍內有動靜（未完成、範圍內完成、或範圍內更新過）。
 */
export function decisionItems(member, model) {
  return member.items
    .filter(
      (it) =>
        DECISION_RE.test(it.title) || DECISION_RE.test(it.projectName) || /^\s*(#+\s*)?決議\s*[:：]?/m.test(it.description),
    )
    .filter(
      (it) =>
        it.state !== 'done' ||
        inRange(it.completedDate, model.from, model.to) ||
        inRange(it.updatedDate, model.from, model.to),
    )
    .sort((a, b) => collator.compare(a.projectName, b.projectName) || collator.compare(a.title, b.title));
}

export const DECISION_FIELDS = [
  { key: 'decision', heading: '決議', re: /^(決議|結論|決定)$/ },
  { key: 'reason', heading: '理由', re: /^(理由|原因|為什麼)$/ },
  { key: 'alternatives', heading: '替代方案', re: /^(替代方案|其他方案|備選方案|方案比較)$/ },
  { key: 'impact', heading: '影響', re: /^(影響|影響範圍|後續影響)$/ },
];

/**
 * 從文字抓四欄：`決議：…` 單行，或 `## 決議` 標題底下到下一個標題為止的段落。
 * 先看描述、再看討論（新→舊），先找到的算數；找不到就留空（讓人填）。
 */
export function extractDecisionFields(description, comments = []) {
  const found = {};
  const scan = (text) => {
    const lines = String(text ?? '').split(/\r?\n/);
    let cur = null;
    let buf = [];
    const flush = () => {
      if (cur && !found[cur] && buf.join('\n').trim()) found[cur] = buf.join('\n').trim();
      cur = null;
      buf = [];
    };
    for (const raw of lines) {
      const m = raw.match(/^\s*(#{1,6}\s*)?([^\s:：#][^:：]{0,7}?)\s*(?:[:：]\s*(.*))?$/);
      const label = m?.[2]?.trim();
      const field = label && DECISION_FIELDS.find((f) => f.re.test(label));
      const isHeading = /^\s*#{1,6}\s/.test(raw);
      if (field && (m[3] != null || m[1])) {
        flush();
        if (m[3] != null && m[3].trim()) {
          if (!found[field.key]) found[field.key] = m[3].trim();
        } else {
          cur = field.key;
        }
        continue;
      }
      if (isHeading) {
        flush();
        continue;
      }
      if (cur) buf.push(raw.replace(/^\s*[-*+]\s+/, '・'));
    }
    flush();
  };
  scan(description);
  for (const c of comments) scan(c);
  return Object.fromEntries(DECISION_FIELDS.map((f) => [f.key, found[f.key] ?? '']));
}

/* ── Markdown 跳脫 ─────────────────────── */

// 只跳脫會弄壞版面的 \ ` * |；底線與方括號保留原樣（`_完成`、`[專案]` 是格式的一部分）
function mdKeep(s) {
  return String(s ?? '').replace(/([\\`*|])/g, '\\$1');
}

/* ── 輸出 ─────────────────────── */

const WRAP_OPEN = `<div style="font-family:'Noto Sans TC','Microsoft JhengHei',system-ui,sans-serif;font-size:14px;line-height:1.7;color:${COLORS.text}">`;
const H1 = `margin:0 0 8px;font-size:20px;font-weight:700;color:${COLORS.text}`;
const H2 = `margin:16px 0 6px;font-size:16px;font-weight:700;color:${COLORS.text}`;
const H3 = `margin:10px 0 4px;font-size:14px;font-weight:700;color:${COLORS.text}`;
const MUTED = `margin:0 0 6px;color:${COLORS.secondary}`;
const TABLE = 'border-collapse:collapse;margin:4px 0 12px';
const TD = `border:1px solid ${COLORS.border};padding:4px 10px;text-align:left`;
const BLANK = '（待填）';

function wrap(parts) {
  return `${WRAP_OPEN}${parts.join('')}</div>`;
}

function renderWorklog(model, opts) {
  const text = [];
  const md = [];
  const html = [];
  for (const m of model.members) {
    const t = worklogText(m, model, opts);
    if (!t.length) continue;
    if (text.length) text.push('');
    if (md.length) md.push('');
    text.push(...t);
    md.push(...worklogMd(m, model, opts));
    html.push(...worklogHtml(m, model, opts));
  }
  if (!text.length) {
    const who = model.members.map((m) => m.name).join('、');
    const msg = `${model.rangeLabel} ${who ? `${who} ` : ''}沒有進行中或完成的任務`;
    return { text: msg, md: msg, html: wrap([`<p style="${MUTED}">${escapeHtml(msg)}</p>`]), empty: true };
  }
  return { text: text.join('\n'), md: md.join('\n'), html: wrap(html), empty: false };
}

function renderWeekly(model, opts) {
  const m = model.members[0];
  if (!m) return { text: '', md: '', html: wrap([]), empty: true };
  const sections = weeklySections(m, model);
  const todos = weeklyTodos(m, model, opts);
  const title = weeklyTitle(m, model);
  const text = [title];
  const md = [`# ${mdKeep(title)}`];
  const html = [`<h1 style="${H1}">${escapeHtml(title)}</h1>`];
  for (const s of sections) {
    const lines = s.items.map((it) => weeklyLine(s.key, it, model, opts));
    const extra = s.key === 'done' ? todos.map((t) => ({ project: '自由待辦', title: t.title, tail: '', note: '' })) : [];
    const all = [...lines, ...extra];
    text.push('', `【${s.heading}】`);
    md.push('', `## ${s.heading}`, '');
    html.push(`<h2 style="${H2}">${escapeHtml(s.heading)}</h2>`);
    if (!all.length) {
      text.push('・（無）');
      md.push('- （無）');
      html.push(`<p style="${MUTED}">（無）</p>`);
      continue;
    }
    html.push('<ul style="margin:0 0 8px;padding-left:24px">');
    for (const l of all) {
      text.push(`・[${l.project}] ${l.title}${l.tail}${l.note}`);
      md.push(`- [${mdKeep(l.project)}] ${mdKeep(l.title)}${mdKeep(l.tail)}${mdKeep(l.note)}`);
      const tone = s.key === 'stuck' ? COLORS.paused : s.key === 'doing' ? COLORS.doing : null;
      const tail = tone && l.tail ? `<span style="color:${tone}">${escapeHtml(l.tail)}</span>` : escapeHtml(l.tail);
      html.push(
        `<li style="${LI}"><span style="color:${COLORS.secondary}">[${escapeHtml(l.project)}]</span> ${escapeHtml(l.title)}${tail}${escapeHtml(l.note)}</li>`,
      );
    }
    html.push('</ul>');
  }
  const empty = sections.every((s) => s.items.length === 0) && !todos.length;
  return { text: text.join('\n'), md: md.join('\n'), html: wrap(html), empty };
}

function renderPl(model, opts) {
  const title = `進度匯報 ${model.rangeLabel}`;
  const stats = model.members.map((m) => ({ m, s: memberStats(m, model) }));
  const text = [title, '', '【總覽】'];
  const md = [`# ${title}`, '', '## 總覽', '', '| 成員 | 完成 | 進行中 | 逾期 |', '| --- | --- | --- | --- |'];
  const html = [
    `<h1 style="${H1}">${escapeHtml(title)}</h1>`,
    `<h2 style="${H2}">總覽</h2>`,
    `<table style="${TABLE}"><thead><tr>${['成員', '完成', '進行中', '逾期'].map((h) => `<th style="${TD}">${h}</th>`).join('')}</tr></thead><tbody>`,
  ];
  for (const { m, s } of stats) {
    text.push(`・${m.name}：完成 ${s.done}／進行中 ${s.doing}／逾期 ${s.overdue}`);
    md.push(`| ${mdKeep(m.name)} | ${s.done} | ${s.doing} | ${s.overdue} |`);
    html.push(
      `<tr><td style="${TD}">${escapeHtml(m.name)}</td><td style="${TD}">${s.done}</td><td style="${TD}">${s.doing}</td><td style="${TD}">${s.overdue}</td></tr>`,
    );
  }
  html.push('</tbody></table>');
  for (const m of model.members) {
    const t = worklogText(m, model, opts);
    text.push('', `【${m.name}】`);
    md.push('', `## ${mdKeep(m.name)}`, '');
    html.push(`<h2 style="${H2}">${escapeHtml(m.name)}</h2>`);
    if (!t.length) {
      text.push('（這段期間沒有進行中或完成的任務）');
      md.push('（這段期間沒有進行中或完成的任務）');
      html.push(`<p style="${MUTED}">（這段期間沒有進行中或完成的任務）</p>`);
      continue;
    }
    text.push(...t);
    md.push(...worklogMd(m, model, opts));
    html.push(...worklogHtml(m, model, opts));
  }
  const empty = stats.every(({ s }) => s.done + s.doing === 0);
  return { text: text.join('\n'), md: md.join('\n'), html: wrap(html), empty };
}

export const DECISION_HINT = '在任務標題或專案名稱加上「決議」或「設計」，或在描述寫「決議：…」，就會被收進來';

function renderDecision(model, opts) {
  const title = `設計決議 ${model.rangeLabel}`;
  const rows = model.members.flatMap((m) => decisionItems(m, model).map((it) => ({ m, it })));
  const text = [title];
  const md = [`# ${title}`];
  const html = [`<h1 style="${H1}">${escapeHtml(title)}</h1>`];
  const blocks = rows.length
    ? rows.map(({ m, it }) => ({
        topic: it.title,
        meta: `專案：${it.projectName} · 負責人：${m.name} · 期限：${it.dueDate ? formatReportDate(it.dueDate, model.year) : '—'}`,
        fields: extractDecisionFields(it.description, it.comments),
      }))
    : [{ topic: '', meta: `負責人：${model.members.map((m) => m.name).join('、')} · 期限：`, fields: {} }];
  if (!rows.length) {
    text.push('', `（${DECISION_HINT}）`);
    md.push('', `> ${DECISION_HINT}`);
    html.push(`<p style="${MUTED}">${escapeHtml(DECISION_HINT)}</p>`);
  }
  for (const b of blocks) {
    text.push('', `■ 議題：${b.topic || BLANK}`, b.meta);
    md.push('', `## 議題：${mdKeep(b.topic || BLANK)}`, '', mdKeep(b.meta));
    html.push(`<h2 style="${H2}">議題：${escapeHtml(b.topic || BLANK)}</h2>`, `<p style="${MUTED}">${escapeHtml(b.meta)}</p>`);
    html.push(`<table style="${TABLE};width:100%"><tbody>`);
    for (const f of DECISION_FIELDS) {
      const v = b.fields[f.key] ?? '';
      text.push(`【${f.heading}】${v ? `\n${v}` : BLANK}`);
      md.push('', `### ${f.heading}`, '', v ? mdKeep(v) : BLANK);
      html.push(
        `<tr><th style="${TD};width:96px;white-space:nowrap;vertical-align:top">${f.heading}</th><td style="${TD};${v ? '' : `color:${COLORS.secondary}`}">${v ? escapeHtml(v).replace(/\n/g, '<br>') : BLANK}</td></tr>`,
      );
    }
    html.push('</tbody></table>');
  }
  return { text: text.join('\n'), md: md.join('\n'), html: wrap(html), empty: rows.length === 0 };
}

/**
 * 主入口：模版 + 模型 + 選項 → { text, html, md, empty }。
 * text＝純文字（貼進純文字框）；html＝inline style 版面（貼進 Word／Google Docs／PPT）；md＝下載用。
 */
export function renderTemplate(template, model, opts = DEFAULT_TEMPLATE_OPTIONS) {
  const o = { ...DEFAULT_TEMPLATE_OPTIONS, ...opts };
  switch (template) {
    case 'weekly':
      return renderWeekly(model, o);
    case 'pl':
      return renderPl(model, o);
    case 'decision':
      return renderDecision(model, o);
    default:
      return renderWorklog(model, o);
  }
}

/** 下載的完整 HTML 檔（含 <head>，可直接用瀏覽器開、或拖進 Word） */
export function htmlDocument(title, bodyHtml) {
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:32px auto;max-width:860px;padding:0 16px;background:#fff}</style></head>
<body>${bodyHtml}</body></html>
`;
}

/** 摘要「共 8 項 · 5 完成 · 2 進行中 · 1 暫停」（工作日誌／PL 匯報用） */
export function templateSummary(model) {
  let done = 0;
  let doing = 0;
  let paused = 0;
  for (const m of model.members) {
    for (const it of worklogItems(m, model)) {
      if (it.state === 'done') done += 1;
      else if (it.state === 'paused') paused += 1;
      else doing += 1;
    }
  }
  const total = done + doing + paused;
  return `共 ${total} 項 · ${done} 完成 · ${doing} 進行中 · ${paused} 暫停`;
}

/** 下載檔名：工作日誌_2026-11-24_2026-11-30_王小明.md（照 reportFileName 的清理規則） */
export function templateFileName(template, from, to, ext, member) {
  const who = member ? `_${member.replace(/[\\/:*?"<>|\s]+/g, '')}` : '';
  const label = (TEMPLATE_LABEL[template] ?? '匯報').replace(/\s+/g, '');
  return `${label}_${from}_${to}${who}.${ext}`;
}

/* ── 本週卡（§6.1） ─────────────────────── */

/** 本週（週一～週日，本地時間）；與 reportFormat.presetRange('week') 同一支 */
export function weekRange(today) {
  return presetRange('week', today);
}

/** ISO 週次（第幾週） */
export function isoWeek(date) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - start) / 86_400_000 + 1) / 7);
}

/**
 * 本週卡三欄：
 * - doing：category doing（不論日期），到期近→遠
 * - due：未完成、到期日 ≤ 本週日（含已逾期；逾期排最前）
 * - done：本週內完成（completedAt 落在週一～週日），新→舊
 */
export function weekBuckets(tasks, statuses, today) {
  const get = (id) => (statuses instanceof Map ? statuses.get(id) : statuses?.[id]);
  const { from, to } = weekRange(today);
  const byDue = (a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.id - b.id;
  const cat = (t) => get(t.statusId)?.category ?? 'todo';
  const doing = tasks.filter((t) => cat(t) === 'doing').sort(byDue);
  const due = tasks.filter((t) => cat(t) !== 'done' && t.dueDate && t.dueDate <= to).sort(byDue);
  const done = tasks
    .filter((t) => cat(t) === 'done' && inRange(localDate(t.completedAt ?? t.updatedAt), from, to))
    .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));
  return { from, to, doing, due, done, overdue: due.filter((t) => t.dueDate < today).length };
}

/** 本週卡的到期標示：逾期 N 天／今天／MM/DD／— */
export function weekDueLabel(due, today) {
  if (!due) return { text: '—', kind: 'none' };
  if (due < today) return { text: `逾期 ${inclusiveDays(due, today) - 1} 天`, kind: 'overdue' };
  if (due === today) return { text: '今天', kind: 'today' };
  return { text: formatReportDate(due, Number(today.slice(0, 4))), kind: 'week' };
}
