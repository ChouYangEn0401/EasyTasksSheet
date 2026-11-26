import { useLayoutEffect, useRef, useSyncExternalStore } from 'preact/compat';

/*
 * 動態共用工具（docs/design/realtime-feedback.md §3、§5）：
 * - 讀取 tokens.css 的動態 token（不寫死毫秒數）
 * - prefers-reduced-motion 即時狀態
 * - 項目層級效果狀態：更新高亮（flash）、進場（enter）、離場（leave）
 * - FLIP 位置移動
 */

// ── reduced motion ─────────────────────────────────

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function reducedMql() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_QUERY)
    : null;
}

/** 目前是否要求減少動態（使用中切換即時生效） */
export function prefersReducedMotion() {
  return !!reducedMql()?.matches;
}

export function useReducedMotion() {
  return useSyncExternalStore(
    (fn) => {
      const mql = reducedMql();
      mql?.addEventListener('change', fn);
      return () => mql?.removeEventListener('change', fn);
    },
    prefersReducedMotion,
    () => false,
  );
}

// ── tokens ─────────────────────────────────────────

const FALLBACK_MS = {
  '--duration-fast': 120,
  '--duration-base': 200,
  '--duration-exit': 150,
  '--duration-slow': 320,
  '--duration-highlight': 1200,
};

/** 解析 CSS 時間值（"200ms" / ".2s"） */
export function parseCssTime(value) {
  const v = value.trim();
  const m = /^(-?[\d.]+)(ms|s)$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === 's' ? n * 1000 : n;
}

/** 讀取動態 token 的毫秒數（reduced motion 時 tokens.css 已設為 0） */
export function motionMs(token) {
  if (typeof document === 'undefined') return FALLBACK_MS[token];
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token);
  return parseCssTime(raw) ?? FALLBACK_MS[token];
}

export function motionEasing(token) {
  const fallback = 'cubic-bezier(0.2, 0, 0, 1)';
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback;
}

// ── 項目效果狀態 ─────────────────────────────────────

/** 依 key（如 `task:12`）記錄目前效果；以 useSyncExternalStore 訂閱 */
function createFxStore() {
  let state = new Map();
  const timers = new Map();
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());

  function set(key, fx, ms) {
    const prev = timers.get(key);
    if (prev != null) window.clearTimeout(prev);
    state = new Map(state).set(key, fx);
    emit();
    timers.set(
      key,
      window.setTimeout(() => {
        timers.delete(key);
        if (state.get(key) !== fx) return;
        const next = new Map(state);
        next.delete(key);
        state = next;
        emit();
      }, ms),
    );
  }

  return {
    set,
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

const fxStore = createFxStore();

/** 更新高亮的停留時間：一般為 --duration-highlight；reduced motion 時靜態標示 2 秒 */
export function highlightMs() {
  return prefersReducedMotion() ? 2000 : motionMs('--duration-highlight');
}

/** 「剛更新」高亮 */
export function flashItem(key) {
  fxStore.set(key, 'flash', highlightMs());
}

/** 進場（列插入）後接著播更新高亮 */
export function enterItem(key) {
  fxStore.set(key, 'enter', highlightMs());
}

/** 離場：回傳離場動畫總長（ms），呼叫端在此之後才把項目從資料移除 */
export function leaveItem(key) {
  const ms = prefersReducedMotion() ? 0 : motionMs('--duration-fast') + motionMs('--duration-exit');
  if (ms > 0) fxStore.set(key, 'leave', ms + 1000);
  return ms;
}

export function useItemFx() {
  return useSyncExternalStore(fxStore.subscribe, fxStore.get, fxStore.get);
}

/** 給元素的 data 屬性：data-fx="flash|enter|leave" */
export function fxAttr(fx) {
  return fx ? { 'data-fx': fx } : {};
}

export const taskFxKey = (id) => `task:${id}`;

// ── 他人變更標記（FLIP 只對他人造成的移動播放） ───────

const REMOTE_WINDOW_MS = 3000;
const remoteMarks = new Map();

/** 標記某項目剛被他人變更（資料重抓後的位置移動會播 FLIP） */
export function markRemote(key) {
  remoteMarks.set(key, Date.now() + REMOTE_WINDOW_MS);
}

export function isRecentRemote(key) {
  const until = remoteMarks.get(key);
  if (until == null) return false;
  if (until < Date.now()) {
    remoteMarks.delete(key);
    return false;
  }
  return true;
}

// ── FLIP ───────────────────────────────────────────

/** 一次變動超過此數量時不播動畫（直接替換內容） */
export const MAX_ANIMATED_CHANGES = 20;

/**
 * FLIP 位置移動：每次 render 後量測 container 內 `[selector]` 元素（以 attr 值為 id），
 * 與上次位置比較，對 `shouldAnimate(id)` 為真的元素播放位移動畫。
 * 位置以「相對 container」計算，避免捲動造成誤判；變動數超過 MAX_ANIMATED_CHANGES、
 * reduced motion 或 enabled=false 時只更新量測、不播放。
 */
export function useFlip(
  containerRef,
  { selector, attr, enabled = true, shouldAnimate, token = '--duration-base' },
) {
  const last = useRef(new Map());

  // 無依賴陣列：每次 render 後都量測
  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const next = new Map();
    const els = root.querySelectorAll(selector);
    for (const el of els) {
      const id = el.getAttribute(attr);
      if (!id) continue;
      const r = el.getBoundingClientRect();
      next.set(id, { x: r.left - base.left, y: r.top - base.top });
    }
    const prev = last.current;
    last.current = next;
    if (
      !enabled ||
      prev.size === 0 ||
      prefersReducedMotion() ||
      typeof Element.prototype.animate !== 'function'
    )
      return;
    const moves = [];
    for (const el of els) {
      const id = el.getAttribute(attr);
      if (!id || !shouldAnimate(id)) continue;
      const a = prev.get(id);
      const b = next.get(id);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      moves.push([el, dx, dy]);
    }
    if (!moves.length || moves.length > MAX_ANIMATED_CHANGES) return;
    const duration = motionMs(token);
    const easing = motionEasing('--ease-standard');
    for (const [el, dx, dy] of moves) {
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
        duration,
        easing,
      });
    }
  });
}
