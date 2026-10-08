import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';

/** Offsets of a floating element from the viewport's right and bottom edges, in px. */
export interface FloatPos {
  right: number;
  bottom: number;
}

const KEY = 'lds.adminChatPos';
const HIDDEN_KEY = 'lds.adminChatHidden';
export const ASSISTANT_RESET_EVENT = 'lds-assistant-reset';
const MOVE_THRESHOLD = 6;

export function clampPos(p: FloatPos, size: { w: number; h: number }, view: { w: number; h: number }, margin = 4): FloatPos {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, margin), Math.max(margin, max - margin));
  return { right: clamp(p.right, view.w - size.w), bottom: clamp(p.bottom, view.h - size.h) };
}

function load(): FloatPos | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<FloatPos> | null;
    return v && Number.isFinite(v.right) && Number.isFinite(v.bottom) ? { right: v.right!, bottom: v.bottom! } : null;
  } catch {
    return null;
  }
}
function save(p: FloatPos | null): void {
  try {
    if (p) window.localStorage.setItem(KEY, JSON.stringify(p));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* not persisted */
  }
}

/** Settings → "Reset position": back to the default corner, and visible again. Safe to call from anywhere. */
export function resetAssistant(): void {
  save(null);
  try {
    window.localStorage.removeItem(HIDDEN_KEY);
  } catch {
    /* not persisted */
  }
  window.dispatchEvent(new Event(ASSISTANT_RESET_EVENT));
}

/**
 * Makes an element draggable with mouse, touch or pen (Pointer Events). A tap/click that moved less than a few px is
 * still a click; a real drag swallows the click that follows it. The position is remembered per browser and re-clamped
 * when the window changes size. `pos === null` means "use the stylesheet default".
 */
export function useFloatDrag() {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<FloatPos | null>(() => load());
  const drag = useRef<{ x: number; y: number; id: number; start: FloatPos; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const metrics = () => {
    const el = ref.current;
    return {
      size: { w: el?.offsetWidth ?? 0, h: el?.offsetHeight ?? 0 },
      view: { w: window.innerWidth, h: window.innerHeight },
    };
  };

  const onPointerDown = useCallback((e: RPointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
      start: { right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom },
      moved: false,
    };
  }, []);

  const onPointerMove = useCallback((e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
    if (!d.moved) {
      // Capture only once it is really a drag — capturing on press would retarget the click away from the button.
      ref.current?.setPointerCapture?.(d.id);
    }
    d.moved = true;
    const { size, view } = metrics();
    setPos(clampPos({ right: d.start.right - dx, bottom: d.start.bottom - dy }, size, view));
  }, []);

  const end = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      setPos((p) => {
        save(p);
        return p;
      });
    }
  }, []);

  useEffect(() => {
    const onResize = () => {
      setPos((p) => {
        if (!p) return p;
        const { size, view } = metrics();
        const next = clampPos(p, size, view);
        return next.right === p.right && next.bottom === p.bottom ? p : next;
      });
    };
    const onReset = () => setPos(null);
    window.addEventListener('resize', onResize);
    window.addEventListener(ASSISTANT_RESET_EVENT, onReset);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener(ASSISTANT_RESET_EVENT, onReset);
    };
  }, []);

  /** Put it back to the default corner. */
  const reset = useCallback(() => {
    setPos(null);
    save(null);
  }, []);

  return {
    ref,
    pos,
    reset,
    /** Spread on the wrapper element. `touchAction: 'none'` keeps a touch drag from scrolling the page. */
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
    /** Call from the inner button's onClick: true when the click was really the end of a drag. */
    wasDrag: () => suppressClick.current,
  };
}

export interface EdgeTab {
  side: 'left' | 'right';
  /** Offset of the tab's bottom from the viewport bottom, px. */
  bottom: number;
}

export const EDGE_TAB_HEIGHT = 52;

/** Where the "show the assistant" tab goes: the screen edge nearest the bubble, centred on its height. */
export function edgeTabFor(rect: { left: number; right: number; top: number; bottom: number }, view: { w: number; h: number }): EdgeTab {
  const side = (rect.left + rect.right) / 2 < view.w / 2 ? 'left' : 'right';
  const centreFromBottom = view.h - (rect.top + rect.bottom) / 2;
  const bottom = Math.min(Math.max(centreFromBottom - EDGE_TAB_HEIGHT / 2, 8), Math.max(8, view.h - EDGE_TAB_HEIGHT - 8));
  return { side, bottom: Math.round(bottom) };
}

/** The remembered tab placement while hidden, or null when the assistant is shown. Old values ('1') mean right edge, default height. */
export function readEdgeTab(): EdgeTab | null {
  try {
    const raw = window.localStorage.getItem(HIDDEN_KEY);
    if (!raw) return null;
    if (raw === '1') return { side: 'right', bottom: 24 };
    const v = JSON.parse(raw) as Partial<EdgeTab>;
    return (v.side === 'left' || v.side === 'right') && Number.isFinite(v.bottom) ? { side: v.side, bottom: v.bottom! } : { side: 'right', bottom: 24 };
  } catch {
    return null;
  }
}

export function writeEdgeTab(t: EdgeTab | null): void {
  try {
    if (t) window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(t));
    else window.localStorage.removeItem(HIDDEN_KEY);
  } catch {
    /* not persisted */
  }
}
