import { AUDIT_ENTITY_TYPES } from '../../shared/audit.js';

/** 稽核紀錄的純函式（行內差異、篩選條件、狀態判斷）。docs/design/audit-log.md */

// ── 行內差異 ─────────────────────────────────────────────

/** 一次比對的最大工作量（tokens 乘積）；超過時改以行為單位，再超過則整段視為替換 */
const MAX_CELLS = 2_000_000;
/** 相鄰「刪除＋新增」的共同內容低於此比例時，視為整段替換 */
const MIN_SIMILARITY = 0.4;

/** 斷詞：中日韓文字逐字、英數連續為一詞、空白連續為一段、換行獨立 */
export function tokenize(text) {
  return text.match(/\n|[^\S\n]+|[A-Za-z0-9_]+|[\s\S]/gu) ?? [];
}

function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function pushSeg(out, type, text) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === type) last.text += text;
  else out.push({ type, text });
}

function lcsDiff(a, b, out) {
  const n = a.length;
  const m = b.length;
  // dp[i][j]：a[i..] 與 b[j..] 的 LCS 長度（扁平陣列）
  const dp = new Uint32Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pushSeg(out, 'same', a[i]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) pushSeg(out, 'del', a[i++]);
    else pushSeg(out, 'add', b[j++]);
  }
  while (i < n) pushSeg(out, 'del', a[i++]);
  while (j < m) pushSeg(out, 'add', b[j++]);
}

/** 兩邊都只出現一次的 token 中，最靠近 a 中央者（用來把大問題切成兩半） */
function findAnchor(a, b) {
  const count = (xs) => {
    const m = new Map();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  const mid = a.length >> 1;
  for (let d = 0; d <= mid + 1; d++) {
    for (const i of [mid - d, mid + d]) {
      const t = a[i];
      if (t !== undefined && ca.get(t) === 1 && cb.get(t) === 1) return [i, b.indexOf(t)];
    }
  }
  return null;
}

/** 序列差異：去掉共同前後綴後以 LCS 比對；太大時以唯一 token 為錨點切半（類 patience diff） */
function diffSeq(a, b, out) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  pushSeg(out, 'same', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length <= MAX_CELLS) lcsDiff(midA, midB, out);
  else {
    const anchor = findAnchor(midA, midB);
    if (anchor) {
      const [i, j] = anchor;
      diffSeq(midA.slice(0, i), midB.slice(0, j), out);
      pushSeg(out, 'same', midA[i]);
      diffSeq(midA.slice(i + 1), midB.slice(j + 1), out);
    } else {
      pushSeg(out, 'del', midA.join(''));
      pushSeg(out, 'add', midB.join(''));
    }
  }
  pushSeg(out, 'same', a.slice(endA).join(''));
}

/** 文字的行內差異：先以行比較，再把「刪除＋新增」的相鄰行細分到詞 / 字層級 */
export function inlineDiff(before, after) {
  const out = [];
  if (before === after) {
    pushSeg(out, 'same', before);
    return out;
  }
  const lines = [];
  diffSeq(splitLines(before), splitLines(after), lines);
  for (let k = 0; k < lines.length; k++) {
    const s = lines[k];
    const next = lines[k + 1];
    if (s.type === 'del' && next?.type === 'add') {
      const fine = [];
      diffSeq(tokenize(s.text), tokenize(next.text), fine);
      // 幾乎整段改寫時，零碎的共同字只會干擾閱讀 → 整段顯示為替換
      const same = fine.reduce((n, x) => n + (x.type === 'same' ? x.text.trim().length : 0), 0);
      const longer = Math.max(s.text.trim().length, next.text.trim().length);
      if (longer > 0 && same / longer < MIN_SIMILARITY) {
        pushSeg(out, 'del', s.text);
        pushSeg(out, 'add', next.text);
      } else for (const f of fine) pushSeg(out, f.type, f.text);
      k++;
    } else pushSeg(out, s.type, s.text);
  }
  return out;
}

/** 修改前一欄只顯示 same + del；修改後一欄只顯示 same + add */
export function sideOf(segments, side) {
  const drop = side === 'before' ? 'add' : 'del';
  return segments.filter((s) => s.type !== drop);
}

// ── 標籤 ─────────────────────────────────────────────────

export const ENTITY_LABELS = {
  task: '任務',
  project: '專案',
  status: '狀態',
  property: '自訂欄位',
  user: '成員',
  permission: '權限',
  import: '資料匯入',
  sync: '資料同步',
  relation: '相關任務',
  dependency: '依賴',
  checklist: '待辦清單',
  comment: '留言',
};

export const ACTION_LABELS = {
  create: '建立',
  update: '修改',
  delete: '刪除',
  restore: '還原刪除',
  reorder: '調整順序',
  reset_password: '重設密碼',
  unlock: '解除鎖定',
  apply: '整批套用',
};

export const SOURCE_LABELS = {
  web: '網頁',
  api: 'API',
  import: '匯入',
  sync: '同步',
  system: '系統',
  revert: '還原',
};

export function entryState(e) {
  if (e.revertedAt != null) return 'reverted';
  return e.revertable ? 'revertable' : 'locked';
}

export const STATE_LABELS = {
  reverted: '已還原',
  revertable: '可還原',
  locked: '不可還原',
};

export const STATE_TONES = {
  reverted: 'neutral',
  revertable: 'accent',
  locked: 'gray',
};

/** 是否顯示「還原」按鈕 */
export function canShowRevert(e, canRevert) {
  return canRevert && entryState(e) === 'revertable';
}

// ── 衝突判斷 ─────────────────────────────────────────────

export function conflictFields(preview) {
  return preview?.fields.filter((f) => f.conflict) ?? [];
}

/** 409 REVERT_CONFLICT 的 details 轉為欄位清單（格式不符時回傳 null） */
export function conflictFromError(details) {
  if (!details || typeof details !== 'object') return null;
  const fields = details.fields;
  if (!Array.isArray(fields)) return null;
  return fields;
}

export function revertKindText(kind, entityLabel, entity) {
  const noun = ENTITY_LABELS[entity] ?? '資料';
  const name = entityLabel ? `「${entityLabel}」` : '';
  switch (kind) {
    case 'soft_delete':
      return `會把${noun}${name}移除（之後仍可在稽核紀錄還原）。`;
    case 'undelete':
      return `會讓已刪除的${noun}${name}重新出現。`;
    case 'delete_row':
      return `會刪除${noun}${name}（之後仍可在稽核紀錄還原）。`;
    case 'recreate_row':
      return `會以原本的設定重新建立${noun}${name}。`;
    case 'delete_link':
      return `會移除這個${noun}連結（之後仍可在稽核紀錄還原）。`;
    case 'recreate_link':
      return `會重新建立這個${noun}連結。`;
    case 'undelete_comment':
      return '會讓這則被刪除的留言重新出現在討論區。';
    case 'set_fields':
      return '以下欄位會改回這次修改之前的內容：';
    default:
      return '';
  }
}

// ── 篩選條件 ─────────────────────────────────────────────

export const RANGE_PRESETS = ['today', '7d', '30d', 'all', 'custom'];

export const RANGE_LABELS = {
  today: '今天',
  '7d': '7 天',
  '30d': '30 天',
  all: '全部',
  custom: '自訂',
};

export const DEFAULT_FILTERS = {
  range: '30d',
  fromDate: '',
  toDate: '',
  actor: null,
  entityType: null,
  action: null,
  revertable: 'any',
  q: '',
  taskId: null,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function startOfLocalDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseLocalDate(s) {
  if (!DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d).getTime();
  return Number.isNaN(t) ? null : t;
}

/** 時間範圍 → { from, to }（unix ms；to 不含） */
export function rangeOf(f, now) {
  const today = startOfLocalDay(now);
  switch (f.range) {
    case 'today':
      return { from: today, to: undefined };
    case '7d':
      return { from: today - 6 * DAY_MS, to: undefined };
    case '30d':
      return { from: today - 29 * DAY_MS, to: undefined };
    case 'custom': {
      const from = parseLocalDate(f.fromDate) ?? undefined;
      const toDay = parseLocalDate(f.toDate);
      return { from, to: toDay == null ? undefined : toDay + DAY_MS };
    }
    default:
      return { from: undefined, to: undefined };
  }
}

/** 篩選條件 → API query 參數（不含游標） */
export function toApiParams(f, now) {
  const { from, to } = rangeOf(f, now);
  return {
    from,
    to,
    actor: f.actor ?? undefined,
    entityType: f.entityType ?? undefined,
    action: f.action ?? undefined,
    revertable: f.revertable === 'any' ? undefined : f.revertable === 'yes' ? 'true' : 'false',
    q: f.q.trim() || undefined,
    taskId: f.taskId ?? undefined,
  };
}

const ENTITY_SET = new Set(AUDIT_ENTITY_TYPES);
const ACTION_SET = new Set(Object.keys(ACTION_LABELS));
const posInt = (v) => (v && /^\d{1,12}$/.test(v) && Number(v) > 0 ? Number(v) : null);

/** 網址 → 篩選條件（不合法的值忽略；有 taskId 時預設看全部時間） */
export function readFilters(sp) {
  const range = sp.get('range');
  const taskId = posInt(sp.get('taskId'));
  const et = sp.get('type');
  const action = sp.get('action');
  const rv = sp.get('revertable');
  return {
    range: RANGE_PRESETS.includes(range ?? '') ? range : taskId != null ? 'all' : DEFAULT_FILTERS.range,
    fromDate: DATE_RE.test(sp.get('from') ?? '') ? sp.get('from') : '',
    toDate: DATE_RE.test(sp.get('to') ?? '') ? sp.get('to') : '',
    actor: posInt(sp.get('actor')),
    entityType: et && ENTITY_SET.has(et) ? et : null,
    action: action && ACTION_SET.has(action) ? action : null,
    revertable: rv === 'yes' || rv === 'no' ? rv : 'any',
    q: (sp.get('q') ?? '').slice(0, 200),
    taskId,
  };
}

/** 篩選條件 → 網址參數（預設值不寫入） */
export function writeFilters(f) {
  const sp = new URLSearchParams();
  const defaultRange = f.taskId != null ? 'all' : DEFAULT_FILTERS.range;
  if (f.range !== defaultRange) sp.set('range', f.range);
  if (f.range === 'custom') {
    if (f.fromDate) sp.set('from', f.fromDate);
    if (f.toDate) sp.set('to', f.toDate);
  }
  if (f.actor != null) sp.set('actor', String(f.actor));
  if (f.entityType) sp.set('type', f.entityType);
  if (f.action) sp.set('action', f.action);
  if (f.revertable !== 'any') sp.set('revertable', f.revertable);
  if (f.q.trim()) sp.set('q', f.q.trim());
  if (f.taskId != null) sp.set('taskId', String(f.taskId));
  return sp;
}

export function hasActiveFilters(f) {
  return (
    f.actor != null ||
    f.entityType != null ||
    f.action != null ||
    f.revertable !== 'any' ||
    f.q.trim() !== '' ||
    f.taskId != null ||
    f.range === 'custom'
  );
}
