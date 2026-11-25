import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { REPORT_MAX_DAYS, type ReportIncludeKey } from '../../../shared/personal.ts';
import { toast } from '../../lib/toast.ts';
import { Button, Checkbox, ColorDot, Dialog, ErrorState, Spinner } from '../../ui/index.ts';
import { useReport } from './api.ts';
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
  type RangePreset,
  type ReportFormat,
  type ReportModel,
  type ReportOptions,
} from './reportFormat.ts';

const PREFS_KEY = 'personal-report-prefs';

type Prefs = { preset: RangePreset; from: string; to: string; options: ReportOptions; format: ReportFormat };

const isPreset = (v: unknown): v is RangePreset => RANGE_PRESETS.some((p) => p.value === v);
const isFormat = (v: unknown): v is ReportFormat => REPORT_FORMATS.some((f) => f.value === v);

/** 讀取上次的選項與區間（localStorage 失敗或內容不合法時用預設值） */
function loadPrefs(today: string): Prefs {
  const base: Prefs = {
    preset: 'week',
    ...(presetRange('week', today) as { from: string; to: string }),
    options: DEFAULT_REPORT_OPTIONS,
    format: 'plain',
  };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null;
    if (!raw || typeof raw !== 'object') return base;
    const options = { ...DEFAULT_REPORT_OPTIONS };
    for (const k of Object.keys(options) as (keyof ReportOptions)[]) {
      if (typeof raw.options?.[k] === 'boolean') options[k] = raw.options[k];
    }
    const preset = isPreset(raw.preset) ? raw.preset : 'week';
    const range =
      preset === 'custom'
        ? typeof raw.from === 'string' && typeof raw.to === 'string' && inclusiveDays(raw.from, raw.to) > 0
          ? { from: raw.from, to: raw.to }
          : (presetRange('week', today) as { from: string; to: string })
        : (presetRange(preset, today) as { from: string; to: string });
    return { preset, ...range, options, format: isFormat(raw.format) ? raw.format : 'plain' };
  } catch {
    return base;
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // 無法儲存不影響使用
  }
}

function download(name: string, mime: string, text: string) {
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

async function copyText(text: string): Promise<boolean> {
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
function PrintView({
  model,
  showDate,
  showHours,
}: {
  model: ReportModel;
  showDate: boolean;
  showHours: boolean;
}) {
  return createPortal(
    <div className="pl-report-print-portal" aria-hidden="true">
      <h1>{model.memberName ? `${model.title}：${model.memberName}` : model.title}</h1>
      <p>{model.summary}</p>
      {showHours && model.hoursTotal != null && (
        <p>
          預估工時合計 {Math.round(model.hoursTotal * 100) / 100} 小時（{model.hoursKnown} 件有填）
        </p>
      )}
      {model.empty && <p>{EMPTY_TEXT}</p>}
      {model.sections.map((s) => (
        <section key={s.key}>
          <h2>{s.heading}</h2>
          {s.groups.map((g) => (
            <div key={g.name ?? ''}>
              {g.name && <h3>{g.name}</h3>}
              <ul>
                {g.items.map((it) => (
                  <li key={it.key}>
                    {showDate && it.date ? `${formatReportDate(it.date, model.year)} ` : ''}
                    {it.title}
                    {it.note ? `（${it.note}）` : ''}
                    {showHours && it.hours != null ? `（預估 ${Math.round(it.hours * 100) / 100} 小時）` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>,
    document.body,
  );
}

/**
 * 匯報報告對話框：選日期區間與內容 → 即時預覽（每項可取消勾選、可編輯文字）→ 複製 / 下載 / 列印。
 * 報告是讓人整理自己做了什麼，語氣中性；檢視他人清單時為該成員產生（唯讀資料，標題標示名稱）。
 */
export function ReportDialog({
  open,
  onClose,
  userId,
  memberName,
}: {
  open: boolean;
  onClose: () => void;
  userId: number;
  /** 檢視他人時的成員名稱；本人為 null */
  memberName: string | null;
}) {
  const today = toDateString(new Date());
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(today));
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<'preview' | 'text'>('preview');
  const [edit, setEdit] = useState<{ base: string; value: string } | null>(null);
  const { preset, from, to, options, format } = prefs;

  useEffect(() => savePrefs(prefs), [prefs]);
  // 每次開啟時，快速區間依「今天」重新計算（隔天再開不會停在舊的本週）
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    const r = open && prefs.preset !== 'custom' ? presetRange(prefs.preset, today) : null;
    if (r && (r.from !== prefs.from || r.to !== prefs.to)) setPrefs({ ...prefs, ...r });
  }

  const days = inclusiveDays(from, to);
  const rangeError =
    days === 0
      ? '結束日不可早於開始日'
      : days > REPORT_MAX_DAYS
        ? `日期區間最長 ${REPORT_MAX_DAYS} 天`
        : null;
  const include: ReportIncludeKey[] = [
    ...(options.inProgress ? (['doing'] as const) : []),
    ...(options.deferredTodos ? (['deferred', 'cancelled'] as const) : []),
    ...(options.createdTasks ? (['created'] as const) : []),
  ];
  const query = useReport(userId, { from, to }, include, open && !rangeError);
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

  const patch = (p: Partial<Prefs>) => setPrefs((prev) => ({ ...prev, ...p }));
  const setOption = (k: keyof ReportOptions, v: boolean) => patch({ options: { ...options, [k]: v } });
  const pickPreset = (p: RangePreset) => {
    const r = presetRange(p, today);
    patch(r ? { preset: p, ...r } : { preset: p });
    setExcluded(new Set());
  };
  const setDate = (k: 'from' | 'to', v: string) => {
    patch({ preset: 'custom', [k]: v });
    setExcluded(new Set());
  };
  const toggle = (key: string, on: boolean) =>
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
  const onDownload = (ext: 'md' | 'txt' | 'csv') => {
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

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={who ? `匯報報告：${who}` : '匯報報告'}
      actions={
        <>
          <div className="pl-report-actions-main">
            <select
              className="ui-input pl-report-select"
              aria-label="輸出格式"
              value={format}
              onChange={(e) => patch({ format: e.target.value as ReportFormat })}
            >
              {REPORT_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <Button variant="primary" onClick={() => void onCopy()} disabled={!model}>
              複製
            </Button>
          </div>
          <div className="pl-report-actions-side" role="group" aria-label="下載與列印">
            <Button onClick={() => onDownload('md')} disabled={!model}>
              下載 .md
            </Button>
            <Button onClick={() => onDownload('txt')} disabled={!model}>
              下載 .txt
            </Button>
            <Button onClick={() => onDownload('csv')} disabled={!model}>
              下載 .csv
            </Button>
            <Button onClick={() => window.print()} disabled={!model}>
              列印
            </Button>
          </div>
        </>
      }
    >
      <div className="pl-report">
        <div className="pl-report-controls">
          <div className="pl-report-row">
            <label className="pl-report-field">
              <span>期間</span>
              <select
                aria-label="快速區間"
                className="ui-input"
                value={preset}
                onChange={(e) => pickPreset(e.target.value as RangePreset)}
              >
                {RANGE_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="pl-report-field">
              <span>開始日</span>
              <input
                className="ui-input"
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setDate('from', e.target.value)}
              />
            </label>
            <label className="pl-report-field">
              <span>結束日</span>
              <input
                className="ui-input"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setDate('to', e.target.value)}
              />
            </label>
          </div>
          <fieldset className="pl-report-opts">
            <legend>納入內容</legend>
            <Checkbox
              label="已完成的任務"
              checked={options.completedTasks}
              onChange={(e) => setOption('completedTasks', e.target.checked)}
            />
            <Checkbox
              label="已完成的待辦"
              checked={options.completedTodos}
              onChange={(e) => setOption('completedTodos', e.target.checked)}
            />
            <Checkbox
              label="進行中的任務"
              checked={options.inProgress}
              onChange={(e) => setOption('inProgress', e.target.checked)}
            />
            <Checkbox
              label="延後／取消的待辦"
              checked={options.deferredTodos}
              onChange={(e) => setOption('deferredTodos', e.target.checked)}
            />
            <Checkbox
              label="期間新建立的任務"
              checked={options.createdTasks}
              onChange={(e) => setOption('createdTasks', e.target.checked)}
            />
          </fieldset>
          <fieldset className="pl-report-opts">
            <legend>呈現方式</legend>
            <Checkbox
              label="依專案分組"
              checked={options.groupByProject}
              onChange={(e) => setOption('groupByProject', e.target.checked)}
            />
            {hasHours && (
              <Checkbox
                label="顯示預估工時"
                checked={options.showHours}
                onChange={(e) => setOption('showHours', e.target.checked)}
              />
            )}
            <Checkbox
              label="顯示完成日期"
              checked={options.showDate}
              onChange={(e) => setOption('showDate', e.target.checked)}
            />
          </fieldset>
          {rangeError && (
            <p className="pl-report-error" role="alert">
              {rangeError}
            </p>
          )}
        </div>

        <div className="pl-report-result" aria-busy={query.isFetching || undefined}>
          {rangeError ? null : query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : !full || !model ? (
            <div className="pl-report-loading">
              <Spinner size={20} label="產生中" />
            </div>
          ) : (
            <>
              <p className="pl-report-summary" role="status" data-testid="report-summary">
                {model.summary}
                {flags.showHours && model.hoursTotal != null && (
                  <span>
                    {' '}
                    · 預估工時合計 {Math.round(model.hoursTotal * 100) / 100} 小時（{model.hoursKnown}{' '}
                    件有填）
                  </span>
                )}
              </p>
              <div className="pl-report-tabs" role="tablist" aria-label="報告檢視">
                {(
                  [
                    ['preview', '預覽'],
                    ['text', '可編輯文字'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    id={`pl-report-tab-${k}`}
                    aria-selected={tab === k}
                    aria-controls="pl-report-panel"
                    tabIndex={tab === k ? 0 : -1}
                    className="pl-report-tab"
                    onClick={() => setTab(k)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                        e.preventDefault();
                        setTab(k === 'preview' ? 'text' : 'preview');
                        document
                          .getElementById(`pl-report-tab-${k === 'preview' ? 'text' : 'preview'}`)
                          ?.focus();
                      }
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div
                id="pl-report-panel"
                role="tabpanel"
                aria-labelledby={`pl-report-tab-${tab}`}
                className="pl-report-panel"
              >
                {tab === 'preview' ? (
                  noneSelected ? (
                    <p className="pl-report-empty">請至少勾選一項要納入的內容</p>
                  ) : full.empty ? (
                    <p className="pl-report-empty">{EMPTY_TEXT}</p>
                  ) : (
                    full.sections.map((s) => (
                      <section key={s.key} className="pl-report-section" aria-label={s.heading}>
                        <h3 className="pl-report-heading">{s.heading}</h3>
                        {s.groups.map((g) => (
                          <div key={g.name ?? ''} className="pl-report-group">
                            {g.name && (
                              <div className="pl-report-project">
                                <ColorDot color={g.color} />
                                <span>{g.name}</span>
                              </div>
                            )}
                            <ul className="pl-report-list">
                              {g.items.map((it) => {
                                const on = !excluded.has(it.key);
                                return (
                                  <li
                                    key={it.key}
                                    className="pl-report-item"
                                    data-excluded={!on || undefined}
                                  >
                                    <Checkbox
                                      checked={on}
                                      aria-label={`納入：${it.title}`}
                                      onChange={(e) => toggle(it.key, e.target.checked)}
                                    />
                                    {options.showDate && it.date && (
                                      <span className="pl-report-date">
                                        {formatReportDate(it.date, full.year)}
                                      </span>
                                    )}
                                    {!g.name && it.projectName && <ColorDot color={it.projectColor} />}
                                    <span className="pl-report-title">{it.title}</span>
                                    {it.note && <span className="pl-report-note">{it.note}</span>}
                                    {flags.showHours && it.hours != null && (
                                      <span className="pl-report-note">
                                        預估 {Math.round(it.hours * 100) / 100} 小時
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        ))}
                      </section>
                    ))
                  )
                ) : (
                  <div className="pl-report-text">
                    <textarea
                      className="ui-textarea pl-report-textarea"
                      aria-label="可編輯文字"
                      value={output}
                      onChange={(e) => setEdit({ base: generated, value: e.target.value })}
                      spellCheck={false}
                    />
                    <div className="pl-report-text-foot">
                      <span>在這裡修改的文字會用於「複製」與 .md / .txt 下載；.csv 依預覽內容產生。</span>
                      {edit && edit.base === generated && (
                        <button type="button" className="pl-linkbtn" onClick={() => setEdit(null)}>
                          還原自動產生的文字
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {open && model && <PrintView model={model} showDate={flags.showDate} showHours={flags.showHours} />}
    </Dialog>
  );
}
