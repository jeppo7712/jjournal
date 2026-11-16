import React, { useState } from 'react';
import { APP_VERSION, builtLabel, QUOTES, nextQuoteIndex } from '../../utils/appVersion';
import styles from './Navigation.module.css';

// What the logo opens: the journal's version and build, and a trading quote
// that changes with every tap. `compact` is the strip at the bottom of the
// tablet/phone logo popup (which is about the account).
export default function AboutCard({ compact = false }) {
  const [quote, setQuote] = useState(() => nextQuoteIndex(-1));
  const q = QUOTES[quote];
  const built = builtLabel();

  return (
    <div className={compact ? styles.aboutCompact : styles.aboutCard} onClick={e => e.stopPropagation()}>
      <div className={styles.aboutHead}>
        {!compact && <img src="/logo192.png" alt="" className={styles.aboutLogo} />}
        <div>
          <div className={styles.aboutName}>Jay's Journal</div>
          <div className={styles.aboutVersion}>
            {APP_VERSION ? `Version ${APP_VERSION}` : 'Version unknown'}
            {built && <><span className={styles.aboutSep}> · </span><span className={styles.aboutBuilt}>built {built}</span></>}
          </div>
        </div>
      </div>
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
  );
}
