import React from 'react';
import styles from './TagChip.module.css';

// One tag as a small pill in its group's colour (tags outside a group are
// violet). `state`: 'on' (picked), 'off' (pickable), 'include' / 'exclude'
// (the Dashboard filter) or undefined for plain display.
export const UNGROUPED_COLOR = '#8B5CF6';

function TagChip({ name, color, state, onClick, title, small = false, prefix }) {
  const c = color || UNGROUPED_COLOR;
  const className = [
    styles.chip,
    small ? styles.small : '',
    onClick ? styles.clickable : '',
    state ? styles[state] : '',
  ].join(' ');
  const content = (
    <>
      {state === 'exclude' && <span className={styles.mark} aria-hidden="true">−</span>}
      {prefix}{name}
    </>
  );
  return onClick ? (
    <button type="button" className={className} style={{ '--tag-color': c }} onClick={onClick} title={title} aria-pressed={state === 'on' || state === 'include' || undefined}>
      {content}
    </button>
  ) : (
    <span className={className} style={{ '--tag-color': c }} title={title}>{content}</span>
  );
}

export default TagChip;
