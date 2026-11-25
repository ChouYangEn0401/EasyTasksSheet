import { useState, type FormEvent } from 'react';
import type { Task } from '../../../shared/tasks.ts';
import type { TaskDuplicateCopy } from '../../../shared/taskRelations.ts';
import { errorMessage } from '../../lib/api.ts';
import { statusStyle, statusTone } from '../../lib/colors.ts';
import { useStatuses } from '../../lib/hooks.ts';
import { notifySuccess, quoteName } from '../../lib/toast.ts';
import { Alert, Button, Checkbox, Dialog, Field, Input, Select } from '../../ui/index.ts';
import { openDuplicated } from './drawerNav.ts';
import { useDuplicateTask } from './relationData.ts';
import { allCopyOptions, COPY_OPTIONS, defaultCopyTitle, defaultDuplicateStatus } from './relationModel.ts';
import './relations.css';

/** 複製任務對話框（TaskDrawer「⋯」選單或在抽屜內按 D 開啟） */
export function DuplicateDialog({ task, open, onClose }: { task: Task; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="複製任務" size="md">
      {open && <DuplicateForm task={task} onClose={onClose} />}
    </Dialog>
  );
}

function DuplicateForm({ task, onClose }: { task: Task; onClose: () => void }) {
  const statuses = useStatuses().data;
  const dup = useDuplicateTask(task.id);
  const [title, setTitle] = useState(() => defaultCopyTitle(task.title));
  const [copy, setCopy] = useState<Required<TaskDuplicateCopy>>(allCopyOptions);
  const [statusId, setStatusId] = useState<number | null>(null);
  const [relate, setRelate] = useState(true);
  const effectiveStatus = statusId ?? defaultDuplicateStatus(statuses);
  const trimmed = title.trim();
  const titleError = trimmed ? null : '請輸入標題';

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (titleError || dup.isPending) return;
    dup.mutate(
      { title: trimmed, copy, relate, ...(effectiveStatus != null ? { statusId: effectiveStatus } : {}) },
      {
        onSuccess: (created) => {
          onClose();
          notifySuccess(`已建立${quoteName(created.title)}`);
          openDuplicated(created.id);
        },
      },
    );
  };

  return (
    <form
      className="tr-dup"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <Field label="標題" error={titleError}>
        <Input
          value={title}
          maxLength={500}
          onChange={(e) => setTitle(e.target.value)}
          data-autofocus
          onFocus={(e) => e.currentTarget.select()}
        />
      </Field>
      <fieldset className="tr-dup-fieldset">
        <legend className="tr-dup-legend">複製內容</legend>
        <div className="tr-dup-grid">
          {COPY_OPTIONS.map((o) => (
            <Checkbox
              key={o.key}
              label={o.label}
              checked={copy[o.key]}
              onChange={(e) => setCopy((c) => ({ ...c, [o.key]: e.target.checked }))}
            />
          ))}
        </div>
        <p className="tr-dup-hint">專案一律沿用；進度歸零，不複製完成時間、附件、釘選與既有關聯。</p>
      </fieldset>
      <Field label="狀態">
        <Select
          aria-label="狀態"
          options={(statuses ?? []).map((s) => ({
            value: s.id,
            label: s.name,
            leading: <span className="tr-dot" style={statusStyle(statusTone(s))} aria-hidden="true" />,
          }))}
          value={effectiveStatus}
          onChange={(v) => setStatusId(v)}
          placeholder="載入中…"
        />
      </Field>
      <Checkbox
        label="並與原任務建立相關連結"
        checked={relate}
        onChange={(e) => setRelate(e.target.checked)}
      />
      {dup.isError && <Alert tone="danger">{errorMessage(dup.error)}</Alert>}
      <div className="tr-dup-actions">
        <span className="tr-dup-kbd">Ctrl + Enter 建立</span>
        <Button type="button" variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" variant="primary" loading={dup.isPending} disabled={!!titleError}>
          建立
        </Button>
      </div>
    </form>
  );
}
