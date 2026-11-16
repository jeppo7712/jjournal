import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { APP_VERSION, builtLabel, QUOTES, nextQuoteIndex } from '../../utils/appVersion';
import styles from './Navigation.module.css';

const versionText = () => (APP_VERSION ? `Version ${APP_VERSION}` : 'Version unknown');

// The version line at the bottom of the tablet/phone logo popup (which is
// about the account). Just the line: no room for more there.
export function AboutLine() {
  const built = builtLabel();
  return (
    <div className={styles.aboutCompact}>
      {versionText()}
      {built && <span className={styles.aboutBuilt}> · built {built}</span>}
    </div>
  );
}

// What the logo opens on the wide sidebar: a small window in the middle of
// the screen with the version, the build and a trading quote that changes
// with every click. Closes on Escape, the ×, or a click beside it.
export default function AboutCard({ onClose }) {
  const [quote, setQuote] = useState(() => nextQuoteIndex(-1));
  const q = QUOTES[quote];
  const built = builtLabel();

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className={styles.aboutOverlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.aboutCard} role="dialog" aria-modal="true" aria-label="About Jay's Journal">
        <button type="button" className={styles.aboutClose} onClick={onClose} aria-label="Close" title="Close">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <img src="/logo192.png" alt="" className={styles.aboutLogo} />
        <div className={styles.aboutName}>Jay's Journal</div>
        <div className={styles.aboutVersion}>{versionText()}</div>
        {built && <div className={styles.aboutBuilt}>Built {built}</div>}
        <button
          type="button"
          className={styles.aboutQuote}
          onClick={() => setQuote(i => nextQuoteIndex(i))}
          title="Another one"
        >
          <span key={quote} className={styles.aboutQuoteText}>
            “{q.text}”
            <span className={styles.aboutQuoteBy}>— {q.by}</span>
          </span>
        </button>
      </div>
    </div>,
    document.body
  );
}
