import { createElement, Fragment } from 'preact';
import { useEffect } from 'preact/compat';
import { useQueryClient } from '../../lib/query.js';
import { findCachedTask } from '../../lib/taskUndo.js';
import { readTaskParam } from '../../lib/openTask.js';
import { useSearchParams } from '../../lib/router.js';
import { Icon, Kbd } from '../../ui/index.js';
import { CommandPalette } from './CommandPalette.js';
import { modKeyLabel, rememberRecent } from './searchModel.js';
import { openSearch } from './searchStore.js';

/**
 * 頂欄的全站搜尋入口（ui-refresh §2.2）：長得像輸入框的按鈕，點了開 Ctrl+K 浮層。
 * 浮層本身也掛在這裡（頂欄在所有登入後頁面都在），快捷鍵只透過 searchStore 叫它開。
 */
export function SearchButton() {
  const mod = modKeyLabel();
  return createElement(
    Fragment,
    null,
    createElement(
      'button',
      {
        type: 'button',
        className: 'header-search',
        'aria-label': '全站搜尋',
        'aria-haspopup': 'dialog',
        'aria-keyshortcuts': 'Control+K Meta+K',
        title: `全站搜尋（${mod}+K）`,
        onClick: () => openSearch(),
      },
      createElement(Icon, { name: 'search', size: 16 }),
      createElement('span', { className: 'header-search-text' }, '搜尋'),
      createElement(Kbd, null, mod),
      createElement(Kbd, null, 'K'),
    ),
    createElement(CommandPalette, null),
    createElement(RecentTracker, null),
  );
}

/**
 * 不管從哪裡開的任務抽屜（?task=），都記進「最近開啟」。
 * 只讀快取（抽屜自己會抓那筆任務），不另外掛查詢——多掛一個任務查詢的觀察者會干擾清單頁的篩選 debounce。
 */
function RecentTracker() {
  const [sp] = useSearchParams();
  const id = readTaskParam(sp);
  const qc = useQueryClient();
  useEffect(() => {
    if (id == null) return;
    const timers = [];
    let done = false;
    const tryRecord = () => {
      if (done) return;
      const t = findCachedTask(qc, id);
      if (t && t.deletedAt == null) {
        done = true;
        rememberRecent(t);
      }
    };
    tryRecord();
    for (const ms of [300, 1000, 2500, 5000]) timers.push(window.setTimeout(tryRecord, ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [id, qc]);
  return null;
}
