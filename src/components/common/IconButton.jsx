import React from 'react';
import styles from './IconButton.module.css';

// Round icon buttons for footers (trade form, trade view, day note, the
// Settings forms) and, in the small size, table rows, instead of rows of
// text buttons. The label is the tooltip on desktop and what screen readers
// announce; `caption` adds a tiny word under the icon.
//
// Each action has one colour everywhere (ACTION_COLORS), so e.g. Chart isn't
// green in one window and yellow in another. Import them for text buttons
// doing the same kind of thing.
const PATHS = {
  chart: <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />,
  trash: <path fillRule="evenodd" clipRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" />,
  check: <path fillRule="evenodd" clipRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" />,
  pencil: <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />,
  move: <path d="M8 5a1 1 0 100 2h5.586l-1.293 1.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L13.586 5H8zM12 15a1 1 0 100-2H6.414l1.293-1.293a1 1 0 10-1.414-1.414l-3 3a1 1 0 000 1.414l3 3a1 1 0 001.414-1.414L6.414 15H12z" />,
  cloudDownload: <path fillRule="evenodd" clipRule="evenodd" d="M2 9.5A3.5 3.5 0 005.5 13H9v2.586l-1.293-1.293a1 1 0 00-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 15.586V13h2.5a4.5 4.5 0 10-.616-8.958 4.002 4.002 0 10-7.753 1.977A3.5 3.5 0 002 9.5zm9 3.5H9V8a1 1 0 012 0v5z" />,
  desktop: <path fillRule="evenodd" clipRule="evenodd" d="M3 5a2 2 0 012-2h10a2 2 0 012 2v8a2 2 0 01-2 2h-2.22l.123.489.804.804A1 1 0 0113 18H7a1 1 0 01-.707-1.707l.804-.804L7.22 15H5a2 2 0 01-2-2V5zm5.771 7H5V5h10v7H8.771z" />,
};

export const ACTION_COLORS = {
  primary: '#3B82F6', // save, edit: the main action
  danger: '#EF4444', // delete
  chart: '#F59E0B',
  import: '#6366F1', // fetching data: Flex, TWS, historical data
  neutral: '#6B7280', // move and other secondary actions
};

const ICON_COLORS = {
  check: ACTION_COLORS.primary,
  pencil: ACTION_COLORS.primary,
  trash: ACTION_COLORS.danger,
  chart: ACTION_COLORS.chart,
  cloudDownload: ACTION_COLORS.import,
  desktop: ACTION_COLORS.import,
  move: ACTION_COLORS.neutral,
};

function IconButton({ icon, label, onClick, disabled = false, busy = false, caption, size = 'normal', className = '', ...rest }) {
  return (
    <button
      type="button"
      className={`${styles.iconButton} ${size === 'small' ? styles.small : ''} ${className}`}
      style={{ '--btn-color': ICON_COLORS[icon] || ACTION_COLORS.primary }}
      onClick={onClick}
      disabled={disabled || busy}
      title={label}
      aria-label={label}
      aria-busy={busy || undefined}
      {...rest}
    >
      <span className={styles.circle}>
        {busy
          ? <span className={styles.spinner} aria-hidden="true" />
          : <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">{PATHS[icon]}</svg>}
      </span>
      {caption && <span className={styles.caption}>{caption}</span>}
    </button>
  );
}

export default IconButton;
