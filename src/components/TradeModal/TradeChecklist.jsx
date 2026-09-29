import React from 'react';
import styles from './TradeChecklist.module.css';

// The account's Entry/Exit checklist as tick boxes in a trade's Journal tab
// (the lists themselves are set in Settings → Checklists).
//
// `value` is what this trade saved: { entry: [{label, checked}], exit: [...],
// removed }, or null when nothing was ticked yet. While it's null the
// account's current lists are shown, all unticked; the first tick saves a
// copy with the labels as they are now, so later edits to the account's
// lists don't change this trade.
export function checklistFromTemplate(template) {
  const toItems = list => (list || []).map(label => ({ label, checked: false }));
  return { entry: toItems(template?.entry), exit: toItems(template?.exit), removed: false };
}

const SECTIONS = [['entry', 'Entry'], ['exit', 'Exit']];

function TradeChecklist({ template, value, onChange, readOnly = false }) {
  const hasTemplate = (template?.entry?.length || 0) + (template?.exit?.length || 0) > 0;
  const checklist = value || (hasTemplate ? checklistFromTemplate(template) : null);

  if (!checklist) {
    if (readOnly) return null;
    return <p className={styles.hint}>No checklist for this account yet — add one under Settings → Checklists.</p>;
  }

  if (checklist.removed) {
    if (readOnly) return null;
    return (
      <p className={styles.hint}>
        Checklist removed for this trade.{' '}
        <button type="button" className={styles.linkBtn} onClick={() => onChange({ ...checklist, removed: false })}>
          Show it again
        </button>
      </p>
    );
  }

  const toggle = (key, index) => {
    const next = { ...checklist, [key]: checklist[key].map((item, i) => (i === index ? { ...item, checked: !item.checked } : item)) };
    onChange(next);
  };

  const done = [...checklist.entry, ...checklist.exit].filter(i => i.checked).length;
  const total = checklist.entry.length + checklist.exit.length;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>Checklist <span className={styles.count}>{done}/{total}</span></span>
        {!readOnly && (
          <button
            type="button"
            className={styles.linkBtn}
            title="Hide the checklist for this trade only; the lists in Settings stay as they are"
            onClick={() => onChange({ ...checklist, removed: true })}
          >
            Remove from this trade
          </button>
        )}
      </div>
      <div className={styles.columns}>
        {SECTIONS.map(([key, title]) => checklist[key].length > 0 && (
          <div key={key} className={styles.column}>
            <div className={styles.columnTitle}>{title}</div>
            {checklist[key].map((item, i) => (
              readOnly ? (
                <div key={i} className={`${styles.item} ${item.checked ? styles.checked : styles.unchecked}`}>
                  <span className={styles.mark}>{item.checked ? '✓' : '✗'}</span>{item.label}
                </div>
              ) : (
                <label key={i} className={styles.item}>
                  <input type="checkbox" checked={item.checked} onChange={() => toggle(key, i)} />
                  <span>{item.label}</span>
                </label>
              )
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default TradeChecklist;
