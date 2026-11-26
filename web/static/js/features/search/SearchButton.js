import { createElement, Fragment } from 'preact';
import { useEffect } from 'preact/compat';
import { useTask } from '../../lib/hooks.js';
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

/** 不管從哪裡開的任務抽屜（?task=），都記進「最近開啟」 */
function RecentTracker() {
  const [sp] = useSearchParams();
  const id = readTaskParam(sp);
  const { data } = useTask(id);
  const task = id != null && data?.id === id ? data : null;
  useEffect(() => {
    if (task && task.deletedAt == null) rememberRecent(task);
  }, [task?.id, task?.title, task?.statusId, task?.projectId, task?.assigneeId]);
  return null;
}
