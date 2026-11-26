import { createElement, Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/compat';
import { createPortal } from 'preact/compat';
import { REPORT_MAX_DAYS } from '../../shared/personal.js';
import { useUsers } from '../../lib/hooks.js';
import { toast } from '../../lib/toast.js';
import { Avatar, Button, Checkbox, ColorDot, Dialog, ErrorState, MultiSelect, Spinner } from '../../ui/index.js';
import { useReport } from './api.js';
import {
  DEFAULT_REPORT_OPTIONS,
  EMPTY_TEXT,
  RANGE_PRESETS,
  REPORT_FORMATS,
  buildReportModel,
  formatCsv,
  formatMarkdown,
  formatPlain,
  formatReport,
  formatReportDate,
  formatTable,
  inclusiveDays,
  presetRange,
  reportFileName,
  toDateString,
} from './reportFormat.js';
import {
  BULLETS,
  DEFAULT_TEMPLATE_OPTIONS,
  TEMPLATES,
  TEMPLATE_LABEL,
  htmlDocument,
  isTemplate,
  templateFileName,
} from './reportTemplates.js';
import { useTemplateOutput } from './templateData.js';

const PREFS_KEY = 'personal-report-prefs';

const isPreset = (v) => RANGE_PRESETS.some((p) => p.value === v);
const isFormat = (v) => REPORT_FORMATS.some((f) => f.value === v);

/** 讀取上次的選項與區間（localStorage 失敗或內容不合法時用預設值） */
function loadPrefs(today) {
  const base = {
    preset: 'week',
    ...presetRange('week', today),
    options: DEFAULT_REPORT_OPTIONS,
    format: 'plain',
  };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return base;
    const options = { ...DEFAULT_REPORT_OPTIONS };
    for (const k of Object.keys(options)) {
      if (typeof raw.options?.[k] === 'boolean') options[k] = raw.options[k];
    }
    const preset = isPreset(raw.preset) ? raw.preset : 'week';
    const range =
      preset === 'custom'
        ? typeof raw.from === 'string' && typeof raw.to === 'string' && inclusiveDays(raw.from, raw.to) > 0
          ? { from: raw.from, to: raw.to }
          : presetRange('week', today)
        : presetRange(preset, today);
    return { preset, ...range, options, format: isFormat(raw.format) ? raw.format : 'plain' };
  } catch {
    return base;
  }
}

function savePrefs(p) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // 無法儲存不影響使用
  }
}

/** 模版選項另存一把鍵（不動 PREFS_KEY 的形狀）；模版本身不記，每次由入口決定 */
const TEMPLATE_PREFS_KEY = 'personal-report-template-prefs';

function loadTemplateOpts() {
  const out = { ...DEFAULT_TEMPLATE_OPTIONS };
  try {
    const raw = JSON.parse(localStorage.getItem(TEMPLATE_PREFS_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      for (const k of ['showProgress', 'showNote', 'includeTodos'])
        if (typeof raw[k] === 'boolean') out[k] = raw[k];
      if (BULLETS.some((b) => b.value === raw.bullet)) out.bullet = raw.bullet;
    }
  } catch {
    // 讀不到就用預設
  }
  return out;
}

function saveTemplateOpts(o) {
  try {
    localStorage.setItem(TEMPLATE_PREFS_KEY, JSON.stringify(o));
  } catch {
    // 無法儲存不影響使用
  }
}

/** 同時寫 text/plain 與 text/html（貼進 Word／Google Docs 保留顏色與條列）；不支援時退回純文字 */
async function copyRich(text, html) {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return 'rich';
    }
  } catch {
    // 落到純文字
  }
  return (await copyText(text)) ? 'plain' : 'fail';
}

function download(name, mime, text) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 退而求其次：暫時的 textarea + execCommand
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      el.remove();
    }
  }
}

/** 列印用版面（portal 到 body，@media print 時只顯示這一塊） */
function PrintView({ model, showDate, showHours }) {
  return createPortal(
    createElement(
      'div',
      { className: 'pl-report-print-portal', 'aria-hidden': 'true' },
      createElement('h1', null, model.memberName ? `${model.title}：${model.memberName}` : model.title),
      createElement('p', null, model.summary),
      showHours &&
        model.hoursTotal != null &&
        createElement(
          'p',
          null,
          '預估工時合計 ',
          Math.round(model.hoursTotal * 100) / 100,
          ' 小時（',
          model.hoursKnown,
          ' 件有填）',
        ),
      model.empty && createElement('p', null, EMPTY_TEXT),
      model.sections.map((s) =>
        createElement(
          'section',
          { key: s.key },
          createElement('h2', null, s.heading),
          s.groups.map((g) =>
            createElement(
              'div',
              { key: g.name ?? '' },
              g.name && createElement('h3', null, g.name),
              createElement(
                'ul',
                null,
                g.items.map((it) =>
                  createElement(
                    'li',
                    { key: it.key },
                    showDate && it.date ? `${formatReportDate(it.date, model.year)} ` : '',
                    it.title,
                    it.note ? `（${it.note}）` : '',
                    showHours && it.hours != null ? `（預估 ${Math.round(it.hours * 100) / 100} 小時）` : '',
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    document.body,
  );
}

/** 模版的列印版面：同一份 HTML（已逐字跳脫，見 reportTemplates.escapeHtml） */
function TemplatePrintView({ html }) {
  return createPortal(
    createElement('div', {
      className: 'pl-report-print-portal',
      'aria-hidden': 'true',
      dangerouslySetInnerHTML: { __html: html },
    }),
    document.body,
  );
}

/**
 * 匯報報告對話框：選日期區間與內容 → 即時預覽（每項可取消勾選、可編輯文字）→ 複製 / 下載 / 列印。
 * 報告是讓人整理自己做了什麼，語氣中性；檢視他人清單時為該成員產生（唯讀資料，標題標示名稱）。
 */
export function ReportDialog({ open, onClose, userId, memberName, selfName, initialTemplate, initialPreset }) {
  const today = toDateString(new Date());
  const [prefs, setPrefs] = useState(() => loadPrefs(today));
  // 模版（§6.2）：classic＝原本的四種格式；其餘見 reportTemplates.TEMPLATES
  const [template, setTemplate] = useState('classic');
  const [tplRange, setTplRange] = useState(() => ({ preset: 'week', ...presetRange('week', today) }));
  const [tplOpts, setTplOpts] = useState(loadTemplateOpts);
  const [tplTab, setTplTab] = useState('preview');
  const [plIds, setPlIds] = useState([userId]);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(0);
  useEffect(() => saveTemplateOpts(tplOpts), [tplOpts]);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  const [excluded, setExcluded] = useState(new Set());
  const [tab, setTab] = useState('preview');
  const [edit, setEdit] = useState(null);
  const { preset, from, to, options, format } = prefs;

  useEffect(() => savePrefs(prefs), [prefs]);
  // 每次開啟時，快速區間依「今天」重新計算（隔天再開不會停在舊的本週）
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    const r = open && prefs.preset !== 'custom' ? presetRange(prefs.preset, today) : null;
    if (r && (r.from !== prefs.from || r.to !== prefs.to)) setPrefs({ ...prefs, ...r });
    if (open) {
      // 入口決定模版與區間：本週卡「匯報」→ 個人週報＋本週；「今日」→ 工作日誌＋今日；原按鈕 → 一般格式
      setTemplate(isTemplate(initialTemplate) ? initialTemplate : 'classic');
      const p = initialPreset && RANGE_PRESETS.some((x) => x.value === initialPreset) ? initialPreset : 'week';
      setTplRange({ preset: p, ...presetRange(p, today) });
      setPlIds([userId]);
      setTplTab('preview');
    }
  }
  const isClassic = template === 'classic';

  const days = inclusiveDays(from, to);
  const rangeError =
    days === 0
      ? '結束日不可早於開始日'
      : days > REPORT_MAX_DAYS
        ? `日期區間最長 ${REPORT_MAX_DAYS} 天`
        : null;
  const include = [
    ...(options.inProgress ? ['doing'] : []),
    ...(options.deferredTodos ? ['deferred', 'cancelled'] : []),
    ...(options.createdTasks ? ['created'] : []),
  ];
  const query = useReport(userId, { from, to }, include, open && isClassic && !rangeError);

  // ── 模版模式的資料 ──
  const users = useUsers();
  const tplDays = inclusiveDays(tplRange.from, tplRange.to);
  const tplRangeError =
    tplDays === 0
      ? '結束日不可早於開始日'
      : tplDays > REPORT_MAX_DAYS
        ? `日期區間最長 ${REPORT_MAX_DAYS} 天`
        : null;
  const selfLabel = memberName ?? selfName ?? '我';
  const members = useMemo(() => {
    if (template !== 'pl') return [{ id: userId, name: selfLabel }];
    const all = users.data ?? [];
    const picked = plIds
      .map((id) => (id === userId ? { id, name: selfLabel } : all.find((u) => u.id === id)))
      .filter(Boolean)
      .map((u) => ({ id: u.id, name: u.name ?? u.displayName }));
    return picked.length ? picked : [{ id: userId, name: selfLabel }];
  }, [template, userId, selfLabel, plIds, users.data]);
  const tplRangeObj = useMemo(() => ({ from: tplRange.from, to: tplRange.to }), [tplRange.from, tplRange.to]);
  const tpl = useTemplateOutput({
    enabled: open && !isClassic,
    template,
    members,
    userId,
    range: tplRangeObj,
    today,
    opts: tplOpts,
    rangeOk: !tplRangeError,
  });
  const tplOut = tpl.output;
  const tplWho = template === 'pl' ? (members.length > 1 ? null : members[0]?.name) : selfLabel;
  const onTplCopy = async () => {
    if (!tplOut) return;
    const how = await copyRich(tplOut.text, tplOut.html);
    if (how === 'fail') {
      toast({ tone: 'danger', title: '無法複製', description: '請改用「純文字」分頁手動選取複製' });
      return;
    }
    if (how === 'plain')
      toast({ tone: 'info', title: '已複製純文字', description: '這個瀏覽器不支援複製格式，貼上後不會有顏色' });
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };
  const onTplDownload = (ext) => {
    if (!tplOut) return;
    const name = templateFileName(template, tplRange.from, tplRange.to, ext, tplWho);
    if (ext === 'md') return download(name, 'text/markdown', tplOut.md);
    download(name, 'text/html', htmlDocument(`${TEMPLATE_LABEL[template]} ${tplRange.from}–${tplRange.to}`, tplOut.html));
  };
  const pickTplPreset = (p) => {
    const r = presetRange(p, today);
    setTplRange((prev) => (r ? { preset: p, ...r } : { ...prev, preset: p }));
  };
  const setTplDate = (k, v) => setTplRange((prev) => ({ ...prev, preset: 'custom', [k]: v }));
  const setTplOpt = (k, v) => setTplOpts((prev) => ({ ...prev, [k]: v }));
  const data = query.data;
  const hasHours = (data?.summary.hoursKnown ?? 0) > 0;
  const flags = { showDate: options.showDate, showHours: options.showHours && hasHours };

  // 預覽列出全部項目（含已取消勾選）；輸出（文字 / 下載 / 列印）則扣除取消勾選的項目
  const full = useMemo(() => (data ? buildReportModel(data, options) : null), [data, options]);
  const model = useMemo(
    () => (data ? buildReportModel(data, options, excluded) : null),
    [data, options, excluded],
  );
  const generated = model ? formatReport(model, format, flags) : '';
  const output = edit && edit.base === generated ? edit.value : generated;

  const patch = (p) => setPrefs((prev) => ({ ...prev, ...p }));
  const setOption = (k, v) => patch({ options: { ...options, [k]: v } });
  const pickPreset = (p) => {
    const r = presetRange(p, today);
    patch(r ? { preset: p, ...r } : { preset: p });
    setExcluded(new Set());
  };
  const setDate = (k, v) => {
    patch({ preset: 'custom', [k]: v });
    setExcluded(new Set());
  };
  const toggle = (key, on) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });

  const onCopy = async () => {
    const ok = await copyText(output);
    toast(
      ok
        ? { tone: 'success', title: '已複製到剪貼簿', duration: 2500 }
        : { tone: 'danger', title: '無法複製', description: '請改用「可編輯文字」分頁手動選取複製' },
    );
  };
  const who = memberName;
  const onDownload = (ext) => {
    if (!model) return;
    const name = reportFileName(from, to, ext, who);
    if (ext === 'csv') return download(name, 'text/csv', formatCsv(model, flags));
    const family = ext === 'md' ? ['markdown', 'table'] : ['plain', 'oneline'];
    if (family.includes(format)) return download(name, ext === 'md' ? 'text/markdown' : 'text/plain', output);
    const text =
      ext === 'md'
        ? format === 'table'
          ? formatTable(model, flags)
          : formatMarkdown(model, flags)
        : formatPlain(model, flags);
    download(name, ext === 'md' ? 'text/markdown' : 'text/plain', text);
  };

  const noneSelected = !options.completedTasks && !options.completedTodos && !include.length;

  /* ── 模版列與模版模式的畫面（§6.2） ── */
  const templateBar = createElement(
    'div',
    { className: 'rp-template-row' },
    createElement('span', { className: 'rp-label', id: 'rp-template-label' }, '模版'),
    createElement(
      'div',
      { className: 'rp-templates', role: 'group', 'aria-labelledby': 'rp-template-label' },
      [{ value: 'classic', label: '一般格式' }, ...TEMPLATES].map((t) =>
        createElement(
          'button',
          {
            key: t.value,
            type: 'button',
            className: 'rp-template',
            'aria-pressed': template === t.value,
            'data-template': t.value,
            onClick: () => {
              setTemplate(t.value);
              setTplTab('preview');
            },
          },
          t.label,
        ),
      ),
    ),
  );

  const tplActions = createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className: 'pl-report-actions-main rp-actions-main' },
      createElement(
        Button,
        { variant: 'primary', onClick: () => void onTplCopy(), disabled: !tplOut, 'aria-label': '一鍵複製' },
        copied ? createElement('span', { className: 'rp-copied' }, '已複製 ✓') : '一鍵複製',
      ),
      createElement(Button, { onClick: () => onTplDownload('md'), disabled: !tplOut }, '下載 .md'),
      createElement(Button, { onClick: () => onTplDownload('html'), disabled: !tplOut }, '下載 .html'),
      createElement(Button, { onClick: () => window.print(), disabled: !tplOut }, '列印'),
    ),
    createElement(
      'div',
      { className: 'pl-report-actions-side' },
      createElement(Button, { variant: 'ghost', onClick: onClose }, '關閉'),
    ),
  );

  const userOptions = (users.data ?? [])
    .filter((u) => u.isActive)
    .sort((x, y) => x.displayName.localeCompare(y.displayName, 'zh-Hant'))
    .map((u) => ({
      value: u.id,
      label: u.id === userId ? `${u.displayName}` : u.displayName,
      leading: createElement(Avatar, { user: u, size: 'xs', tooltip: false }),
    }));

  const usesBullets = template === 'worklog' || template === 'pl';
  const tplBody = createElement(
    'div',
    { className: 'pl-report rp-body', 'data-template': template },
    createElement(
      'div',
      { className: 'pl-report-controls' },
      createElement(
        'div',
        { className: 'pl-report-row' },
        createElement(
          'label',
          { className: 'pl-report-field' },
          createElement('span', null, '範圍'),
          createElement(
            'select',
            {
              'aria-label': '模版區間',
              className: 'ui-input',
              value: tplRange.preset,
              onChange: (e) => pickTplPreset(e.target.value),
            },
            RANGE_PRESETS.map((p) => createElement('option', { key: p.value, value: p.value }, p.label)),
          ),
        ),
        createElement(
          'label',
          { className: 'pl-report-field' },
          createElement('span', null, '開始日'),
          createElement('input', {
            className: 'ui-input',
            type: 'date',
            'aria-label': '模版開始日',
            value: tplRange.from,
            max: tplRange.to || undefined,
            onChange: (e) => setTplDate('from', e.target.value),
          }),
        ),
        createElement(
          'label',
          { className: 'pl-report-field' },
          createElement('span', null, '結束日'),
          createElement('input', {
            className: 'ui-input',
            type: 'date',
            'aria-label': '模版結束日',
            value: tplRange.to,
            min: tplRange.from || undefined,
            onChange: (e) => setTplDate('to', e.target.value),
          }),
        ),
      ),
      template === 'pl' &&
        createElement(
          'div',
          { className: 'rp-members' },
          createElement('span', { className: 'rp-label' }, '成員'),
          createElement(MultiSelect, {
            label: '成員',
            'aria-label': '匯報成員',
            options: userOptions,
            value: plIds,
            onChange: (v) => setPlIds(v),
          }),
          createElement(
            'span',
            { className: 'rp-hint' },
            '依成員名稱排序；每人一節，節內照工作日誌格式分專案',
          ),
        ),
      template !== 'decision' &&
      createElement(
        'fieldset',
        { className: 'pl-report-opts' },
        createElement('legend', null, '內容'),
        createElement(Checkbox, {
            label: '顯示進度%',
            checked: tplOpts.showProgress,
            onChange: (e) => setTplOpt('showProgress', e.target.checked),
          }),
        createElement(Checkbox, {
            label: '附上備註（描述第一行）',
            checked: tplOpts.showNote,
            onChange: (e) => setTplOpt('showNote', e.target.checked),
          }),
        (template === 'worklog' || template === 'weekly') &&
          createElement(Checkbox, {
            label: '含完成的自由待辦',
            checked: tplOpts.includeTodos,
            onChange: (e) => setTplOpt('includeTodos', e.target.checked),
          }),
        usesBullets &&
          createElement(
            'span',
            { className: 'rp-bullets', role: 'group', 'aria-label': '條列符號' },
            BULLETS.map((b) =>
              createElement(
                'button',
                {
                  key: b.value,
                  type: 'button',
                  className: 'rp-template rp-template--sm',
                  'aria-pressed': tplOpts.bullet === b.value,
                  'aria-label': `條列符號 ${b.label}`,
                  onClick: () => setTplOpt('bullet', b.value),
                },
                b.label,
              ),
            ),
          ),
      ),
      tplRangeError && createElement('p', { className: 'pl-report-error', role: 'alert' }, tplRangeError),
    ),
    createElement(
      'div',
      { className: 'pl-report-result', 'aria-busy': tpl.loading || undefined },
      tplRangeError
        ? null
        : tpl.error
          ? createElement(ErrorState, { error: tpl.error, onRetry: tpl.refetch })
          : !tplOut
            ? createElement(
                'div',
                { className: 'pl-report-loading' },
                createElement(Spinner, { size: 20, label: '產生中' }),
              )
            : createElement(
                Fragment,
                null,
                createElement(
                  'div',
                  { className: 'rp-head' },
                  createElement(
                    'div',
                    { className: 'pl-report-tabs', role: 'tablist', 'aria-label': '模版檢視' },
                    [
                      ['preview', '預覽'],
                      ['text', '純文字'],
                    ].map(([k, label]) =>
                      createElement(
                        'button',
                        {
                          key: k,
                          type: 'button',
                          role: 'tab',
                          id: `rp-tab-${k}`,
                          'aria-selected': tplTab === k,
                          'aria-controls': 'rp-panel',
                          tabIndex: tplTab === k ? 0 : -1,
                          className: 'pl-report-tab',
                          onClick: () => setTplTab(k),
                          onKeyDown: (e) => {
                            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                              e.preventDefault();
                              const next = k === 'preview' ? 'text' : 'preview';
                              setTplTab(next);
                              document.getElementById(`rp-tab-${next}`)?.focus();
                            }
                          },
                        },
                        label,
                      ),
                    ),
                  ),
                  template !== 'decision' &&
                    createElement(
                      'span',
                      { className: 'rp-summary', role: 'status', 'data-testid': 'template-summary' },
                      tpl.summary,
                    ),
                ),
                createElement(
                  'div',
                  { id: 'rp-panel', role: 'tabpanel', 'aria-labelledby': `rp-tab-${tplTab}` },
                  tplTab === 'preview'
                    ? createElement('div', {
                        className: 'rp-preview',
                        'data-testid': 'template-preview',
                        dangerouslySetInnerHTML: { __html: tplOut.html },
                      })
                    : createElement('textarea', {
                        className: 'ui-textarea pl-report-textarea rp-plain',
                        'aria-label': '純文字',
                        readOnly: true,
                        value: tplOut.text,
                        spellCheck: false,
                        onFocus: (e) => e.target.select(),
                      }),
                ),
                createElement(
                  'p',
                  { className: 'rp-foot' },
                  '「一鍵複製」同時帶格式與純文字：貼進 Word／Google Docs／投影片保留顏色與條列，貼進純文字框就是乾淨文字。',
                ),
              ),
    ),
  );

  return createElement(
    Dialog,
    {
      open: open,
      onClose: onClose,
      size: 'lg',
      title: who ? `匯報報告：${who}` : '匯報報告',
      actions: !isClassic
        ? tplActions
        : createElement(
        Fragment,
        null,
        createElement(
          'div',
          { className: 'pl-report-actions-main' },
          createElement(
            'select',
            {
              className: 'ui-input pl-report-select',
              'aria-label': '輸出格式',
              value: format,
              onChange: (e) => patch({ format: e.target.value }),
            },
            REPORT_FORMATS.map((f) => createElement('option', { key: f.value, value: f.value }, f.label)),
          ),
          createElement(
            Button,
            { variant: 'primary', onClick: () => void onCopy(), disabled: !model },
            '複製',
          ),
        ),
        createElement(
          'div',
          { className: 'pl-report-actions-side', role: 'group', 'aria-label': '下載與列印' },
          createElement(Button, { onClick: () => onDownload('md'), disabled: !model }, '下載 .md'),
          createElement(Button, { onClick: () => onDownload('txt'), disabled: !model }, '下載 .txt'),
          createElement(Button, { onClick: () => onDownload('csv'), disabled: !model }, '下載 .csv'),
          createElement(Button, { onClick: () => window.print(), disabled: !model }, '列印'),
        ),
      ),
    },
    templateBar,
    !isClassic
      ? tplBody
      : createElement(
      'div',
      { className: 'pl-report' },
      createElement(
        'div',
        { className: 'pl-report-controls' },
        createElement(
          'div',
          { className: 'pl-report-row' },
          createElement(
            'label',
            { className: 'pl-report-field' },
            createElement('span', null, '期間'),
            createElement(
              'select',
              {
                'aria-label': '快速區間',
                className: 'ui-input',
                value: preset,
                onChange: (e) => pickPreset(e.target.value),
              },
              RANGE_PRESETS.map((p) => createElement('option', { key: p.value, value: p.value }, p.label)),
            ),
          ),
          createElement(
            'label',
            { className: 'pl-report-field' },
            createElement('span', null, '開始日'),
            createElement('input', {
              className: 'ui-input',
              type: 'date',
              value: from,
              max: to || undefined,
              onChange: (e) => setDate('from', e.target.value),
            }),
          ),
          createElement(
            'label',
            { className: 'pl-report-field' },
            createElement('span', null, '結束日'),
            createElement('input', {
              className: 'ui-input',
              type: 'date',
              value: to,
              min: from || undefined,
              onChange: (e) => setDate('to', e.target.value),
            }),
          ),
        ),
        createElement(
          'fieldset',
          { className: 'pl-report-opts' },
          createElement('legend', null, '納入內容'),
          createElement(Checkbox, {
            label: '已完成的任務',
            checked: options.completedTasks,
            onChange: (e) => setOption('completedTasks', e.target.checked),
          }),
          createElement(Checkbox, {
            label: '已完成的待辦',
            checked: options.completedTodos,
            onChange: (e) => setOption('completedTodos', e.target.checked),
          }),
          createElement(Checkbox, {
            label: '進行中的任務',
            checked: options.inProgress,
            onChange: (e) => setOption('inProgress', e.target.checked),
          }),
          createElement(Checkbox, {
            label: '延後／取消的待辦',
            checked: options.deferredTodos,
            onChange: (e) => setOption('deferredTodos', e.target.checked),
          }),
          createElement(Checkbox, {
            label: '期間新建立的任務',
            checked: options.createdTasks,
            onChange: (e) => setOption('createdTasks', e.target.checked),
          }),
        ),
        createElement(
          'fieldset',
          { className: 'pl-report-opts' },
          createElement('legend', null, '呈現方式'),
          createElement(Checkbox, {
            label: '依專案分組',
            checked: options.groupByProject,
            onChange: (e) => setOption('groupByProject', e.target.checked),
          }),
          hasHours &&
            createElement(Checkbox, {
              label: '顯示預估工時',
              checked: options.showHours,
              onChange: (e) => setOption('showHours', e.target.checked),
            }),
          createElement(Checkbox, {
            label: '顯示完成日期',
            checked: options.showDate,
            onChange: (e) => setOption('showDate', e.target.checked),
          }),
        ),
        rangeError && createElement('p', { className: 'pl-report-error', role: 'alert' }, rangeError),
      ),

      createElement(
        'div',
        { className: 'pl-report-result', 'aria-busy': query.isFetching || undefined },
        rangeError
          ? null
          : query.isError
            ? createElement(ErrorState, { error: query.error, onRetry: () => void query.refetch() })
            : !full || !model
              ? createElement(
                  'div',
                  { className: 'pl-report-loading' },
                  createElement(Spinner, { size: 20, label: '產生中' }),
                )
              : createElement(
                  Fragment,
                  null,
                  createElement(
                    'p',
                    { className: 'pl-report-summary', role: 'status', 'data-testid': 'report-summary' },
                    model.summary,
                    flags.showHours &&
                      model.hoursTotal != null &&
                      createElement(
                        'span',
                        null,
                        ' ',
                        '· 預估工時合計 ',
                        Math.round(model.hoursTotal * 100) / 100,
                        ' 小時（',
                        model.hoursKnown,
                        ' ',
                        '件有填）',
                      ),
                  ),
                  createElement(
                    'div',
                    { className: 'pl-report-tabs', role: 'tablist', 'aria-label': '報告檢視' },
                    [
                      ['preview', '預覽'],
                      ['text', '可編輯文字'],
                    ].map(([k, label]) =>
                      createElement(
                        'button',
                        {
                          key: k,
                          type: 'button',
                          role: 'tab',
                          id: `pl-report-tab-${k}`,
                          'aria-selected': tab === k,
                          'aria-controls': 'pl-report-panel',
                          tabIndex: tab === k ? 0 : -1,
                          className: 'pl-report-tab',
                          onClick: () => setTab(k),
                          onKeyDown: (e) => {
                            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                              e.preventDefault();
                              setTab(k === 'preview' ? 'text' : 'preview');
                              document
                                .getElementById(`pl-report-tab-${k === 'preview' ? 'text' : 'preview'}`)
                                ?.focus();
                            }
                          },
                        },
                        label,
                      ),
                    ),
                  ),
                  createElement(
                    'div',
                    {
                      id: 'pl-report-panel',
                      role: 'tabpanel',
                      'aria-labelledby': `pl-report-tab-${tab}`,
                      className: 'pl-report-panel',
                    },
                    tab === 'preview'
                      ? noneSelected
                        ? createElement('p', { className: 'pl-report-empty' }, '請至少勾選一項要納入的內容')
                        : full.empty
                          ? createElement('p', { className: 'pl-report-empty' }, EMPTY_TEXT)
                          : full.sections.map((s) =>
                              createElement(
                                'section',
                                { key: s.key, className: 'pl-report-section', 'aria-label': s.heading },
                                createElement('h3', { className: 'pl-report-heading' }, s.heading),
                                s.groups.map((g) =>
                                  createElement(
                                    'div',
                                    { key: g.name ?? '', className: 'pl-report-group' },
                                    g.name &&
                                      createElement(
                                        'div',
                                        { className: 'pl-report-project' },
                                        createElement(ColorDot, { color: g.color }),
                                        createElement('span', null, g.name),
                                      ),
                                    createElement(
                                      'ul',
                                      { className: 'pl-report-list' },
                                      g.items.map((it) => {
                                        const on = !excluded.has(it.key);
                                        return createElement(
                                          'li',
                                          {
                                            key: it.key,
                                            className: 'pl-report-item',
                                            'data-excluded': !on || undefined,
                                          },
                                          createElement(Checkbox, {
                                            checked: on,
                                            'aria-label': `納入：${it.title}`,
                                            onChange: (e) => toggle(it.key, e.target.checked),
                                          }),
                                          options.showDate &&
                                            it.date &&
                                            createElement(
                                              'span',
                                              { className: 'pl-report-date' },
                                              formatReportDate(it.date, full.year),
                                            ),
                                          !g.name &&
                                            it.projectName &&
                                            createElement(ColorDot, { color: it.projectColor }),
                                          createElement('span', { className: 'pl-report-title' }, it.title),
                                          it.note &&
                                            createElement('span', { className: 'pl-report-note' }, it.note),
                                          flags.showHours &&
                                            it.hours != null &&
                                            createElement(
                                              'span',
                                              { className: 'pl-report-note' },
                                              '預估 ',
                                              Math.round(it.hours * 100) / 100,
                                              ' 小時',
                                            ),
                                        );
                                      }),
                                    ),
                                  ),
                                ),
                              ),
                            )
                      : createElement(
                          'div',
                          { className: 'pl-report-text' },
                          createElement('textarea', {
                            className: 'ui-textarea pl-report-textarea',
                            'aria-label': '可編輯文字',
                            value: output,
                            onChange: (e) => setEdit({ base: generated, value: e.target.value }),
                            spellCheck: false,
                          }),
                          createElement(
                            'div',
                            { className: 'pl-report-text-foot' },
                            createElement(
                              'span',
                              null,
                              '在這裡修改的文字會用於「複製」與 .md / .txt 下載；.csv 依預覽內容產生。',
                            ),
                            edit &&
                              edit.base === generated &&
                              createElement(
                                'button',
                                { type: 'button', className: 'pl-linkbtn', onClick: () => setEdit(null) },
                                '還原自動產生的文字',
                              ),
                          ),
                        ),
                  ),
                ),
      ),
    ),
    open && !isClassic && tplOut && createElement(TemplatePrintView, { html: tplOut.html }),
    open &&
      isClassic &&
      model &&
      createElement(PrintView, { model: model, showDate: flags.showDate, showHours: flags.showHours }),
  );
}
