import React, { useMemo } from 'react';
import { useTodos } from '../../context/TodosContext';
import { todaySummary, whenText } from '../../utils/todos';
import styles from './TodayTodos.module.css';

// The Todo list's "Today" on the Dashboard (utils/todos.js, todaySummary):
// what's overdue or due today, alerts that fired and weren't seen yet, and
// how many orders are working and alerts armed — with the first few items
// by name. Tapping it opens the Todo page. Not shown when it's all zero.

const MAX_SHOWN = 3;

export default function TodayTodos({ onOpen }) {
  const { scoped, zone, now } = useTodos();
  const s = useMemo(() => todaySummary(scoped, now, zone), [scoped, now, zone]);
  if (!s.overdue && !s.dueToday && !s.fired && !s.orders && !s.alerts) return null;

  const parts = [
    s.fired > 0 && { text: `${s.fired} fired`, tone: styles.fired },
    s.overdue > 0 && { text: `${s.overdue} overdue`, tone: styles.late },
    s.dueToday > 0 && { text: `${s.dueToday} due today` },
    s.orders > 0 && { text: `${s.orders} working order${s.orders > 1 ? 's' : ''}`, quiet: true },
    s.alerts > 0 && { text: `${s.alerts} armed alert${s.alerts > 1 ? 's' : ''}`, quiet: true },
  ].filter(Boolean);

  return (
    <button type="button" className={styles.panel} onClick={onOpen} title="Open the Todo list">
      <span className={styles.head}>Today</span>
      <span className={styles.counts}>
        {parts.map((p, i) => (
          <span key={p.text} className={`${p.tone || ''} ${p.quiet ? styles.quiet : ''}`}>{i > 0 ? ' · ' : ''}{p.text}</span>
        ))}
      </span>
      {s.top.length > 0 && (
        <span className={styles.items}>
          {s.top.slice(0, MAX_SHOWN).map(item => (
            <span key={item.id} className={styles.item}>
              <span className={styles.title}>{item.title}</span>
              <span className={styles.when}>
                {item.status === 'fired' ? `fired ${whenText(item.fired_at, now, zone)}` : whenText(item.due_at, now, zone)}
              </span>
            </span>
          ))}
          {s.top.length > MAX_SHOWN && <span className={styles.more}>+{s.top.length - MAX_SHOWN} more</span>}
        </span>
      )}
    </button>
  );
}
