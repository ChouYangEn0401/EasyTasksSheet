import { PERSONAL_STATUS_LABEL, PERSONAL_STATUSES, type PersonalStatus } from '../../../shared/personal.ts';
import { Badge, Icon, Menu } from '../../ui/index.ts';
import { STATUS_TONE } from './model.ts';

/** 狀態小標籤（唯讀顯示） */
export function TodoStatusBadge({ status }: { status: PersonalStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} className={`pl-status-badge pl-status-badge--${status}`}>
      {PERSONAL_STATUS_LABEL[status]}
    </Badge>
  );
}

/** 列上的狀態 chip：點一下展開選單，選取即切換狀態（唯讀時只顯示標籤） */
export function StatusChip({
  status,
  title,
  readOnly,
  onChange,
}: {
  status: PersonalStatus;
  title: string;
  readOnly: boolean;
  onChange: (status: PersonalStatus) => void;
}) {
  if (readOnly) return <TodoStatusBadge status={status} />;
  return (
    <Menu
      align="end"
      width={140}
      label="變更狀態"
      trigger={(p) => (
        <button
          {...p}
          type="button"
          className="pl-status-btn"
          aria-label={`狀態：${PERSONAL_STATUS_LABEL[status]}，點擊變更：${title}`}
        >
          <TodoStatusBadge status={status} />
        </button>
      )}
      items={PERSONAL_STATUSES.map((s) => ({
        key: s,
        label: PERSONAL_STATUS_LABEL[s],
        icon: s === status ? <Icon name="check" /> : undefined,
        onSelect: () => {
          if (s !== status) onChange(s);
        },
      }))}
    />
  );
}
