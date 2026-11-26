import { createElement, Fragment } from 'preact';
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'preact/compat';
import { useCurrentUser } from '../../lib/auth.js';
import { Avatar, Button, Textarea } from '../../ui/index.js';
import {
  BODY_MAX,
  applyMention,
  filterMentionCandidates,
  loadDraft,
  mentionQueryAt,
  safeLocalStorage,
  saveDraft,
} from './discussionModel.js';

/** 輸入框最多長到 6 行（之後內部捲動） */
const MAX_LINES = 6;
const LINE_PX = 22;

/**
 * 討論區輸入框：自動增高（最多 6 行）、Enter 送出 / Shift+Enter 換行（IME 組字中不送出）、
 * `@` 開啟成員選單（上下鍵 / Enter / Tab 選取，Esc 關閉）、草稿以使用者 + 任務為單位存在 localStorage（登出清除）。
 */
export const DiscussionComposer = forwardRef(function DiscussionComposer(
  { taskId, users, replyLabel, onCancelReply, onSend, disabled },
  ref,
) {
  const storage = useMemo(() => safeLocalStorage(), []);
  const userId = useCurrentUser()?.id ?? null;
  const [text, setText] = useState(() => loadDraft(storage, userId, taskId));
  const [caret, setCaret] = useState(0);
  const [menuOpen, setMenuOpen] = useState(true);
  const [active, setActive] = useState(0);
  const areaRef = useRef(null);
  /** 選取提及後要放置的游標位置（在同一次 render 後立即套用，避免與後續輸入競爭） */
  const pendingCaret = useRef(null);
  const listId = useId();
  const hintId = useId();

  useImperativeHandle(ref, () => ({ focus: () => areaRef.current?.focus() }), []);

  // 草稿：每次輸入即保存（切換任務、重新整理都不遺失）
  useEffect(() => saveDraft(storage, userId, taskId, text), [storage, userId, taskId, text]);

  useLayoutEffect(() => {
    const el = areaRef.current;
    const pos = pendingCaret.current;
    if (!el || pos == null) return;
    pendingCaret.current = null;
    el.setSelectionRange(pos, pos);
  }, [text]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = MAX_LINES * LINE_PX + 18;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [text]);

  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(
    () => (mention ? filterMentionCandidates(users, mention.query, 6) : []),
    [users, mention],
  );
  const showMenu = menuOpen && !!mention && candidates.length > 0;
  const activeIndex = Math.min(active, Math.max(0, candidates.length - 1));

  const trimmed = text.trim();
  const over = trimmed.length > BODY_MAX;
  const canSend = !!trimmed && !over && !disabled;

  const syncCaret = () => setCaret(areaRef.current?.selectionStart ?? 0);

  const pick = (u) => {
    if (!mention) return;
    const next = applyMention(text, mention.start, caret, u.username);
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    areaRef.current?.focus();
  };

  const send = () => {
    if (!canSend) return;
    onSend(trimmed);
    setText('');
    setCaret(0);
  };

  const onKeyDown = (e) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (showMenu && !composing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setActive((activeIndex + d + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const u = candidates[activeIndex];
        if (u) pick(u);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !composing) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Escape' && replyLabel) {
      e.preventDefault();
      e.stopPropagation();
      onCancelReply();
    }
  };

  const remaining = BODY_MAX - trimmed.length;

  return createElement(
    'div',
    { className: 'disc-composer' },
    replyLabel &&
      createElement(
        'div',
        { className: 'disc-replying' },
        createElement(
          'span',
          { className: 'truncate' },
          '回覆 ',
          createElement('strong', null, replyLabel),
          ' 的訊息',
        ),
        createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          iconOnly: true,
          icon: 'x',
          'aria-label': '取消回覆',
          onClick: onCancelReply,
        }),
      ),
    createElement(
      'div',
      { className: 'disc-input-row' },
      createElement(
        'div',
        { className: 'disc-input-wrap' },
        createElement(Textarea, {
          ref: areaRef,
          value: text,
          rows: 1,
          maxLength: BODY_MAX + 200,
          placeholder: replyLabel ? '寫下回覆…（@ 可提及成員）' : '寫下想法、疑問或筆記…（@ 可提及成員）',
          'aria-label': '討論區訊息',
          'aria-describedby': hintId,
          'aria-autocomplete': 'list',
          'aria-controls': showMenu ? listId : undefined,
          'aria-expanded': showMenu,
          'aria-activedescendant': showMenu ? `${listId}-${activeIndex}` : undefined,
          role: 'combobox',
          className: 'disc-input scroll-soft',
          onChange: (e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setMenuOpen(true);
            setActive(0);
          },
          onSelect: syncCaret,
          onClick: syncCaret,
          onKeyDown: onKeyDown,
          onBlur: () => window.setTimeout(() => setMenuOpen(false), 120),
          onFocus: () => setMenuOpen(true),
        }),
        showMenu &&
          createElement(
            'ul',
            { id: listId, role: 'listbox', 'aria-label': '提及成員', className: 'disc-mention-menu' },
            candidates.map((u, i) =>
              createElement(
                'li',
                {
                  key: u.id,
                  id: `${listId}-${i}`,
                  role: 'option',
                  'aria-selected': i === activeIndex,
                  className: 'disc-mention-option',
                  onMouseDown: (e) => {
                    e.preventDefault();
                    pick(u);
                  },
                  onMouseEnter: () => setActive(i),
                },
                createElement(Avatar, { user: u, size: 'xs', tooltip: false }),
                createElement('span', { className: 'disc-mention-name' }, u.displayName),
                createElement('span', { className: 'disc-mention-username' }, '@', u.username),
              ),
            ),
          ),
      ),
      createElement(Button, {
        variant: 'primary',
        size: 'sm',
        iconOnly: true,
        icon: createElement(SendIcon, null),
        'aria-label': '送出',
        disabled: !canSend,
        onClick: send,
        className: 'disc-send',
      }),
    ),
    createElement(
      'div',
      { className: 'disc-hint', id: hintId },
      createElement('span', null, 'Enter 送出 · Shift+Enter 換行 · @ 提及成員'),
      remaining < 500 &&
        createElement(
          'span',
          { className: over ? 'disc-error' : undefined, 'aria-live': 'polite' },
          over ? `超過上限 ${-remaining} 字` : `還可輸入 ${remaining} 字`,
        ),
    ),
  );
});

function SendIcon() {
  return createElement(
    'svg',
    { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    createElement('path', {
      d: 'M4 12l16-8-6 16-2.5-6.5z',
      stroke: 'currentColor',
      strokeWidth: '1.7',
      strokeLinejoin: 'round',
      strokeLinecap: 'round',
    }),
  );
}
