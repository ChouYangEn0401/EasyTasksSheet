import { createElement, Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/compat';
import { api, errorMessage } from '../../lib/api.js';
import { statusStyle, statusTone, tagVars } from '../../lib/colors.js';
import { useProjects, useProjectsById, useStatusesById, useUsers, useUsersById } from '../../lib/hooks.js';
import { useNavigate } from '../../lib/router.js';
import { openTask } from '../../lib/openTask.js';
import { Avatar, Icon, Kbd } from '../../ui/index.js';
import {
  DEBOUNCE_MS,
  TASK_LIMIT,
  filterLinks,
  filterProjects,
  filterUsers,
  highlight,
  modKeyLabel,
  normalizeQuery,
  QUICK_LINKS,
  readRecent,
  rememberRecent,
  taskIdQuery,
} from './searchModel.js';
import { closeSearch, takeReturnFocus, useSearchState } from './searchStore.js';

/*
 * 全站搜尋浮層（docs/design/ui-refresh-2026-11-26.md §7）。
 * <dialog class="cmdk"> + showModal：Esc／點遮罩／選定後關閉，關閉後焦點回到開啟前的位置。
 * 任務用既有 GET /api/tasks?q=（前 8 筆）；專案與成員用既有快取本地過濾。
 * 鍵盤：↑↓ 跨組移動、Home／End、Tab／Shift+Tab 跳組、Enter 開啟、Esc 關閉。
 */

const LIST_ID = 'cmdk-list';
const optionId = (key) => `cmdk-opt-${key}`;

function Highlighted({ text, q }) {
  return createElement(
    Fragment,
    null,
    highlight(text, q).map((s, i) => (s.hit ? createElement('mark', { key: i }, s.text) : s.text)),
  );
}

/** 任務搜尋：debounce 後打 /api/tasks?q=；#id 另外直接查那一筆 */
function useTaskSearch(q) {
  const [state, setState] = useState({ q: '', tasks: [], total: 0, loading: false, error: null });
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setState({ q: '', tasks: [], total: 0, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    const ctrl = new AbortController();
    const byId = taskIdQuery(query);
    Promise.all([
      api.get(`/tasks?q=${encodeURIComponent(query)}`, { signal: ctrl.signal }),
      byId != null
        ? api.get(`/tasks/${byId}`, { signal: ctrl.signal }).catch((e) => {
            if (e?.name === 'AbortError') throw e;
            return null;
          })
        : Promise.resolve(null),
    ]).then(
      ([list, one]) => {
        const rows = Array.isArray(list) ? list : [];
        const merged = one && one.deletedAt == null ? [one, ...rows.filter((t) => t.id !== one.id)] : rows;
        setState({ q: query, tasks: merged.slice(0, TASK_LIMIT), total: merged.length, loading: false, error: null });
      },
      (e) => {
        if (e?.name === 'AbortError') return;
        setState({ q: query, tasks: [], total: 0, loading: false, error: errorMessage(e) });
      },
    );
    return () => ctrl.abort();
  }, [q]);
  return state;
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    if (!value.trim()) {
      setV(value);
      return;
    }
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function StatusDot({ status }) {
  const tone = status ? statusTone(status) : 'todo';
  return createElement('span', {
    className: 'ui-dot ui-dot--md cmdk-status-dot',
    style: statusStyle(tone),
    'aria-hidden': 'true',
  });
}

/** 浮層內容（只在開著時掛載，避免平常也在輪詢專案、成員） */
function PaletteBody({ nonce, onClose }) {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [input, setInput] = useState('');
  const [active, setActive] = useState(0);
  const q = useDebounced(input, DEBOUNCE_MS);
  const nq = normalizeQuery(q);
  const projects = useProjects().data;
  const users = useUsers().data;
  const projectsById = useProjectsById();
  const usersById = useUsersById();
  const statusesById = useStatusesById();
  const search = useTaskSearch(q);
  const [recent] = useState(() => readRecent());

  // 已開著又按 Ctrl+K：焦點拉回輸入框並全選
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [nonce]);

  const taskMeta = (t) => {
    const parts = [];
    const p = t.projectId != null ? projectsById.get(t.projectId) : null;
    parts.push(p?.name ?? '無專案');
    const s = t.statusId != null ? statusesById.get(t.statusId) : null;
    if (s) parts.push(s.name);
    const u = t.assigneeId != null ? usersById.get(t.assigneeId) : null;
    parts.push(u?.displayName ?? '未指派');
    return parts.join(' · ');
  };

  const openTaskItem = (t) => ({
    key: `t-${t.id}`,
    kind: 'task',
    title: t.title,
    meta: taskMeta(t),
    lead: createElement(StatusDot, { status: t.statusId != null ? statusesById.get(t.statusId) : null }),
    label: `任務 #${t.id} ${t.title}，${taskMeta(t)}`,
    run: () =>
      onClose(() => {
        rememberRecent(t);
        openTask(t.id);
      }),
  });
  const goItem = (key, title, to, meta, lead) => ({
    key,
    kind: 'link',
    title,
    meta,
    lead,
    run: () => onClose(() => navigate(to)),
  });

  const groups = useMemo(() => {
    const out = [];
    if (!nq) {
      if (recent.length > 0)
        out.push({ key: 'recent', label: '最近開啟', items: recent.map(openTaskItem) });
      out.push({
        key: 'links',
        label: '快速前往',
        items: QUICK_LINKS.map((l) =>
          goItem(`l-${l.key}`, l.label, l.to, `快捷鍵 ${l.keys}`, createElement(Icon, { name: 'chevronRight', size: 14 })),
        ),
      });
      return out;
    }
    const taskItems = search.q === q.trim() ? search.tasks.map(openTaskItem) : [];
    if (search.q === q.trim() && search.total > search.tasks.length)
      taskItems.push(
        goItem(
          'all-tasks',
          `查看全部 ${search.total} 筆任務`,
          `/tasks/list?q=${encodeURIComponent(q.trim())}`,
          '清單頁',
          createElement(Icon, { name: 'list', size: 14 }),
        ),
      );
    out.push({
      key: 'tasks',
      label: '任務',
      count: search.q === q.trim() ? search.total : null,
      items: taskItems,
      note: search.error
        ? `搜尋失敗：${search.error}`
        : search.loading && taskItems.length === 0
          ? '搜尋中…'
          : null,
    });
    const ps = filterProjects(projects, q);
    if (ps.items.length > 0)
      out.push({
        key: 'projects',
        label: '專案',
        count: ps.total,
        items: ps.items.map((p) =>
          goItem(
            `p-${p.id}`,
            p.name,
            `/tasks/list?project=${p.id}`,
            p.isArchived ? '已封存' : '看這個專案的任務',
            createElement('span', {
              className: 'cmdk-project-swatch',
              style: { background: tagVars(p.color).color },
              'aria-hidden': 'true',
            }),
          ),
        ),
      });
    const us = filterUsers(users, q);
    if (us.items.length > 0)
      out.push({
        key: 'users',
        label: '成員',
        count: us.total,
        items: us.items.map((u) =>
          goItem(
            `u-${u.id}`,
            u.displayName,
            `/tasks/list?assignee=${u.id}`,
            `@${u.username} · 看他負責的任務`,
            createElement(Avatar, { user: u, size: 'xs', tooltip: false }),
          ),
        ),
      });
    const ls = filterLinks(q);
    if (ls.length > 0)
      out.push({
        key: 'links',
        label: '頁面',
        items: ls.map((l) =>
          goItem(`l-${l.key}`, l.label, l.to, `快捷鍵 ${l.keys}`, createElement(Icon, { name: 'chevronRight', size: 14 })),
        ),
      });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nq, q, recent, search, projects, users, projectsById, usersById, statusesById]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const groupStarts = useMemo(() => {
    const starts = [];
    let i = 0;
    for (const g of groups) {
      if (g.items.length > 0) starts.push(i);
      i += g.items.length;
    }
    return starts;
  }, [groups]);

  // 結果換了就回到第一筆
  useEffect(() => setActive(0), [nq, search]);
  const current = flat.length > 0 ? Math.min(active, flat.length - 1) : -1;
  const activeItem = current >= 0 ? flat[current] : null;

  // 選中的那一筆捲進可視範圍
  useEffect(() => {
    if (!activeItem) return;
    const el = listRef.current?.querySelector(`#${optionId(activeItem.key)}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeItem?.key]);

  const onKeyDown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const n = flat.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n === 0) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((current + d + n) % n);
    } else if ((e.key === 'Home' || e.key === 'End') && e.ctrlKey) {
      e.preventDefault();
      if (n > 0) setActive(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (groupStarts.length === 0) return;
      const curGroup = groupStarts.filter((s) => s <= current).length - 1;
      const g = e.shiftKey
        ? (curGroup - 1 + groupStarts.length) % groupStarts.length
        : (curGroup + 1) % groupStarts.length;
      setActive(groupStarts[g]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activeItem?.run();
    }
  };

  const nothing = nq && flat.length === 0 && !search.loading && !search.error && search.q === q.trim();
  const mod = modKeyLabel();

  let idx = 0;
  return createElement(
    Fragment,
    null,
    createElement(
      'div',
      { className: 'cmdk-input-row' },
      createElement(Icon, { name: 'search', size: 16, className: 'cmdk-icon' }),
      createElement('input', {
        ref: inputRef,
        className: 'cmdk-input',
        type: 'text',
        role: 'combobox',
        'aria-label': '全站搜尋：任務、專案、成員',
        'aria-expanded': flat.length > 0 ? 'true' : 'false',
        'aria-controls': LIST_ID,
        'aria-autocomplete': 'list',
        'aria-activedescendant': activeItem ? optionId(activeItem.key) : undefined,
        placeholder: '搜尋任務、專案、成員…',
        autoComplete: 'off',
        spellCheck: false,
        value: input,
        maxLength: 200,
        onInput: (e) => setInput(e.currentTarget.value),
        onKeyDown: onKeyDown,
      }),
      createElement(Kbd, null, 'Esc'),
    ),
    createElement(
      'div',
      {
        ref: listRef,
        className: 'cmdk-list',
        id: LIST_ID,
        role: 'listbox',
        'aria-label': '搜尋結果',
      },
      groups.map((g) => {
        const labelId = `cmdk-g-${g.key}`;
        return createElement(
          'div',
          { key: g.key, className: 'cmdk-group', role: 'group', 'aria-labelledby': labelId },
          createElement(
            'div',
            { className: 'cmdk-group-label', id: labelId },
            g.label,
            g.count != null && createElement('span', { className: 'cmdk-group-count' }, g.count),
          ),
          g.note && createElement('div', { className: 'cmdk-group-note', role: 'status' }, g.note),
          !g.note &&
            g.key === 'tasks' &&
            g.items.length === 0 &&
            createElement('div', { className: 'cmdk-group-note' }, '沒有符合的任務'),
          g.items.map((it) => {
            const i = idx++;
            const selected = i === current;
            return createElement(
              'div',
              {
                key: it.key,
                id: optionId(it.key),
                className: `cmdk-item cmdk-item--${it.kind}`,
                role: 'option',
                'aria-selected': selected ? 'true' : 'false',
                'aria-label': it.label,
                onMouseMove: () => i !== current && setActive(i),
                onMouseDown: (e) => e.preventDefault(),
                onClick: () => it.run(),
              },
              createElement('span', { className: 'cmdk-item-lead' }, it.lead),
              createElement(
                'span',
                { className: 'cmdk-item-title' },
                createElement(Highlighted, { text: it.title, q: q }),
              ),
              createElement('span', { className: 'cmdk-item-meta' }, it.meta),
              createElement('kbd', { className: 'ui-kbd cmdk-item-kbd', 'aria-hidden': 'true' }, '↵'),
            );
          }),
        );
      }),
      nothing && createElement('div', { className: 'cmdk-empty' }, `找不到「${q.trim()}」`),
    ),
    createElement(
      'div',
      { className: 'cmdk-foot', 'aria-hidden': 'true' },
      createElement('span', null, createElement(Kbd, null, '↑↓'), '移動'),
      createElement('span', null, createElement(Kbd, null, '↵'), '開啟'),
      createElement('span', null, createElement(Kbd, null, 'Tab'), '切換分組'),
      createElement('span', null, createElement(Kbd, null, 'Esc'), '關閉'),
      createElement('span', { className: 'cmdk-foot-end' }, createElement(Kbd, null, mod), createElement(Kbd, null, 'K'), '隨時開啟'),
    ),
  );
}

/** 浮層本體：跟著 searchStore 開關；掛在頂欄的搜尋按鈕旁邊（見 SearchButton） */
export function CommandPalette() {
  const { open, nonce } = useSearchState();
  const ref = useRef(null);

  /** 關閉並把焦點送回開啟前的位置；after 在焦點歸位後才做（openTask 才記得住正確的返回點） */
  const close = (after) => {
    const el = ref.current;
    if (el?.open) el.close();
    const back = takeReturnFocus();
    if (back?.isConnected) back.focus();
    closeSearch();
    after?.();
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      const input = el.querySelector('.cmdk-input');
      input?.focus();
      input?.select();
    } else if (!open && el.open) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return createElement(
    'dialog',
    {
      ref: ref,
      className: 'cmdk',
      'aria-label': '全站搜尋',
      onCancel: (e) => {
        e.preventDefault();
        close();
      },
      onClick: (e) => {
        // 點在 <dialog> 本身（遮罩）才關
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) close();
      },
    },
    open && createElement(PaletteBody, { nonce: nonce, onClose: close }),
  );
}
