import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { TradeContext } from '../../context/TradeContext';
import { useTodos, CLOSED_DAYS } from '../../context/TodosContext';
import { notify } from '../common/Dialogs';
import { groupTodos } from '../../utils/todos';
import { useTodoRows } from './TodoRow';
import TodoCalendar from './TodoCalendar';
import styles from './Todo.module.css';

// The Todo page: one list of things to do, price alerts and pending orders,
// from the user and from the agent (EXTERNAL_API.md, "Todos"), in sections
// (utils/todos.js, groupTodos). It follows the account picker (TodosContext).
// Opening it marks the fired items as seen; the ones that were new stay
// marked "new" while the page is open. A calendar view (TodoCalendar) shows
// the same items by day.

const VIEW_KEY = 'jjournal_todo_view';

function Section({ title, count, hint, children, collapsible, open, onToggle }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        {collapsible ? (
          <button type="button" className={styles.sectionToggle} onClick={onToggle} aria-expanded={open}>
            <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true">›</span>
            {title}
          </button>
        ) : title}
        <span className={styles.count}>{count}</span>
        {hint && <span className={styles.sectionHint}>{hint}</span>}
      </h3>
      {(!collapsible || open) && children}
    </section>
  );
}

export default function Todo({ onViewTrade }) {
  const { accounts, currentAccountId } = useContext(TradeContext);
  const { scoped, loaded, zone, now, markSeen, loadOlderClosed } = useTodos();
  const [showClosed, setShowClosed] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [older, setOlder] = useState(null);
  // List or calendar, remembered in this browser.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list'; } catch { return 'list'; }
  });
  const chooseView = (next) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* not remembered */ }
  };

  // Fired items not seen yet: "new" for as long as the page is open, then
  // marked seen (the menu badge drops them).
  // Each once: if marking fails, the reload must not send it again and again.
  const [newIds, setNewIds] = useState(() => new Set());
  const sentSeen = useRef(new Set());
  useEffect(() => {
    const unseen = scoped.filter(t => t.status === 'fired' && !t.seen_at && !sentSeen.current.has(t.id)).map(t => t.id);
    if (unseen.length === 0) return;
    unseen.forEach(id => sentSeen.current.add(id));
    setNewIds(ids => new Set([...ids, ...unseen]));
    markSeen(unseen);
  }, [scoped, markSeen]);

  const { list, openForm, form } = useTodoRows({ onViewTrade, newIds });
  const groups = useMemo(() => groupTodos(scoped, now, zone), [scoped, now, zone]);
  const currentAccount = (accounts || []).find(a => String(a.id) === String(currentAccountId));
  const hasSubAccounts = (accounts || []).some(a => String(a.parent_account_id) === String(currentAccountId));

  const openCount = scoped.length - groups.closed.length;
  const noteShown = showInfo || (loaded && openCount === 0);
  const upcomingCount = groups.upcoming.reduce((n, d) => n + d.items.length, 0);
  const ordersCount = groups.orders.reduce((n, g) => n + g.items.length, 0);

  // "Show older" loads the closed items before those; while shown they
  // follow the list (a reopened one leaves, another account shows its own).
  const [olderOpen, setOlderOpen] = useState(false);
  useEffect(() => {
    if (!olderOpen) return undefined;
    let current = true;
    loadOlderClosed()
      .then(list => { if (current) setOlder(list); })
      .catch(err => { if (current) notify(err.message, 'error'); });
    return () => { current = false; };
  }, [olderOpen, scoped, loadOlderClosed]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.titleLine}>
          <h2 className={styles.title}>Todo — {currentAccount?.name}</h2>
          <button
            type="button"
            className={`${styles.infoBtn} ${showInfo ? styles.infoBtnOn : ''}`}
            onClick={() => setShowInfo(v => !v)}
            aria-expanded={showInfo}
            aria-label="What is this page?"
            title="What is this page?"
          >
            i
          </button>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.viewToggle} role="group" aria-label="View">
            {[['list', 'List'], ['calendar', 'Calendar']].map(([value, label]) => (
              <button key={value} type="button" aria-pressed={view === value} className={`${styles.viewBtn} ${view === value ? styles.viewBtnActive : ''}`} onClick={() => chooseView(value)}>{label}</button>
            ))}
          </div>
          <button type="button" className={styles.addBtn} onClick={() => openForm(null, { kind: 'todo' })}>+ Add</button>
        </div>
      </div>
      {noteShown && <p className={styles.subNote}>
        Things to do, price alerts and pending orders for this account{hasSubAccounts ? ' and its sub-accounts' : ''}, and the ones for all accounts.
        {' '}The journal only keeps the list: watching prices and sending alerts is the job of an external agent, which reads and updates it through the external API.
      </p>}

      {view === 'calendar' && (
        <TodoCalendar items={scoped} zone={zone} now={now} list={list} openForm={openForm} layoutKey={noteShown} />
      )}

      {view === 'list' && loaded && openCount === 0 && (
        <div className={styles.empty}>
          <p>Nothing to do.</p>
          <div className={styles.emptyActions}>
            <button type="button" className={styles.actBtn} onClick={() => openForm(null, { kind: 'todo' })}>Add a todo</button>
            <button type="button" className={styles.actBtn} onClick={() => openForm(null, { kind: 'trigger' })}>Add a price alert</button>
            <button type="button" className={styles.actBtn} onClick={() => openForm(null, { kind: 'order' })}>Add a pending order</button>
          </div>
        </div>
      )}

      {view === 'list' && (<>
      {groups.needs.length > 0 && (
        <Section title="Needs you" count={groups.needs.length}>{list(groups.needs)}</Section>
      )}
      {groups.today.length > 0 && (
        <Section title="Today" count={groups.today.length}>{list(groups.today)}</Section>
      )}
      {groups.upcoming.length > 0 && (
        <Section title="Upcoming" count={upcomingCount}>{list(groups.upcoming.flatMap(day => day.items))}</Section>
      )}
      {groups.alerts.length > 0 && (
        <Section title="Price alerts" count={groups.alerts.length}>{list(groups.alerts)}</Section>
      )}
      {groups.orders.length > 0 && (
        <Section title="Pending orders" count={ordersCount}>
          {groups.orders.map(group => (
            <div key={String(group.accountId)} className={styles.group}>
              {groups.orders.length > 1 && <h4 className={styles.groupTitle}>{group.accountName}</h4>}
              {list(group.items, groups.orders.length > 1 ? { showAccount: false } : undefined)}
            </div>
          ))}
        </Section>
      )}
      {groups.someday.length > 0 && (
        <Section title="Someday" count={groups.someday.length}>{list(groups.someday)}</Section>
      )}
      {(groups.closed.length > 0 || loaded) && (
        <Section
          title="Closed"
          count={groups.closed.length}
          hint={`last ${CLOSED_DAYS} days`}
          collapsible
          open={showClosed}
          onToggle={() => setShowClosed(o => !o)}
        >
          {groups.closed.length > 0 ? list(groups.closed) : <p className={styles.emptyLine}>Nothing closed in the last {CLOSED_DAYS} days.</p>}
          {!olderOpen ? (
            <button type="button" className={styles.linkBtn} onClick={() => setOlderOpen(true)}>Show older</button>
          ) : older === null ? null : older.length > 0 ? list(older) : <p className={styles.emptyLine}>Nothing older.</p>}
        </Section>
      )}
      </>)}

      {form}
    </div>
  );
}
