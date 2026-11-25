import { useMemo, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  STATUS_CATEGORIES,
  TAG_COLORS,
  type Project,
  type Status,
  type StatusCategory,
  type TagColor,
} from '../../../shared/projects.ts';
import { tagVars } from '../../lib/colors.ts';
import {
  useCreateProject,
  useCreateStatus,
  useDeleteStatus,
  useProjects,
  useStatuses,
  useStatusUsage,
  useUpdateProject,
  useUpdateStatus,
} from '../../lib/hooks.ts';
import { useCan } from '../../lib/permissions.ts';
import { notifySuccess } from '../../lib/toast.ts';
import { Alert, Button, ColorDot, Dialog, Field, Icon, Input, Select } from '../../ui/index.ts';
import { closeAdminDialog, useAdminDialog } from './adminUi.ts';
import {
  CATEGORY_HINT,
  CATEGORY_LABELS,
  defaultMigrationTarget,
  migrationTargets,
  moveItem,
  nextFreeColor,
  sortOrderChanges,
} from './statusAdmin.ts';

/** 掛在 TaskAreaLayout 的對話框集合；開關見 adminUi.ts。各對話框只在具備對應權限時才掛載 */
export function AdminDialogs() {
  const { dialog, seq } = useAdminDialog();
  const canStatus = useCan('statuses.manage');
  const canCreate = useCan('projects.create');
  const canManage = useCan('projects.manage');
  return (
    <>
      {canStatus && <AddStatusDialog key={seq} open={dialog?.kind === 'add-status'} />}
      {canStatus && <StatusManagerDialog key={seq} open={dialog?.kind === 'manage-statuses'} />}
      {canCreate && (
        <AddProjectDialog
          key={seq}
          open={dialog?.kind === 'add-project'}
          onCreated={dialog?.kind === 'add-project' ? dialog.onCreated : undefined}
        />
      )}
      {canManage && <ProjectManagerDialog key={seq} open={dialog?.kind === 'manage-projects'} />}
    </>
  );
}

/** 八色選擇（TAG_COLORS） */
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

const CATEGORY_OPTIONS = STATUS_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }));

function CategorySelect({
  value,
  onChange,
  label,
}: {
  value: StatusCategory;
  onChange: (c: StatusCategory) => void;
  label: string;
}) {
  return <Select options={CATEGORY_OPTIONS} value={value} onChange={onChange} aria-label={label} />;
}

/* ── 新增狀態 ─────────────────────────── */

function AddStatusDialog({ open }: { open: boolean }) {
  const statuses = useStatuses().data ?? [];
  const create = useCreateStatus();
  // 每次開啟都會以新的 key 重新掛載（見 AdminDialogs），初始值即為預設
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>(() => nextFreeColor(statuses.map((s) => s.color)));
  const [category, setCategory] = useState<StatusCategory>('todo');

  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed || create.isPending) return;
    create.mutate(
      { name: trimmed, color, category },
      {
        onSuccess: (s) => {
          closeAdminDialog();
          notifySuccess(`已新增狀態「${s.name}」`);
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onClose={closeAdminDialog}
      title="新增狀態"
      dirty={!!trimmed}
      actions={
        <>
          <Button variant="ghost" onClick={closeAdminDialog}>
            取消
          </Button>
          <Button variant="primary" disabled={!trimmed} loading={create.isPending} onClick={submit}>
            新增
          </Button>
        </>
      }
    >
      <form
        className="adm-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="狀態名稱">
          <Input
            data-autofocus
            value={name}
            maxLength={100}
            placeholder="例如：待驗收"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="顏色">
          <ColorPicker value={color} onChange={setColor} label="狀態顏色" />
        </Field>
        <Field label="類別" hint={CATEGORY_HINT}>
          <CategorySelect value={category} onChange={setCategory} label="狀態類別" />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/* ── 管理狀態 ─────────────────────────── */

function StatusManagerDialog({ open }: { open: boolean }) {
  const statusesQ = useStatuses();
  const usageQ = useStatusUsage(open);
  const update = useUpdateStatus();
  const [order, setOrder] = useState<Status[] | null>(null);
  const [removing, setRemoving] = useState<Status | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  const server = statusesQ.data;
  const list = order ?? server ?? [];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const applyOrder = async (next: Status[]) => {
    setOrder(next);
    setSaving(true);
    try {
      await Promise.all(sortOrderChanges(next).map((c) => update.mutateAsync(c)));
    } catch {
      /* 全域 toast 已顯示錯誤 */
    } finally {
      setSaving(false);
      setOrder(null);
    }
  };
  const move = (from: number, to: number) => void applyOrder(moveItem(list, from, to));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    move(
      list.findIndex((s) => s.id === e.active.id),
      list.findIndex((s) => s.id === e.over!.id),
    );
  };

  return (
    <Dialog
      open={open}
      onClose={closeAdminDialog}
      title="管理狀態"
      size="md"
      actions={
        <>
          <Button variant="secondary" icon="plus" onClick={() => setAdding(true)}>
            新增狀態
          </Button>
          <Button variant="primary" onClick={closeAdminDialog}>
            完成
          </Button>
        </>
      }
    >
      <p className="adm-hint">拖曳或用上下鈕調整順序（清單、看板與篩選同步）。{CATEGORY_HINT}。</p>
      <div className="adm-list" aria-busy={saving || undefined}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={list.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {list.map((s, i) => (
              <StatusRow
                key={s.id}
                status={s}
                index={i}
                last={i === list.length - 1}
                usage={usageQ.data?.[String(s.id)] ?? 0}
                onMove={move}
                onRemove={() => setRemoving(s)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      {removing && (
        <DeleteStatusPanel
          key={removing.id}
          status={removing}
          statuses={list}
          usage={usageQ.data?.[String(removing.id)] ?? 0}
          onDone={() => setRemoving(null)}
        />
      )}
      {adding && <AddStatusInline onClose={() => setAdding(false)} />}
    </Dialog>
  );
}

function StatusRow({
  status,
  index,
  last,
  usage,
  onMove,
  onRemove,
}: {
  status: Status;
  index: number;
  last: boolean;
  usage: number;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
}) {
  const update = useUpdateStatus();
  const [name, setName] = useState(status.name);
  const [seenName, setSeenName] = useState(status.name);
  if (seenName !== status.name) {
    setSeenName(status.name);
    setName(status.name);
  }
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: status.id,
  });
  const commitName = () => {
    const t = name.trim();
    if (!t) return setName(status.name);
    if (t !== status.name) update.mutate({ id: status.id, name: t }, { onError: () => setName(status.name) });
  };
  return (
    <div
      ref={setNodeRef}
      className="adm-row"
      data-testid="status-row"
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="adm-grip"
        aria-label={`拖曳排序：${status.name}`}
        {...attributes}
        {...listeners}
      >
        <Icon name="grip" />
      </button>
      <div className="adm-row-main">
        <div className="adm-row-top">
          <Input
            size="sm"
            aria-label={`狀態名稱：${status.name}`}
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setName(status.name);
              }
            }}
          />
          <span className="adm-usage">{usage > 0 ? `${usage} 筆任務` : '未使用'}</span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="chevronDown" style={{ transform: 'rotate(180deg)' }} />}
            aria-label={`上移：${status.name}`}
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="chevronDown"
            aria-label={`下移：${status.name}`}
            disabled={last}
            onClick={() => onMove(index, index + 1)}
          />
          <Button variant="ghost" size="sm" aria-label={`刪除狀態：${status.name}`} onClick={onRemove}>
            刪除
          </Button>
        </div>
        <div className="adm-row-bottom">
          <ColorPicker
            value={status.color}
            label={`顏色：${status.name}`}
            onChange={(color) => update.mutate({ id: status.id, color })}
          />
          <CategorySelect
            value={status.category}
            label={`類別：${status.name}`}
            onChange={(category) => update.mutate({ id: status.id, category })}
          />
        </div>
      </div>
    </div>
  );
}

function AddStatusInline({ onClose }: { onClose: () => void }) {
  const statuses = useStatuses().data ?? [];
  const create = useCreateStatus();
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>(() => nextFreeColor(statuses.map((s) => s.color)));
  const [category, setCategory] = useState<StatusCategory>('todo');
  const submit = () => {
    const t = name.trim();
    if (!t) return;
    create.mutate({ name: t, color, category }, { onSuccess: onClose });
  };
  return (
    <form
      className="adm-inline"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input
        autoFocus
        size="sm"
        aria-label="新狀態名稱"
        placeholder="新狀態名稱"
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <ColorPicker value={color} onChange={setColor} label="新狀態顏色" />
      <CategorySelect value={category} onChange={setCategory} label="新狀態類別" />
      <Button type="submit" variant="primary" size="sm" disabled={!name.trim()} loading={create.isPending}>
        新增
      </Button>
      <Button variant="ghost" size="sm" onClick={onClose}>
        取消
      </Button>
    </form>
  );
}

function DeleteStatusPanel({
  status,
  statuses,
  usage,
  onDone,
}: {
  status: Status;
  statuses: Status[];
  usage: number;
  onDone: () => void;
}) {
  const del = useDeleteStatus();
  const targets = useMemo(() => migrationTargets(statuses, status.id), [statuses, status.id]);
  const [target, setTarget] = useState<number | null>(() => defaultMigrationTarget(statuses, status));
  const onlyOne = targets.length === 0;
  const confirm = () => {
    del.mutate(
      { id: status.id, targetStatusId: usage > 0 && target != null ? target : undefined },
      {
        onSuccess: () => {
          notifySuccess(`已刪除狀態「${status.name}」`);
          onDone();
        },
      },
    );
  };
  return (
    <Alert tone={usage > 0 ? 'warning' : 'info'}>
      <div className="adm-delete" data-testid="delete-status-panel">
        <strong>刪除「{status.name}」</strong>
        {onlyOne ? (
          <p>至少需保留一個狀態，無法刪除。</p>
        ) : usage > 0 ? (
          <>
            <p>有 {usage} 筆任務（含已刪除可還原的任務）使用此狀態，請先選擇要改移到哪個狀態。</p>
            <div className="adm-delete-target">
              <span>改移任務到</span>
              <Select
                aria-label="改移任務到"
                value={target}
                onChange={setTarget}
                options={targets.map((s) => ({
                  value: s.id,
                  label: s.name,
                  leading: <ColorDot color={s.color} size="md" />,
                }))}
              />
            </div>
          </>
        ) : (
          <p>沒有任務使用此狀態，可直接刪除。</p>
        )}
        <div className="adm-delete-actions">
          <Button variant="ghost" size="sm" onClick={onDone}>
            取消
          </Button>
          {!onlyOne && (
            <Button
              variant="danger"
              size="sm"
              loading={del.isPending}
              disabled={usage > 0 && target == null}
              onClick={confirm}
            >
              {usage > 0 ? '改移任務並刪除' : '刪除狀態'}
            </Button>
          )}
        </div>
      </div>
    </Alert>
  );
}

/* ── 新增專案 ─────────────────────────── */

function AddProjectDialog({ open, onCreated }: { open: boolean; onCreated?: (project: Project) => void }) {
  const projects = useProjects().data ?? [];
  const create = useCreateProject();
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>(() => nextFreeColor(projects.map((p) => p.color)));
  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed || create.isPending) return;
    create.mutate(
      { name: trimmed, color },
      {
        onSuccess: (p) => {
          closeAdminDialog();
          onCreated?.(p);
          notifySuccess(`已新增專案「${p.name}」`);
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onClose={closeAdminDialog}
      title="新增專案"
      dirty={!!trimmed}
      actions={
        <>
          <Button variant="ghost" onClick={closeAdminDialog}>
            取消
          </Button>
          <Button variant="primary" disabled={!trimmed} loading={create.isPending} onClick={submit}>
            新增專案
          </Button>
        </>
      }
    >
      <form
        className="adm-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="專案名稱">
          <Input
            data-autofocus
            value={name}
            maxLength={100}
            placeholder="輸入名稱後按 Enter"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="顏色">
          <ColorPicker value={color} onChange={setColor} label="專案顏色" />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/* ── 管理專案（改名 / 改色 / 封存；需 projects.manage）── */

function ProjectManagerDialog({ open }: { open: boolean }) {
  const projects = useProjects().data ?? [];
  const [showArchived, setShowArchived] = useState(false);
  const shown = projects.filter((p) => showArchived || !p.isArchived);
  const archivedCount = projects.filter((p) => p.isArchived).length;
  return (
    <Dialog
      open={open}
      onClose={closeAdminDialog}
      title="管理專案"
      size="md"
      actions={
        <Button variant="primary" onClick={closeAdminDialog}>
          完成
        </Button>
      }
    >
      <p className="adm-hint">預設專案不可刪除，只能改名或封存；封存的專案不會出現在下拉選單。</p>
      <div className="adm-list">
        {shown.map((p) => (
          <ProjectRow key={p.id} project={p} />
        ))}
      </div>
      {archivedCount > 0 && (
        <label className="adm-check">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          顯示已封存（{archivedCount}）
        </label>
      )}
    </Dialog>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const update = useUpdateProject();
  const [name, setName] = useState(project.name);
  const [seenName, setSeenName] = useState(project.name);
  if (seenName !== project.name) {
    setSeenName(project.name);
    setName(project.name);
  }
  const commitName = () => {
    const t = name.trim();
    if (!t) return setName(project.name);
    if (t !== project.name)
      update.mutate({ id: project.id, name: t }, { onError: () => setName(project.name) });
  };
  return (
    <div className="adm-row" data-testid="project-row" data-archived={project.isArchived || undefined}>
      <div className="adm-row-main">
        <div className="adm-row-top">
          <Input
            size="sm"
            aria-label={`專案名稱：${project.name}`}
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setName(project.name);
              }
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${project.isArchived ? '取消封存' : '封存'}：${project.name}`}
            onClick={() => update.mutate({ id: project.id, isArchived: !project.isArchived })}
          >
            {project.isArchived ? '取消封存' : '封存'}
          </Button>
        </div>
        <ColorPicker
          value={project.color}
          label={`顏色：${project.name}`}
          onChange={(color) => update.mutate({ id: project.id, color })}
        />
      </div>
    </div>
  );
}
