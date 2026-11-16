// Swipe-down-to-close for windows shown as cards on a phone: the decisions,
// kept apart from the touch wiring (useSheetDismiss.js) so they can be tested.

// Movement before a drag counts as one, so a tap with a wobble stays a tap.
export const DRAG_SLOP = 8;

// Where a touch may start a drag. Never from a text field or editor (that's
// for the cursor), a chart (its own drags) or anything marked
// [data-sheet-no-drag]. From the grip or title bar ([data-sheet-handle])
// always; from the content only while everything under the finger is
// scrolled to the top, or the swipe is the content's to scroll.
const NO_DRAG = 'input, textarea, [contenteditable=""], [contenteditable="true"], canvas, [data-sheet-no-drag]';

export function dragStart(target, sheet) {
  if (!target || !sheet || !sheet.contains(target)) return null;
  if (target.closest(NO_DRAG)) return null;
  const handle = target.closest('[data-sheet-handle]');
  if (handle && sheet.contains(handle)) return 'handle';
  for (let el = target; el && el !== sheet.parentElement; el = el.parentElement) {
    if (el.scrollTop > 0) return null;
  }
  return 'content';
}

// The first move decides whose swipe it is. From the content only a
// downward one is the card's (an upward one scrolls); sideways is never.
export function firstMoveIsDrag(mode, dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) return false;
  return mode === 'handle' || dy > 0;
}

// Let go: close when pulled down far enough, or flicked down.
// velocity in px/ms (positive = down).
export function shouldDismiss(offset, velocity, height) {
  if (offset <= 0) return false;
  if (offset > Math.min(160, height * 0.3)) return true;
  return velocity > 0.5 && offset > 30;
}
