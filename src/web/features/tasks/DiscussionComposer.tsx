import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { PublicUser } from '../../../shared/users.ts';
import { Avatar, Button, Textarea } from '../../ui/index.ts';
import {
  BODY_MAX,
  applyMention,
  filterMentionCandidates,
  loadDraft,
  mentionQueryAt,
  safeLocalStorage,
  saveDraft,
} from './discussionModel.ts';

export type ComposerHandle = { focus: () => void };

/** 輸入框最多長到 6 行（之後內部捲動） */
const MAX_LINES = 6;
const LINE_PX = 22;

/**
 * 討論區輸入框：自動增高（最多 6 行）、Enter 送出 / Shift+Enter 換行（IME 組字中不送出）、
 * `@` 開啟成員選單（上下鍵 / Enter / Tab 選取，Esc 關閉）、草稿以任務為單位存在 localStorage。
 */
export const DiscussionComposer = forwardRef<
  ComposerHandle,
  {
    taskId: number;
    users: PublicUser[];
    replyLabel: string | null;
    onCancelReply: () => void;
    onSend: (body: string) => void;
    disabled?: boolean;
  }
>(function DiscussionComposer({ taskId, users, replyLabel, onCancelReply, onSend, disabled }, ref) {
  const storage = useMemo(() => safeLocalStorage(), []);
  const [text, setText] = useState(() => loadDraft(storage, taskId));
  const [caret, setCaret] = useState(0);
  const [menuOpen, setMenuOpen] = useState(true);
  const [active, setActive] = useState(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /** 選取提及後要放置的游標位置（在同一次 render 後立即套用，避免與後續輸入競爭） */
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();
  const hintId = useId();

  useImperativeHandle(ref, () => ({ focus: () => areaRef.current?.focus() }), []);

  // 草稿：每次輸入即保存（切換任務、重新整理都不遺失）
  useEffect(() => saveDraft(storage, taskId, text), [storage, taskId, text]);

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

  const pick = (u: PublicUser) => {
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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

  return (
    <div className="disc-composer">
      {replyLabel && (
        <div className="disc-replying">
          <span className="truncate">
            回覆 <strong>{replyLabel}</strong> 的訊息
          </span>
          <Button variant="ghost" size="sm" iconOnly icon="x" aria-label="取消回覆" onClick={onCancelReply} />
        </div>
      )}
      <div className="disc-input-row">
        <div className="disc-input-wrap">
          <Textarea
            ref={areaRef}
            value={text}
            rows={1}
            maxLength={BODY_MAX + 200}
            placeholder={replyLabel ? '寫下回覆…（@ 可提及成員）' : '寫下想法、疑問或筆記…（@ 可提及成員）'}
            aria-label="討論區訊息"
            aria-describedby={hintId}
            aria-autocomplete="list"
            aria-controls={showMenu ? listId : undefined}
            aria-expanded={showMenu}
            aria-activedescendant={showMenu ? `${listId}-${activeIndex}` : undefined}
            role="combobox"
            className="disc-input scroll-soft"
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setMenuOpen(true);
              setActive(0);
            }}
            onSelect={syncCaret}
            onClick={syncCaret}
            onKeyDown={onKeyDown}
            onBlur={() => window.setTimeout(() => setMenuOpen(false), 120)}
            onFocus={() => setMenuOpen(true)}
          />
          {showMenu && (
            <ul id={listId} role="listbox" aria-label="提及成員" className="disc-mention-menu">
              {candidates.map((u, i) => (
                <li
                  key={u.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className="disc-mention-option"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(u);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <Avatar user={u} size="xs" tooltip={false} />
                  <span className="disc-mention-name">{u.displayName}</span>
                  <span className="disc-mention-username">@{u.username}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button
          variant="primary"
          size="sm"
          iconOnly
          icon={<SendIcon />}
          aria-label="送出"
          disabled={!canSend}
          onClick={send}
          className="disc-send"
        />
      </div>
      <div className="disc-hint" id={hintId}>
        <span>Enter 送出 · Shift+Enter 換行</span>
        {remaining < 500 && (
          <span className={over ? 'disc-error' : undefined} aria-live="polite">
            {over ? `超過上限 ${-remaining} 字` : `還可輸入 ${remaining} 字`}
          </span>
        )}
      </div>
    </div>
  );
});

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 12l16-8-6 16-2.5-6.5z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
