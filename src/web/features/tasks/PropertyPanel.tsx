import { useEffect, useRef, useState } from 'react';
import { TAG_COLORS, type TagColor } from '../../../shared/projects.ts';
import {
  PROPERTY_TYPES,
  type PropertyDef,
  type PropertyType,
  type SelectOption,
} from '../../../shared/properties.ts';
import type { Task } from '../../../shared/tasks.ts';
import { errorMessage } from '../../lib/api.ts';
import { useProjectsById, useProperties } from '../../lib/hooks.ts';
import { Alert, Button, ColorDot, Dialog, Field, Input, Select } from '../../ui/index.ts';
import { useCreateProperty, useDeleteProperty, useUpdateProperty } from './data.ts';
import {
  checkOptions,
  checkPropertyName,
  countOptionUsage,
  newOptionId,
  nextOptionColor,
  PROPERTY_TYPE_LABELS,
} from './model.ts';
import { Popover } from './Popover.tsx';

const TYPE_GLYPH: Record<PropertyType, string> = {
  text: 'T',
  number: '#',
  select: '◉',
  multi_select: '≡',
  date: '▦',
  checkbox: '☑',
  url: '↗',
  person: '@',
};

export function TypeIcon({ type }: { type: PropertyType }) {
  return (
    <span className="tl-type-icon" aria-hidden="true">
      {TYPE_GLYPH[type]}
    </span>
  );
}

const isSelectType = (t: PropertyType) => t === 'select' || t === 'multi_select';

type DraftOption = SelectOption & { color: TagColor };

/** 選項編輯區：色點（8 色調色盤）+ 名稱 + 刪除；Enter 新增下一列 */
function OptionsEditor({
  options,
  onChange,
}: {
  options: DraftOption[];
  onChange: (next: DraftOption[]) => void;
}) {
  const [palette, setPalette] = useState<{ id: string; el: HTMLElement } | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusId) return;
    listRef.current?.querySelector<HTMLInputElement>(`[data-opt="${focusId}"]`)?.focus();
  }, [focusId]);

  const add = () => {
    const id = newOptionId(options);
    onChange([...options, { id, label: '', color: nextOptionColor(options.length) }]);
    setFocusId(id);
  };
  const patch = (id: string, p: Partial<DraftOption>) =>
    onChange(options.map((o) => (o.id === id ? { ...o, ...p } : o)));

  return (
    <div className="tl-options" ref={listRef}>
      {options.map((o, i) => (
        <div key={o.id} className="tl-option-row">
          <button
            type="button"
            className="tl-color-btn"
            aria-label={`選項 ${i + 1} 顏色`}
            onClick={(e) => setPalette({ id: o.id, el: e.currentTarget })}
          >
            <ColorDot color={o.color} size="md" />
          </button>
          <Input
            size="sm"
            value={o.label}
            aria-label={`選項 ${i + 1}`}
            placeholder={`選項${i + 1}`}
            data-opt={o.id}
            onChange={(e) => patch(o.id, { label: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="x"
            aria-label={`刪除選項 ${i + 1}`}
            onClick={() => onChange(options.filter((x) => x.id !== o.id))}
          />
        </div>
      ))}
      <Button variant="ghost" size="sm" icon="plus" onClick={add}>
        新增選項
      </Button>
      {palette && (
        <Popover anchor={palette.el} onClose={() => setPalette(null)} label="選擇顏色">
          <div className="tl-palette">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="tl-palette-btn"
                aria-label={c}
                onClick={() => {
                  patch(palette.id, { color: c });
                  setPalette(null);
                }}
              >
                <ColorDot color={c} size="md" />
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

/** 被刪除但仍有任務使用的選項 → 警示 */
function RemovedWarnings({
  before,
  after,
  usage,
}: {
  before: SelectOption[];
  after: SelectOption[];
  usage: (optionId: string) => number;
}) {
  const removed = before.filter((o) => !after.some((a) => a.id === o.id));
  const warn = removed.map((o) => ({ o, n: usage(o.id) })).filter((x) => x.n > 0);
  if (!warn.length) return null;
  return (
    <div className="tl-warn-list">
      {warn.map(({ o, n }) => (
        <Alert key={o.id} tone="warning">
          「{o.label}」{n} 筆任務使用中，刪除後這些值會被清除
        </Alert>
      ))}
    </div>
  );
}

const toDraft = (opts: SelectOption[]): DraftOption[] =>
  opts.map((o, i) => ({ ...o, color: (o.color ?? nextOptionColor(i - 1)) as TagColor }));
const cleanOptions = (opts: DraftOption[]): SelectOption[] =>
  opts.filter((o) => o.label.trim()).map((o) => ({ ...o, label: o.label.trim() }));

/** §6.1 新增欄位面板內容 */
export function NewPropertyForm({
  scopeProjectId,
  onDone,
}: {
  /** FilterBar 恰好選一個專案時的專案 id（可選「僅此專案」） */
  scopeProjectId: number | null;
  onDone: (created?: PropertyDef) => void;
}) {
  const properties = useProperties().data ?? [];
  const projects = useProjectsById();
  const create = useCreateProperty();
  const [name, setName] = useState('');
  const [type, setType] = useState<PropertyType>('text');
  const [options, setOptions] = useState<DraftOption[]>([{ id: 'o1', label: '', color: nextOptionColor(0) }]);
  const [scope, setScope] = useState<'all' | 'project'>('all');
  const [touched, setTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  const nameError = checkPropertyName(name, properties);
  const optError = isSelectType(type) ? checkOptions(options) : null;
  const canSubmit = !nameError && !optError && !create.isPending;
  const project = scopeProjectId != null ? projects.get(scopeProjectId) : undefined;

  const submit = () => {
    if (!canSubmit) return;
    create.mutate(
      {
        name: name.trim(),
        type,
        options: isSelectType(type) ? cleanOptions(options) : undefined,
        projectId: scope === 'project' && scopeProjectId != null ? scopeProjectId : null,
      },
      { onSuccess: (p) => onDone(p) },
    );
  };

  return (
    <form
      className="tl-prop-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="tl-prop-title">新增欄位</div>
      {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
      <Field label="名稱" error={touched && name.trim() && nameError ? nameError : undefined}>
        <Input
          ref={nameRef}
          size="sm"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setTouched(true);
          }}
        />
      </Field>
      <Field label="型別">
        <Select<PropertyType>
          aria-label="型別"
          value={type}
          onChange={setType}
          options={PROPERTY_TYPES.map((t) => ({
            value: t,
            label: PROPERTY_TYPE_LABELS[t],
            leading: <TypeIcon type={t} />,
          }))}
        />
      </Field>
      {isSelectType(type) && (
        <div className="ui-field">
          <span className="ui-label">選項</span>
          <OptionsEditor options={options} onChange={setOptions} />
        </div>
      )}
      <fieldset className="tl-scope">
        <legend className="ui-label">範圍</legend>
        <label className="ui-checkbox-label">
          <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />
          所有專案
        </label>
        <label className="ui-checkbox-label" aria-disabled={!project || undefined}>
          <input
            type="radio"
            name="scope"
            disabled={!project}
            checked={scope === 'project'}
            onChange={() => setScope('project')}
          />
          {project ? `僅「${project.name}」` : '僅此專案'}
        </label>
        {!project && <span className="ui-hint">先篩選單一專案</span>}
      </fieldset>
      <div className="tl-prop-actions">
        <Button variant="secondary" size="sm" onClick={() => onDone()}>
          取消
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={!canSubmit} loading={create.isPending}>
          建立
        </Button>
      </div>
    </form>
  );
}

/** §6.2 編輯選項（Popover 內容） */
export function EditOptionsForm({
  property,
  tasks,
  onDone,
}: {
  property: PropertyDef;
  tasks: Task[];
  onDone: () => void;
}) {
  const update = useUpdateProperty();
  const [options, setOptions] = useState<DraftOption[]>(() => toDraft(property.options));
  const error = checkOptions(options);
  const usage = (id: string) => countOptionUsage(tasks, property.id, id);
  return (
    <form
      className="tl-prop-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (error) return;
        update.mutate({ id: property.id, options: cleanOptions(options) }, { onSuccess: onDone });
      }}
    >
      <div className="tl-prop-title">編輯選項：{property.name}</div>
      {update.isError && <Alert tone="danger">{errorMessage(update.error)}</Alert>}
      <OptionsEditor options={options} onChange={setOptions} />
      <RemovedWarnings before={property.options} after={options} usage={usage} />
      {error && <span className="ui-field-error">{error}</span>}
      <div className="tl-prop-actions">
        <Button variant="secondary" size="sm" onClick={onDone}>
          取消
        </Button>
        <Button variant="primary" size="sm" type="submit" disabled={!!error} loading={update.isPending}>
          儲存
        </Button>
      </div>
    </form>
  );
}

/** §6.2 刪除欄位確認 */
export function DeletePropertyDialog({
  property,
  onClose,
}: {
  property: PropertyDef | null;
  onClose: () => void;
}) {
  const del = useDeleteProperty();
  return (
    <Dialog
      open={!!property}
      onClose={onClose}
      role="alertdialog"
      title={`刪除欄位「${property?.name ?? ''}」？`}
      actions={
        <>
          <Button variant="secondary" onClick={onClose} data-autofocus>
            取消
          </Button>
          <Button
            variant="danger"
            loading={del.isPending}
            onClick={() => property && del.mutate(property.id, { onSuccess: onClose })}
          >
            刪除欄位
          </Button>
        </>
      }
    >
      <p className="m-0">所有任務在此欄位的值將不再顯示，此動作無法復原。</p>
      {del.isError && (
        <div style={{ marginTop: 12 }}>
          <Alert tone="danger">{errorMessage(del.error)}</Alert>
        </div>
      )}
    </Dialog>
  );
}
