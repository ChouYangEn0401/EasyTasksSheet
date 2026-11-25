import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useCurrentUser } from '../../lib/auth.ts';
import { useUsersById } from '../../lib/hooks.ts';
import { activeMembers, describeMember, viewForPath, STATUS_LABEL } from '../../lib/presence.ts';
import { useNow, usePresenceQuery, usePresenceReporter } from './usePresence.ts';
import { PresenceAvatar } from './PresenceAvatar.tsx';
import { PresenceCard } from './PresenceCard.tsx';
import { Floating } from './Floating.tsx';
import { PresencePanel } from './PresencePanel.tsx';
import './presence.css';

const MAX_SHOWN = 5;
const HOVER_DELAY_MS = 120;
const LEAVE_DELAY_MS = 160;

/**
 * 頂欄「雲端」在線頭像堆疊（docs/design/presence.md §2）：
 * 其他在線 / 閒置成員的頭像（最多 5 個 + 「+N」），右下角小圓點表示狀態；
 * hover / focus 顯示可愛的小卡片；點擊開啟「全部成員」面板。同時負責回報自己的動態。
 */
export function PresenceStack({ title }: { title: string }) {
  const me = useCurrentUser();
  const location = useLocation();
  const query = usePresenceQuery();
  const view = viewForPath(location.pathname, title);
  usePresenceReporter(view, me?.id ?? null, query.data?.keepaliveMs);

  const usersById = useUsersById();
  const now = useNow();
  const [panelOpen, setPanelOpen] = useState(false);
  const [hover, setHover] = useState<{ id: number; el: HTMLElement } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const members = query.data?.members;
  const active = activeMembers(members, me?.id ?? null).filter((m) => usersById.has(m.userId));
  const shown = active.slice(0, MAX_SHOWN);
  const rest = active.length - shown.length;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // 面板：點外面或 Esc 關閉
  useEffect(() => {
    if (!panelOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!rootEl?.contains(t) && !panelRef.current?.contains(t)) setPanelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPanelOpen(false);
        rootEl?.querySelector<HTMLElement>('.pr-cloud')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [panelOpen, rootEl]);

  if (!me) return null;

  const hoverIn = (id: number, el: HTMLElement, delay = HOVER_DELAY_MS) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHover({ id, el }), delay);
  };
  const hoverOut = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHover(null), LEAVE_DELAY_MS);
  };
  const togglePanel = () => {
    window.clearTimeout(timer.current);
    setHover(null);
    setPanelOpen((v) => !v);
  };

  const onlineCount = active.filter((m) => m.status === 'online').length;
  const cloudLabel =
    active.length === 0 ? '全部成員（目前只有你在線上）' : `全部成員（${active.length} 人在線上）`;

  return (
    <div className="pr-stack" ref={setRootEl} role="group" aria-label="在線成員">
      {shown.length > 0 && (
        <div className="pr-avatars">
          {shown.map((m, i) => {
            const user = usersById.get(m.userId)!;
            const text = describeMember(m, now);
            return (
              <span
                key={m.userId}
                className="pr-item"
                // 前面的頭像疊在上層，右下角的狀態圓點才不會被下一個頭像蓋住
                style={{ zIndex: shown.length - i }}
                onPointerEnter={(e) => hoverIn(m.userId, e.currentTarget)}
                onPointerLeave={hoverOut}
                onFocus={(e) => hoverIn(m.userId, e.currentTarget, 0)}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hoverOut();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && hover?.id === m.userId) {
                    e.stopPropagation();
                    setHover(null);
                  }
                }}
              >
                <button
                  type="button"
                  className="pr-avatar-btn"
                  aria-label={`${user.displayName}，${STATUS_LABEL[m.status]}，${text.doing}`}
                  aria-haspopup="dialog"
                  aria-controls={panelOpen ? panelId : undefined}
                  onClick={togglePanel}
                >
                  <PresenceAvatar user={user} member={m} />
                </button>
                {hover?.id === m.userId && !panelOpen && (
                  <Floating
                    anchor={hover.el}
                    className="pr-floating"
                    onPointerEnter={() => hoverIn(m.userId, hover.el, 0)}
                    onPointerLeave={hoverOut}
                  >
                    <PresenceCard user={user} member={m} now={now} onDone={() => setHover(null)} />
                  </Floating>
                )}
              </span>
            );
          })}
          {rest > 0 && (
            <button
              type="button"
              className="pr-more"
              aria-label={`另外 ${rest} 人在線上，查看全部成員`}
              onClick={togglePanel}
            >
              +{rest}
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className="pr-cloud"
        data-alone={active.length === 0 || undefined}
        aria-label={cloudLabel}
        aria-expanded={panelOpen}
        aria-controls={panelOpen ? panelId : undefined}
        title={cloudLabel}
        onClick={togglePanel}
      >
        <CloudIcon />
        {onlineCount > 0 && <span className="pr-cloud-count">{onlineCount}</span>}
      </button>
      {panelOpen && (
        <Floating anchor={rootEl} className="pr-floating" floatingRef={panelRef}>
          <PresencePanel
            id={panelId}
            members={members ?? []}
            meId={me.id}
            usersById={usersById}
            now={now}
            onClose={() => setPanelOpen(false)}
          />
        </Floating>
      )}
    </div>
  );
}

function CloudIcon() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.2 4.5 4.5 0 0 0 7 18z" />
    </svg>
  );
}
