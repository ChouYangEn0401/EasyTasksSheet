import { useDroppable } from '@dnd-kit/core';
import { forwardRef, useEffect, useRef, useState } from 'react';
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_STATUSES,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackStatus,
} from '../../../shared/feedback.ts';
import { errorMessage } from '../../lib/api.ts';
import { readStorage, writeStorage } from '../../lib/storage.ts';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Input,
  MultiSelect,
  Select,
  Skeleton,
  Spinner,
} from '../../ui/index.ts';
import { LIST_DROP_ID, type DropData } from './actions.ts';
import { useCreateFeedback } from './api.ts';
import { FeedbackCard } from './FeedbackCard.tsx';
import { groupItems, hasFilters, type FeedbackFilters } from './model.ts';

const KIND_PREF_KEY = 'feedback.lastKind';
const KIND_OPTIONS = (['problem', 'feedback'] as const).map((k) => ({
  value: k,
  label: FEEDBACK_KIND_LABELS[k],
}));

/** 新增列：輸入標題 + 類型，Enter 建立後清空並保持 focus */
const NewItemRow = forwardRef<HTMLInputElement>(function NewItemRow(_props, ref) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<FeedbackKind>(() =>
    readStorage(KIND_PREF_KEY) === 'feedback' ? 'feedback' : 'problem',
  );
  const [done, setDone] = useState(false);
  const create = useCreateFeedback();

  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1200);
    return () => window.clearTimeout(t);
  }, [done]);

  const submit = () => {
    const value = title.trim();
    if (!value || create.isPending) return;
    create.mutate(
      { title: value, kind },
      {
        onSuccess: () => {
          setTitle('');
          setDone(true);
        },
      },
    );
  };

  return (
    <div className="fb-new">
      <div className="fb-new-row">
        <Input
          ref={ref}
          wrapperClassName="fb-new-input"
          icon="plus"
          aria-label="新增問題或回饋"
          placeholder="新增問題或回饋，按 Enter 建立"
          value={title}
          readOnly={create.isPending}
          invalid={create.isError}
          onChange={(e) => {
            setTitle(e.target.value);
            if (create.isError) create.reset();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              setTitle('');
              create.reset();
              e.currentTarget.blur();
            }
          }}
          end={
            create.isPending ? (
              <Spinner size={14} />
            ) : done ? (
              <Icon name="check" style={{ color: 'var(--color-success)' }} />
            ) : null
          }
        />
        <Select
          className="fb-new-kind"
          aria-label="類型"
          options={KIND_OPTIONS}
          value={kind}
          onChange={(k) => {
            setKind(k);
            writeStorage(KIND_PREF_KEY, k);
          }}
        />
      </div>
      <div aria-live="polite" className="fb-new-feedback">
        {create.isError ? (
          <span className="ui-field-error">{errorMessage(create.error)}</span>
        ) : done ? (
          <span className="fb-new-done">已建立</span>
        ) : null}
      </div>
    </div>
  );
});

/** 類型分段切換：全部｜問題｜回饋 */
export function KindSegmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="fb-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="fb-seg-item"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const STATUS_OPTIONS = FEEDBACK_STATUSES.map((s) => ({ value: s, label: FEEDBACK_STATUS_LABELS[s] }));

function FilterRow({
  filters,
  onChange,
  onClear,
}: {
  filters: FeedbackFilters;
  onChange: (f: FeedbackFilters) => void;
  onClear: () => void;
}) {
  return (
    <div className="fb-filters">
      <KindSegmented<'all' | FeedbackKind>
        label="類型篩選"
        value={filters.kind ?? 'all'}
        options={[{ value: 'all', label: '全部' }, ...KIND_OPTIONS]}
        onChange={(v) => onChange({ ...filters, kind: v === 'all' ? null : v })}
      />
      <MultiSelect<FeedbackStatus>
        label="狀態"
        aria-label="狀態篩選"
        options={STATUS_OPTIONS}
        value={filters.status}
        onChange={(status) => onChange({ ...filters, status })}
      />
      {hasFilters(filters) && (
        <Button variant="ghost" size="sm" onClick={onClear}>
          清除
        </Button>
      )}
    </div>
  );
}

function Group({
  status,
  items,
  defaultOpen,
}: {
  status: FeedbackStatus;
  items: FeedbackItem[];
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="fb-group" aria-label={FEEDBACK_STATUS_LABELS[status]}>
      <button type="button" className="fb-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} />
        <span>{FEEDBACK_STATUS_LABELS[status]}</span>
        <Badge count>{items.length}</Badge>
      </button>
      {open &&
        (items.length ? (
          <div className="fb-group-items">
            {items.map((item) => (
              <FeedbackCard key={item.id} item={item} />
            ))}
          </div>
        ) : (
          <div className="fb-group-empty">—</div>
        ))}
    </section>
  );
}

function ListSkeleton() {
  return (
    <div className="fb-groups" aria-busy="true" aria-label="載入中">
      {[0, 1, 2].map((g) => (
        <div key={g} className="fb-group">
          <div className="fb-group-head">
            <Skeleton width={90} height={12} />
          </div>
          {g < 2 && (
            <div className="fb-group-items">
              {[0, 1, 2].map((i) => (
                <div key={i} className="fb-card fb-card--skeleton">
                  <Skeleton width="80%" height={12} />
                  <Skeleton width="50%" height={10} />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 清單面板：新增列 + 篩選列 + 三個狀態群組；拖曳月曆 chip 時整體成為「取消排程」放置區 */
export const FeedbackList = forwardRef<
  HTMLInputElement,
  {
    items: FeedbackItem[];
    total: number;
    isLoading: boolean;
    error: unknown;
    onRetry: () => void;
    filters: FeedbackFilters;
    onFiltersChange: (f: FeedbackFilters) => void;
    onClearFilters: () => void;
    acceptsDrop: boolean;
  }
>(function FeedbackList(props, inputRef) {
  const { items, total, isLoading, error, onRetry, filters, onFiltersChange, onClearFilters, acceptsDrop } =
    props;
  const data: DropData = { type: 'list' };
  // 一律註冊為放置區（拖曳中途才啟用會量不到位置）；清單卡片放回清單時由 onDragEnd 忽略
  const { setNodeRef, isOver } = useDroppable({ id: LIST_DROP_ID, data });
  const groups = groupItems(items);
  const scrollRef = useRef<HTMLDivElement>(null);

  let content;
  if (isLoading) content = <ListSkeleton />;
  else if (error) content = <ErrorState error={error} onRetry={onRetry} />;
  else if (total === 0)
    content = <EmptyState title="還沒有問題或回饋" description="在上方輸入框新增第一筆" />;
  else if (items.length === 0)
    content = (
      <EmptyState
        title="沒有符合條件的項目"
        action={
          <Button variant="secondary" onClick={onClearFilters}>
            清除篩選
          </Button>
        }
      />
    );
  else
    content = (
      <div className="fb-groups">
        <Group status="open" items={groups.open} defaultOpen />
        <Group status="scheduled" items={groups.scheduled} defaultOpen />
        <Group status="resolved" items={groups.resolved} defaultOpen={false} />
      </div>
    );

  return (
    <section
      ref={setNodeRef}
      className="fb-panel fb-list-panel"
      aria-label="問題與回饋清單"
      data-drop-active={acceptsDrop || undefined}
      data-drop-over={(acceptsDrop && isOver) || undefined}
    >
      <div className="fb-list-head">
        <NewItemRow ref={inputRef} />
        <FilterRow filters={filters} onChange={onFiltersChange} onClear={onClearFilters} />
      </div>
      <div ref={scrollRef} className="fb-list-scroll">
        {content}
      </div>
      {acceptsDrop && (
        <div className="fb-list-dropzone" aria-hidden="true">
          放開以取消排程
        </div>
      )}
    </section>
  );
});
