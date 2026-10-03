import { useEffect } from 'react';

// While a window is open the page behind it must not scroll: on a phone a
// swipe that reaches the end of the window's content otherwise carries on
// into the page underneath. Counted, so nested windows (a confirm dialog
// over a settings window) only unlock when the last one closes.
// The class is styled in src/styles.css.

let openCount = 0;

export default function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) return undefined;
    openCount += 1;
    document.documentElement.classList.add('jj-window-open');
    return () => {
      openCount -= 1;
      if (openCount <= 0) {
        openCount = 0;
        document.documentElement.classList.remove('jj-window-open');
      }
    };
  }, [active]);
}
