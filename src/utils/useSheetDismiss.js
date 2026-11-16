import { useEffect, useRef } from 'react';
import { DRAG_SLOP, dragStart, firstMoveIsDrag, shouldDismiss } from './sheetGesture';

// Phones: a window shown as a card from the bottom follows the finger down
// and closes when let go far enough down (or flicked). The X stays for
// everyone without a touch screen. See sheetGesture.js for where a drag may
// start.
//
// `sheetRef` is the card; its parent (the dimmed backdrop) fades as it goes,
// unless `fade` is false (a card without a backdrop of its own).
// `onRequestClose` is what the X does: it may ask about unsaved changes
// first. If the window is still open shortly after (it asked), the card
// slides back up under the question.
//
// Touch events, not pointer events: the content's own scrolling has to be
// stopped (preventDefault on a non-passive touchmove) once a downward swipe
// at its top belongs to the card.

const OUT_MS = 200;
const BACK = 'transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)';

export default function useSheetDismiss(sheetRef, { enabled, onRequestClose, fade = true }) {
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!enabled || !sheet) return undefined;
    let g = null; // the touch being followed
    let timers = [];

    const backdrop = () => (fade ? sheet.parentElement : null);
    const place = (y) => { sheet.style.transform = y > 0 ? `translate3d(0, ${y}px, 0)` : ''; };
    const slideBack = () => {
      sheet.style.transition = BACK;
      place(0);
      const bd = backdrop();
      if (bd) { bd.style.transition = 'opacity 0.2s'; bd.style.opacity = ''; }
    };
    const dismiss = () => {
      sheet.style.transition = `transform ${OUT_MS}ms ease-in`;
      place(sheet.offsetHeight + 24);
      const bd = backdrop();
      if (bd) { bd.style.transition = `opacity ${OUT_MS}ms ease-in`; bd.style.opacity = '0'; }
      timers.push(setTimeout(() => {
        if (closeRef.current) closeRef.current();
        // Still open: it asked first (unsaved changes) — show the window again.
        timers.push(setTimeout(() => { if (mounted.current && sheet.isConnected) slideBack(); }, 150));
      }, OUT_MS));
    };

    const onStart = (e) => {
      g = null;
      if (e.touches.length !== 1) return;
      const mode = dragStart(e.target, sheet);
      if (!mode) return;
      const t = e.touches[0];
      g = { mode, x0: t.clientX, y0: t.clientY, phase: 'first', offset: 0, samples: [] };
    };

    const onMove = (e) => {
      if (!g) return;
      if (e.touches.length !== 1) { if (g.phase === 'drag') slideBack(); g = null; return; }
      const t = e.touches[0];
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      if (g.phase === 'first') {
        if (dx === 0 && dy === 0) return;
        if (!firstMoveIsDrag(g.mode, dx, dy)) { g = null; return; }
        g.phase = 'pending';
      }
      if (e.cancelable) e.preventDefault();
      if (g.phase === 'pending') {
        if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
        if (Math.abs(dx) > Math.abs(dy)) { g = null; return; }
        g.phase = 'drag';
        g.y0 = t.clientY; // follow from here, without a jump
        sheet.style.transition = 'none';
      }
      g.offset = Math.max(0, t.clientY - g.y0);
      place(g.offset);
      const now = e.timeStamp;
      g.samples.push({ y: t.clientY, t: now });
      while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift();
    };

    const onEnd = (e) => {
      if (!g) return;
      const done = g;
      g = null;
      if (done.phase !== 'drag') return;
      // No click on whatever the finger was on.
      if (e.cancelable) e.preventDefault();
      const s = done.samples;
      const first = s[0];
      const last = s[s.length - 1];
      const velocity = first && last && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
      if (e.type === 'touchend' && shouldDismiss(done.offset, velocity, sheet.offsetHeight)) dismiss();
      else slideBack();
    };

    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd, { passive: false });
    sheet.addEventListener('touchcancel', onEnd, { passive: false });
    return () => {
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onEnd);
      sheet.removeEventListener('touchcancel', onEnd);
      timers.forEach(clearTimeout);
      timers = [];
    };
  }, [enabled, fade, sheetRef]);
}
