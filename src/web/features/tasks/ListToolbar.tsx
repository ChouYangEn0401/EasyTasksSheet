import { useState } from 'react';
import type { PropertyDef } from '../../../shared/properties.ts';
import { useMediaQuery } from '../../lib/storage.ts';
import { Button, Checkbox, Select, Tooltip } from '../../ui/index.ts';
import { GROUP_MODES, type ColumnDef, type GroupMode } from './model.ts';
import { Popover } from './Popover.tsx';
import { NewPropertyForm, TypeIcon } from './PropertyPanel.tsx';

/** ViewTabs actions 插槽內容：分組 Select + 欄位 Popover */
export function ListToolbar({
  group,
  onGroup,
  columns,
  hidden,
  onToggleColumn,
  scopeProjectId,
  onPropertyCreated,
}: {
  group: GroupMode;
  onGroup: (g: GroupMode) => void;
  columns: ColumnDef[];
  hidden: string[];
  onToggleColumn: (key: string, visible: boolean) => void;
  scopeProjectId: number | null;
  onPropertyCreated: (p: PropertyDef) => void;
}) {
  const compact = !useMediaQuery('(min-width: 1024px)');
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [adding, setAdding] = useState(false);
  const close = () => {
    setAnchor(null);
    setAdding(false);
  };
  const groupLabel = GROUP_MODES.find((g) => g.value === group)?.label ?? '';

  return (
    <>
      <Tooltip content={compact ? `分組：${groupLabel}` : undefined}>
        <Select<GroupMode>
          aria-label="分組"
          className="tl-group-select"
          value={group}
          onChange={onGroup}
          align="end"
          options={GROUP_MODES}
          renderValue={(o) => (
            <span className="ui-select-label" style={{ flex: 1, textAlign: 'left' }}>
              {compact ? '分組' : `分組：${o?.label ?? ''}`}
            </span>
          )}
        />
      </Tooltip>
      <Tooltip content={compact ? '欄位' : undefined}>
        <Button
          variant="secondary"
          size="sm"
          icon="eye"
          iconOnly={compact}
          aria-label="欄位"
          aria-haspopup="dialog"
          aria-expanded={!!anchor}
          onClick={(e) => (anchor ? close() : setAnchor(e.currentTarget))}
        >
          欄位
        </Button>
      </Tooltip>
      {anchor && (
        <Popover
          anchor={anchor}
          onClose={close}
          width={adding ? 300 : 260}
          label={adding ? '新增欄位' : '欄位'}
        >
          {adding ? (
            <NewPropertyForm
              scopeProjectId={scopeProjectId}
              onDone={(p) => {
                close();
                if (p) onPropertyCreated(p);
              }}
            />
          ) : (
            <div className="tl-columns">
              {columns.map((c) => (
                <label key={c.key} className="ui-option tl-column-item">
                  <Checkbox
                    checked={!c.hideable || !hidden.includes(c.key)}
                    disabled={!c.hideable}
                    onChange={(e) => onToggleColumn(c.key, e.target.checked)}
                  />
                  {c.property ? (
                    <TypeIcon type={c.property.type} />
                  ) : (
                    <span className="tl-type-icon" aria-hidden="true" />
                  )}
                  <span className="ui-option-label">{c.label}</span>
                </label>
              ))}
              <div className="ui-menu-separator" />
              <button type="button" className="ui-option" onClick={() => setAdding(true)}>
                <span className="tl-type-icon" aria-hidden="true">
                  +
                </span>
                <span className="ui-option-label">新增欄位</span>
              </button>
            </div>
          )}
        </Popover>
      )}
    </>
  );
}
