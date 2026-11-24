import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './Button.tsx';

/**
 * 對話框（原生 <dialog> + showModal：focus trap、Esc、背景不可操作）。
 * - 開啟時 focus 移入第一個可互動元素（或 [data-autofocus]），關閉後 focus 回到觸發元素
 * - Esc 與點遮罩關閉；dismissible=false 時兩者皆無效（強制型）
 * - dirty=true（表單有未存內容）時點遮罩不關閉
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  size = 'sm',
  dismissible = true,
  dirty = false,
  role = 'dialog',
  showClose,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** 動作列（右對齊；次要在左、主要在右） */
  actions?: ReactNode;
  size?: 'sm' | 'md';
  dismissible?: boolean;
  dirty?: boolean;
  role?: 'dialog' | 'alertdialog';
  /**
   * 是否顯示標題列 ✕ 關閉鈕。未指定時跟隨 dismissible（可關閉才顯示）；
   * 明確傳 true 時即使 dismissible=false 也顯示（Esc / 點遮罩仍無效，只能按 ✕ 或動作列關閉）。
   */
  showClose?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      el.showModal();
      const target =
        el.querySelector<HTMLElement>('[data-autofocus]') ??
        el.querySelector<HTMLElement>(
          '.ui-dialog-body input:not([disabled]), .ui-dialog-body textarea:not([disabled]), .ui-dialog-body select:not([disabled]), .ui-dialog-body button:not([disabled])',
        );
      target?.focus();
    } else if (!open && el.open) {
      el.close();
      const back = returnTo.current;
      returnTo.current = null;
      if (back?.isConnected) back.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`ui-dialog${size === 'md' ? ' ui-dialog--md' : ''}`}
      role={role === 'alertdialog' ? 'alertdialog' : undefined}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        // 點在 <dialog> 本身（即遮罩區域）才算點遮罩
        if (e.target === e.currentTarget && dismissible && !dirty) {
          const r = e.currentTarget.getBoundingClientRect();
          const inside =
            e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          if (!inside) onClose();
        }
      }}
    >
      {open && (
        <>
          <div className="ui-dialog-header">
            <h2 id={titleId} className="ui-dialog-title">
              {title}
            </h2>
            {(showClose ?? dismissible) && (
              <Button variant="ghost" size="sm" iconOnly icon="x" aria-label="關閉" onClick={onClose} />
            )}
          </div>
          {children != null && <div className="ui-dialog-body">{children}</div>}
          {actions != null && <div className="ui-dialog-actions">{actions}</div>}
        </>
      )}
    </dialog>
  );
}
