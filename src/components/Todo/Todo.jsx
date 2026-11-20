import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
// Every section can be collapsed; which ones are is remembered in this
// browser. Closed starts collapsed, the others open.
const COLLAPSED_KEY = 'jjournal_todo_collapsed';
const DEFAULT_COLLAPSED = { closed: true };

function Section({ title, count, hint, children, open, onToggle }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        <button type="button" className={styles.sectionToggle} onClick={onToggle} aria-expanded={open}>
          <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true">›</span>
          {title}
        </button>
        <span className={styles.count}>{count}</span>
        {hint && <span className={styles.sectionHint}>{hint}</span>}
      </h3>
      {open && children}
    </section>
  );
}

export default function Todo({ onViewTrade }) {
  const { accounts, currentAccountId } = useContext(TradeContext);
  const { scoped, loaded, loadFailed, refresh, zone, now, markSeen, loadOlderClosed } = useTodos();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY));
      return saved && typeof saved === 'object' ? { ...DEFAULT_COLLAPSED, ...saved } : DEFAULT_COLLAPSED;
    } catch { return DEFAULT_COLLAPSED; }
  });
  const setSectionOpen = useCallback((key, open) => setCollapsed(prev => {
    if (!prev[key] === open) return prev;
    const next = { ...prev, [key]: !open };
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* not remembered */ }
    return next;
  }), []);
  const sectionProps = key => ({ open: !collapsed[key], onToggle: () => setSectionOpen(key, !!collapsed[key]) });
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
  // Each firing once: if marking fails, the reload must not send it again
  // and again; one that fires again while the page is open is sent again.
  const [newIds, setNewIds] = useState(() => new Set());
  const sentSeen = useRef(new Set());
  useEffect(() => {
    const firing = t => `${t.id}|${t.fired_at}`;
    const fresh = scoped.filter(t => t.status === 'fired' && !t.seen_at && !sentSeen.current.has(firing(t)));
    if (fresh.length === 0) return;
    fresh.forEach(t => sentSeen.current.add(firing(t)));
    const unseen = fresh.map(t => t.id);
    setNewIds(ids => new Set([...ids, ...unseen]));
    markSeen(unseen);
    // A new firing is never hidden in a collapsed "Needs you".
    setSectionOpen('needs', true);
  }, [scoped, markSeen, setSectionOpen]);

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

      {/* Only before anything loaded: a later failed refresh (a phone waking
          up) keeps the last list, which is what it shows. */}
      {loadFailed && !loaded && (
        <p className={styles.loadError} role="alert">
          The list could not be loaded.
          {' '}<button type="button" className={styles.linkBtn} onClick={refresh}>Try again</button>
        </p>
      )}

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
        <Section title="Needs you" count={groups.needs.length} {...sectionProps('needs')}>{list(groups.needs)}</Section>
      )}
      {groups.today.length > 0 && (
        <Section title="Today" count={groups.today.length} {...sectionProps('today')}>{list(groups.today)}</Section>
      )}
      {groups.upcoming.length > 0 && (
        <Section title="Upcoming" count={upcomingCount} {...sectionProps('upcoming')}>{list(groups.upcoming.flatMap(day => day.items))}</Section>
      )}
      {groups.alerts.length > 0 && (
        <Section title="Price alerts" count={groups.alerts.length} {...sectionProps('alerts')}>{list(groups.alerts)}</Section>
      )}
      {groups.orders.length > 0 && (
        <Section title="Pending orders" count={ordersCount} {...sectionProps('orders')}>
          {groups.orders.map(group => (
            <div key={String(group.accountId)} className={styles.group}>
              {groups.orders.length > 1 && <h4 className={styles.groupTitle}>{group.accountName}</h4>}
              {list(group.items, groups.orders.length > 1 ? { showAccount: false } : undefined)}
            </div>
          ))}
        </Section>
      )}
      {groups.someday.length > 0 && (
        <Section title="Someday" count={groups.someday.length} {...sectionProps('someday')}>{list(groups.someday)}</Section>
      )}
      {(groups.closed.length > 0 || loaded) && (
        <Section
          title="Closed"
          count={groups.closed.length}
          hint={`last ${CLOSED_DAYS} days`}
          {...sectionProps('closed')}
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
