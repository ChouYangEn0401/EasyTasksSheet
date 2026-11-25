import { useState, type ReactNode } from 'react';
import {
  ENG_CATEGORY_LABELS,
  ISSUE_CATEGORIES,
  WORKTREE_CATEGORIES,
  type EngStatus,
  type EngStatusCategory,
  type EngStatusKind,
} from '../../../shared/engManual.ts';
import { TAG_COLORS, type TagColor } from '../../../shared/projects.ts';
import { errorMessage } from '../../lib/api.ts';
import { tagVars } from '../../lib/colors.ts';
import { useCan } from '../../lib/permissions.ts';
import { notifySuccess } from '../../lib/toast.ts';
import { Alert, Badge, Button, ColorDot, Dialog, Field, Icon, Input, Select } from '../../ui/index.ts';
import { useCreateEngStatus, useDeleteEngStatus, useUpdateEngStatus } from './api.ts';
import { selectableStatuses, statusView } from './model.ts';
import { StatusAdminContext, useStatusAdmin, useStatusList, type StatusAdminState } from './statusHooks.ts';

const KIND_LABEL: Record<EngStatusKind, string> = { issue: '問題', worktree: '工作樹' };
const CATEGORIES: Record<EngStatusKind, readonly EngStatusCategory[]> = {
  issue: ISSUE_CATEGORIES,
  worktree: WORKTREE_CATEGORIES,
};
const CATEGORY_HINT: Record<EngStatusKind, string> = {
  issue: '「已結案」類預設隱藏，可勾選「顯示已結案」查看',
  worktree: '「已結束」類預設隱藏（可勾選「顯示已清理」），也不會提示回報中找不到',
};

// ── 對話框開關（EngPage 提供） ──

export function StatusAdminProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StatusAdminState>(null);
  const [seq, setSeq] = useState(0);
  const canManage = useCan('eng.status.manage');
  const open = (s: StatusAdminState) => {
    setSeq((n) => n + 1);
    setState(s);
  };
  return (
    <StatusAdminContext.Provider value={open}>
      {children}
      {canManage && state?.mode === 'add' && (
        <AddStatusDialog
          key={seq}
          kind={state.kind}
          onCreated={state.onCreated}
          onClose={() => setState(null)}
        />
      )}
      {canManage && state?.mode === 'manage' && (
        <StatusManagerDialog key={seq} kind={state.kind} onClose={() => setState(null)} />
      )}
    </StatusAdminContext.Provider>
  );
}

/** 管理入口按鈕（工具列用；無權限不顯示） */
export function ManageStatusesButton({ kind }: { kind: EngStatusKind }) {
  const canManage = useCan('eng.status.manage');
  const open = useStatusAdmin();
  if (!canManage) return null;
  return (
    <Button variant="ghost" size="sm" icon="pencil" onClick={() => open({ mode: 'manage', kind })}>
      管理狀態
    </Button>
  );
}

/** 狀態下拉：由 eng_statuses 驅動；底部「＋ 新增狀態…」「管理狀態…」（需 eng.status.manage） */
export function StatusSelect({
  kind,
  value,
  onChange,
  label,
  badge = false,
}: {
  kind: EngStatusKind;
  value: string;
  onChange: (key: string) => void;
  label: string;
  /** 以膠囊顯示目前值（表格列內） */
  badge?: boolean;
}) {
  const list = useStatusList(kind);
  const canManage = useCan('eng.status.manage');
  const open = useStatusAdmin();
  const current = statusView(list, kind, value);
  const options = selectableStatuses(list, value).map((s) => ({
    value: s.key,
    label: s.isArchived ? `${s.label}（已封存）` : s.label,
    leading: <ColorDot color={s.color} size="md" />,
  }));
  if (!options.some((o) => o.value === value)) {
    options.push({ value, label: current.label, leading: <ColorDot color={current.color} size="md" /> });
  }
  return (
    <Select
      options={options}
      value={value}
      onChange={(v) => {
        if (v !== value) onChange(v);
      }}
      aria-label={label}
      renderValue={
        badge
          ? () => (
              <Badge tone={current.color} dot>
                {current.label}
              </Badge>
            )
          : undefined
      }
      footer={
        canManage
          ? (close) => (
              <>
                <button
                  type="button"
                  className="ui-option"
                  onClick={() => {
                    close();
                    open({ mode: 'add', kind, onCreated: onChange });
                  }}
                >
                  <Icon name="plus" />
                  <span className="ui-option-label">新增狀態…</span>
                </button>
                <button
                  type="button"
                  className="ui-option"
                  onClick={() => {
                    close();
                    open({ mode: 'manage', kind });
                  }}
                >
                  <Icon name="pencil" />
                  <span className="ui-option-label">管理狀態…</span>
                </button>
              </>
            )
          : undefined
      }
    />
  );
}

// ── 色票、類別 ──

function ColorPicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (c: TagColor) => void;
  label: string;
}) {
  return (
    <div className="adm-colors" role="radiogroup" aria-label={label}>
      {TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          title={c}
          className="adm-swatch"
          data-selected={value === c || undefined}
          style={{ background: tagVars(c).color }}
          onClick={() => onChange(c)}
        >
          {value === c && <Icon name="check" size={12} />}
        </button>
      ))}
    </div>
  );
}

function CategorySelect({
  kind,
  value,
  onChange,
  label,
}: {
  kind: EngStatusKind;
  value: EngStatusCategory;
  onChange: (c: EngStatusCategory) => void;
  label: string;
}) {
  const options = CATEGORIES[kind].map((c) => ({ value: c, label: ENG_CATEGORY_LABELS[c] }));
  return <Select options={options} value={value} onChange={onChange} aria-label={label} />;
}

function nextColor(list: EngStatus[]): TagColor {
  const used = new Set(list.map((s) => s.color));
  return TAG_COLORS.find((c) => !used.has(c)) ?? TAG_COLORS[list.length % TAG_COLORS.length]!;
}

// ── 新增狀態 ──

function AddStatusForm({
  id,
  kind,
  onDone,
  onCancel,
  inline = false,
}: {
  id?: string;
  kind: EngStatusKind;
  onDone: (s: EngStatus) => void;
  onCancel: () => void;
  inline?: boolean;
}) {
  const list = useStatusList(kind);
  const create = useCreateEngStatus();
  const [label, setLabel] = useState('');
  const [color, setColor] = useState<TagColor>(() => nextColor(list));
  const [category, setCategory] = useState<EngStatusCategory>(CATEGORIES[kind][0]!);
  const trimmed = label.trim();
  const submit = () => {
    if (!trimmed || create.isPending) return;
    create.mutate({ kind, label: trimmed, color, category }, { onSuccess: onDone });
  };
  return (
    <form
      id={id}
      className={inline ? 'adm-inline eng-status-add' : 'adm-form'}
      aria-label={`新增${KIND_LABEL[kind]}狀態`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {create.error != null && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
      <Field label="狀態名稱">
        <Input
          data-autofocus
          autoFocus={inline}
          size={inline ? 'sm' : undefined}
          value={label}
          maxLength={40}
          placeholder={kind === 'issue' ? '例如：待回覆' : '例如：待驗證'}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && inline) {
              e.stopPropagation();
              onCancel();
            }
          }}
        />
      </Field>
      <Field label="顏色">
        <ColorPicker value={color} onChange={setColor} label="狀態顏色" />
      </Field>
      <Field label="類別" hint={CATEGORY_HINT[kind]}>
        <CategorySelect kind={kind} value={category} onChange={setCategory} label="狀態類別" />
      </Field>
      {inline ? (
        <div className="eng-status-add-actions">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={!trimmed} loading={create.isPending}>
            新增
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function AddStatusDialog({
  kind,
  onCreated,
  onClose,
}: {
  kind: EngStatusKind;
  onCreated?: (key: string) => void;
  onClose: () => void;
}) {
  const formId = `eng-add-status-${kind}`;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`新增${KIND_LABEL[kind]}狀態`}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" type="submit" form={formId}>
            新增
          </Button>
        </>
      }
    >
      <AddStatusForm
        id={formId}
        kind={kind}
        onCancel={onClose}
        onDone={(s) => {
          notifySuccess(`已新增狀態「${s.label}」`);
          onCreated?.(s.key);
          onClose();
        }}
      />
    </Dialog>
  );
}

// ── 管理狀態 ──

function StatusManagerDialog({ kind, onClose }: { kind: EngStatusKind; onClose: () => void }) {
  const list = useStatusList(kind);
  const update = useUpdateEngStatus();
  const [adding, setAdding] = useState(false);
  const move = (from: number, to: number) => {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    next.forEach((s, i) => {
      if (s.sortOrder !== i + 1) update.mutate({ id: s.id, sortOrder: i + 1 });
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`管理${KIND_LABEL[kind]}狀態`}
      size="md"
      actions={
        <>
          <Button variant="secondary" icon="plus" onClick={() => setAdding(true)} disabled={adding}>
            新增狀態
          </Button>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      <p className="adm-hint">
        內建狀態可改名、改色、排序與封存，但不能刪除；自訂狀態沒有資料使用時可刪除，使用中只能封存。封存的狀態不出現在選單，舊資料仍照常顯示。
        {CATEGORY_HINT[kind]}。
      </p>
      <div className="adm-list" data-testid="eng-status-list">
        {list.map((s, i) => (
          <StatusRow key={s.id} kind={kind} status={s} index={i} last={i === list.length - 1} onMove={move} />
        ))}
      </div>
      {adding && (
        <AddStatusForm
          inline
          kind={kind}
          onCancel={() => setAdding(false)}
          onDone={(s) => {
            notifySuccess(`已新增狀態「${s.label}」`);
            setAdding(false);
          }}
        />
      )}
    </Dialog>
  );
}

function StatusRow({
  kind,
  status,
  index,
  last,
  onMove,
}: {
  kind: EngStatusKind;
  status: EngStatus;
  index: number;
  last: boolean;
  onMove: (from: number, to: number) => void;
}) {
  const update = useUpdateEngStatus();
  const del = useDeleteEngStatus();
  const [label, setLabel] = useState(status.label);
  const [seen, setSeen] = useState(status.label);
  if (seen !== status.label) {
    setSeen(status.label);
    setLabel(status.label);
  }
  const commit = () => {
    const t = label.trim();
    if (!t) return setLabel(status.label);
    if (t !== status.label)
      update.mutate({ id: status.id, label: t }, { onError: () => setLabel(status.label) });
  };
  const usage = status.usage ?? 0;
  const canDelete = !status.isBuiltin && usage === 0;
  return (
    <div className="adm-row" data-testid="eng-status-row" data-archived={status.isArchived || undefined}>
      <div className="adm-row-main">
        <div className="adm-row-top">
          <Input
            size="sm"
            aria-label={`狀態名稱：${status.label}`}
            value={label}
            maxLength={40}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setLabel(status.label);
              }
            }}
          />
          <span className="adm-usage">
            {status.isBuiltin ? '內建 · ' : ''}
            {usage > 0 ? `${usage} 筆使用中` : '未使用'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="chevronDown" style={{ transform: 'rotate(180deg)' }} />}
            aria-label={`上移：${status.label}`}
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="chevronDown"
            aria-label={`下移：${status.label}`}
            disabled={last}
            onClick={() => onMove(index, index + 1)}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${status.isArchived ? '取消封存' : '封存'}：${status.label}`}
            onClick={() => update.mutate({ id: status.id, isArchived: !status.isArchived })}
          >
            {status.isArchived ? '取消封存' : '封存'}
          </Button>
          {!status.isBuiltin && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`刪除狀態：${status.label}`}
              disabled={!canDelete}
              title={canDelete ? undefined : '使用中的狀態只能封存'}
              loading={del.isPending}
              onClick={() =>
                del.mutate(status.id, { onSuccess: () => notifySuccess(`已刪除狀態「${status.label}」`) })
              }
            >
              刪除
            </Button>
          )}
        </div>
        <div className="adm-row-bottom">
          <ColorPicker
            value={status.color}
            label={`顏色：${status.label}`}
            onChange={(color) => update.mutate({ id: status.id, color })}
          />
          {status.isBuiltin ? (
            <span className="adm-usage">類別：{ENG_CATEGORY_LABELS[status.category]}</span>
          ) : (
            <CategorySelect
              kind={kind}
              value={status.category}
              label={`類別：${status.label}`}
              onChange={(category) => update.mutate({ id: status.id, category })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
