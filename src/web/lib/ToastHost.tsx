import { useEffect, useRef, useState } from 'react';
import { Avatar, Button, Toast, ToastViewport } from '../ui/index.ts';
import { toastStore, useToasts, type ToastItem } from './toast.ts';

/**
 * Toast viewport 與佇列呈現（docs/design/realtime-feedback.md §2）。
 * - 滑鼠移入、focus 在任一則、視窗失焦時全部暫停計時
 * - Alt+T：focus 移到最新一則；Esc：關閉 focus 中的那則並把 focus 還回原處
 * - 連線狀態 toast 永遠在最下方，不計入 3 則上限
 */
export function ToastHost() {
  const { items, connection } = useToasts();
  const returnTo = useRef<HTMLElement | null>(null);
  const refs = useRef(new Map<number, HTMLDivElement>());

  // 視窗失焦時暫停
  useEffect(() => {
    const onBlur = () => toastStore.pause('window');
    const onFocus = () => toastStore.resume('window');
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      toastStore.resume('window');
      toastStore.resume('hover');
      toastStore.resume('focus');
    };
  }, []);

  // Alt+T：focus 最新一則
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== 'KeyT') return;
      const latest = [...items].reverse().find((t) => !t.leaving);
      const el = latest ? refs.current.get(latest.id) : null;
      if (!el) return;
      e.preventDefault();
      const active = document.activeElement;
      if (active instanceof HTMLElement && !active.closest('.toast-viewport')) returnTo.current = active;
      el.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items]);

  const restoreFocus = () => {
    const el = returnTo.current;
    returnTo.current = null;
    if (el?.isConnected) el.focus();
  };

  return (
    <ToastViewport
      onPointerEnter={() => toastStore.pause('hover')}
      onPointerLeave={() => toastStore.resume('hover')}
      onFocus={() => toastStore.pause('focus')}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) toastStore.resume('focus');
      }}
    >
      {items.map((t) => (
        <ToastEntry
          key={t.id}
          item={t}
          setRef={(el) => {
            if (el) refs.current.set(t.id, el);
            else refs.current.delete(t.id);
          }}
          onEscape={() => {
            toastStore.dismiss(t.id);
            restoreFocus();
          }}
        />
      ))}
      {connection && (
        <Toast
          key="connection"
          tone={connection.tone}
          title={connection.title}
          busy={connection.spinner}
          onClose={connection.closable ? () => toastStore.setConnection(null) : undefined}
        />
      )}
    </ToastViewport>
  );
}

function ToastEntry({
  item,
  setRef,
  onEscape,
}: {
  item: ToastItem;
  setRef: (el: HTMLDivElement | null) => void;
  onEscape: () => void;
}) {
  const [running, setRunning] = useState(false);
  const action = item.action;
  return (
    <Toast
      ref={setRef}
      tone={item.tone}
      title={item.title}
      description={item.description}
      leaving={item.leaving}
      tabIndex={-1}
      lead={
        item.avatar ? (
          <Avatar
            user={
              item.avatar.userId != null
                ? { id: item.avatar.userId, displayName: item.avatar.name }
                : undefined
            }
            size="xs"
            tooltip={false}
          />
        ) : undefined
      }
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onEscape();
        }
      }}
      action={
        action ? (
          <Button
            variant="ghost"
            size="sm"
            loading={running}
            onClick={() => {
              const r = action.onClick();
              if (r && typeof (r as Promise<unknown>).then === 'function') {
                setRunning(true);
                void (r as Promise<unknown>).finally(() => {
                  setRunning(false);
                  toastStore.dismiss(item.id);
                });
              } else toastStore.dismiss(item.id);
            }}
          >
            {action.label}
          </Button>
        ) : undefined
      }
      onClose={() => toastStore.dismiss(item.id)}
    />
  );
}
