// 拖放（drag and drop）函式庫：@dnd-kit/core、@dnd-kit/sortable、@dnd-kit/utilities 的子集相容替代品。
//
// - 原生 ES module，瀏覽器直接載入，零建置；只依賴 import map 提供的 preact／preact/hooks／preact/compat。
// - 以原生 Pointer／Mouse／Touch 事件＋鍵盤實作（不用 HTML5 原生 DnD：它沒有鍵盤操作、也不能自訂浮層）。
// - 匯出名稱、參數形狀、回傳形狀照 dnd-kit（core 6.x／sortable 10.x／utilities 3.x），
//   呼叫端只把 import 來源換成本檔即可。
//
// 與 dnd-kit 的已知差異（刻意簡化）：
// - 沒有自動捲動（autoScroll 參數接受但忽略）；KeyboardSensor 的 scrollBehavior 忽略。
// - 放下後清單項目不做「從舊位置滑到新位置」的 FLIP 動畫（dnd-kit 的 derivedTransform），直接就位。
// - animateLayoutChanges、resizeObserverConfig、adjustScale、DragOverlay 的 sideEffects 物件接受但忽略；
//   放下動畫期間來源節點一律 opacity: 0（等同 dnd-kit 預設的 sideEffects）。
// - 碰撞用的 rect 一律是視窗座標（getBoundingClientRect，扣掉元素自身的 transform）；捲動時重量。
// - collisionDetection 沒給時預設 closestCenter（dnd-kit 預設 rectIntersection）。
// - 同時有 PointerSensor 與 TouchSensor 時，觸控只交給 TouchSensor（避免兩個感應器搶同一次按壓）。
import { createElement as h, createContext } from 'preact';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';

// ───────────────────────────── utilities ─────────────────────────────

/** 鍵盤代碼（KeyboardEvent.code） */
export const KeyboardCode = {
  Space: 'Space',
  Down: 'ArrowDown',
  Right: 'ArrowRight',
  Left: 'ArrowLeft',
  Up: 'ArrowUp',
  Esc: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
};

const Translate = {
  toString(t) {
    if (!t) return undefined;
    const { x, y } = t;
    return `translate3d(${x ? Math.round(x) : 0}px, ${y ? Math.round(y) : 0}px, 0)`;
  },
};
const Scale = {
  toString(t) {
    if (!t) return undefined;
    return `scaleX(${t.scaleX ?? 1}) scaleY(${t.scaleY ?? 1})`;
  },
};

/** CSS 字串工具（同 @dnd-kit/utilities 的 CSS） */
export const CSS = Object.freeze({
  Translate,
  Scale,
  Transform: {
    toString(t) {
      if (!t) return undefined;
      return [Translate.toString(t), Scale.toString(t)].join(' ');
    },
  },
  Transition: {
    toString({ property, duration, easing }) {
      return `${property} ${duration}ms ${easing}`;
    },
  },
});

const nativeOf = (e) => (e && e.nativeEvent) || e;

export function isKeyboardEvent(event) {
  const e = nativeOf(event);
  return !!e && typeof KeyboardEvent !== 'undefined' && e instanceof KeyboardEvent;
}

export function isTouchEvent(event) {
  const e = nativeOf(event);
  if (!e) return false;
  if (typeof TouchEvent !== 'undefined' && e instanceof TouchEvent) return true;
  return 'touches' in e && 'changedTouches' in e;
}

/** 事件 → 視窗座標 { x, y }；鍵盤事件等沒有座標者回 null */
export function getEventCoordinates(event) {
  const e = nativeOf(event);
  if (!e) return null;
  if (isTouchEvent(e)) {
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    return t ? { x: t.clientX, y: t.clientY } : null;
  }
  if (typeof e.clientX === 'number' && typeof e.clientY === 'number') return { x: e.clientX, y: e.clientY };
  return null;
}

// ───────────────────────────── rect 與量測 ─────────────────────────────

const makeRect = (left, top, width, height) => ({
  top,
  left,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

/** 解析 computed transform 的 matrix / matrix3d → { scaleX, scaleY, x, y } */
function parseTransform(t) {
  if (!t || t === 'none') return null;
  if (t.startsWith('matrix3d(')) {
    const v = t.slice(9, -1).split(',').map(Number);
    return { scaleX: v[0], scaleY: v[5], x: v[12], y: v[13] };
  }
  if (t.startsWith('matrix(')) {
    const v = t.slice(7, -1).split(',').map(Number);
    return { scaleX: v[0], scaleY: v[3], x: v[4], y: v[5] };
  }
  return null;
}

/** 量測元素位置（視窗座標），扣掉元素自身的 transform（同 dnd-kit 的 getTransformAgnosticClientRect） */
function measureNode(el) {
  const r = el.getBoundingClientRect();
  let { left, top, width, height } = r;
  const cs = getComputedStyle(el);
  const p = parseTransform(cs.transform);
  if (p) {
    const origin = (cs.transformOrigin || '0 0').split(' ').map(parseFloat);
    const sx = p.scaleX || 1;
    const sy = p.scaleY || 1;
    left = left - p.x - (1 - sx) * (origin[0] || 0);
    top = top - p.y - (1 - sy) * (origin[1] || 0);
    width = width / sx;
    height = height / sy;
  }
  return makeRect(left, top, width, height);
}

const rawRect = (el) => {
  const r = el.getBoundingClientRect();
  return makeRect(r.left, r.top, r.width, r.height);
};

const windowRect = () => makeRect(0, 0, window.innerWidth, window.innerHeight);

/** 可捲動的祖先（含 document.scrollingElement） */
function getScrollableAncestors(el) {
  const out = [];
  let n = el ? el.parentElement : null;
  while (n && n !== document.body && n !== document.documentElement) {
    const cs = getComputedStyle(n);
    if (/(auto|scroll|overlay)/.test(cs.overflow + cs.overflowX + cs.overflowY)) out.push(n);
    n = n.parentElement;
  }
  if (document.scrollingElement) out.push(document.scrollingElement);
  return out;
}

// ───────────────────────────── 碰撞偵測 ─────────────────────────────

const distanceBetween = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
const centerOf = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
const cornersOf = (r) => [
  { x: r.left, y: r.top },
  { x: r.left + r.width, y: r.top },
  { x: r.left, y: r.top + r.height },
  { x: r.left + r.width, y: r.top + r.height },
];
const rectOf = (args, c) => args.droppableRects.get(c.id);
const asc = (a, b) => a.data.value - b.data.value;

/** 中心最近者優先 */
export const closestCenter = (args) => {
  const { collisionRect, droppableContainers } = args;
  if (!collisionRect) return [];
  const center = centerOf(collisionRect);
  const out = [];
  for (const c of droppableContainers) {
    const r = rectOf(args, c);
    if (!r) continue;
    out.push({ id: c.id, data: { droppableContainer: c, value: distanceBetween(centerOf(r), center) } });
  }
  return out.sort(asc);
};

/** 四角距離平均最近者優先 */
export const closestCorners = (args) => {
  const { collisionRect, droppableContainers } = args;
  if (!collisionRect) return [];
  const corners = cornersOf(collisionRect);
  const out = [];
  for (const c of droppableContainers) {
    const r = rectOf(args, c);
    if (!r) continue;
    const rc = cornersOf(r);
    const d = corners.reduce((sum, p, i) => sum + distanceBetween(rc[i], p), 0);
    out.push({ id: c.id, data: { droppableContainer: c, value: Number((d / 4).toFixed(4)) } });
  }
  return out.sort(asc);
};

function intersectionRatio(entry, target) {
  const top = Math.max(target.top, entry.top);
  const left = Math.max(target.left, entry.left);
  const right = Math.min(target.left + target.width, entry.left + entry.width);
  const bottom = Math.min(target.top + target.height, entry.top + entry.height);
  if (left < right && top < bottom) {
    const inter = (right - left) * (bottom - top);
    return Number((inter / (target.width * target.height + entry.width * entry.height - inter)).toFixed(4));
  }
  return 0;
}

/** 重疊比例大者優先（只回有重疊的） */
export const rectIntersection = (args) => {
  const { collisionRect, droppableContainers } = args;
  if (!collisionRect) return [];
  const out = [];
  for (const c of droppableContainers) {
    const r = rectOf(args, c);
    if (!r) continue;
    const v = intersectionRatio(r, collisionRect);
    if (v > 0) out.push({ id: c.id, data: { droppableContainer: c, value: v } });
  }
  return out.sort((a, b) => b.data.value - a.data.value);
};

/** 只回包含指標的放置區，四角距離近者優先；沒有指標座標（鍵盤）回 [] */
export const pointerWithin = (args) => {
  const { pointerCoordinates, droppableContainers } = args;
  if (!pointerCoordinates) return [];
  const p = pointerCoordinates;
  const out = [];
  for (const c of droppableContainers) {
    const r = rectOf(args, c);
    if (!r) continue;
    if (p.y >= r.top && p.y <= r.bottom && p.x >= r.left && p.x <= r.right) {
      const d = cornersOf(r).reduce((sum, q) => sum + distanceBetween(q, p), 0);
      out.push({ id: c.id, data: { droppableContainer: c, value: Number((d / 4).toFixed(4)) } });
    }
  }
  return out.sort(asc);
};

export function getFirstCollision(collisions, property) {
  if (!collisions || collisions.length === 0) return null;
  const [first] = collisions;
  return property ? first[property] : first;
}

// ───────────────────────────── 常數 ─────────────────────────────

export const MeasuringStrategy = { Always: 0, BeforeDragging: 1, WhileDragging: 2 };
export const MeasuringFrequency = { Optimized: 'optimized' };
export const AutoScrollActivator = { Pointer: 0, DraggableRect: 1 };
export const TraversalOrder = { TreeOrder: 0, ReversedTreeOrder: 1 };

export const defaultScreenReaderInstructions = {
  draggable: `
    To pick up a draggable item, press the space bar.
    While dragging, use the arrow keys to move the item.
    Press space again to drop the item in its new position, or press escape to cancel.
  `,
};

export const defaultAnnouncements = {
  onDragStart({ active }) {
    return `Picked up draggable item ${active.id}.`;
  },
  onDragOver({ active, over }) {
    if (over) return `Draggable item ${active.id} was moved over droppable area ${over.id}.`;
    return `Draggable item ${active.id} is no longer over a droppable area.`;
  },
  onDragEnd({ active, over }) {
    if (over) return `Draggable item ${active.id} was dropped over droppable area ${over.id}`;
    return `Draggable item ${active.id} was dropped.`;
  },
  onDragCancel({ active }) {
    return `Dragging was cancelled. Draggable item ${active.id} was dropped.`;
  },
};

/** 放下動畫的副作用：本實作固定為「動畫期間來源節點透明」，這個函式只為相容而存在 */
export function defaultDropAnimationSideEffects() {
  return () => undefined;
}

export const defaultDropAnimation = { duration: 250, easing: 'ease', sideEffects: defaultDropAnimationSideEffects() };
export const defaultDropAnimationConfiguration = defaultDropAnimation;

// ───────────────────────────── 感應器 ─────────────────────────────

/** 預設鍵盤座標：方向鍵每次 25px */
export const defaultKeyboardCoordinateGetter = (event, { currentCoordinates }) => {
  switch (event.code) {
    case KeyboardCode.Right:
      event.preventDefault();
      return { ...currentCoordinates, x: currentCoordinates.x + 25 };
    case KeyboardCode.Left:
      event.preventDefault();
      return { ...currentCoordinates, x: currentCoordinates.x - 25 };
    case KeyboardCode.Down:
      event.preventDefault();
      return { ...currentCoordinates, y: currentCoordinates.y + 25 };
    case KeyboardCode.Up:
      event.preventDefault();
      return { ...currentCoordinates, y: currentCoordinates.y - 25 };
    default:
      return undefined;
  }
};

const defaultKeyboardCodes = {
  start: [KeyboardCode.Space, KeyboardCode.Enter],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter],
};

// 感應器本身只是標記：真正的事件處理集中在 DndStore（同一套拖曳生命週期）
export class PointerSensor {
  static kind = 'pointer';
  static activators = [{ eventName: 'onPointerDown' }];
}
export class MouseSensor {
  static kind = 'mouse';
  static activators = [{ eventName: 'onMouseDown' }];
}
export class TouchSensor {
  static kind = 'touch';
  static activators = [{ eventName: 'onTouchStart' }];
  /** dnd-kit 的 TouchSensor.setup：讓 touchmove 可以 preventDefault（iOS） */
  static setup() {
    const noop = () => undefined;
    window.addEventListener('touchmove', noop, { capture: false, passive: false });
    return () => window.removeEventListener('touchmove', noop);
  }
}
export class KeyboardSensor {
  static kind = 'keyboard';
  static activators = [{ eventName: 'onKeyDown' }];
}

export function useSensor(sensor, options) {
  return useMemo(() => ({ sensor, options: options ?? {} }), [sensor, options]);
}

export function useSensors(...sensors) {
  return useMemo(() => sensors.filter((s) => s != null), [...sensors]);
}

const DEFAULT_SENSORS = [
  { sensor: PointerSensor, options: {} },
  { sensor: KeyboardSensor, options: {} },
];

const eventNameOf = (desc) => desc.sensor.activators?.[0]?.eventName;

// ───────────────────────────── Store（每個 DndContext 一份） ─────────────────────────────

/** droppableContainers 的 Map 形狀（coordinateGetter 的 context 會用到 getEnabled） */
class DroppableContainersMap extends Map {
  get(id) {
    return id != null ? super.get(id) : undefined;
  }
  toArray() {
    return Array.from(this.values());
  }
  getEnabled() {
    return this.toArray().filter((c) => !c.disabled);
  }
  getNodeFor(id) {
    return this.get(id)?.node.current ?? undefined;
  }
}

/** 已被某個感應器處理過的原生事件（避免巢狀可拖曳元素、或元素與 window 重複處理同一個事件） */
const handledEvents = new WeakSet();
let idCounter = 0;

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });

class DndStore {
  constructor() {
    idCounter += 1;
    this.uid = idCounter;
    this.describedById = `DndDescribedBy-${this.uid}`;
    this.props = {};
    this.listeners = new Set();
    this.monitors = new Set();
    this.draggables = new Map();
    this.droppables = new Map();
    this.listenerCache = new Map();
    this.session = null; // 拖曳中的狀態
    this.pending = null; // 指標按下、尚未達到啟動條件
    this.dropping = null; // 放下動畫中
    this.overlayCount = 0;
    this.announcement = '';
    this.version = 0;
    this.activeVersion = 0;
    this.overVersion = 0;
    this.moveVersion = 0;
    this.dropVersion = 0;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.version += 1;
    for (const fn of Array.from(this.listeners)) fn();
  }

  get sensors() {
    const s = this.props.sensors;
    return s && s.length ? s : DEFAULT_SENSORS;
  }

  get active() {
    return this.session ? this.session.active : null;
  }

  get over() {
    return this.session ? this.session.over : null;
  }

  measuringStrategy() {
    return this.props.measuring?.droppable?.strategy ?? MeasuringStrategy.WhileDragging;
  }

  /** 某個 draggable 的 listeners：依目前的感應器決定事件名稱（onPointerDown / onMouseDown / onTouchStart / onKeyDown） */
  listenersFor(id) {
    const sensors = this.sensors;
    const hit = this.listenerCache.get(id);
    if (hit && hit.sensors === sensors) return hit.value;
    const value = {};
    for (const desc of sensors) {
      const name = eventNameOf(desc);
      if (!name || value[name]) continue;
      value[name] = (event) => this.onActivator(name, event, id);
    }
    this.listenerCache.set(id, { sensors, value });
    return value;
  }

  onActivator(eventName, event, id) {
    const ne = nativeOf(event);
    if (!ne || this.isNull) return; // 不在 DndContext 裡：跟 dnd-kit 一樣什麼都不做
    // 鍵盤拖曳中，焦點元素自己的 onKeyDown 也可能把事件轉給我們（例如呼叫端 stopPropagation 時）
    if (this.session) {
      if (eventName === 'onKeyDown' && this.session.kind === 'keyboard') this.onSessionKey(ne);
      return;
    }
    if (this.pending || handledEvents.has(ne)) return;
    const rec = this.draggables.get(id);
    if (!rec || rec.disabled) return;
    const desc = this.sensors.find((d) => eventNameOf(d) === eventName);
    if (!desc) return;
    const kind = desc.sensor.kind;
    if (kind === 'keyboard') this.keyboardActivate(desc, ne, id, rec);
    else this.pointerPending(kind, desc, ne, id);
  }

  // ── 指標類（pointer / mouse / touch） ──

  pointerPending(kind, desc, ne, id) {
    if (kind === 'pointer') {
      if (ne.isPrimary === false || ne.button !== 0) return;
      if (ne.pointerType === 'touch' && this.sensors.some((d) => d.sensor.kind === 'touch')) return;
    } else if (kind === 'mouse') {
      if (ne.button !== 0) return;
    } else if (kind === 'touch') {
      if (ne.touches && ne.touches.length > 1) return;
    }
    const start = getEventCoordinates(ne);
    if (!start) return;
    handledEvents.add(ne);

    let constraint = desc.options.activationConstraint;
    if (kind === 'touch' && !constraint) constraint = { delay: 250, tolerance: 5 };
    const names = {
      pointer: { move: 'pointermove', end: ['pointerup'], cancel: ['pointercancel'] },
      mouse: { move: 'mousemove', end: ['mouseup'], cancel: [] },
      touch: { move: 'touchmove', end: ['touchend'], cancel: ['touchcancel'] },
    }[kind];

    const p = { kind, desc, id, event: ne, start, last: start, timer: 0, offs: [] };
    this.pending = p;
    const on = (target, type, fn, opts = { capture: true, passive: false }) => {
      target.addEventListener(type, fn, opts);
      p.offs.push(() => target.removeEventListener(type, fn, opts));
    };

    on(window, names.move, (e) => {
      const c = getEventCoordinates(e);
      if (!c) return;
      p.last = c;
      if (this.session && this.session.pending === p) {
        if (e.cancelable && kind !== 'pointer') e.preventDefault();
        this.session.pointer = c;
        this.session.coords = c;
        this.updatePosition();
        return;
      }
      if (this.pending !== p) return;
      const d = sub(c, start);
      if (constraint && 'delay' in constraint) {
        if (exceeds(d, constraint.tolerance)) this.abortPending();
        return;
      }
      if (constraint && 'distance' in constraint) {
        if (constraint.tolerance != null && exceeds(d, constraint.tolerance) && !exceeds(d, constraint.distance)) {
          return;
        }
        if (exceeds(d, constraint.distance)) this.activatePointer(p, c);
      }
    });
    for (const type of names.end)
      on(window, type, (e) => {
        if (this.session && this.session.pending === p) {
          if (kind === 'touch' && e.cancelable) e.preventDefault(); // 不要再產生模擬滑鼠事件與 click
          this.finish('end');
        } else if (this.pending === p) this.abortPending();
      });
    for (const type of names.cancel)
      on(window, type, () => {
        if (this.session && this.session.pending === p) this.finish('cancel');
        else if (this.pending === p) this.abortPending();
      });
    on(window, 'keydown', (e) => {
      if (e.code !== KeyboardCode.Esc) return;
      if (this.session && this.session.pending === p) {
        e.preventDefault();
        this.finish('cancel');
      } else if (this.pending === p) this.abortPending();
    });
    on(window, 'dragstart', (e) => e.preventDefault());
    on(window, 'contextmenu', (e) => {
      if (kind === 'touch' || this.session) e.preventDefault();
    });

    if (!constraint) this.activatePointer(p, start);
    else if ('delay' in constraint) {
      p.timer = window.setTimeout(() => {
        if (this.pending === p) this.activatePointer(p, p.last);
      }, constraint.delay);
    }
  }

  abortPending() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    window.clearTimeout(p.timer);
    for (const off of p.offs) off();
  }

  activatePointer(p, current) {
    window.clearTimeout(p.timer);
    this.pending = null;
    const ok = this.startDrag({
      kind: p.kind,
      desc: p.desc,
      id: p.id,
      activatorEvent: p.event,
      initialCoords: p.start,
      pointer: p.start,
      pending: p,
    });
    if (!ok) {
      for (const off of p.offs) off();
      return;
    }
    // 有啟動條件（distance / delay）表示使用者確實在拖；沒有條件時要真的移動過才吞 click
    this.session.swallowClick = !!p.desc.options.activationConstraint || p.kind === 'touch';
    if (current.x !== p.start.x || current.y !== p.start.y) {
      this.session.pointer = current;
      this.session.coords = current;
      this.session.swallowClick = true;
      this.updatePosition();
    }
  }

  // ── 鍵盤 ──

  keyboardCodes(desc) {
    return { ...defaultKeyboardCodes, ...(desc.options.keyboardCodes || {}) };
  }

  keyboardActivate(desc, ne, id, rec) {
    const codes = this.keyboardCodes(desc);
    if (!codes.start.includes(ne.code)) return;
    const activator = rec.activator.current;
    if (activator && ne.target !== activator) return;
    const node = rec.node.current || activator;
    if (!node) return;
    ne.preventDefault();
    handledEvents.add(ne);
    const r = rawRect(node);
    const coords = { x: r.left, y: r.top };
    const p = { offs: [] };
    const on = (type, fn) => {
      window.addEventListener(type, fn);
      p.offs.push(() => window.removeEventListener(type, fn));
    };
    if (!this.startDrag({ kind: 'keyboard', desc, id, activatorEvent: ne, initialCoords: coords, pointer: null, pending: p }))
      return;
    on('keydown', (e) => this.onSessionKey(e));
  }

  onSessionKey(ne) {
    const s = this.session;
    if (!s || s.kind !== 'keyboard' || handledEvents.has(ne)) return;
    handledEvents.add(ne);
    const codes = this.keyboardCodes(s.desc);
    if (codes.end.includes(ne.code)) {
      ne.preventDefault();
      this.finish('end');
      return;
    }
    if (codes.cancel.includes(ne.code)) {
      ne.preventDefault();
      this.finish('cancel');
      return;
    }
    if (ne.code === KeyboardCode.Tab) {
      ne.preventDefault(); // 拖曳中焦點不離開
      return;
    }
    const getter = s.desc.options.coordinateGetter || defaultKeyboardCoordinateGetter;
    this.measureDroppables(true); // 鍵盤每一步都重量（上一步可能讓版面變了）
    this.refreshOver(); // over.rect 用最新量測
    const rect = s.active.rect.current.translated;
    const currentCoordinates = { x: rect.left, y: rect.top };
    const next = getter(ne, { active: s.activeId, currentCoordinates, context: this.getterContext() });
    if (!next || this.session !== s) return;
    s.coords = { x: next.x, y: next.y };
    this.updatePosition();
  }

  getterContext() {
    const s = this.session;
    const map = new DroppableContainersMap();
    for (const c of this.droppables.values()) map.set(c.id, c);
    const rec = this.draggables.get(s.activeId);
    return {
      active: s.active,
      activeNode: rec?.node.current ?? null,
      activeNodeRect: s.initialRect,
      activatorEvent: s.activatorEvent,
      collisionRect: s.active.rect.current.translated,
      collisions: s.collisions,
      draggableNodes: this.draggables,
      droppableContainers: map,
      droppableRects: s.droppableRects,
      over: s.over,
      scrollableAncestors: s.scrollAncestors.map((a) => a.el),
      scrollableAncestorRects: [],
      windowRect: windowRect(),
      measuringConfiguration: this.props.measuring ?? {},
      measureDroppableContainers: () => this.measureDroppables(),
    };
  }

  // ── 拖曳生命週期 ──

  startDrag({ kind, desc, id, activatorEvent, initialCoords, pointer, pending }) {
    const rec = this.draggables.get(id);
    if (!rec) return false;
    if (this.dropping) this.endDropAnimation();
    const node = rec.node.current || rec.activator.current;
    const initialRect = node ? rawRect(node) : makeRect(initialCoords.x, initialCoords.y, 0, 0);
    const scrollAncestors = getScrollableAncestors(node).map((el) => ({
      el,
      left: el.scrollLeft,
      top: el.scrollTop,
    }));
    const active = {
      id,
      data: rec.data,
      rect: { current: { initial: initialRect, translated: initialRect } },
    };
    const s = {
      kind,
      desc,
      activeId: id,
      active,
      activatorEvent,
      initialRect,
      initialCoords,
      coords: initialCoords,
      pointer,
      pending,
      over: null,
      collisions: null,
      droppableRects: new Map(),
      scrollAncestors,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
      viewportDelta: { x: 0, y: 0 },
      swallowClick: false,
      offs: [],
    };
    this.session = s;

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      s.offs.push(() => target.removeEventListener(type, fn, opts));
    };
    on(window, 'scroll', () => {
      if (this.session !== s) return;
      this.invalidateRects();
      this.updatePosition();
    }, { capture: true, passive: true });
    on(window, 'resize', () => this.session === s && this.finish('cancel'));
    on(document, 'visibilitychange', () => this.session === s && document.hidden && this.finish('cancel'));

    // 拖曳中禁止選取文字
    const bs = document.body.style;
    s.prevUserSelect = [bs.userSelect, bs.webkitUserSelect];
    bs.userSelect = 'none';
    bs.webkitUserSelect = 'none';
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* 忽略 */
    }

    this.activeVersion += 1;
    this.measureDroppables();
    s.active.rect.current.translated = initialRect;
    const evt = { active, activatorEvent };
    this.props.onDragStart?.(evt);
    this.notifyMonitors('onDragStart', evt);
    this.announce('onDragStart', { active });
    if (this.session !== s) return true;
    this.computeCollisions(true);
    this.emit();
    // 開始拖曳後的第一次渲染（佔位樣式等）可能改變版面：渲染完再量一次
    window.setTimeout(() => {
      if (this.session !== s) return;
      this.invalidateRects();
      this.computeCollisions(true);
      this.emit();
    }, 0);
    return true;
  }

  scrollDelta() {
    const s = this.session;
    let x = 0;
    let y = 0;
    for (const a of s.scrollAncestors) {
      x += a.el.scrollLeft - a.left;
      y += a.el.scrollTop - a.top;
    }
    return { x, y };
  }

  applyModifiers(transform) {
    const mods = this.props.modifiers;
    if (!mods || !mods.length) return transform;
    const s = this.session;
    return mods.reduce(
      (t, m) =>
        m({
          transform: t,
          active: s.active,
          activatorEvent: s.activatorEvent,
          activeNodeRect: s.initialRect,
          draggingNodeRect: s.initialRect,
          containerNodeRect: null,
          over: s.over,
          overlayNodeRect: null,
          scrollableAncestors: s.scrollAncestors.map((a) => a.el),
          scrollableAncestorRects: [],
          windowRect: windowRect(),
        }) ?? t,
      transform,
    );
  }

  /** 依目前座標更新位移、碰撞、over，並觸發 onDragMove／onDragOver */
  updatePosition() {
    const s = this.session;
    if (!s) return;
    const vd = sub(s.coords, s.initialCoords);
    const sd = this.scrollDelta();
    const t = this.applyModifiers({ x: vd.x + sd.x, y: vd.y + sd.y, scaleX: 1, scaleY: 1 });
    s.transform = t;
    s.viewportDelta = { x: t.x - sd.x, y: t.y - sd.y };
    const r = s.initialRect;
    s.active.rect.current.translated = makeRect(r.left + s.viewportDelta.x, r.top + s.viewportDelta.y, r.width, r.height);
    this.moveVersion += 1;
    if (this.measuringStrategy() === MeasuringStrategy.Always) this.invalidateRects();
    this.computeCollisions(false);
    if (this.session === s) this.emit();
  }

  invalidateRects() {
    if (this.session) this.session.droppableRects = new Map();
  }

  /** 量所有啟用中的放置區；已量過的保留（invalidateRects 之後才重量） */
  measureDroppables(force = false) {
    const s = this.session;
    if (!s) return;
    if (force) s.droppableRects = new Map();
    for (const c of this.droppables.values()) {
      if (c.disabled) continue;
      if (s.droppableRects.has(c.id)) continue;
      const n = c.node.current;
      if (!n || !n.isConnected) {
        c.rect.current = null;
        continue;
      }
      const r = measureNode(n);
      c.rect.current = r;
      s.droppableRects.set(c.id, r);
    }
  }

  makeOver(id) {
    if (id == null) return null;
    const c = this.droppables.get(id);
    if (!c) return null;
    const s = this.session;
    let rect = s.droppableRects.get(id);
    if (!rect && c.node.current) rect = measureNode(c.node.current);
    return { id: c.id, rect: rect ?? null, data: c.data, disabled: !!c.disabled };
  }

  refreshOver() {
    const s = this.session;
    if (s && s.over) {
      const o = this.makeOver(s.over.id);
      if (o) s.over = o;
    }
  }

  computeCollisions(initial) {
    const s = this.session;
    if (!s) return;
    this.measureDroppables();
    const enabled = [];
    for (const c of this.droppables.values()) if (!c.disabled) enabled.push(c);
    const detect = this.props.collisionDetection || closestCenter;
    const collisions =
      detect({
        active: s.active,
        collisionRect: s.active.rect.current.translated,
        droppableRects: s.droppableRects,
        droppableContainers: enabled,
        pointerCoordinates: s.pointer,
      }) || [];
    s.collisions = collisions;
    const overId = getFirstCollision(collisions, 'id');
    const prevId = s.over ? s.over.id : null;
    const over = this.makeOver(overId);
    s.over = over;
    const evt = this.dragEvent();
    if (!initial) {
      this.props.onDragMove?.(evt);
      this.notifyMonitors('onDragMove', evt);
      this.announce('onDragMove', { active: s.active, over });
    }
    if (this.session !== s) return;
    if ((over ? over.id : null) !== prevId) {
      this.overVersion += 1;
      if (initial && !over) return; // 一開始就沒有 over：不算「變化」
      this.props.onDragOver?.(evt);
      this.notifyMonitors('onDragOver', evt);
      this.announce('onDragOver', { active: s.active, over });
    }
  }

  dragEvent() {
    const s = this.session;
    return {
      active: s.active,
      over: s.over,
      delta: { x: s.transform.x, y: s.transform.y },
      activatorEvent: s.activatorEvent,
      collisions: s.collisions,
    };
  }

  /** 結束拖曳：type 為 'end'（放下）或 'cancel'（取消） */
  finish(type) {
    const s = this.session;
    if (!s) return;
    const evt = this.dragEvent();
    for (const off of s.offs) off();
    if (s.pending) for (const off of s.pending.offs) off();
    const bs = document.body.style;
    bs.userSelect = s.prevUserSelect[0];
    bs.webkitUserSelect = s.prevUserSelect[1];

    // 指標拖曳放下後，緊接著的那一次 click 不能讓元素被「點開」
    if (s.kind !== 'keyboard' && s.swallowClick) {
      const swallow = (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener('click', swallow, true);
      };
      window.addEventListener('click', swallow, true);
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    }

    // 浮層的放下動畫：從目前位置回到來源節點的最終位置
    if (this.overlayCount > 0 && this.overlayHadContent) {
      this.dropping = { id: s.activeId, initialRect: s.initialRect, from: s.viewportDelta, started: false };
      this.dropVersion += 1;
    }
    this.overlayHadContent = false;

    this.session = null;
    this.activeVersion += 1;
    this.overVersion += 1;
    if (type === 'end') {
      this.props.onDragEnd?.(evt);
      this.notifyMonitors('onDragEnd', evt);
      this.announce('onDragEnd', { active: evt.active, over: evt.over, delta: evt.delta });
    } else {
      this.props.onDragCancel?.(evt);
      this.notifyMonitors('onDragCancel', evt);
      this.announce('onDragCancel', { active: evt.active, over: evt.over });
    }
    this.emit();

    // 鍵盤拖曳結束後把焦點還給拿起的元素（accessibility.restoreFocus: false 可關）
    if (s.kind === 'keyboard' && this.props.accessibility?.restoreFocus !== false) {
      requestAnimationFrame(() => {
        const rec = this.draggables.get(s.activeId);
        const el = rec?.activator.current || rec?.node.current;
        if (el && el.isConnected && document.activeElement !== el) el.focus?.({ preventScroll: true });
      });
    }
  }

  endDropAnimation() {
    const d = this.dropping;
    if (!d) return;
    d.cleanup?.();
    this.dropping = null;
    this.dropVersion += 1;
    this.emit();
  }

  cancelAll() {
    this.abortPending();
    if (this.session) this.finish('cancel');
  }

  notifyMonitors(name, evt) {
    for (const m of Array.from(this.monitors)) m.current?.[name]?.(evt);
  }

  announce(name, arg) {
    const custom = this.props.accessibility?.announcements;
    const fn = custom ? (custom[name] ?? (name in custom ? undefined : defaultAnnouncements[name])) : defaultAnnouncements[name];
    if (typeof fn !== 'function') return;
    const text = fn(arg);
    if (text) {
      this.announcement = text;
      this.emit();
    }
  }
}

function exceeds(delta, measurement) {
  if (measurement == null) return false;
  const dx = Math.abs(delta.x);
  const dy = Math.abs(delta.y);
  if (typeof measurement === 'number') return Math.sqrt(dx * dx + dy * dy) > measurement;
  if ('x' in measurement && 'y' in measurement) return dx > measurement.x && dy > measurement.y;
  if ('x' in measurement) return dx > measurement.x;
  if ('y' in measurement) return dy > measurement.y;
  return false;
}

const NULL_STORE = new DndStore();
NULL_STORE.isNull = true;
const StoreContext = createContext(null);

const useStore = () => useContext(StoreContext) || NULL_STORE;

/** 訂閱 store：compute() 的結果（字串或原始值）變了才重新渲染 */
function useStoreSnapshot(store, compute) {
  const [, force] = useState(0);
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const lastRef = useRef(undefined);
  lastRef.current = compute();
  useLayoutEffect(() => {
    const check = () => {
      const v = computeRef.current();
      if (v !== lastRef.current) {
        lastRef.current = v;
        force((n) => n + 1);
      }
    };
    const off = store.subscribe(check);
    check();
    return off;
  }, [store]);
}

// ───────────────────────────── DndContext ─────────────────────────────

const srOnly = {
  position: 'fixed',
  top: '0',
  left: '0',
  width: '1px',
  height: '1px',
  margin: '-1px',
  border: '0',
  padding: '0',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(100%)',
  whiteSpace: 'nowrap',
};

function LiveRegion({ store }) {
  useStoreSnapshot(store, () => store.announcement);
  return h('div', { id: `DndLiveRegion-${store.uid}`, role: 'status', 'aria-live': 'assertive', 'aria-atomic': 'true', style: srOnly }, store.announcement);
}

function Accessibility({ store, instructions, container }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    h(
      'div',
      { 'data-dnd-accessibility': '' },
      h('div', { id: store.describedById, style: { display: 'none' } }, instructions),
      h(LiveRegion, { store }),
    ),
    container || document.body,
  );
}

/**
 * 拖放的最外層：提供感應器、碰撞偵測與事件。
 * props：sensors、collisionDetection、measuring、accessibility、modifiers、autoScroll（忽略）、
 * onDragStart／onDragMove／onDragOver／onDragEnd／onDragCancel、children。
 */
export function DndContext(props) {
  const ref = useRef(null);
  if (!ref.current) ref.current = new DndStore();
  const store = ref.current;
  store.props = props;
  useEffect(() => {
    const cleanups = [];
    for (const d of store.sensors) if (typeof d.sensor.setup === 'function') cleanups.push(d.sensor.setup());
    return () => cleanups.forEach((fn) => fn && fn());
  }, [props.sensors]);
  useEffect(() => () => store.cancelAll(), [store]);
  const a11y = props.accessibility || {};
  const instructions = a11y.screenReaderInstructions?.draggable ?? defaultScreenReaderInstructions.draggable;
  return h(
    StoreContext.Provider,
    { value: store },
    props.children,
    h(Accessibility, { store, instructions, container: a11y.container }),
  );
}

/** 目前拖曳狀態（active、over…） */
export function useDndContext() {
  const store = useStore();
  useStoreSnapshot(store, () => `${store.activeVersion}:${store.overVersion}:${store.moveVersion}`);
  const s = store.session;
  return {
    active: s ? s.active : null,
    activeNode: s ? (store.draggables.get(s.activeId)?.node.current ?? null) : null,
    activeNodeRect: s ? s.initialRect : null,
    activatorEvent: s ? s.activatorEvent : null,
    collisions: s ? s.collisions : null,
    over: s ? s.over : null,
    draggableNodes: store.draggables,
    droppableContainers: store.droppables,
    droppableRects: s ? s.droppableRects : new Map(),
    measureDroppableContainers: () => store.measureDroppables(true),
    measuringScheduled: false,
    dragOverlay: { nodeRef: { current: null }, rect: null },
  };
}

/** 監聽拖曳事件（不必是 DndContext 的直接使用者） */
export function useDndMonitor(handlers) {
  const store = useStore();
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    store.monitors.add(ref);
    return () => store.monitors.delete(ref);
  }, [store]);
}

// ───────────────────────────── useDraggable / useDroppable ─────────────────────────────

/** 可拖曳元素 */
export function useDraggable({ id, data, disabled = false, attributes } = {}) {
  const store = useStore();
  const dataRef = useRef(data);
  dataRef.current = data;
  const node = useRef(null);
  const activator = useRef(null);
  const recRef = useRef(null);
  if (!recRef.current) recRef.current = { id, data: dataRef, node, activator, disabled };
  const rec = recRef.current;
  rec.id = id;
  rec.disabled = disabled;

  useLayoutEffect(() => {
    store.draggables.set(id, rec);
    return () => {
      if (store.draggables.get(id) === rec) store.draggables.delete(id);
    };
  }, [store, id]);

  useStoreSnapshot(store, () => {
    const s = store.session;
    const mine = !!s && Object.is(s.activeId, id);
    return `${store.activeVersion}:${store.overVersion}:${mine ? store.moveVersion : ''}`;
  });

  const setNodeRef = useCallback((el) => {
    node.current = el;
  }, []);
  const setActivatorNodeRef = useCallback((el) => {
    activator.current = el;
  }, []);

  const s = store.session;
  const isDragging = !!s && Object.is(s.activeId, id);
  const role = attributes?.role ?? 'button';
  return {
    active: s ? s.active : null,
    activatorEvent: s ? s.activatorEvent : null,
    activeNodeRect: s ? s.initialRect : null,
    attributes: {
      role,
      tabIndex: attributes?.tabIndex ?? 0,
      'aria-disabled': disabled,
      'aria-pressed': isDragging && role === 'button' ? true : undefined,
      'aria-roledescription': attributes?.roleDescription ?? 'draggable',
      'aria-describedby': store.describedById,
    },
    isDragging,
    listeners: disabled ? undefined : store.listenersFor(id),
    node,
    over: s ? s.over : null,
    setNodeRef,
    setActivatorNodeRef,
    transform: isDragging ? s.transform : null,
  };
}

/** 放置區 */
export function useDroppable({ id, data, disabled = false } = {}) {
  const store = useStore();
  const dataRef = useRef(data);
  dataRef.current = data;
  const node = useRef(null);
  const recRef = useRef(null);
  if (!recRef.current) recRef.current = { id, key: `Droppable-${++idCounter}`, data: dataRef, disabled, node, rect: { current: null } };
  const rec = recRef.current;
  rec.id = id;
  if (rec.disabled !== disabled) {
    rec.disabled = disabled;
    if (store.session) store.session.droppableRects.delete(id);
  }

  useLayoutEffect(() => {
    store.droppables.set(id, rec);
    return () => {
      if (store.droppables.get(id) === rec) store.droppables.delete(id);
      if (store.session) store.session.droppableRects.delete(id);
    };
  }, [store, id]);

  useStoreSnapshot(store, () => `${store.activeVersion}:${store.overVersion}`);

  const setNodeRef = useCallback(
    (el) => {
      if (node.current === el) return;
      node.current = el;
      // 拖曳中換了節點：下次重量
      if (store.session) store.session.droppableRects.delete(rec.id);
    },
    [store],
  );

  const s = store.session;
  return {
    active: s ? s.active : null,
    rect: rec.rect,
    isOver: !!s && !!s.over && Object.is(s.over.id, id),
    node,
    over: s ? s.over : null,
    setNodeRef,
  };
}

// ───────────────────────────── DragOverlay ─────────────────────────────

const defaultOverlayTransition = (activatorEvent) =>
  isKeyboardEvent(activatorEvent) ? 'transform 250ms ease' : undefined;

/**
 * 拖曳浮層：portal 到 document.body 的 position: fixed 容器，跟著指標／鍵盤座標移動。
 * dropAnimation：{ duration, easing } 或 null；不給時用預設 250ms ease。
 */
export function DragOverlay(props) {
  const { children, className, style, zIndex = 999, wrapperElement = 'div', transition } = props;
  const store = useStore();
  const propsRef = useRef(props);
  propsRef.current = props;
  const nodeRef = useRef(null);
  const cacheRef = useRef(null);

  useLayoutEffect(() => {
    store.overlayCount += 1;
    store.emit();
    return () => {
      store.overlayCount -= 1;
      store.emit();
    };
  }, [store]);

  useStoreSnapshot(store, () => `${store.activeVersion}:${store.dropVersion}`);

  const s = store.session;
  if (s && children != null) {
    cacheRef.current = { children, rect: s.initialRect, activatorEvent: s.activatorEvent };
    store.overlayHadContent = true;
  } else if (s) {
    store.overlayHadContent = false;
  }
  const dropping = !s && store.dropping;
  const content = s ? children : dropping ? cacheRef.current?.children : null;
  const rect = s ? s.initialRect : dropping ? dropping.initialRect : null;

  // 拖曳中直接改 DOM 的 transform（不必每次移動都重新渲染浮層內容）
  useLayoutEffect(() => {
    const apply = () => {
      const el = nodeRef.current;
      const cur = store.session;
      if (!el || !cur) return;
      el.style.transform = CSS.Translate.toString(cur.viewportDelta);
    };
    apply();
    return store.subscribe(apply);
  }, [store, content != null]);

  // 放下動畫
  useLayoutEffect(() => {
    const d = store.dropping;
    if (!d || d.started || store.session) return;
    d.started = true;
    let done = false;
    let raf = 0;
    let timer = 0;
    let anim = null;
    let source = null;
    let prevOpacity = '';
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      if (source) source.style.opacity = prevOpacity;
      if (store.dropping === d) store.endDropAnimation();
    };
    d.cleanup = () => {
      anim?.cancel?.();
      finish();
    };
    const run = () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      if (done || store.dropping !== d) return;
      const p = propsRef.current;
      const cfg = p.dropAnimation === undefined ? defaultDropAnimation : p.dropAnimation;
      const el = nodeRef.current;
      const target = store.draggables.get(d.id)?.node.current;
      if (!cfg || !el || !target || !target.isConnected) return finish();
      const r = rawRect(target);
      const to = { x: r.left - d.initialRect.left, y: r.top - d.initialRect.top };
      const duration = cfg.duration ?? defaultDropAnimation.duration;
      const easing = cfg.easing ?? defaultDropAnimation.easing;
      source = target;
      prevOpacity = target.style.opacity;
      target.style.opacity = '0';
      el.style.transition = 'none';
      if (typeof el.animate === 'function') {
        anim = el.animate(
          [{ transform: CSS.Translate.toString(d.from) }, { transform: CSS.Translate.toString(to) }],
          { duration, easing, fill: 'forwards' },
        );
        anim.onfinish = finish;
        anim.oncancel = finish;
      } else {
        el.style.transform = CSS.Translate.toString(to);
        timer = window.setTimeout(finish, duration);
      }
    };
    // 等呼叫端的 onDragEnd 狀態更新渲染完，再量來源節點的新位置
    raf = requestAnimationFrame(run);
    timer = window.setTimeout(run, 100);
  });

  if (content == null || !rect || typeof document === 'undefined') return null;
  const ev = s ? s.activatorEvent : cacheRef.current?.activatorEvent;
  const trans = typeof transition === 'function' ? transition(ev) : transition === undefined ? defaultOverlayTransition(ev) : transition;
  const vd = s ? s.viewportDelta : dropping.from;
  return createPortal(
    h(
      wrapperElement,
      {
        ref: nodeRef,
        className,
        'data-dnd-overlay': '',
        style: {
          position: 'fixed',
          top: `${rect.top}px`,
          left: `${rect.left}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          boxSizing: 'border-box',
          touchAction: 'none',
          zIndex,
          transformOrigin: '0 0',
          transform: CSS.Translate.toString(vd),
          transition: s ? trans : undefined,
          ...(style || {}),
        },
      },
      content,
    ),
    document.body,
  );
}

// ───────────────────────────── sortable ─────────────────────────────

/** 把陣列中 from 的元素移到 to */
export function arrayMove(array, from, to) {
  const next = array.slice();
  next.splice(to < 0 ? next.length + to : to, 0, next.splice(from, 1)[0]);
  return next;
}

/** 交換兩個位置 */
export function arraySwap(array, from, to) {
  const next = array.slice();
  next[from] = array[to];
  next[to] = array[from];
  return next;
}

function getItemGap(rects, index, activeIndex, axis) {
  const [start, size] = axis === 'y' ? ['top', 'height'] : ['left', 'width'];
  const cur = rects[index];
  const prev = rects[index - 1];
  const next = rects[index + 1];
  if (!cur) return 0;
  if (activeIndex < index) {
    if (prev) return cur[start] - (prev[start] + prev[size]);
    return next ? next[start] - (cur[start] + cur[size]) : 0;
  }
  if (next) return next[start] - (cur[start] + cur[size]);
  return prev ? cur[start] - (prev[start] + prev[size]) : 0;
}

function listStrategy(axis) {
  const [start, size] = axis === 'y' ? ['top', 'height'] : ['left', 'width'];
  const make = (v) => (axis === 'y' ? { x: 0, y: v, scaleX: 1, scaleY: 1 } : { x: v, y: 0, scaleX: 1, scaleY: 1 });
  return ({ activeIndex, activeNodeRect: fallback, index, rects, overIndex }) => {
    const activeNodeRect = rects[activeIndex] ?? fallback;
    if (!activeNodeRect) return null;
    if (index === activeIndex) {
      const overRect = rects[overIndex];
      if (!overRect) return null;
      return make(
        activeIndex < overIndex
          ? overRect[start] + overRect[size] - (activeNodeRect[start] + activeNodeRect[size])
          : overRect[start] - activeNodeRect[start],
      );
    }
    const gap = getItemGap(rects, index, activeIndex, axis);
    if (index > activeIndex && index <= overIndex) return make(-activeNodeRect[size] - gap);
    if (index < activeIndex && index >= overIndex) return make(activeNodeRect[size] + gap);
    return make(0);
  };
}

/** 垂直清單：active 與 over 之間的項目平移「active 的高＋間距」，active 自己移到 over 的位置 */
export const verticalListSortingStrategy = listStrategy('y');
/** 水平清單 */
export const horizontalListSortingStrategy = listStrategy('x');

/** 格狀：照移動後的順序把每一格平移到新位置 */
export const rectSortingStrategy = ({ rects, activeIndex, overIndex, index }) => {
  const newRects = arrayMove(rects, overIndex, activeIndex);
  const oldRect = rects[index];
  const newRect = newRects[index];
  if (!newRect || !oldRect) return null;
  return {
    x: newRect.left - oldRect.left,
    y: newRect.top - oldRect.top,
    scaleX: newRect.width / oldRect.width,
    scaleY: newRect.height / oldRect.height,
  };
};

/** 兩兩交換 */
export const rectSwappingStrategy = ({ activeIndex, index, rects, overIndex }) => {
  let oldRect;
  let newRect;
  if (index === activeIndex) {
    oldRect = rects[index];
    newRect = rects[overIndex];
  }
  if (index === overIndex) {
    oldRect = rects[index];
    newRect = rects[activeIndex];
  }
  if (!newRect || !oldRect) return null;
  return {
    x: newRect.left - oldRect.left,
    y: newRect.top - oldRect.top,
    scaleX: newRect.width / oldRect.width,
    scaleY: newRect.height / oldRect.height,
  };
};

const SortableCtx = createContext({
  containerId: 'Sortable',
  items: [],
  strategy: rectSortingStrategy,
  disabled: { draggable: false, droppable: false },
  cache: { version: -1 },
});

const normalizeDisabled = (d) =>
  typeof d === 'boolean' || d == null ? { draggable: !!d, droppable: !!d } : { draggable: !!d.draggable, droppable: !!d.droppable };

/** 一組可排序項目 */
export function SortableContext({ children, id, items, strategy = rectSortingStrategy, disabled = false }) {
  const store = useStore();
  const genId = useRef(null);
  if (!genId.current) genId.current = `Sortable-${++idCounter}`;
  const containerId = id ?? genId.current;
  const ids = useMemo(() => items.map((it) => (typeof it === 'object' && it !== null ? it.id : it)), [items]);
  const dis = normalizeDisabled(disabled);
  const value = useMemo(
    () => ({ containerId, items: ids, strategy, disabled: dis, cache: { version: -1 } }),
    [containerId, ids, strategy, dis.draggable, dis.droppable],
  );
  // 拖曳中項目變了：放置區位置要重量
  useLayoutEffect(() => {
    if (store.session) store.invalidateRects();
  }, [store, ids]);
  return h(SortableCtx.Provider, { value }, children);
}

/** 同一個 SortableContext 在同一個 store 版本只算一次 activeIndex / overIndex / rects */
function sortState(store, sctx) {
  const c = sctx.cache;
  if (c.version === store.version && c.store === store) return c;
  const s = store.session;
  c.version = store.version;
  c.store = store;
  if (!s) {
    c.activeIndex = -1;
    c.overIndex = -1;
    c.rects = [];
    return c;
  }
  c.activeIndex = sctx.items.indexOf(s.activeId);
  c.overIndex = s.over ? sctx.items.indexOf(s.over.id) : -1;
  c.rects = sctx.items.map((id) => s.droppableRects.get(id) ?? null);
  return c;
}

export const defaultAnimateLayoutChanges = () => false;
const defaultSortableTransition = { duration: 200, easing: 'ease' };

function computeSortable(store, sctx, id, index, strategyOverride, transitionParam) {
  const s = store.session;
  if (!s) return { transform: null, transition: undefined, activeIndex: -1, overIndex: -1, key: '-' };
  const { activeIndex, overIndex, rects } = sortState(store, sctx);
  const isDragging = Object.is(s.activeId, id);
  const useOverlay = store.overlayCount > 0;
  const displaceSource = !useOverlay && isDragging;
  let transform = null;
  if (activeIndex !== -1 && overIndex !== -1) {
    if (displaceSource) transform = s.transform;
    else {
      const strategy = strategyOverride ?? sctx.strategy;
      transform =
        strategy({ activeNodeRect: s.initialRect, activeIndex, overIndex, index, rects, id }) ?? null;
    }
  }
  let transition;
  if (transitionParam && !(displaceSource && !isKeyboardEvent(s.activatorEvent)))
    transition = CSS.Transition.toString({ ...transitionParam, property: 'transform' });
  const key = transform
    ? `${Math.round(transform.x)},${Math.round(transform.y)},${transform.scaleX},${transform.scaleY}|${transition}`
    : `n|${transition}`;
  return { transform, transition, activeIndex, overIndex, key };
}

/** 可排序項目（= useDraggable + useDroppable，再加上排序位移） */
export function useSortable({
  id,
  data,
  disabled,
  attributes,
  transition = defaultSortableTransition,
  strategy,
  animateLayoutChanges,
  getNewIndex,
  resizeObserverConfig,
} = {}) {
  void animateLayoutChanges;
  void getNewIndex;
  void resizeObserverConfig;
  const sctx = useContext(SortableCtx);
  const store = useStore();
  const { containerId, items } = sctx;
  const index = items.indexOf(id);
  const own = normalizeDisabled(disabled);
  const dis = {
    draggable: own.draggable || sctx.disabled.draggable,
    droppable: own.droppable || sctx.disabled.droppable,
  };
  const sortData = useMemo(
    () => ({ sortable: { containerId, index, items }, ...data }),
    [containerId, index, items, data],
  );
  const drop = useDroppable({ id, data: sortData, disabled: dis.droppable });
  const drag = useDraggable({ id, data: sortData, disabled: dis.draggable, attributes });

  useStoreSnapshot(store, () => computeSortable(store, sctx, id, index, strategy, transition).key);
  const res = computeSortable(store, sctx, id, index, strategy, transition);

  const setNodeRef = useCallback(
    (el) => {
      drop.setNodeRef(el);
      drag.setNodeRef(el);
    },
    [drop.setNodeRef, drag.setNodeRef],
  );

  const s = store.session;
  const overIndex = res.overIndex;
  return {
    active: drag.active,
    activeIndex: res.activeIndex,
    attributes: drag.attributes,
    data: sortData,
    rect: drop.rect,
    index,
    newIndex: index,
    items,
    isOver: drop.isOver,
    isSorting: !!s,
    isDragging: drag.isDragging,
    listeners: drag.listeners,
    node: drag.node,
    overIndex,
    over: drag.over,
    setNodeRef,
    setActivatorNodeRef: drag.setActivatorNodeRef,
    setDroppableNodeRef: drop.setNodeRef,
    setDraggableNodeRef: drag.setNodeRef,
    transform: res.transform,
    transition: res.transition,
  };
}

export function hasSortableData(entry) {
  const d = entry?.data?.current;
  return !!(d && typeof d === 'object' && 'sortable' in d && d.sortable && 'containerId' in d.sortable);
}

const keyboardDirections = [KeyboardCode.Down, KeyboardCode.Right, KeyboardCode.Up, KeyboardCode.Left];

/** sortable 的鍵盤座標：方向鍵移到該方向最近的項目（回該項目的左上角座標） */
export const sortableKeyboardCoordinates = (event, { context: { active, collisionRect, droppableRects, droppableContainers, over } }) => {
  if (!keyboardDirections.includes(event.code)) return undefined;
  event.preventDefault();
  if (!active || !collisionRect) return undefined;
  const filtered = [];
  for (const entry of droppableContainers.getEnabled()) {
    if (!entry || entry.disabled) continue;
    const rect = droppableRects.get(entry.id);
    if (!rect) continue;
    switch (event.code) {
      case KeyboardCode.Down:
        if (collisionRect.top < rect.top) filtered.push(entry);
        break;
      case KeyboardCode.Up:
        if (collisionRect.top > rect.top) filtered.push(entry);
        break;
      case KeyboardCode.Left:
        if (collisionRect.left > rect.left) filtered.push(entry);
        break;
      case KeyboardCode.Right:
        if (collisionRect.left < rect.left) filtered.push(entry);
        break;
    }
  }
  const collisions = closestCorners({
    active,
    collisionRect,
    droppableRects,
    droppableContainers: filtered,
    pointerCoordinates: null,
  });
  let closestId = getFirstCollision(collisions, 'id');
  if (closestId === over?.id && collisions.length > 1) closestId = collisions[1].id;
  if (closestId == null) return undefined;
  const activeDroppable = droppableContainers.get(active.id);
  const newDroppable = droppableContainers.get(closestId);
  const newRect = newDroppable ? droppableRects.get(newDroppable.id) : null;
  if (!newRect || !activeDroppable || !newDroppable) return undefined;
  const a = activeDroppable.data.current?.sortable;
  const b = newDroppable.data.current?.sortable;
  const sameContainer = hasSortableData(activeDroppable) && hasSortableData(newDroppable) && a.containerId === b.containerId;
  const isAfter = sameContainer && a.index < b.index;
  const offset = !sameContainer
    ? { x: 0, y: 0 }
    : {
        x: isAfter ? collisionRect.width - newRect.width : 0,
        y: isAfter ? collisionRect.height - newRect.height : 0,
      };
  const rectCoordinates = { x: newRect.left, y: newRect.top };
  return offset.x && offset.y ? rectCoordinates : sub(rectCoordinates, offset);
};
