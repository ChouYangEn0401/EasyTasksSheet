import { createElement, Fragment } from 'preact';
import { useEffect, useRef } from 'preact/compat';
import { describeMember, setPresenceHidden, usePresenceHidden } from '../../lib/presence.js';
import { Checkbox } from '../../ui/index.js';
import { PresenceAvatar } from './PresenceAvatar.js';
import { PresenceLine } from './PresenceCard.js';

const GROUPS = [
  { status: 'online', title: '在線上' },
  { status: 'idle', title: '暫時離開' },
  { status: 'offline', title: '離線' },
];

/**
 * 「全部成員」面板（點頭像堆疊或雲朵展開）：在線 → 閒置 → 離線；
 * 離線成員顯示「最後上線 3 小時前 · 最後看的是 清單」。底部為「隱藏我的動態」開關。
 * 不排名、不顯示精確時間。
 */
export function PresencePanel({ id, members, meId, usersById, now, onClose }) {
  const hidden = usePresenceHidden();
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const others = members.filter((m) => m.userId !== meId && usersById.has(m.userId));
  // 同組內依名稱排序（不依活躍程度排名）
  const byName = (a, b) =>
    usersById.get(a.userId).displayName.localeCompare(usersById.get(b.userId).displayName, 'zh-Hant');

  return createElement(
    'div',
    { id: id, ref: ref, className: 'pr-panel', role: 'dialog', 'aria-label': '全部成員', tabIndex: -1 },
    createElement(
      'div',
      { className: 'pr-panel-head' },
      createElement('span', { className: 'pr-panel-title' }, '大家在哪裡'),
      createElement(
        'span',
        { className: 'pr-panel-hint' },
        others.some((m) => m.status === 'online') ? '一起在線上 ☁' : '目前只有你在線上',
      ),
    ),
    createElement(
      'div',
      { className: 'pr-panel-body' },
      others.length === 0 && createElement('p', { className: 'pr-empty' }, '還沒有其他成員'),
      GROUPS.map((g) => {
        const list = others.filter((m) => m.status === g.status).sort(byName);
        if (!list.length) return null;
        return createElement(
          'section',
          { key: g.status, className: 'pr-group', 'aria-label': g.title },
          createElement(
            'h3',
            { className: 'pr-group-title' },
            g.title,
            createElement('span', { className: 'pr-group-count' }, list.length),
          ),
          createElement(
            'ul',
            { className: 'pr-list' },
            list.map((m) => {
              const user = usersById.get(m.userId);
              const text = describeMember(m, now);
              return createElement(
                'li',
                { key: m.userId, className: 'pr-row', 'data-status': m.status },
                createElement(PresenceAvatar, { user: user, member: m, size: 'sm' }),
                createElement(
                  'div',
                  { className: 'pr-row-main' },
                  createElement('span', { className: 'pr-row-name' }, user.displayName),
                  createElement(PresenceLine, { member: m, text: text.doing, onOpen: onClose }),
                  (text.lastOpened || text.when) &&
                    createElement(
                      'span',
                      { className: 'pr-row-sub' },
                      [text.lastOpened, m.status === 'online' ? null : text.when].filter(Boolean).join(' · '),
                    ),
                ),
              );
            }),
          ),
        );
      }),
    ),
    createElement(
      'div',
      { className: 'pr-panel-foot' },
      createElement(Checkbox, {
        checked: hidden,
        onChange: (e) => setPresenceHidden(e.target.checked),
        label: '隱藏我的動態',
      }),
      createElement(
        'p',
        { className: 'pr-foot-hint' },
        hidden ? '大家只會看到你在線上，不會看到你在看什麼' : '開啟後，大家只會看到你在線上',
      ),
    ),
  );
}
