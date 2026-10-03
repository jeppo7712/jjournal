import React, { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import useDraggableWindow from '../../utils/useDraggableWindow';
import useScrollLock from '../../utils/useScrollLock';
import styles from './AppWindow.module.css';

// The app's standard window for forms opened from a page (Settings'
// account, symbol, exchange and rollover editors, ...), with the same look
// as the trade and note windows:
// - desktop: a centred card, movable by its title bar (double-click to
//   centre again; the position is remembered per `storageKey`);
// - phone: full screen, title bar on top and `footer` (the Save button)
//   pinned to the bottom, only the content in between scrolls.
// It's rendered into <body>, so nothing on the page (its scroll area, the
// phone's bottom bar) can cover it or scroll instead of it.
//
// `className` goes on the window, e.g. for a page's own colour tokens.
// Footer: pass `onSave` for the usual Cancel + Save pair (`saveLabel`,
// `busy` while saving, `leftActions` for e.g. a Delete button on the
// left), or a custom `footer`.

const PHONE = '(max-width: 600px)';

function useIsPhone() {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const onChange = () => setPhone(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return phone;
}

export function WindowButton({ variant = 'secondary', busy, disabled, children, ...rest }) {
  return (
    <button type="button" className={`${styles.btn} ${styles[variant] || ''}`} disabled={busy || disabled} {...rest}>
      {busy && <span className={styles.spinner} aria-hidden="true" />}
      {children}
    </button>
  );
}

export default function AppWindow({
  title, subtitle, onClose, storageKey, width = 640, className = '',
  onSave, saveLabel = 'Save', busy = false, leftActions, footer, children,
}) {
  const phone = useIsPhone();
  const drag = useDraggableWindow(storageKey, { enabled: !phone });
  const titleId = useId();
  useScrollLock();

  return createPortal(
    <div className={styles.overlay}>
      <div
        ref={drag.setWindowEl}
        className={`${styles.window} ${drag.dragging ? styles.dragging : ''} ${className}`}
        style={{ '--window-width': `${width}px`, ...(drag.windowStyle || {}) }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={styles.header} {...drag.dragHandleProps}>
          <div className={styles.titles}>
            <h2 id={titleId} className={styles.title}>{title}</h2>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close" title="Close">
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {(footer || onSave) && (
          <div className={styles.footer}>
            {footer || (
              <>
                {leftActions && <div className={styles.footerLeft}>{leftActions}</div>}
                <WindowButton onClick={onClose}>Cancel</WindowButton>
                <WindowButton variant="primary" onClick={onSave} busy={busy}>{saveLabel}</WindowButton>
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
