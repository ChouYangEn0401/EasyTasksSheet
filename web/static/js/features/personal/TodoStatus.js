import { createElement, Fragment } from 'preact';
import { PERSONAL_STATUS_LABEL, PERSONAL_STATUSES } from '../../shared/personal.js';
import { Badge, Icon, Menu } from '../../ui/index.js';
import { STATUS_TONE } from './model.js';

/** 狀態小標籤（唯讀顯示） */
export function TodoStatusBadge({ status }) {
  return createElement(
    Badge,
    { tone: STATUS_TONE[status], className: `pl-status-badge pl-status-badge--${status}` },
    PERSONAL_STATUS_LABEL[status],
  );
}

/** 列上的狀態 chip：點一下展開選單，選取即切換狀態（唯讀時只顯示標籤） */
export function StatusChip({ status, title, readOnly, onChange }) {
  if (readOnly) return createElement(TodoStatusBadge, { status: status });
  return createElement(Menu, {
    align: 'end',
    width: 140,
    label: '變更狀態',
    trigger: (p) =>
      createElement(
        'button',
        {
          ...p,
          type: 'button',
          className: 'pl-status-btn',
          'aria-label': `狀態：${PERSONAL_STATUS_LABEL[status]}，點擊變更：${title}`,
        },
        createElement(TodoStatusBadge, { status: status }),
      ),
    items: PERSONAL_STATUSES.map((s) => ({
      key: s,
      label: PERSONAL_STATUS_LABEL[s],
      icon: s === status ? createElement(Icon, { name: 'check' }) : undefined,
      onSelect: () => {
        if (s !== status) onChange(s);
      },
    })),
  });
}
