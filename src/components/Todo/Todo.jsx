import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { TradeContext } from '../../context/TradeContext';
import { useTodos, CLOSED_DAYS } from '../../context/TodosContext';
import { notify } from '../common/Dialogs';
import { getAgentName, subscribeAgentName } from '../../utils/agentName';
import {
  groupTodos, isLapsing, describeTrigger, describeOrder, describeOrderTerms, statusLabel, plainPrice,
  whenText, dayHeading, snoozeTimes, toUtcIso, fromUtcIso,
} from '../../utils/todos';
import TodoForm from './TodoForm';
import styles from './Todo.module.css';

// The Todo page: one list of things to do, price alerts and pending orders,
// from the user and from the agent (EXTERNAL_API.md, "Todos"), in sections
// (utils/todos.js, groupTodos). It follows the account picker (TodosContext).
// Opening it marks the fired items as seen; the ones that were new stay
// marked "new" while the page is open.

const KIND_LABEL = { todo: 'Todo', trigger: 'Price alert', order: 'Order' };

function SnoozeMenu({ item, now, zone, onSnooze, onClose }) {
  const times = snoozeTimes(item, now, zone);
  const start = fromUtcIso(times.tomorrow, zone);
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const ref = useRef(null);
  useEffect(() => {
    const outside = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div className={styles.snoozeMenu} ref={ref} role="menu">
      <button type="button" role="menuitem" onClick={() => onSnooze(times.hour)}>In an hour <span>{whenText(times.hour, now, zone)}</span></button>
      <button type="button" role="menuitem" onClick={() => onSnooze(times.tomorrow)}>Tomorrow <span>{whenText(times.tomorrow, now, zone)}</span></button>
      <div className={styles.snoozePick}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Snooze until: date" />
        <input type="time" value={time} onChange={e => setTime(e.target.value)} aria-label="Snooze until: time" />
        <button type="button" onClick={() => { const iso = toUtcIso(date, time, zone); if (iso) onSnooze(iso); }} disabled={!date}>Set</button>
      </div>
    </div>
  );
}

function TodoRow({ item, isNew, agentName, now, zone, onEdit, onPatch, onOpenTrade, canOpenTrade, showAccount }) {
  const [snoozing, setSnoozing] = useState(false);
  const closed = ['done', 'dismissed', 'expired'].includes(item.status);
  const lapsing = isLapsing(item, now);
  const overdue = item.status === 'open' && item.due_at && Date.parse(item.due_at) <= now.getTime();
  const detail = item.kind === 'trigger' ? describeTrigger(item.trigger) : item.kind === 'order' ? describeOrder(item.order) : '';
  // A title made from the alert or order itself: no need to say it twice.
  const plainDetail = item.kind === 'trigger' ? describeTrigger(item.trigger, plainPrice) : item.kind === 'order' ? describeOrder(item.order, plainPrice) : '';
  const titleIsDetail = detail && (item.title === detail || item.title === plainDetail);
  const terms = item.kind === 'order' ? describeOrderTerms(item.order) : '';
  const sub = item.then || item.notes;

  const act = (body, message) => onPatch(item, body, message);
  const buttons = [];
  if (closed) {
    buttons.push({ label: 'Reopen', onClick: () => act({ status: 'open' }) });
  } else if (item.kind === 'order') {
    buttons.push({ label: 'Filled', primary: true, onClick: () => act({ status: 'done', closed_note: 'filled' }, 'Marked filled') });
    buttons.push({ label: 'Cancelled', onClick: () => act({ status: 'dismissed', closed_note: 'cancelled' }, 'Marked cancelled') });
  } else {
    buttons.push({ label: 'Done', primary: true, onClick: () => act({ status: 'done' }, 'Done') });
    buttons.push({ label: 'Dismiss', onClick: () => act({ status: 'dismissed' }, 'Dismissed') });
    if (item.kind === 'trigger' && item.status === 'fired') buttons.push({ label: 'Re-arm', onClick: () => act({ status: 'open' }, 'Watching again') });
  }
  const canSnooze = !closed && (item.due_at || item.kind === 'todo');

  return (
    <li className={`${styles.row} ${closed || lapsing ? styles.rowDim : ''} ${item.status === 'fired' ? styles.rowFired : ''} ${overdue ? styles.rowOverdue : ''}`}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitleLine}>
          {item.kind !== 'todo' && <span className={`${styles.kindChip} ${styles[`kind_${item.kind}`]}`}>{KIND_LABEL[item.kind]}</span>}
          <button type="button" className={styles.rowTitle} onClick={() => onEdit(item)} title="Edit">{item.title}</button>
          {isNew && item.status === 'fired' && <span className={styles.newChip}>new</span>}
          {(item.status !== 'open' || item.kind === 'order') && (
            <span className={`${styles.statusChip} ${styles[`status_${item.status}`]}`}>{statusLabel(item)}</span>
          )}
          {lapsing && <span className={styles.statusChip}>Past expiry</span>}
        </div>
        {detail && !titleIsDetail && <div className={styles.rowDetail}>{detail}</div>}
        {terms && <div className={styles.rowDetail}>{terms}</div>}
        {item.status === 'fired' && (
          <div className={styles.firedLine}>
            {item.fired_note || 'Fired'}
            {item.fired_at && <span className={styles.metaTime}> · {whenText(item.fired_at, now, zone)}</span>}
          </div>
        )}
        {sub && <div className={styles.rowSub}>{item.then ? <><span className={styles.thenMark}>Then</span> {item.then}</> : item.notes}</div>}
        {item.then && item.notes && <div className={styles.rowSub}>{item.notes}</div>}
        {closed && item.closed_note && <div className={styles.rowSub}>{item.closed_note}</div>}
        <div className={styles.meta}>
          <span className={`${styles.byChip} ${item.created_by === 'agent' ? styles.byAgent : ''}`}>{item.created_by === 'agent' ? agentName : 'you'}</span>
          {item.source && item.source !== 'app' && <span>{item.source}</span>}
          {item.due_at && (
            <span className={overdue ? styles.metaLate : ''}>
              {item.kind === 'todo' ? '' : 'remind '}{whenText(item.due_at, now, zone)}
              {item.alert ? '' : ' (no ping)'}
              {item.reminded_at && !closed ? ' · pinged' : ''}
            </span>
          )}
          {item.expires_at && !closed && <span>expires {whenText(item.expires_at, now, zone)}</span>}
          {closed && item.closed_at && <span>{statusLabel(item).toLowerCase()} {whenText(item.closed_at, now, zone)}</span>}
          {showAccount && item.account_name && <span>{item.account_name}</span>}
          {item.trade_id && (
            canOpenTrade
              ? <button type="button" className={styles.linkBtn} onClick={() => onOpenTrade(item.trade_id)}>{item.trade_symbol || 'trade'} trade</button>
              : <span title="The trade is in another account">{item.trade_symbol || 'trade'} trade</span>
          )}
        </div>
      </div>
      <div className={styles.rowActions}>
        {buttons.map(b => (
          <button key={b.label} type="button" className={`${styles.actBtn} ${b.primary ? styles.actPrimary : ''}`} onClick={b.onClick}>{b.label}</button>
        ))}
        {canSnooze && (
          <span className={styles.snoozeWrap}>
            <button type="button" className={styles.actBtn} onClick={() => setSnoozing(s => !s)} aria-expanded={snoozing}>
              {item.due_at ? 'Snooze' : 'Date'}
            </button>
            {snoozing && (
              <SnoozeMenu
                item={item}
                now={now}
                zone={zone}
                onClose={() => setSnoozing(false)}
                onSnooze={(iso) => { setSnoozing(false); act({ due_at: iso }, `Moved to ${whenText(iso, now, zone)}`); }}
              />
            )}
          </span>
        )}
        <button type="button" className={styles.actBtn} onClick={() => onEdit(item)}>Edit</button>
      </div>
    </li>
  );
}

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
  const { accounts, currentAccountId, scopedTrades } = useContext(TradeContext);
  const { scoped, loaded, zone, now, save, markSeen, loadOlderClosed } = useTodos();
  const [agentName, setAgentNameState] = useState(getAgentName);
  useEffect(() => subscribeAgentName(setAgentNameState), []);
  const [editing, setEditing] = useState(null);
  const [showClosed, setShowClosed] = useState(false);
  const [older, setOlder] = useState(null);

  // Fired items not seen yet: "new" for as long as the page is open, then
  // marked seen (the menu badge drops them).
  const [newIds, setNewIds] = useState(() => new Set());
  useEffect(() => {
    const unseen = scoped.filter(t => t.status === 'fired' && !t.seen_at).map(t => t.id);
    if (unseen.length === 0) return;
    setNewIds(ids => new Set([...ids, ...unseen]));
    markSeen(unseen);
  }, [scoped, markSeen]);

  const groups = useMemo(() => groupTodos(scoped, now, zone), [scoped, now, zone]);
  const currentAccount = (accounts || []).find(a => String(a.id) === String(currentAccountId));
  const hasSubAccounts = (accounts || []).some(a => String(a.parent_account_id) === String(currentAccountId));
  const tradesById = useMemo(() => new Map((scopedTrades || []).map(t => [String(t.id), t])), [scopedTrades]);

  const patch = async (item, body, message) => {
    try {
      await save(item.id, body);
      if (message) notify(`${message}: ${item.title}`, 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const openTrade = (tradeId) => {
    const trade = tradesById.get(String(tradeId));
    if (trade) onViewTrade(trade);
  };

  const rowProps = (item) => ({
    item,
    isNew: newIds.has(item.id),
    agentName,
    now,
    zone,
    onEdit: setEditing,
    onPatch: patch,
    onOpenTrade: openTrade,
    canOpenTrade: tradesById.has(String(item.trade_id)),
    showAccount: hasSubAccounts || item.kind !== 'order',
  });
  const list = (items) => <ul className={styles.list}>{items.map(item => <TodoRow key={item.id} {...rowProps(item)} />)}</ul>;

  const openCount = scoped.length - groups.closed.length;
  const upcomingCount = groups.upcoming.reduce((n, d) => n + d.items.length, 0);
  const ordersCount = groups.orders.reduce((n, g) => n + g.items.length, 0);

  const showOlder = async () => {
    try {
      setOlder(await loadOlderClosed());
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>Todo — {currentAccount?.name}</h2>
        <div className={styles.headerActions}>
          <button type="button" className={styles.addBtn} onClick={() => setEditing({ kind: 'todo' })}>+ Add</button>
        </div>
      </div>
      <p className={styles.subNote}>
        Things to do, price alerts and pending orders for this account{hasSubAccounts ? ' and its sub-accounts' : ''}, and the ones for all accounts.
        {' '}{agentName} watches the prices and the clock and pings you; the journal only keeps the list.
      </p>

      {loaded && openCount === 0 && (
        <div className={styles.empty}>
          <p>Nothing to do.</p>
          <div className={styles.emptyActions}>
            <button type="button" className={styles.actBtn} onClick={() => setEditing({ kind: 'todo' })}>Add a todo</button>
            <button type="button" className={styles.actBtn} onClick={() => setEditing({ kind: 'trigger' })}>Add a price alert</button>
            <button type="button" className={styles.actBtn} onClick={() => setEditing({ kind: 'order' })}>Add a pending order</button>
          </div>
        </div>
      )}

      {groups.needs.length > 0 && (
        <Section title="Needs you" count={groups.needs.length}>{list(groups.needs)}</Section>
      )}
      {groups.today.length > 0 && (
        <Section title="Today" count={groups.today.length}>{list(groups.today)}</Section>
      )}
      {groups.upcoming.length > 0 && (
        <Section title="Upcoming" count={upcomingCount}>
          {groups.upcoming.map(day => (
            <div key={day.day} className={styles.group}>
              <h4 className={styles.groupTitle}>{dayHeading(day.day, now, zone)}</h4>
              {list(day.items)}
            </div>
          ))}
        </Section>
      )}
      {groups.alerts.length > 0 && (
        <Section title="Price alerts" count={groups.alerts.length}>{list(groups.alerts)}</Section>
      )}
      {groups.orders.length > 0 && (
        <Section title="Pending orders" count={ordersCount}>
          {groups.orders.map(group => (
            <div key={String(group.accountId)} className={styles.group}>
              <h4 className={styles.groupTitle}>{group.accountName}</h4>
              {list(group.items)}
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
          {older === null ? (
            <button type="button" className={styles.linkBtn} onClick={showOlder}>Show older</button>
          ) : older.length > 0 ? list(older) : <p className={styles.emptyLine}>Nothing older.</p>}
        </Section>
      )}

      {editing && (
        <TodoForm
          item={editing.id ? editing : null}
          kind={editing.id ? undefined : editing.kind}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
