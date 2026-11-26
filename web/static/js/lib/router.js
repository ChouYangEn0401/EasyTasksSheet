/**
 * router.js —— react-router v7 的子集相容替代品（Preact 版，原生 ES module、零建置）。
 *
 * 呼叫端只把 `from 'react-router'` 換成 `from '../lib/router.js'`，所以這裡的匯出名稱、
 * 參數形狀、行為都照 react-router：
 *   createBrowserRouter / RouterProvider / Outlet / Navigate / Link / NavLink /
 *   useLocation / useNavigate / useMatches / useParams / useSearchParams / matchRoutes
 *   （另附 createPath / parsePath / resolvePath / createSearchParams / useHref / useOutlet）
 *
 * 只允許 import 'preact' 與 'preact/hooks'（由 import map 提供），不得 import 任何第三方套件。
 *
 * 設計重點：
 *  1. 網址用 history.pushState / replaceState（加上 basename），改完同步更新 router.state，
 *     再通知訂閱者重畫；同一個 location 連續 navigate 會改成 replace，不重複 push。
 *  2. 渲染時由葉到根一層一層用 RouteContext.Provider 包住 route.element（已建好的 vnode）；
 *     同一個 route 物件在 location 變化時 vnode 型別不變，所以 Preact 只會重畫、不會重新掛載
 *     （RequireAuth、PageLayout 這類外框在子路由切換時保持掛載）。
 *  3. useSearchParams 的 setter 以 router.state.location（navigate 後同步更新）為準，
 *     同一個 tick 內連續呼叫也會疊在最新的 search 上。
 *  4. 不自動捲到頂。
 */
import { createContext, createElement } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useState } from 'preact/hooks';

// ─────────────────────────────────────────────────────────────────────────────
// 路徑工具
// ─────────────────────────────────────────────────────────────────────────────

/** 把好幾段路徑接起來並壓掉重複的斜線：joinPaths(['/a/', '/b']) → '/a/b' */
function joinPaths(paths) {
  return paths.join('/').replace(/\/\/+/g, '/');
}

/** 去掉結尾多餘的斜線（根目錄保留 '/'） */
function normalizePathname(pathname) {
  return pathname.replace(/\/+$/, '').replace(/^\/*/, '/');
}

/** 字串 → { pathname, search, hash }（照 react-router 的 parsePath） */
export function parsePath(path) {
  const parsed = {};
  if (path) {
    const hashIndex = path.indexOf('#');
    if (hashIndex >= 0) {
      parsed.hash = path.slice(hashIndex);
      path = path.slice(0, hashIndex);
    }
    const searchIndex = path.indexOf('?');
    if (searchIndex >= 0) {
      parsed.search = path.slice(searchIndex);
      path = path.slice(0, searchIndex);
    }
    if (path) parsed.pathname = path;
  }
  return parsed;
}

/** { pathname, search, hash } → 字串 */
export function createPath({ pathname = '/', search = '', hash = '' }) {
  if (search && search !== '?') pathname += search.charAt(0) === '?' ? search : '?' + search;
  if (hash && hash !== '#') pathname += hash.charAt(0) === '#' ? hash : '#' + hash;
  return pathname;
}

/** 把相對 pathname 解析成絕對路徑（'..' 往上一層、'.' 留在原地） */
function resolvePathname(relativePath, fromPathname) {
  const segments = fromPathname.replace(/\/+$/, '').split('/');
  for (const segment of relativePath.split('/')) {
    if (segment === '..') {
      if (segments.length > 1) segments.pop();
    } else if (segment !== '.') {
      segments.push(segment);
    }
  }
  return segments.length > 1 ? segments.join('/') : '/';
}

/**
 * 把 `to`（字串或 { pathname, search, hash }）解析成絕對的 { pathname, search, hash }。
 * 沒給 pathname（例如只給 '?a=1'）就沿用 fromPathname；相對路徑以 fromPathname 為基準。
 */
export function resolvePath(to, fromPathname = '/') {
  const { pathname: toPathname, search = '', hash = '' } = typeof to === 'string' ? parsePath(to) : to;
  let pathname;
  if (toPathname == null || toPathname === '') pathname = fromPathname;
  else if (toPathname.startsWith('/')) pathname = toPathname;
  else pathname = resolvePathname(toPathname, fromPathname);
  return { pathname, search: normalizeSearch(search), hash: normalizeHash(hash) };
}

function normalizeSearch(search) {
  return !search || search === '?' ? '' : search.startsWith('?') ? search : '?' + search;
}

function normalizeHash(hash) {
  return !hash || hash === '#' ? '' : hash.startsWith('#') ? hash : '#' + hash;
}

/** basename 正規化：'/' 或 '' → ''（根目錄）；'/easytasks/' → '/easytasks' */
function normalizeBasename(basename) {
  if (!basename) return '';
  const b = basename.replace(/\/+$/, '');
  return b === '' ? '' : b.startsWith('/') ? b : '/' + b;
}

/** 從瀏覽器 pathname 去掉 basename；不是這個 basename 底下的路徑回 null（照 react-router 不分大小寫） */
function stripBasename(pathname, basename) {
  if (!basename || basename === '/') return pathname;
  if (!pathname.toLowerCase().startsWith(basename.toLowerCase())) return null;
  const startIndex = basename.endsWith('/') ? basename.length - 1 : basename.length;
  const nextChar = pathname.charAt(startIndex);
  if (nextChar && nextChar !== '/') return null; // '/easytasksx' 不算 '/easytasks' 底下
  return pathname.slice(startIndex) || '/';
}

/** 解碼網址中的 %XX；壞掉的編碼原樣留著不要炸 */
function decodePath(value) {
  try {
    return value
      .split('/')
      .map((v) => decodeURIComponent(v).replace(/\//g, '%2F'))
      .join('/');
  } catch {
    return value;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 路由比對（照 react-router：攤平成分支、算分排序、逐段比對）
// ─────────────────────────────────────────────────────────────────────────────

const paramRe = /^:[\w-]+$/;
const dynamicSegmentValue = 3;
const indexRouteValue = 2;
const emptySegmentValue = 1;
const staticSegmentValue = 10;
const splatPenalty = -2;
const isSplat = (s) => s === '*';

/** 排名：靜態段 > 參數段 > splat；index 優先於 splat */
function computeScore(path, index) {
  const segments = path.split('/');
  let initialScore = segments.length;
  if (segments.some(isSplat)) initialScore += splatPenalty;
  if (index) initialScore += indexRouteValue;
  return segments
    .filter((s) => !isSplat(s))
    .reduce(
      (score, segment) =>
        score +
        (paramRe.test(segment)
          ? dynamicSegmentValue
          : segment === ''
            ? emptySegmentValue
            : staticSegmentValue),
      initialScore,
    );
}

/** 同分時照宣告順序（父層相同的兄弟，先宣告的先） */
function compareIndexes(a, b) {
  const siblings = a.length === b.length && a.slice(0, -1).every((n, i) => n === b[i]);
  return siblings ? a[a.length - 1] - b[b.length - 1] : 0;
}

function rankRouteBranches(branches) {
  branches.sort((a, b) =>
    a.score !== b.score
      ? b.score - a.score
      : compareIndexes(
          a.routesMeta.map((m) => m.childrenIndex),
          b.routesMeta.map((m) => m.childrenIndex),
        ),
  );
}

/**
 * 把巢狀路由表攤成「每一條可能命中的分支」。
 * 沒有 path 也不是 index 的路由（純版面層，例如 PageLayout）只當中間層，不自己成一條分支。
 * 每個 route 的 id：沒宣告就用 '0-1-2' 這種位置編號（照 react-router）。
 */
function flattenRoutes(routes, branches = [], parentsMeta = [], parentPath = '', parentId = '') {
  routes.forEach((route, index) => {
    const id = route.id != null ? String(route.id) : parentId ? `${parentId}-${index}` : String(index);
    const meta = {
      relativePath: route.path || '',
      caseSensitive: route.caseSensitive === true,
      childrenIndex: index,
      route,
      id,
    };
    if (meta.relativePath.startsWith('/')) {
      if (!meta.relativePath.startsWith(parentPath)) {
        throw new Error(`絕對路徑 "${meta.relativePath}" 嵌在 "${parentPath}" 底下，必須以父路徑開頭`);
      }
      meta.relativePath = meta.relativePath.slice(parentPath.length);
    }
    const path = joinPaths([parentPath, meta.relativePath]);
    const routesMeta = parentsMeta.concat(meta);

    if (route.children && route.children.length > 0) {
      if (route.index === true) throw new Error(`index 路由不能有 children（路徑 "${path}"）`);
      flattenRoutes(route.children, branches, routesMeta, path, id);
    }
    // 沒有 path 的純版面層不能單獨命中
    if (route.path == null && !route.index) return;
    branches.push({ path, score: computeScore(path, route.index), routesMeta });
  });
  return branches;
}

/** 把一段 path 樣式編成正規表示式；回 [regexp, 參數名清單] */
function compilePath(path, caseSensitive = false, end = true) {
  const params = [];
  let regexpSource =
    '^' +
    path
      .replace(/\/*\*?$/, '') // 結尾的 / 與 /* 先拿掉，splat 下面另外處理
      .replace(/^\/*/, '/') // 保證一個開頭斜線
      .replace(/[\\.*+^${}|()[\]]/g, '\\$&') // 跳脫正規表示式特殊字元
      .replace(/\/:([\w-]+)(\?)?/g, (_, paramName, isOptional) => {
        params.push({ paramName, isOptional: isOptional != null });
        return isOptional ? '/?([^\\/]+)?' : '/([^\\/]+)';
      });

  if (path.endsWith('*')) {
    params.push({ paramName: '*' });
    regexpSource += path === '*' || path === '/*' ? '(.*)$' : '(?:\\/(.+)|\\/*)$';
  } else if (end) {
    regexpSource += '\\/*$';
  } else if (path !== '' && path !== '/') {
    // 不是結尾那一層：後面要接 '/' 或結束（'/tasks' 不能命中 '/tasksx'）
    regexpSource += '(?:(?=\\/|$))';
  } else {
    // 空路徑（版面層）：什麼都接得下
  }
  return [new RegExp(regexpSource, caseSensitive ? undefined : 'i'), params];
}

/** 單一 path 樣式 vs pathname；沒命中回 null */
export function matchPath(pattern, pathname) {
  if (typeof pattern === 'string') pattern = { path: pattern, caseSensitive: false, end: true };
  const [matcher, compiledParams] = compilePath(pattern.path, pattern.caseSensitive, pattern.end);
  const match = pathname.match(matcher);
  if (!match) return null;

  const matchedPathname = match[0];
  let pathnameBase = matchedPathname.replace(/(.)\/+$/, '$1');
  const captureGroups = match.slice(1);
  const params = compiledParams.reduce((memo, { paramName, isOptional }, index) => {
    if (paramName === '*') {
      const splatValue = captureGroups[index] || '';
      pathnameBase = matchedPathname
        .slice(0, matchedPathname.length - splatValue.length)
        .replace(/(.)\/+$/, '$1');
    }
    const value = captureGroups[index];
    memo[paramName] = isOptional && !value ? undefined : (value || '').replace(/%2F/g, '/');
    return memo;
  }, {});

  return { params, pathname: matchedPathname, pathnameBase, pattern };
}

/** 一條分支逐層比對；全部對得上才回 matches（每一層一筆） */
function matchRouteBranch(branch, pathname) {
  const { routesMeta } = branch;
  const matchedParams = {};
  let matchedPathname = '/';
  const matches = [];
  for (let i = 0; i < routesMeta.length; ++i) {
    const meta = routesMeta[i];
    const end = i === routesMeta.length - 1;
    const remainingPathname =
      matchedPathname === '/' ? pathname : pathname.slice(matchedPathname.length) || '/';
    const match = matchPath(
      { path: meta.relativePath, caseSensitive: meta.caseSensitive, end },
      remainingPathname,
    );
    if (!match) return null;

    Object.assign(matchedParams, match.params);
    matches.push({
      params: matchedParams,
      pathname: joinPaths([matchedPathname, match.pathname]),
      pathnameBase: normalizePathname(joinPaths([matchedPathname, match.pathnameBase])),
      route: meta.route,
      id: meta.id,
    });
    if (match.pathnameBase !== '/') matchedPathname = joinPaths([matchedPathname, match.pathnameBase]);
  }
  return matches;
}

/** 攤平與排序的結果照路由表物件快取（同一份 routes 不重算） */
const branchesCache = new WeakMap();
function getBranches(routes) {
  let branches = branchesCache.get(routes);
  if (!branches) {
    branches = flattenRoutes(routes);
    rankRouteBranches(branches);
    branchesCache.set(routes, branches);
  }
  return branches;
}

/**
 * 純函式：routes × pathname → 從根到葉的 matches（[{ route, id, pathname, pathnameBase, params }]）；
 * 沒命中回 null。`locationArg` 可給字串或 { pathname }；給了 basename 會先去掉。
 */
export function matchRoutes(routes, locationArg, basename = '/') {
  const location = typeof locationArg === 'string' ? parsePath(locationArg) : locationArg;
  const pathname = stripBasename(location.pathname || '/', normalizeBasename(basename) || '/');
  if (pathname == null) return null;

  const branches = getBranches(routes);
  const decoded = decodePath(pathname);
  for (let i = 0; i < branches.length; ++i) {
    const matches = matchRouteBranch(branches[i], decoded);
    if (matches) return matches;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 瀏覽器 history → location
// ─────────────────────────────────────────────────────────────────────────────

/** 隨機 key（跟 react-router 一樣 8 碼） */
function createKey() {
  return Math.random().toString(36).substring(2, 10);
}

/** 讀瀏覽器目前的網址，轉成 router 用的 location（pathname 已去掉 basename；不在 basename 底下時原樣） */
function readLocation(basename) {
  const { pathname, search, hash } = window.location;
  const state = window.history.state;
  const stripped = stripBasename(pathname, basename || '/');
  return {
    pathname: stripped == null ? pathname : stripped,
    search,
    hash,
    state: state && state.usr !== undefined ? state.usr : null,
    key: (state && state.key) || 'default',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Router 物件
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 建 router：{ routes, basename, state: { location, matches }, navigate, subscribe, createHref, dispose }
 *  - navigate(to, { replace?, state? })：回 Promise；to 為字串（'/x?y'）、{ pathname, search, hash }，
 *    或數字（navigate(-1) = history.back()）。
 *  - subscribe(fn)：location 改變時呼叫 fn(state)；回退訂函式。
 */
export function createBrowserRouter(routes, opts = {}) {
  const basename = normalizeBasename(opts.basename);
  const subscribers = new Set();
  /** 路由路徑 → 瀏覽器實際網址：加 basename；根目錄在子路徑部署時是 '/easytasks'（不帶結尾斜線） */
  const hrefFor = (path) => {
    if (!path.startsWith('/')) path = '/' + path;
    if (!basename) return path;
    return path === '/' ? basename : basename + path;
  };

  // 第一次載入時瀏覽器的 history.state 多半是 null：補一個 key，之後 back/forward 才有東西可對
  if (window.history.state == null || window.history.state.key == null) {
    const usr = window.history.state && window.history.state.usr;
    window.history.replaceState({ usr: usr === undefined ? null : usr, key: 'default', idx: 0 }, '');
  }

  const router = {
    routes,
    basename: basename || '/',
    state: null,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    /** 路由路徑 → 瀏覽器實際網址（加上 basename） */
    createHref(to) {
      if (typeof to === 'number') return basename || '/';
      return hrefFor(createPath(resolvePath(to, router.state.location.pathname)));
    },
    async navigate(to, navOpts = {}) {
      if (typeof to === 'number') {
        window.history.go(to); // popstate 會接手更新 state
        return;
      }
      const current = router.state.location;
      const resolved = resolvePath(to, current.pathname);
      const href = hrefFor(createPath(resolved));
      const nextState = navOpts.state === undefined ? null : navOpts.state;

      const currentHref = window.location.pathname + window.location.search + window.location.hash;
      // 同一個 location 連續 navigate：改成 replace，不要重複 push
      const sameLocation = currentHref === href;
      const replace = navOpts.replace === true || sameLocation;
      const key = replace && sameLocation && nextState === current.state ? current.key : createKey();
      const idx = (window.history.state && window.history.state.idx) || 0;
      const historyState = { usr: nextState, key, idx: replace ? idx : idx + 1 };
      try {
        if (replace) window.history.replaceState(historyState, '', href);
        else window.history.pushState(historyState, '', href);
      } catch {
        // 某些瀏覽器 pushState 太頻繁會丟 SecurityError：退回整頁跳轉
        window.location.assign(href);
        return;
      }
      router._sync();
    },
    /** 從瀏覽器目前網址重算 state 並通知訂閱者（navigate 與 popstate 共用） */
    _sync() {
      const location = readLocation(basename);
      router.state = {
        location,
        matches: matchRoutes(routes, location.pathname, '/') || [],
        navigation: { state: 'idle' },
      };
      subscribers.forEach((fn) => fn(router.state));
    },
    dispose() {
      subscribers.clear();
    },
  };
  router.state = {
    location: readLocation(basename),
    navigation: { state: 'idle' },
  };
  router.state.matches = matchRoutes(routes, router.state.location.pathname, '/') || [];
  return router;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context 與 Provider
// ─────────────────────────────────────────────────────────────────────────────

/** 整個 router 的狀態（router 物件、目前 location、從根到葉的 matches） */
const RouterStateContext = createContext(null);
/** 每一層路由的位置：這一層以下的 outlet、從根到這一層的 matches */
const RouteContext = createContext({ outlet: null, matches: [] });

function useRouterState(hookName) {
  const ctx = useContext(RouterStateContext);
  if (!ctx) throw new Error(`${hookName}() 只能在 <RouterProvider> 底下使用`);
  return ctx;
}

/** 由葉到根一層一層包：Provider(value) > route.element（沒有 element 的層直接把 outlet 往上交） */
function renderMatches(matches) {
  if (!matches || matches.length === 0) return null;
  return matches.reduceRight((outlet, match, index) => {
    const value = { outlet, matches: matches.slice(0, index + 1) };
    const element = match.route.element !== undefined ? match.route.element : outlet;
    return createElement(RouteContext.Provider, { value }, element);
  }, null);
}

/** 以 context 提供 router 與目前 location；監聽 popstate；依路由表渲染巢狀 element */
export function RouterProvider({ router }) {
  const [state, setState] = useState(router.state);

  useEffect(() => {
    const unsubscribe = router.subscribe(setState);
    const onPop = () => router._sync();
    window.addEventListener('popstate', onPop);
    // 訂閱前若已有變動（例如掛載前就 navigate 過），補一次
    if (router.state !== state) setState(router.state);
    return () => {
      unsubscribe();
      window.removeEventListener('popstate', onPop);
    };
  }, [router]);

  const { location, matches } = state;
  const navigate = useCallback((to, opts) => router.navigate(to, opts), [router]);
  const value = useMemo(
    () => ({ router, location, matches, navigate }),
    [router, location, matches, navigate],
  );

  return createElement(RouterStateContext.Provider, { value }, renderMatches(matches));
}

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────

/** 目前 location：{ pathname, search, hash, state, key }；pathname 已去掉 basename（根目錄 = '/'） */
export function useLocation() {
  return useRouterState('useLocation').location;
}

/** navigate(to, { replace?, state? })；to 可為數字（-1 = 上一頁） */
export function useNavigate() {
  return useRouterState('useNavigate').navigate;
}

/** 從根到葉的 [{ id, pathname, params, handle, data }] */
export function useMatches() {
  const { matches } = useRouterState('useMatches');
  return useMemo(
    () =>
      matches.map((m) => ({
        id: m.id,
        pathname: m.pathname,
        params: m.params,
        data: undefined,
        handle: m.route.handle,
      })),
    [matches],
  );
}

/** 目前這一層（含祖先）的路由參數 */
export function useParams() {
  const { matches } = useContext(RouteContext);
  const routeMatch = matches[matches.length - 1];
  return routeMatch ? routeMatch.params : {};
}

/** 這一層底下的子路由 element（<Outlet /> 用） */
export function useOutlet() {
  return useContext(RouteContext).outlet;
}

/** 把 to 解析成絕對的 { pathname, search, hash }（以目前 location 為基準） */
export function useResolvedPath(to) {
  const { pathname } = useLocation();
  return useMemo(() => resolvePath(to, pathname), [to, pathname]);
}

/** to → 實際 href（含 basename） */
export function useHref(to) {
  const { router } = useRouterState('useHref');
  const path = useResolvedPath(to);
  return router.createHref(path);
}

/** URLSearchParams 建構：接受 URLSearchParams、字串、物件（值可為陣列）、二維陣列 */
export function createSearchParams(init = '') {
  if (typeof init === 'string' || Array.isArray(init) || init instanceof URLSearchParams) {
    return new URLSearchParams(init);
  }
  return new URLSearchParams(
    Object.keys(init).reduce((memo, key) => {
      const value = init[key];
      if (value == null) return memo;
      return memo.concat(Array.isArray(value) ? value.map((v) => [key, String(v)]) : [[key, String(value)]]);
    }, []),
  );
}

/**
 * [URLSearchParams, setSearchParams(nextInitOrFn, { replace?, state? })]
 * next 可為 URLSearchParams、物件、字串、或 (prev) => next；預設 push。
 * setter 以 router.state.location 為準（navigate 後同步更新），同一個 tick 內多次呼叫也正確。
 */
export function useSearchParams() {
  const { router, location, navigate } = useRouterState('useSearchParams');
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);

  const setSearchParams = useCallback(
    (nextInit, navigateOpts) => {
      const latest = router.state.location;
      const prev = new URLSearchParams(latest.search);
      const next = createSearchParams(typeof nextInit === 'function' ? nextInit(prev) : nextInit);
      return navigate(
        { pathname: latest.pathname, search: '?' + next.toString(), hash: latest.hash },
        navigateOpts,
      );
    },
    [router, navigate],
  );

  return [searchParams, setSearchParams];
}

// ─────────────────────────────────────────────────────────────────────────────
// 元件
// ─────────────────────────────────────────────────────────────────────────────

/** 子路由的掛載點：渲染這一層底下的 element */
export function Outlet() {
  return useOutlet();
}

/** 在 effect 裡導向（跟 react-router 一樣：render 階段不碰 history） */
export function Navigate({ to, replace, state }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const path = createPath(resolvePath(to, pathname));
  useEffect(() => {
    navigate(path, { replace, state });
  }, [navigate, path, replace, state]);
  return null;
}

/** 這次點擊要不要交給瀏覽器：修飾鍵、非左鍵、target 不是本頁就放行 */
function shouldProcessLinkClick(event, target) {
  return (
    event.button === 0 &&
    (!target || target === '_self') &&
    !(event.metaKey || event.altKey || event.ctrlKey || event.shiftKey)
  );
}

/** <a href>；無修飾鍵的左鍵點擊時 preventDefault 並 navigate（href 含 basename） */
export function Link({ to, replace, state, reloadDocument, onClick, children, ...rest }) {
  const { router, location, navigate } = useRouterState('Link');
  const resolved = resolvePath(to, location.pathname);
  const href = router.createHref(resolved);

  const handleClick = (event) => {
    if (onClick) onClick(event);
    if (event.defaultPrevented || reloadDocument) return;
    if (!shouldProcessLinkClick(event, rest.target)) return;
    event.preventDefault();
    // 連到目前所在的 location 時改用 replace（照 react-router，避免 history 疊同一頁）
    const sameLocation = createPath(location) === createPath(resolved);
    navigate(resolved, { replace: replace || sameLocation, state });
  };

  return createElement('a', { ...rest, href, onClick: handleClick }, children);
}

/**
 * 命中時 aria-current="page" 並加上 'active' class；className／style／children 可為
 * ({ isActive, isPending, isTransitioning }) => …。end: true 只有完全相等才算命中，否則分段前綴命中。
 */
export function NavLink({ to, end = false, caseSensitive = false, className, style, children, ...rest }) {
  const { location } = useRouterState('NavLink');
  const resolved = resolvePath(to, location.pathname);

  let toPathname = resolved.pathname;
  let locationPathname = location.pathname;
  if (!caseSensitive) {
    toPathname = toPathname.toLowerCase();
    locationPathname = locationPathname.toLowerCase();
  }
  // to 若帶結尾斜線，前綴比對時要退回去（'/tasks/' 等同 '/tasks'）
  const endSlashPosition =
    toPathname !== '/' && toPathname.endsWith('/') ? toPathname.length - 1 : toPathname.length;
  const isActive =
    locationPathname === toPathname ||
    (!end && locationPathname.startsWith(toPathname) && locationPathname.charAt(endSlashPosition) === '/');

  const renderProps = { isActive, isPending: false, isTransitioning: false };
  const resolvedClassName =
    typeof className === 'function'
      ? className(renderProps)
      : [className, isActive ? 'active' : null].filter(Boolean).join(' ') || undefined;
  const resolvedStyle = typeof style === 'function' ? style(renderProps) : style;

  return createElement(
    Link,
    {
      ...rest,
      to,
      'aria-current': isActive ? 'page' : undefined,
      className: resolvedClassName,
      style: resolvedStyle,
    },
    typeof children === 'function' ? children(renderProps) : children,
  );
}
