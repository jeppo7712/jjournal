import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Makes a centred modal window movable by dragging its title bar (desktop
// only; on phones the windows are full screen). Double-clicking the title
// bar puts it back in the middle. The offset is remembered per window
// (`storageKey`), so a window reopens where it was left, and it's kept on
// screen: the title bar can never be dragged out of reach.
//
// Usage: spread `dragHandleProps` on the title bar, give the window
// `ref={setWindowEl}` and `style={windowStyle}`.

const KEEP_VISIBLE_PX = 120; // of the window's width, at either side
const HEADER_PX = 56; // of its height, at the bottom

const NO_DRAG = 'button, input, select, textarea, a, label, [contenteditable="true"], [data-no-drag]';

function loadOffset(key) {
  try {
    const value = JSON.parse(localStorage.getItem(`jj.window.${key}`));
    if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) return value;
  } catch { /* storage unavailable or bad value */ }
  return { x: 0, y: 0 };
}

function saveOffset(key, offset) {
  try { localStorage.setItem(`jj.window.${key}`, JSON.stringify(offset)); } catch { /* storage unavailable */ }
}

export default function useDraggableWindow(storageKey, { enabled = true } = {}) {
  const [offset, setOffset] = useState(() => (enabled ? loadOffset(storageKey) : { x: 0, y: 0 }));
  const [dragging, setDragging] = useState(false);
  const windowEl = useRef(null);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const dragStart = useRef(null);

  // Keeps an offset within the screen, given where the window would sit
  // without one (its layout position).
  const clamp = useCallback((next) => {
    const el = windowEl.current;
    if (!el) return next;
    const rect = el.getBoundingClientRect();
    const baseLeft = rect.left - offsetRef.current.x;
    const baseTop = rect.top - offsetRef.current.y;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minX = -(baseLeft + rect.width - KEEP_VISIBLE_PX);
    const maxX = vw - KEEP_VISIBLE_PX - baseLeft;
    const minY = -baseTop;
    const maxY = vh - HEADER_PX - baseTop;
    return {
      x: Math.round(Math.min(maxX, Math.max(minX, next.x))),
      y: Math.round(Math.min(maxY, Math.max(minY, next.y))),
    };
  }, []);

  // A remembered offset from a bigger screen: pull it back on screen.
  useLayoutEffect(() => {
    if (!enabled) return;
    setOffset(prev => clamp(prev));
  }, [enabled, clamp]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onResize = () => setOffset(prev => clamp(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [enabled, clamp]);

  const onPointerDown = useCallback((e) => {
    if (!enabled || e.button !== 0 || e.target.closest(NO_DRAG)) return;
    e.preventDefault();
    dragStart.current = { px: e.clientX, py: e.clientY, x: offsetRef.current.x, y: offsetRef.current.y };
    setDragging(true);
    const onMove = (ev) => {
      const start = dragStart.current;
      if (!start) return;
      setOffset(clamp({ x: start.x + ev.clientX - start.px, y: start.y + ev.clientY - start.py }));
    };
    const onUp = () => {
      dragStart.current = null;
      setDragging(false);
      saveOffset(storageKey, offsetRef.current);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [enabled, clamp, storageKey]);

  const onDoubleClick = useCallback((e) => {
    if (!enabled || e.target.closest(NO_DRAG)) return;
    setOffset({ x: 0, y: 0 });
    saveOffset(storageKey, { x: 0, y: 0 });
  }, [enabled, storageKey]);

  const setWindowEl = useCallback((el) => { windowEl.current = el; }, []);

  return {
    setWindowEl,
    dragging,
    windowStyle: enabled && (offset.x || offset.y)
      ? { transform: `translate(${offset.x}px, ${offset.y}px)` }
      : undefined,
    dragHandleProps: enabled
      ? {
          onPointerDown,
          onDoubleClick,
          style: { cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' },
          title: 'Drag to move · double-click to centre',
        }
      : {},
  };
}
