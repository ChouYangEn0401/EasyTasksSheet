/**
 * query.js —— `@tanstack/react-query` v5 的子集相容替代品（Preact 版）。
 *
 * 原生 ES module，瀏覽器直接載入、零建置、不依賴任何第三方套件；
 * 只 import `preact` 與 `preact/hooks`（由 import map 提供）。
 *
 * 呼叫端把 `import {...} from '@tanstack/react-query'` 換成 `from '../lib/query.js'` 即可，
 * 匯出名稱與行為對齊 react-query v5（只做專案用到的子集）：
 *   QueryClient、QueryCache、MutationCache、QueryClientProvider、useQueryClient、
 *   useQuery、useInfiniteQuery、useMutation、
 *   QueryObserver、InfiniteQueryObserver、MutationObserver、
 *   hashKey、partialMatchKey、replaceEqualDeep、matchQuery、matchMutation、
 *   keepPreviousData、CancelledError、isCancelledError、focusManager、onlineManager。
 *
 * 結構照 react-query 原本的分層：
 *   工具 → 重試器（retryer）→ Query／QueryCache → Mutation／MutationCache
 *   → QueryClient → QueryObserver／InfiniteQueryObserver／MutationObserver → Preact hooks。
 *
 * 已知與 react-query 不同之處（刻意不做的）：
 *   - 沒有 networkMode（永遠當作 'online'；fetchStatus 不會出現 'paused'）、沒有 suspense、
 *     沒有 persister／hydration、沒有 mutation scope 序列化、沒有 notifyManager 批次
 *     （通知同步送出，交給 Preact 自己的 render 合併）。
 *   - 視窗 focus 同時聽 `visibilitychange`（變成可見）與 `focus`，react-query v5 只聽前者。
 *   - 沒有 `useSyncExternalStore`（preact/hooks 沒有），改用 useState＋useEffect 訂閱，
 *     訂閱完會再對一次結果避免漏掉 render 與訂閱之間的更新。
 */
import { createContext, h } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';

// ───────────────────────────────────────────────────────────────
// 工具
// ───────────────────────────────────────────────────────────────

const noop = () => {};
const DEFAULT_GC_TIME = 5 * 60 * 1000;

function isValidTimeout(value) {
  return typeof value === 'number' && value >= 0 && value !== Infinity;
}

/** 距離變 stale 還有幾毫秒（0 = 已經 stale） */
function timeUntilStale(updatedAt, staleTime) {
  return Math.max(updatedAt + (staleTime || 0) - Date.now(), 0);
}

function resolveStaleTime(staleTime, query) {
  return typeof staleTime === 'function' ? staleTime(query) : staleTime;
}

function resolveEnabled(enabled, query) {
  return typeof enabled === 'function' ? enabled(query) : enabled;
}

function functionalUpdate(updater, input) {
  return typeof updater === 'function' ? updater(input) : updater;
}

function hasObjectPrototype(o) {
  return Object.prototype.toString.call(o) === '[object Object]';
}

/** 是否為「純物件」（字面值物件；class 實例、Map、Date 都不算），照 react-query 的判法 */
function isPlainObject(o) {
  if (!hasObjectPrototype(o)) return false;
  const ctor = o.constructor;
  if (ctor === undefined) return true;
  const prot = ctor.prototype;
  if (!hasObjectPrototype(prot)) return false;
  if (!Object.prototype.hasOwnProperty.call(prot, 'isPrototypeOf')) return false;
  if (Object.getPrototypeOf(o) !== Object.prototype) return false;
  return true;
}

function isPlainArray(value) {
  return Array.isArray(value) && value.length === Object.keys(value).length;
}

/**
 * 查詢鍵雜湊：JSON.stringify，物件的鍵先排序（所以 {a:1,b:2} 與 {b:2,a:1} 同一把鍵）。
 * 與 react-query 的 `hashKey` 一致。
 */
export function hashKey(queryKey) {
  return JSON.stringify(queryKey, (_, val) =>
    isPlainObject(val)
      ? Object.keys(val)
          .sort()
          .reduce((result, key) => {
            result[key] = val[key];
            return result;
          }, {})
      : val,
  );
}

function hashQueryKeyByOptions(queryKey, options) {
  const hashFn = options?.queryKeyHashFn || hashKey;
  return hashFn(queryKey);
}

/**
 * `a` 是否「部分符合」`b`：b 的每一層鍵都要在 a 裡且值相符（陣列 = 前綴比對，物件 = 子集比對）。
 * 與 react-query 的 `partialMatchKey(queryKey, filterKey)` 一致。
 */
export function partialMatchKey(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return Object.keys(b).every((key) => partialMatchKey(a[key], b[key]));
  }
  return false;
}

/**
 * structural sharing：b 裡與 a 深度相等的部分沿用 a 的參考；整個相等就直接回 a。
 * 與 react-query 的 `replaceEqualDeep` 一致（只處理純物件與純陣列）。
 */
export function replaceEqualDeep(a, b) {
  if (a === b) return a;
  const array = isPlainArray(a) && isPlainArray(b);
  if (array || (isPlainObject(a) && isPlainObject(b))) {
    const aItems = array ? a : Object.keys(a);
    const aSize = aItems.length;
    const bItems = array ? b : Object.keys(b);
    const bSize = bItems.length;
    const copy = array ? [] : {};
    let equalItems = 0;
    for (let i = 0; i < bSize; i++) {
      const key = array ? i : bItems[i];
      if (((!array && aItems.includes(key)) || array) && a[key] === undefined && b[key] === undefined) {
        copy[key] = undefined;
        equalItems++;
      } else {
        copy[key] = replaceEqualDeep(a[key], b[key]);
        if (copy[key] === a[key] && a[key] !== undefined) equalItems++;
      }
    }
    return aSize === bSize && equalItems === aSize ? a : copy;
  }
  return b;
}

/** 淺比較（鍵數相同且每個值 ===） */
function shallowEqualObjects(a, b) {
  if (!a || !b) return false;
  if (Object.keys(a).length !== Object.keys(b).length) return false;
  for (const key in a) if (a[key] !== b[key]) return false;
  return true;
}

/** 照 options.structuralSharing 決定新資料要不要跟舊資料共用參考 */
function replaceData(prevData, data, options) {
  if (typeof options.structuralSharing === 'function') return options.structuralSharing(prevData, data);
  if (options.structuralSharing !== false) return replaceEqualDeep(prevData, data);
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addToEnd(items, item, max = 0) {
  const next = [...items, item];
  return max && next.length > max ? next.slice(1) : next;
}

function addToStart(items, item, max = 0) {
  const next = [item, ...items];
  return max && next.length > max ? next.slice(0, -1) : next;
}

/** `placeholderData: keepPreviousData` 用：直接沿用前一把鍵的資料 */
export const keepPreviousData = (previousData) => previousData;

/** 被 cancelQueries／取代重抓中止的 fetch 用這個錯誤結束；`revert` 回到 fetch 前的狀態、`silent` 不改狀態 */
export class CancelledError extends Error {
  constructor(options) {
    super('CancelledError');
    this.name = 'CancelledError';
    this.revert = options?.revert;
    this.silent = options?.silent;
  }
}

export function isCancelledError(value) {
  return value instanceof CancelledError;
}

/** queryFn 自己丟出的中止錯誤（fetch 被 AbortController 中止） */
function isAbortError(error) {
  return !!error && typeof error === 'object' && error.name === 'AbortError';
}

// ───────────────────────────────────────────────────────────────
// focus／online 管理（給 refetchOnWindowFocus／refetchOnReconnect／refetchInterval 用）
// ───────────────────────────────────────────────────────────────

function createEventManager({ events, isActive }) {
  const listeners = new Set();
  let detach;
  let lastFired = 0;
  const fire = () => {
    if (!isActive()) return;
    // visibilitychange 與 focus 常在同一瞬間先後到，合成一次
    const now = Date.now();
    if (now - lastFired < 50) return;
    lastFired = now;
    listeners.forEach((listener) => listener(true));
  };
  return {
    isActive,
    subscribe(listener) {
      listeners.add(listener);
      if (!detach && typeof window !== 'undefined' && window.addEventListener) {
        for (const ev of events) window.addEventListener(ev, fire, false);
        detach = () => {
          for (const ev of events) window.removeEventListener(ev, fire, false);
        };
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size && detach) {
          detach();
          detach = undefined;
        }
      };
    },
  };
}

export const focusManager = createEventManager({
  events: ['visibilitychange', 'focus'],
  isActive: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
});
focusManager.isFocused = focusManager.isActive;

export const onlineManager = createEventManager({
  events: ['online'],
  isActive: () => typeof navigator === 'undefined' || navigator.onLine !== false,
});
onlineManager.isOnline = onlineManager.isActive;

// ───────────────────────────────────────────────────────────────
// 重試器：包一次 fn 呼叫，失敗照 retry／retryDelay 重試，可取消
// ───────────────────────────────────────────────────────────────

function defaultRetryDelay(failureCount) {
  return Math.min(1000 * 2 ** failureCount, 30000);
}

function createRetryer(config) {
  let isRetryCancelled = false;
  let isResolved = false;
  let failureCount = 0;
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // 先掛一個空 handler，免得呼叫端還沒接上 catch 就被瀏覽器當成未處理的 rejection
  promise.catch(noop);

  const resolve = (value) => {
    if (isResolved) return;
    isResolved = true;
    config.onSuccess?.(value);
    resolvePromise(value);
  };
  const reject = (error) => {
    if (isResolved) return;
    isResolved = true;
    config.onError?.(error);
    rejectPromise(error);
  };
  const cancel = (cancelOptions) => {
    if (isResolved) return;
    reject(new CancelledError(cancelOptions));
    config.abort?.();
  };

  const run = () => {
    if (isResolved) return;
    let result;
    try {
      result = config.fn();
    } catch (error) {
      result = Promise.reject(error);
    }
    Promise.resolve(result).then(resolve, (error) => {
      if (isResolved) return;
      const retry = config.retry ?? 3;
      const retryDelay = config.retryDelay ?? defaultRetryDelay;
      const delay = typeof retryDelay === 'function' ? retryDelay(failureCount, error) : retryDelay;
      const shouldRetry =
        retry === true ||
        (typeof retry === 'number' && failureCount < retry) ||
        (typeof retry === 'function' && retry(failureCount, error));
      if (isRetryCancelled || !shouldRetry) {
        reject(error);
        return;
      }
      failureCount++;
      config.onFail?.(failureCount, error);
      sleep(delay).then(() => {
        if (isRetryCancelled) reject(error);
        else run();
      });
    });
  };

  return {
    promise,
    cancel,
    continueRetry: () => {
      isRetryCancelled = false;
    },
    cancelRetry: () => {
      isRetryCancelled = true;
    },
    start: () => {
      run();
      return promise;
    },
  };
}

// ───────────────────────────────────────────────────────────────
// Query：一把鍵一份快取狀態
// ───────────────────────────────────────────────────────────────

function getDefaultQueryState(options) {
  const data = typeof options.initialData === 'function' ? options.initialData() : options.initialData;
  const hasData = data !== undefined;
  const initialDataUpdatedAt = hasData
    ? typeof options.initialDataUpdatedAt === 'function'
      ? options.initialDataUpdatedAt()
      : options.initialDataUpdatedAt
    : 0;
  return {
    data,
    dataUpdateCount: 0,
    dataUpdatedAt: hasData ? (initialDataUpdatedAt ?? Date.now()) : 0,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: false,
    status: hasData ? 'success' : 'pending',
    fetchStatus: 'idle',
  };
}

/** 開始 fetch 時狀態怎麼變（還沒有資料的查詢回到 pending） */
function fetchState(data) {
  return {
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchStatus: 'fetching',
    ...(data === undefined && { error: null, status: 'pending' }),
  };
}

class Query {
  constructor(config) {
    this._abortSignalConsumed = false;
    this._defaultOptions = config.defaultOptions;
    this.setOptions(config.options);
    this.observers = [];
    this._client = config.client;
    this._cache = config.cache;
    this.queryKey = config.queryKey;
    this.queryHash = config.queryHash;
    this._initialState = getDefaultQueryState(this.options);
    this.state = config.state ?? this._initialState;
    this._promise = undefined;
    this._retryer = undefined;
    this._revertState = undefined;
    this._gcTimeout = undefined;
    this.scheduleGc();
  }

  get meta() {
    return this.options.meta;
  }

  get promise() {
    return this._retryer?.promise;
  }

  setOptions(options) {
    this.options = { ...this._defaultOptions, ...options };
    this.updateGcTime(this.options.gcTime);
  }

  /** gcTime 取所有觀察者裡最大的那個 */
  updateGcTime(newGcTime) {
    this.gcTime = Math.max(this.gcTime || 0, newGcTime ?? DEFAULT_GC_TIME);
  }

  /** 最後一個觀察者離開後開始計時，到期才移除快取 */
  scheduleGc() {
    this.clearGcTimeout();
    if (isValidTimeout(this.gcTime)) {
      this._gcTimeout = setTimeout(() => this.optionalRemove(), this.gcTime);
    }
  }

  clearGcTimeout() {
    if (this._gcTimeout) {
      clearTimeout(this._gcTimeout);
      this._gcTimeout = undefined;
    }
  }

  optionalRemove() {
    if (!this.observers.length && this.state.fetchStatus === 'idle') this._cache.remove(this);
  }

  /** 寫入資料（structural sharing 後 dispatch success）；manual = 由 setQueryData 寫的，不動 fetchStatus */
  setData(newData, options) {
    const data = replaceData(this.state.data, newData, this.options);
    this._dispatch({ data, type: 'success', dataUpdatedAt: options?.updatedAt, manual: options?.manual });
    return data;
  }

  setState(state, setStateOptions) {
    this._dispatch({ type: 'setState', state, setStateOptions });
  }

  /** 中止進行中的 fetch；回 Promise 等那次 fetch 收尾 */
  cancel(options) {
    const promise = this._promise;
    this._retryer?.cancel(options);
    return promise ? promise.then(noop).catch(noop) : Promise.resolve();
  }

  destroy() {
    this.clearGcTimeout();
    this.cancel({ silent: true });
  }

  reset() {
    this.destroy();
    this.setState(this._initialState);
  }

  /** 有至少一個 enabled 的觀察者 */
  isActive() {
    return this.observers.some((observer) => resolveEnabled(observer.options.enabled, this) !== false);
  }

  isDisabled() {
    if (this.getObserversCount() > 0) return !this.isActive();
    return !this.options.queryFn || this.state.dataUpdateCount + this.state.errorUpdateCount === 0;
  }

  isStale() {
    if (this.getObserversCount() > 0) return this.observers.some((o) => o.getCurrentResult().isStale);
    return this.state.data === undefined || this.state.isInvalidated;
  }

  isStaleByTime(staleTime = 0) {
    return (
      this.state.isInvalidated ||
      this.state.data === undefined ||
      !timeUntilStale(this.state.dataUpdatedAt, staleTime)
    );
  }

  onFocus() {
    const observer = this.observers.find((o) => o.shouldFetchOnWindowFocus());
    observer?.refetch({ cancelRefetch: false });
    this._retryer?.continueRetry();
  }

  onOnline() {
    const observer = this.observers.find((o) => o.shouldFetchOnReconnect());
    observer?.refetch({ cancelRefetch: false });
    this._retryer?.continueRetry();
  }

  addObserver(observer) {
    if (!this.observers.includes(observer)) {
      this.observers.push(observer);
      this.clearGcTimeout();
      this._cache.notify({ type: 'observerAdded', query: this, observer });
    }
  }

  removeObserver(observer) {
    if (this.observers.includes(observer)) {
      this.observers = this.observers.filter((o) => o !== observer);
      if (!this.observers.length) {
        // 最後一個觀察者離開：queryFn 有拿 signal 的就中止它（沒人要結果了），沒拿的至少不再重試
        if (this._retryer) {
          if (this._abortSignalConsumed) this._retryer.cancel({ revert: true });
          else this._retryer.cancelRetry();
        }
        this.scheduleGc();
      }
      this._cache.notify({ type: 'observerRemoved', query: this, observer });
    }
  }

  getObserversCount() {
    return this.observers.length;
  }

  invalidate() {
    if (!this.state.isInvalidated) this._dispatch({ type: 'invalidate' });
  }

  /**
   * 開跑一次 fetch。同一把鍵進行中的 fetch 會去重（回同一個 Promise）；
   * 已經有資料且 cancelRefetch 時改成中止舊的、重新抓一次。
   */
  fetch(options, fetchOptions) {
    if (this.state.fetchStatus !== 'idle') {
      if (this.state.data !== undefined && fetchOptions?.cancelRefetch) {
        this.cancel({ silent: true });
      } else if (this._promise) {
        this._retryer?.continueRetry();
        return this._promise;
      }
    }

    if (options) this.setOptions(options);

    // 由 setQueryData 建出來的查詢沒有 queryFn：借觀察者的
    if (!this.options.queryFn) {
      const observer = this.observers.find((o) => o.options.queryFn);
      if (observer) this.setOptions(observer.options);
    }

    const abortController = new AbortController();
    const addSignalProperty = (object) => {
      Object.defineProperty(object, 'signal', {
        enumerable: true,
        get: () => {
          this._abortSignalConsumed = true;
          return abortController.signal;
        },
      });
    };

    const fetchFn = () => {
      const queryFn = this.options.queryFn;
      if (typeof queryFn !== 'function') {
        return Promise.reject(new Error(`Missing queryFn: '${this.queryHash}'`));
      }
      const queryFnContext = { client: this._client, queryKey: this.queryKey, meta: this.meta };
      addSignalProperty(queryFnContext);
      this._abortSignalConsumed = false;
      return queryFn(queryFnContext);
    };

    const context = {
      fetchOptions,
      options: this.options,
      queryKey: this.queryKey,
      client: this._client,
      state: this.state,
      fetchFn,
    };
    addSignalProperty(context);

    // useInfiniteQuery 用 behavior 把 fetchFn 換成「依序抓每一頁」
    this.options.behavior?.onFetch(context, this);

    this._revertState = this.state;
    if (this.state.fetchStatus === 'idle' || this.state.fetchMeta !== context.fetchOptions?.meta) {
      this._dispatch({ type: 'fetch', meta: context.fetchOptions?.meta });
    }

    const onError = (error) => {
      if (isAbortError(error)) {
        // queryFn 自己丟的中止錯誤：不算失敗、不改 error，回到 fetch 前的狀態
        error = new CancelledError({ revert: true });
      }
      if (!(isCancelledError(error) && error.silent)) this._dispatch({ type: 'error', error });
      if (!isCancelledError(error)) {
        this._cache.config.onError?.(error, this);
        this._cache.config.onSettled?.(this.state.data, error, this);
      }
      this.scheduleGc();
    };

    this._retryer = createRetryer({
      fn: context.fetchFn,
      abort: abortController.abort.bind(abortController),
      onSuccess: (data) => {
        if (data === undefined) {
          onError(new Error(`${this.queryHash} data is undefined`));
          return;
        }
        try {
          this.setData(data);
        } catch (error) {
          onError(error);
          return;
        }
        this._cache.config.onSuccess?.(data, this);
        this._cache.config.onSettled?.(data, this.state.error, this);
        this.scheduleGc();
      },
      onError,
      onFail: (failureCount, error) => this._dispatch({ type: 'failed', failureCount, error }),
      retry: context.options.retry,
      retryDelay: context.options.retryDelay,
    });

    this._promise = this._retryer.start();
    return this._promise;
  }

  _dispatch(action) {
    this.state = this._reducer(this.state, action);
    this.observers.forEach((observer) => observer.onQueryUpdate());
    this._cache.notify({ query: this, type: 'updated', action });
  }

  _reducer(state, action) {
    switch (action.type) {
      case 'failed':
        return { ...state, fetchFailureCount: action.failureCount, fetchFailureReason: action.error };
      case 'fetch':
        return { ...state, ...fetchState(state.data), fetchMeta: action.meta ?? null };
      case 'success':
        return {
          ...state,
          data: action.data,
          dataUpdateCount: state.dataUpdateCount + 1,
          dataUpdatedAt: action.dataUpdatedAt ?? Date.now(),
          error: null,
          isInvalidated: false,
          status: 'success',
          ...(!action.manual && { fetchStatus: 'idle', fetchFailureCount: 0, fetchFailureReason: null }),
        };
      case 'error': {
        const error = action.error;
        if (isCancelledError(error) && error.revert && this._revertState) {
          return { ...this._revertState, fetchStatus: 'idle' };
        }
        return {
          ...state,
          error,
          errorUpdateCount: state.errorUpdateCount + 1,
          errorUpdatedAt: Date.now(),
          fetchFailureCount: state.fetchFailureCount + 1,
          fetchFailureReason: error,
          fetchStatus: 'idle',
          status: 'error',
        };
      }
      case 'invalidate':
        return { ...state, isInvalidated: true };
      case 'setState':
        return { ...state, ...action.state };
      default:
        return state;
    }
  }
}

/** 篩選條件 → 這個 query 符不符合 */
export function matchQuery(filters, query) {
  const { type = 'all', exact, fetchStatus, predicate, queryKey, stale } = filters;
  if (queryKey) {
    if (exact) {
      if (query.queryHash !== hashQueryKeyByOptions(queryKey, query.options)) return false;
    } else if (!partialMatchKey(query.queryKey, queryKey)) {
      return false;
    }
  }
  if (type !== 'all') {
    const isActive = query.isActive();
    if (type === 'active' && !isActive) return false;
    if (type === 'inactive' && isActive) return false;
  }
  if (typeof stale === 'boolean' && query.isStale() !== stale) return false;
  if (fetchStatus && fetchStatus !== query.state.fetchStatus) return false;
  if (predicate && !predicate(query)) return false;
  return true;
}

export class QueryCache {
  constructor(config = {}) {
    this.config = config;
    this._queries = new Map();
    this._listeners = new Set();
  }

  /** 拿既有的、沒有就建一個（不會觸發 fetch） */
  build(client, options, state) {
    const queryKey = options.queryKey;
    const queryHash = options.queryHash ?? hashQueryKeyByOptions(queryKey, options);
    let query = this.get(queryHash);
    if (!query) {
      query = new Query({
        client,
        cache: this,
        queryKey,
        queryHash,
        options: client.defaultQueryOptions(options),
        state,
        defaultOptions: client.getQueryDefaults(queryKey),
      });
      this.add(query);
    }
    return query;
  }

  add(query) {
    if (!this._queries.has(query.queryHash)) {
      this._queries.set(query.queryHash, query);
      this.notify({ type: 'added', query });
    }
  }

  remove(query) {
    const queryInMap = this._queries.get(query.queryHash);
    if (queryInMap) {
      query.destroy();
      if (queryInMap === query) this._queries.delete(query.queryHash);
      this.notify({ type: 'removed', query });
    }
  }

  clear() {
    this.getAll().forEach((query) => this.remove(query));
  }

  get(queryHash) {
    return this._queries.get(queryHash);
  }

  getAll() {
    return [...this._queries.values()];
  }

  /** 預設 exact 比對 */
  find(filters) {
    const defaultedFilters = { exact: true, ...filters };
    return this.getAll().find((query) => matchQuery(defaultedFilters, query));
  }

  findAll(filters = {}) {
    const queries = this.getAll();
    return Object.keys(filters).length > 0 ? queries.filter((query) => matchQuery(filters, query)) : queries;
  }

  notify(event) {
    this._listeners.forEach((listener) => listener(event));
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  onFocus() {
    this.getAll().forEach((query) => query.onFocus());
  }

  onOnline() {
    this.getAll().forEach((query) => query.onOnline());
  }
}

// ───────────────────────────────────────────────────────────────
// Mutation／MutationCache
// ───────────────────────────────────────────────────────────────

function getDefaultMutationState() {
  return {
    context: undefined,
    data: undefined,
    error: null,
    failureCount: 0,
    failureReason: null,
    isPaused: false,
    status: 'idle',
    variables: undefined,
    submittedAt: 0,
  };
}

class Mutation {
  constructor(config) {
    this.mutationId = config.mutationId;
    this._mutationCache = config.mutationCache;
    this._observers = [];
    this._gcTimeout = undefined;
    this.state = config.state || getDefaultMutationState();
    this.setOptions(config.options);
    this.scheduleGc();
  }

  setOptions(options) {
    this.options = options;
    this.updateGcTime(this.options.gcTime);
  }

  get meta() {
    return this.options.meta;
  }

  updateGcTime(newGcTime) {
    this.gcTime = Math.max(this.gcTime || 0, newGcTime ?? DEFAULT_GC_TIME);
  }

  scheduleGc() {
    this.clearGcTimeout();
    if (isValidTimeout(this.gcTime)) {
      this._gcTimeout = setTimeout(() => this.optionalRemove(), this.gcTime);
    }
  }

  clearGcTimeout() {
    if (this._gcTimeout) {
      clearTimeout(this._gcTimeout);
      this._gcTimeout = undefined;
    }
  }

  addObserver(observer) {
    if (!this._observers.includes(observer)) {
      this._observers.push(observer);
      this.clearGcTimeout();
      this._mutationCache.notify({ type: 'observerAdded', mutation: this, observer });
    }
  }

  removeObserver(observer) {
    this._observers = this._observers.filter((o) => o !== observer);
    this.scheduleGc();
    this._mutationCache.notify({ type: 'observerRemoved', mutation: this, observer });
  }

  optionalRemove() {
    if (!this._observers.length) {
      if (this.state.status === 'pending') this.scheduleGc();
      else this._mutationCache.remove(this);
    }
  }

  /**
   * 跑完整流程（順序與 react-query v5 相同）：
   *   mutationCache.onMutate → options.onMutate → mutationFn
   *   成功：mutationCache.onSuccess → options.onSuccess → mutationCache.onSettled → options.onSettled → dispatch success
   *   失敗：mutationCache.onError → options.onError → mutationCache.onSettled → options.onSettled → dispatch error → 丟出
   * 每一層回呼回傳的 Promise 都會等完，所以 isMutating 要到 onSuccess／onSettled 跑完才減。
   */
  async execute(variables) {
    this._retryer = createRetryer({
      fn: () => {
        if (!this.options.mutationFn) return Promise.reject(new Error('No mutationFn found'));
        return this.options.mutationFn(variables);
      },
      onFail: (failureCount, error) => this._dispatch({ type: 'failed', failureCount, error }),
      retry: this.options.retry ?? 0,
      retryDelay: this.options.retryDelay,
    });

    try {
      this._dispatch({ type: 'pending', variables, isPaused: false });
      await this._mutationCache.config.onMutate?.(variables, this);
      const context = await this.options.onMutate?.(variables);
      if (context !== this.state.context) {
        this._dispatch({ type: 'pending', context, variables, isPaused: false });
      }

      const data = await this._retryer.start();

      await this._mutationCache.config.onSuccess?.(data, variables, this.state.context, this);
      await this.options.onSuccess?.(data, variables, this.state.context);
      await this._mutationCache.config.onSettled?.(data, null, this.state.variables, this.state.context, this);
      await this.options.onSettled?.(data, null, variables, this.state.context);

      this._dispatch({ type: 'success', data });
      return data;
    } catch (error) {
      try {
        await this._mutationCache.config.onError?.(error, variables, this.state.context, this);
        await this.options.onError?.(error, variables, this.state.context);
        await this._mutationCache.config.onSettled?.(
          undefined,
          error,
          this.state.variables,
          this.state.context,
          this,
        );
        await this.options.onSettled?.(undefined, error, variables, this.state.context);
        throw error;
      } finally {
        this._dispatch({ type: 'error', error });
      }
    }
  }

  _dispatch(action) {
    this.state = this._reducer(this.state, action);
    this._observers.forEach((observer) => observer.onMutationUpdate(action));
    this._mutationCache.notify({ mutation: this, type: 'updated', action });
  }

  _reducer(state, action) {
    switch (action.type) {
      case 'failed':
        return { ...state, failureCount: action.failureCount, failureReason: action.error };
      case 'pending':
        return {
          ...state,
          context: action.context,
          data: undefined,
          failureCount: 0,
          failureReason: null,
          error: null,
          isPaused: !!action.isPaused,
          status: 'pending',
          variables: action.variables,
          submittedAt: Date.now(),
        };
      case 'success':
        return {
          ...state,
          data: action.data,
          failureCount: 0,
          failureReason: null,
          error: null,
          status: 'success',
          isPaused: false,
        };
      case 'error':
        return {
          ...state,
          data: undefined,
          error: action.error,
          failureCount: state.failureCount + 1,
          failureReason: action.error,
          isPaused: false,
          status: 'error',
        };
      default:
        return state;
    }
  }
}

/** 篩選條件 → 這個 mutation 符不符合（mutationKey 前綴比對） */
export function matchMutation(filters, mutation) {
  const { exact, status, predicate, mutationKey } = filters;
  if (mutationKey) {
    if (!mutation.options.mutationKey) return false;
    if (exact) {
      if (hashKey(mutation.options.mutationKey) !== hashKey(mutationKey)) return false;
    } else if (!partialMatchKey(mutation.options.mutationKey, mutationKey)) {
      return false;
    }
  }
  if (status && mutation.state.status !== status) return false;
  if (predicate && !predicate(mutation)) return false;
  return true;
}

export class MutationCache {
  /** `new MutationCache({ onError(err, variables, context, mutation), onSuccess, onSettled, onMutate })` */
  constructor(config = {}) {
    this.config = config;
    this._mutations = new Set();
    this._listeners = new Set();
    this._mutationId = 0;
  }

  /** 建一個 mutation 物件（不執行）；`build(client, options).execute(variables)` 跑完整流程 */
  build(client, options, state) {
    const mutation = new Mutation({
      mutationCache: this,
      mutationId: ++this._mutationId,
      options: client.defaultMutationOptions(options),
      state,
    });
    this.add(mutation);
    return mutation;
  }

  add(mutation) {
    this._mutations.add(mutation);
    this.notify({ type: 'added', mutation });
  }

  remove(mutation) {
    if (this._mutations.delete(mutation)) {
      mutation.clearGcTimeout();
      this.notify({ type: 'removed', mutation });
    }
  }

  clear() {
    this.getAll().forEach((mutation) => this.remove(mutation));
  }

  getAll() {
    return [...this._mutations];
  }

  find(filters) {
    const defaultedFilters = { exact: true, ...filters };
    return this.getAll().find((mutation) => matchMutation(defaultedFilters, mutation));
  }

  findAll(filters = {}) {
    return this.getAll().filter((mutation) => matchMutation(filters, mutation));
  }

  /** 事件：{ type: 'added'|'removed'|'updated'|'observerAdded'|'observerRemoved', mutation, action? }
   *  `updated` 的 action.type 為 'pending'|'failed'|'success'|'error' */
  notify(event) {
    this._listeners.forEach((listener) => listener(event));
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }
}

// ───────────────────────────────────────────────────────────────
// QueryClient
// ───────────────────────────────────────────────────────────────

export class QueryClient {
  /** `new QueryClient({ queryCache?, mutationCache?, defaultOptions: { queries: {...}, mutations: {...} } })` */
  constructor(config = {}) {
    this._queryCache = config.queryCache || new QueryCache();
    this._mutationCache = config.mutationCache || new MutationCache();
    this._defaultOptions = config.defaultOptions || {};
    this._queryDefaults = new Map();
    this._mutationDefaults = new Map();
    this._mountCount = 0;
    this._unsubscribeFocus = undefined;
    this._unsubscribeOnline = undefined;
  }

  /** 接上視窗 focus／online 事件（QueryClientProvider 會呼叫；可重入，計數） */
  mount() {
    this._mountCount++;
    if (this._mountCount !== 1) return;
    this._unsubscribeFocus = focusManager.subscribe(() => this._queryCache.onFocus());
    this._unsubscribeOnline = onlineManager.subscribe(() => this._queryCache.onOnline());
  }

  unmount() {
    this._mountCount--;
    if (this._mountCount !== 0) return;
    this._unsubscribeFocus?.();
    this._unsubscribeFocus = undefined;
    this._unsubscribeOnline?.();
    this._unsubscribeOnline = undefined;
  }

  /** 進行中的查詢數 */
  isFetching(filters) {
    return this._queryCache.findAll({ ...filters, fetchStatus: 'fetching' }).length;
  }

  /** 進行中的 mutation 數（mutationKey 前綴比對） */
  isMutating(filters) {
    return this._mutationCache.findAll({ ...filters, status: 'pending' }).length;
  }

  getQueryData(queryKey) {
    const options = this.defaultQueryOptions({ queryKey });
    return this._queryCache.get(options.queryHash)?.state.data;
  }

  /** 快取有就回快取，沒有才抓 */
  ensureQueryData(options) {
    const defaultedOptions = this.defaultQueryOptions(options);
    const query = this._queryCache.build(this, defaultedOptions);
    const cachedData = query.state.data;
    if (cachedData === undefined) return this.fetchQuery(options);
    if (options.revalidateIfStale && query.isStaleByTime(resolveStaleTime(defaultedOptions.staleTime, query))) {
      void this.prefetchQuery(defaultedOptions);
    }
    return Promise.resolve(cachedData);
  }

  /** 回 [[queryKey, data], ...] */
  getQueriesData(filters) {
    return this._queryCache.findAll(filters).map(({ queryKey, state }) => [queryKey, state.data]);
  }

  /**
   * 直接寫快取。updater 可以是值或 `(old) => new`；回 undefined 就不寫。回傳寫進去的值。
   * 寫入會做 structural sharing，不會動 fetchStatus（進行中的 fetch 回來仍會蓋掉，要先 cancelQueries）。
   */
  setQueryData(queryKey, updater, options) {
    const defaultedOptions = this.defaultQueryOptions({ queryKey });
    const query = this._queryCache.get(defaultedOptions.queryHash);
    const prevData = query?.state.data;
    const data = functionalUpdate(updater, prevData);
    if (data === undefined) return undefined;
    return this._queryCache.build(this, defaultedOptions).setData(data, { ...options, manual: true });
  }

  setQueriesData(filters, updater, options) {
    return this._queryCache
      .findAll(filters)
      .map(({ queryKey }) => [queryKey, this.setQueryData(queryKey, updater, options)]);
  }

  getQueryState(queryKey) {
    const options = this.defaultQueryOptions({ queryKey });
    return this._queryCache.get(options.queryHash)?.state;
  }

  removeQueries(filters) {
    const queryCache = this._queryCache;
    queryCache.findAll(filters).forEach((query) => queryCache.remove(query));
  }

  /** 回到初始狀態（initialData 或空），有觀察者的重抓 */
  resetQueries(filters, options) {
    const queryCache = this._queryCache;
    queryCache.findAll(filters).forEach((query) => query.reset());
    return this.refetchQueries({ type: 'active', ...filters }, options);
  }

  /** 中止進行中的 fetch（queryFn 拿到的 signal 會 abort），狀態回到 fetch 前 */
  cancelQueries(filters, cancelOptions = {}) {
    const defaultedCancelOptions = { revert: true, ...cancelOptions };
    const promises = this._queryCache.findAll(filters).map((query) => query.cancel(defaultedCancelOptions));
    return Promise.all(promises).then(noop).catch(noop);
  }

  /** 標 stale；有觀察者的查詢立刻重抓，回 Promise 等重抓完。沒給 filters = 全部 */
  invalidateQueries(filters = {}, options = {}) {
    this._queryCache.findAll(filters).forEach((query) => query.invalidate());
    if (filters.refetchType === 'none') return Promise.resolve();
    const refetchFilters = { ...filters, type: filters.refetchType ?? filters.type ?? 'active' };
    return this.refetchQueries(refetchFilters, options);
  }

  /** 同 invalidateQueries 的重抓那一半，但不管 stale 不 stale */
  refetchQueries(filters = {}, options = {}) {
    const fetchOptions = { ...options, cancelRefetch: options.cancelRefetch ?? true };
    const promises = this._queryCache
      .findAll(filters)
      .filter((query) => !query.isDisabled())
      .map((query) => {
        let promise = query.fetch(undefined, fetchOptions);
        if (!fetchOptions.throwOnError) promise = promise.catch(noop);
        return promise;
      });
    return Promise.all(promises).then(noop);
  }

  /** 直接抓一次（沒掛觀察者）：快取還新鮮就回快取；預設不重試 */
  fetchQuery(options) {
    const defaultedOptions = this.defaultQueryOptions(options);
    if (defaultedOptions.retry === undefined) defaultedOptions.retry = false;
    const query = this._queryCache.build(this, defaultedOptions);
    return query.isStaleByTime(resolveStaleTime(defaultedOptions.staleTime, query))
      ? query.fetch(defaultedOptions)
      : Promise.resolve(query.state.data);
  }

  prefetchQuery(options) {
    return this.fetchQuery(options).then(noop).catch(noop);
  }

  getQueryCache() {
    return this._queryCache;
  }

  getMutationCache() {
    return this._mutationCache;
  }

  getDefaultOptions() {
    return this._defaultOptions;
  }

  setDefaultOptions(options) {
    this._defaultOptions = options;
  }

  setQueryDefaults(queryKey, options) {
    this._queryDefaults.set(hashKey(queryKey), { queryKey, defaultOptions: options });
  }

  getQueryDefaults(queryKey) {
    const defaults = [...this._queryDefaults.values()];
    const result = {};
    defaults.forEach((queryDefault) => {
      if (partialMatchKey(queryKey, queryDefault.queryKey)) Object.assign(result, queryDefault.defaultOptions);
    });
    return result;
  }

  setMutationDefaults(mutationKey, options) {
    this._mutationDefaults.set(hashKey(mutationKey), { mutationKey, defaultOptions: options });
  }

  getMutationDefaults(mutationKey) {
    const defaults = [...this._mutationDefaults.values()];
    const result = {};
    defaults.forEach((queryDefault) => {
      if (partialMatchKey(mutationKey, queryDefault.mutationKey)) Object.assign(result, queryDefault.defaultOptions);
    });
    return result;
  }

  /** 套上 defaultOptions.queries 與 setQueryDefaults，算好 queryHash */
  defaultQueryOptions(options) {
    if (options._defaulted) return options;
    const defaultedOptions = {
      ...this._defaultOptions.queries,
      ...this.getQueryDefaults(options.queryKey),
      ...options,
      _defaulted: true,
    };
    if (!defaultedOptions.queryHash) {
      defaultedOptions.queryHash = hashQueryKeyByOptions(defaultedOptions.queryKey, defaultedOptions);
    }
    if (defaultedOptions.refetchOnReconnect === undefined) defaultedOptions.refetchOnReconnect = true;
    return defaultedOptions;
  }

  defaultMutationOptions(options) {
    if (options?._defaulted) return options;
    return {
      ...this._defaultOptions.mutations,
      ...(options?.mutationKey && this.getMutationDefaults(options.mutationKey)),
      ...options,
      _defaulted: true,
    };
  }

  clear() {
    this._queryCache.clear();
    this._mutationCache.clear();
  }
}

// ───────────────────────────────────────────────────────────────
// QueryObserver：一個 useQuery 一個觀察者
// ───────────────────────────────────────────────────────────────

/** 這個觀察者眼中查詢是否 stale（enabled: false 的永遠不算） */
function isStale(query, options) {
  return (
    resolveEnabled(options.enabled, query) !== false &&
    query.isStaleByTime(resolveStaleTime(options.staleTime, query))
  );
}

function shouldLoadOnMount(query, options) {
  return (
    resolveEnabled(options.enabled, query) !== false &&
    query.state.data === undefined &&
    !(query.state.status === 'error' && options.retryOnMount === false)
  );
}

function shouldFetchOn(query, options, field) {
  if (resolveEnabled(options.enabled, query) !== false && resolveStaleTime(options.staleTime, query) !== 'static') {
    const value = typeof field === 'function' ? field(query) : field;
    return value === 'always' || (value !== false && isStale(query, options));
  }
  return false;
}

function shouldFetchOnMount(query, options) {
  return shouldLoadOnMount(query, options) || (query.state.data !== undefined && shouldFetchOn(query, options, options.refetchOnMount));
}

/** 查詢換了（鍵變了）或從 disabled 變 enabled 時，stale 才抓 */
function shouldFetchOptionally(query, prevQuery, options, prevOptions) {
  return (
    (query !== prevQuery || resolveEnabled(prevOptions.enabled, query) === false) &&
    isStale(query, options)
  );
}

export class QueryObserver {
  constructor(client, options) {
    this._client = client;
    this._listeners = new Set();
    this._currentQuery = undefined;
    this._currentQueryInitialState = undefined;
    this._currentResult = undefined;
    this._currentResultState = undefined;
    this._currentResultOptions = undefined;
    this._selectError = null;
    this._selectFn = undefined;
    this._selectResult = undefined;
    this._lastQueryWithDefinedData = undefined;
    this._staleTimeoutId = undefined;
    this._refetchIntervalId = undefined;
    this._currentRefetchInterval = undefined;
    this.options = options;
    this.bindMethods();
    this.setOptions(options);
  }

  bindMethods() {
    this.refetch = this.refetch.bind(this);
  }

  hasListeners() {
    return this._listeners.size > 0;
  }

  /** 第一個訂閱者進來才掛到 query 上、該抓就抓（fetch 一律在這裡發生，不在 render） */
  subscribe(listener) {
    this._listeners.add(listener);
    if (this._listeners.size === 1) this.onSubscribe();
    return () => {
      this._listeners.delete(listener);
      if (!this.hasListeners()) this.onUnsubscribe();
    };
  }

  onSubscribe() {
    this._currentQuery.addObserver(this);
    if (shouldFetchOnMount(this._currentQuery, this.options)) this._executeFetch();
    else this.updateResult();
    this._updateTimers();
  }

  onUnsubscribe() {
    this.destroy();
  }

  shouldFetchOnReconnect() {
    return shouldFetchOn(this._currentQuery, this.options, this.options.refetchOnReconnect);
  }

  shouldFetchOnWindowFocus() {
    return shouldFetchOn(this._currentQuery, this.options, this.options.refetchOnWindowFocus);
  }

  destroy() {
    this._listeners.clear();
    this._clearStaleTimeout();
    this._clearRefetchInterval();
    this._currentQuery.removeObserver(this);
  }

  setOptions(options) {
    const prevOptions = this.options;
    const prevQuery = this._currentQuery;
    this.options = this._client.defaultQueryOptions(options);

    if (
      this.options.enabled !== undefined &&
      typeof this.options.enabled !== 'boolean' &&
      typeof this.options.enabled !== 'function' &&
      typeof resolveEnabled(this.options.enabled, this._currentQuery) !== 'boolean'
    ) {
      throw new Error('Expected enabled to be a boolean or a callback that returns a boolean');
    }

    this._updateQuery();
    this._currentQuery.setOptions(this.options);

    if (prevOptions?._defaulted && !shallowEqualObjects(this.options, prevOptions)) {
      this._client.getQueryCache().notify({ type: 'observerOptionsUpdated', query: this._currentQuery, observer: this });
    }

    const mounted = this.hasListeners();
    if (mounted && shouldFetchOptionally(this._currentQuery, prevQuery, this.options, prevOptions)) {
      this._executeFetch();
    }

    this.updateResult();

    if (
      mounted &&
      (this._currentQuery !== prevQuery ||
        resolveEnabled(this.options.enabled, this._currentQuery) !== resolveEnabled(prevOptions.enabled, this._currentQuery) ||
        resolveStaleTime(this.options.staleTime, this._currentQuery) !== resolveStaleTime(prevOptions.staleTime, this._currentQuery))
    ) {
      this._updateStaleTimeout();
    }

    const nextRefetchInterval = this._computeRefetchInterval();
    if (
      mounted &&
      (this._currentQuery !== prevQuery ||
        resolveEnabled(this.options.enabled, this._currentQuery) !== resolveEnabled(prevOptions.enabled, this._currentQuery) ||
        nextRefetchInterval !== this._currentRefetchInterval)
    ) {
      this._updateRefetchInterval(nextRefetchInterval);
    }
  }

  /** render 期間用：照新的 options 算出結果（會建 query、不會 fetch） */
  getOptimisticResult(options) {
    const query = this._client.getQueryCache().build(this._client, options);
    const result = this.createResult(query, options);
    if (!shallowEqualObjects(this._currentResult, result)) {
      this._currentResult = result;
      this._currentResultOptions = this.options;
      this._currentResultState = this._currentQuery.state;
    }
    return result;
  }

  getCurrentResult() {
    return this._currentResult;
  }

  getCurrentQuery() {
    return this._currentQuery;
  }

  /** 重抓（永遠 resolve，回新的 result） */
  refetch({ ...options } = {}) {
    return this.fetch({ ...options });
  }

  fetch(fetchOptions) {
    return this._executeFetch({ ...fetchOptions, cancelRefetch: fetchOptions.cancelRefetch ?? true }).then(() => {
      this.updateResult();
      return this._currentResult;
    });
  }

  _executeFetch(fetchOptions) {
    this._updateQuery();
    let promise = this._currentQuery.fetch(this.options, fetchOptions);
    if (!fetchOptions?.throwOnError) promise = promise.catch(noop);
    return promise;
  }

  /** staleTime 到了要重算一次 result（isStale 翻成 true） */
  _updateStaleTimeout() {
    this._clearStaleTimeout();
    const staleTime = resolveStaleTime(this.options.staleTime, this._currentQuery);
    if (this._currentResult.isStale || !isValidTimeout(staleTime)) return;
    const time = timeUntilStale(this._currentResult.dataUpdatedAt, staleTime);
    this._staleTimeoutId = setTimeout(() => {
      if (!this._currentResult.isStale) this.updateResult();
    }, time + 1);
  }

  /** refetchInterval 可以是數字、false 或函式（每次 query 更新都重算） */
  _computeRefetchInterval() {
    return (
      (typeof this.options.refetchInterval === 'function'
        ? this.options.refetchInterval(this._currentQuery)
        : this.options.refetchInterval) ?? false
    );
  }

  _updateRefetchInterval(nextInterval) {
    this._clearRefetchInterval();
    this._currentRefetchInterval = nextInterval;
    if (
      resolveEnabled(this.options.enabled, this._currentQuery) === false ||
      !isValidTimeout(this._currentRefetchInterval) ||
      this._currentRefetchInterval === 0
    ) {
      return;
    }
    this._refetchIntervalId = setInterval(() => {
      if (this.options.refetchIntervalInBackground || focusManager.isFocused()) this._executeFetch();
    }, this._currentRefetchInterval);
  }

  _updateTimers() {
    this._updateStaleTimeout();
    this._updateRefetchInterval(this._computeRefetchInterval());
  }

  _clearStaleTimeout() {
    if (this._staleTimeoutId) {
      clearTimeout(this._staleTimeoutId);
      this._staleTimeoutId = undefined;
    }
  }

  _clearRefetchInterval() {
    if (this._refetchIntervalId) {
      clearInterval(this._refetchIntervalId);
      this._refetchIntervalId = undefined;
    }
  }

  /** 把 query 狀態＋options 算成 useQuery 回傳的那個物件 */
  createResult(query, options) {
    const prevQuery = this._currentQuery;
    const prevOptions = this.options;
    const prevResult = this._currentResult;
    const prevResultState = this._currentResultState;
    const prevResultOptions = this._currentResultOptions;
    const queryChange = query !== prevQuery;
    const queryInitialState = queryChange ? query.state : this._currentQueryInitialState;

    const { state } = query;
    let newState = { ...state };
    let isPlaceholderData = false;
    let data;

    // render 期間的樂觀結果：知道 effect 裡會抓，就先把 fetchStatus 標成 fetching
    if (options._optimisticResults) {
      const mounted = this.hasListeners();
      const fetchOnMount = !mounted && shouldFetchOnMount(query, options);
      const fetchOptionally = mounted && shouldFetchOptionally(query, prevQuery, options, prevOptions);
      if (fetchOnMount || fetchOptionally) newState = { ...newState, ...fetchState(state.data) };
    }

    let { error, errorUpdatedAt, status } = newState;
    data = newState.data;
    let skipSelect = false;

    // placeholderData：還沒有資料時先拿佔位資料（通常是前一把鍵的資料）當 success 顯示
    if (options.placeholderData !== undefined && data === undefined && status === 'pending') {
      let placeholderData;
      if (prevResult?.isPlaceholderData && options.placeholderData === prevResultOptions?.placeholderData) {
        placeholderData = prevResult.data;
        skipSelect = true;
      } else {
        placeholderData =
          typeof options.placeholderData === 'function'
            ? options.placeholderData(this._lastQueryWithDefinedData?.state.data, this._lastQueryWithDefinedData)
            : options.placeholderData;
        if (options.select && placeholderData !== undefined) {
          try {
            placeholderData = options.select(placeholderData);
            this._selectError = null;
          } catch (selectError) {
            this._selectError = selectError;
          }
        }
      }
      if (placeholderData !== undefined) {
        status = 'success';
        data = replaceData(prevResult?.data, placeholderData, options);
        isPlaceholderData = true;
      }
    }

    // select：同一份資料、同一個 select 函式就沿用上次算的
    if (options.select && newState.data !== undefined && !skipSelect) {
      if (prevResult && newState.data === prevResultState?.data && options.select === this._selectFn) {
        data = this._selectResult;
      } else {
        try {
          this._selectFn = options.select;
          data = options.select(newState.data);
          data = replaceData(prevResult?.data, data, options);
          this._selectResult = data;
          this._selectError = null;
        } catch (selectError) {
          this._selectError = selectError;
        }
      }
    }

    if (this._selectError) {
      error = this._selectError;
      data = this._selectResult;
      errorUpdatedAt = Date.now();
      status = 'error';
    }

    const isFetching = newState.fetchStatus === 'fetching';
    const isPending = status === 'pending';
    const isError = status === 'error';
    const isLoading = isPending && isFetching;
    const hasData = data !== undefined;

    return {
      status,
      fetchStatus: newState.fetchStatus,
      isPending,
      isSuccess: status === 'success',
      isError,
      isInitialLoading: isLoading,
      isLoading,
      data,
      dataUpdatedAt: newState.dataUpdatedAt,
      error,
      errorUpdatedAt,
      failureCount: newState.fetchFailureCount,
      failureReason: newState.fetchFailureReason,
      errorUpdateCount: newState.errorUpdateCount,
      isFetched: newState.dataUpdateCount > 0 || newState.errorUpdateCount > 0,
      isFetchedAfterMount:
        newState.dataUpdateCount > queryInitialState.dataUpdateCount ||
        newState.errorUpdateCount > queryInitialState.errorUpdateCount,
      isFetching,
      isRefetching: isFetching && !isPending,
      isLoadingError: isError && !hasData,
      isPaused: newState.fetchStatus === 'paused',
      isPlaceholderData,
      isRefetchError: isError && hasData,
      isStale: isStale(query, options),
      refetch: this.refetch,
    };
  }

  /** 重算 result；跟上一次淺比較不同才通知訂閱者 */
  updateResult() {
    const prevResult = this._currentResult;
    const nextResult = this.createResult(this._currentQuery, this.options);
    this._currentResultState = this._currentQuery.state;
    this._currentResultOptions = this.options;
    if (this._currentResultState.data !== undefined) this._lastQueryWithDefinedData = this._currentQuery;
    if (shallowEqualObjects(nextResult, prevResult)) return;
    this._currentResult = nextResult;
    this._notify();
  }

  /** 照目前 options 找（或建）對應的 query，鍵變了就換過去 */
  _updateQuery() {
    const query = this._client.getQueryCache().build(this._client, this.options);
    if (query === this._currentQuery) return;
    const prevQuery = this._currentQuery;
    this._currentQuery = query;
    this._currentQueryInitialState = query.state;
    if (this.hasListeners()) {
      prevQuery?.removeObserver(this);
      query.addObserver(this);
    }
  }

  onQueryUpdate() {
    this.updateResult();
    if (this.hasListeners()) this._updateTimers();
  }

  _notify() {
    this._listeners.forEach((listener) => listener(this._currentResult));
    this._client.getQueryCache().notify({ query: this._currentQuery, type: 'observerResultsUpdated' });
  }
}

// ───────────────────────────────────────────────────────────────
// InfiniteQueryObserver：data 是 { pages, pageParams }
// ───────────────────────────────────────────────────────────────

function getNextPageParam(options, { pages, pageParams }) {
  const lastIndex = pages.length - 1;
  return pages.length > 0
    ? options.getNextPageParam(pages[lastIndex], pages, pageParams[lastIndex], pageParams)
    : undefined;
}

function getPreviousPageParam(options, { pages, pageParams }) {
  return pages.length > 0 ? options.getPreviousPageParam?.(pages[0], pages, pageParams[0], pageParams) : undefined;
}

function hasNextPage(options, data) {
  if (!data) return false;
  return getNextPageParam(options, data) != null;
}

function hasPreviousPage(options, data) {
  if (!data || !options.getPreviousPageParam) return false;
  return getPreviousPageParam(options, data) != null;
}

/** 把 query 的 fetchFn 換成「抓下一頁／上一頁」或「依序重抓所有已載入的頁」 */
function infiniteQueryBehavior(pages) {
  return {
    onFetch: (context) => {
      const options = context.options;
      const direction = context.fetchOptions?.meta?.fetchMore?.direction;
      const oldPages = context.state.data?.pages || [];
      const oldPageParams = context.state.data?.pageParams || [];
      let result = { pages: [], pageParams: [] };
      let currentPage = 0;

      const fetchFn = async () => {
        let cancelled = false;
        const addSignalProperty = (object) => {
          Object.defineProperty(object, 'signal', {
            enumerable: true,
            get: () => {
              if (context.signal.aborted) cancelled = true;
              else context.signal.addEventListener('abort', () => { cancelled = true; });
              return context.signal;
            },
          });
        };

        const queryFn = options.queryFn;
        if (typeof queryFn !== 'function') throw new Error(`Missing queryFn: '${options.queryHash}'`);

        // 抓一頁並接到 data 上
        const fetchPage = async (data, param, previous) => {
          if (cancelled) return Promise.reject();
          if (param == null && data.pages.length) return Promise.resolve(data);
          const queryFnContext = {
            client: context.client,
            queryKey: context.queryKey,
            pageParam: param,
            direction: previous ? 'backward' : 'forward',
            meta: context.options.meta,
          };
          addSignalProperty(queryFnContext);
          const page = await queryFn(queryFnContext);
          const { maxPages } = context.options;
          const addTo = previous ? addToStart : addToEnd;
          return { pages: addTo(data.pages, page, maxPages), pageParams: addTo(data.pageParams, param, maxPages) };
        };

        if (direction && oldPages.length) {
          // fetchNextPage／fetchPreviousPage：只抓那一頁
          const previous = direction === 'backward';
          const pageParamFn = previous ? getPreviousPageParam : getNextPageParam;
          const oldData = { pages: oldPages, pageParams: oldPageParams };
          const param = pageParamFn(options, oldData);
          result = await fetchPage(oldData, param, previous);
        } else {
          // 重抓：從第一頁開始依序抓回所有已載入的頁（至少一頁）
          const remainingPages = pages ?? oldPages.length;
          do {
            const param = currentPage === 0 ? (oldPageParams[0] ?? options.initialPageParam) : getNextPageParam(options, result);
            if (currentPage > 0 && param == null) break;
            result = await fetchPage(result, param);
            currentPage++;
          } while (currentPage < remainingPages);
        }
        return result;
      };

      context.fetchFn = fetchFn;
    },
  };
}

export class InfiniteQueryObserver extends QueryObserver {
  bindMethods() {
    super.bindMethods();
    this.fetchNextPage = this.fetchNextPage.bind(this);
    this.fetchPreviousPage = this.fetchPreviousPage.bind(this);
  }

  setOptions(options) {
    super.setOptions({ ...options, behavior: infiniteQueryBehavior() });
  }

  getOptimisticResult(options) {
    options.behavior = infiniteQueryBehavior();
    return super.getOptimisticResult(options);
  }

  fetchNextPage(options) {
    return this.fetch({ ...options, meta: { fetchMore: { direction: 'forward' } } });
  }

  fetchPreviousPage(options) {
    return this.fetch({ ...options, meta: { fetchMore: { direction: 'backward' } } });
  }

  createResult(query, options) {
    const { state } = query;
    const parentResult = super.createResult(query, options);
    const { isFetching, isRefetching, isError, isRefetchError } = parentResult;
    const fetchDirection = state.fetchMeta?.fetchMore?.direction;
    const isFetchNextPageError = isError && fetchDirection === 'forward';
    const isFetchingNextPage = isFetching && fetchDirection === 'forward';
    const isFetchPreviousPageError = isError && fetchDirection === 'backward';
    const isFetchingPreviousPage = isFetching && fetchDirection === 'backward';
    return {
      ...parentResult,
      fetchNextPage: this.fetchNextPage,
      fetchPreviousPage: this.fetchPreviousPage,
      hasNextPage: hasNextPage(options, state.data),
      hasPreviousPage: hasPreviousPage(options, state.data),
      isFetchNextPageError,
      isFetchingNextPage,
      isFetchPreviousPageError,
      isFetchingPreviousPage,
      isRefetchError: isRefetchError && !isFetchNextPageError && !isFetchPreviousPageError,
      isRefetching: isRefetching && !isFetchingNextPage && !isFetchingPreviousPage,
    };
  }
}

// ───────────────────────────────────────────────────────────────
// MutationObserver：一個 useMutation 一個觀察者（只追最後一次 mutate）
// ───────────────────────────────────────────────────────────────

export class MutationObserver {
  constructor(client, options) {
    this._client = client;
    this._listeners = new Set();
    this._currentMutation = undefined;
    this._mutateOptions = undefined;
    this._currentResult = undefined;
    this.bindMethods();
    this.setOptions(options);
    this._updateResult();
  }

  bindMethods() {
    this.mutate = this.mutate.bind(this);
    this.reset = this.reset.bind(this);
    // useMutation 的 mutate()：不回 Promise、吞錯
    this.mutateSilently = (variables, options) => {
      this.mutate(variables, options).catch(noop);
    };
  }

  setOptions(options) {
    const prevOptions = this.options;
    this.options = this._client.defaultMutationOptions(options);
    if (!shallowEqualObjects(this.options, prevOptions)) {
      this._client.getMutationCache().notify({
        type: 'observerOptionsUpdated',
        mutation: this._currentMutation,
        observer: this,
      });
    }
    if (
      prevOptions?.mutationKey &&
      this.options.mutationKey &&
      hashKey(prevOptions.mutationKey) !== hashKey(this.options.mutationKey)
    ) {
      this.reset();
    } else if (this._currentMutation?.state.status === 'pending') {
      // 進行中的 mutation 跟著最新一次 render 的 options（回呼拿到最新的 closure）
      this._currentMutation.setOptions(this.options);
    }
  }

  hasListeners() {
    return this._listeners.size > 0;
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
      if (!this.hasListeners()) this._currentMutation?.removeObserver(this);
    };
  }

  onMutationUpdate(action) {
    this._updateResult();
    this._notify(action);
  }

  getCurrentResult() {
    return this._currentResult;
  }

  reset() {
    this._currentMutation?.removeObserver(this);
    this._currentMutation = undefined;
    this._updateResult();
    this._notify();
  }

  /** = useMutation 的 mutateAsync：回 Promise、會丟錯 */
  mutate(variables, options) {
    this._mutateOptions = options;
    this._currentMutation?.removeObserver(this);
    this._currentMutation = this._client.getMutationCache().build(this._client, this.options);
    this._currentMutation.addObserver(this);
    return this._currentMutation.execute(variables);
  }

  _updateResult() {
    const state = this._currentMutation?.state ?? getDefaultMutationState();
    this._currentResult = {
      ...state,
      isPending: state.status === 'pending',
      isSuccess: state.status === 'success',
      isError: state.status === 'error',
      isIdle: state.status === 'idle',
      mutate: this.mutateSilently,
      mutateAsync: this.mutate,
      reset: this.reset,
    };
  }

  /** 呼叫端 mutate(vars, { onSuccess, onError, onSettled }) 那層回呼：元件還掛著才呼叫 */
  _notify(action) {
    if (this._mutateOptions && this.hasListeners()) {
      const variables = this._currentResult.variables;
      const context = this._currentResult.context;
      if (action?.type === 'success') {
        this._mutateOptions.onSuccess?.(action.data, variables, context);
        this._mutateOptions.onSettled?.(action.data, null, variables, context);
      } else if (action?.type === 'error') {
        this._mutateOptions.onError?.(action.error, variables, context);
        this._mutateOptions.onSettled?.(undefined, action.error, variables, context);
      }
    }
    this._listeners.forEach((listener) => listener(this._currentResult));
  }
}

// ───────────────────────────────────────────────────────────────
// Preact 接線：Provider 與 hooks
// ───────────────────────────────────────────────────────────────

const QueryClientContext = createContext(undefined);

/** `useQueryClient()` 取 Provider 給的 client；也接受直接傳一個進來 */
export function useQueryClient(queryClient) {
  const client = useContext(QueryClientContext);
  if (queryClient) return queryClient;
  if (!client) throw new Error('No QueryClient set, use QueryClientProvider to set one');
  return client;
}

/** `<QueryClientProvider client={client}>…</QueryClientProvider>`：提供 client，掛載期間接上 focus／online 事件 */
export function QueryClientProvider({ client, children }) {
  useEffect(() => {
    client.mount();
    return () => client.unmount();
  }, [client]);
  return h(QueryClientContext.Provider, { value: client }, children);
}

/**
 * useQuery／useInfiniteQuery 的共用骨架：
 * render 期間只算樂觀結果（會建 query，不會 fetch）；訂閱與 setOptions 都在 effect 裡，
 * 所以 fetch 一律在 effect 之後發生。
 */
function useBaseQuery(options, Observer) {
  if (!options || typeof options !== 'object') throw new Error('useQuery 需要一個 options 物件');
  if (options.queryKey === undefined) throw new Error('useQuery 的 options 缺少 queryKey');
  const client = useQueryClient();
  const defaultedOptions = client.defaultQueryOptions(options);
  defaultedOptions._optimisticResults = 'optimistic';

  const [observer] = useState(() => new Observer(client, defaultedOptions));
  const [, setTick] = useState(0);
  const result = observer.getOptimisticResult(defaultedOptions);

  useEffect(() => {
    const unsubscribe = observer.subscribe(() => setTick((t) => t + 1));
    // render 到訂閱之間若有更新（例如別的觀察者抓完了），補一次重算
    observer.updateResult();
    return unsubscribe;
  }, [observer]);

  // 每次 render 都同步 options（鍵變了就在這裡換 query、該抓就抓）
  useEffect(() => {
    observer.setOptions(defaultedOptions);
  });

  return result;
}

/**
 * useQuery({ queryKey, queryFn({ queryKey, signal, meta }), enabled, staleTime, gcTime, refetchInterval,
 *            refetchIntervalInBackground, refetchOnWindowFocus, refetchOnReconnect, refetchOnMount,
 *            placeholderData, select, retry, retryDelay, meta, initialData, structuralSharing })
 * 回 { data, error, status, fetchStatus, isPending, isLoading, isError, isSuccess, isFetching, isRefetching,
 *      isPlaceholderData, isStale, dataUpdatedAt, errorUpdatedAt, failureCount, refetch }
 */
export function useQuery(options) {
  return useBaseQuery(options, QueryObserver);
}

/**
 * useInfiniteQuery({ ...useQuery 的選項, initialPageParam, getNextPageParam(lastPage, allPages, lastPageParam, allPageParams),
 *                    getPreviousPageParam, maxPages })
 * queryFn 收 { pageParam, signal, queryKey, meta, direction }；data 是 { pages, pageParams }。
 * 回傳多 fetchNextPage()、hasNextPage、isFetchingNextPage（與 previous 系列）。
 */
export function useInfiniteQuery(options) {
  return useBaseQuery(options, InfiniteQueryObserver);
}

/**
 * useMutation({ mutationFn, mutationKey, meta, onMutate, onSuccess, onError, onSettled, retry })
 * 回 { mutate, mutateAsync, isPending, isIdle, isSuccess, isError, error, data, variables, status, reset }
 * mutate／mutateAsync／reset 是穩定參考（同一個 hook 不會換）。
 */
export function useMutation(options) {
  if (!options || typeof options !== 'object') throw new Error('useMutation 需要一個 options 物件');
  const client = useQueryClient();
  const [observer] = useState(() => new MutationObserver(client, options));
  const [, setTick] = useState(0);

  useEffect(() => {
    observer.setOptions(options);
  });

  useEffect(() => observer.subscribe(() => setTick((t) => t + 1)), [observer]);

  return observer.getCurrentResult();
}
