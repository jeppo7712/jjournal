import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { TradeContext } from '../../context/TradeContext';
import { useTodos } from '../../context/TodosContext';
import { notify } from '../common/Dialogs';
import { getAgentName, subscribeAgentName } from '../../utils/agentName';
import {
  isLapsing, describeTrigger, describeOrder, describeOrderTerms, statusLabel, plainPrice,
  whenText, snoozeTimes, toUtcIso, fromUtcIso,
} from '../../utils/todos';
import TodoForm from './TodoForm';
import styles from './Todo.module.css';

// One item of the Todo list as a row (the Todo page, its calendar's day
// window, the trade view), and useTodoRows(), which gives a row everything
// it needs: the agent's name, the actions (saved through TodosContext, with
// a toast), opening the item's trade, and the add/edit form.

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

export function TodoRow({ item, isNew, agentName, now, zone, onEdit, onPatch, onOpenTrade, canOpenTrade, showAccount, showTrade = true }) {
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
          {showTrade && item.trade_id && (
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

// rowProps(item) for a TodoRow; list(items) renders them; openForm(item)
// edits an item, openForm(null, { kind, trade_id, dueDate }) adds one;
// `form` is the open form (render it).
//   onViewTrade(trade)  opens a linked trade (not given: no trade link)
//   newIds              fired items to mark "new"
//   rowOptions          extra TodoRow props (e.g. showTrade: false)
export function useTodoRows({ onViewTrade, newIds, rowOptions } = {}) {
  const { accounts, currentAccountId, scopedTrades } = useContext(TradeContext);
  const { zone, now, save } = useTodos();
  const [agentName, setAgentNameState] = useState(getAgentName);
  useEffect(() => subscribeAgentName(setAgentNameState), []);
  const [editing, setEditing] = useState(null);
  const hasSubAccounts = (accounts || []).some(a => String(a.parent_account_id) === String(currentAccountId));
  const tradesById = useMemo(() => new Map((scopedTrades || []).map(t => [String(t.id), t])), [scopedTrades]);

  const patch = useCallback(async (item, body, message) => {
    try {
      await save(item.id, body);
      if (message) notify(`${message}: ${item.title}`, 'success');
    } catch (err) {
      notify(err.message, 'error');
    }
  }, [save]);

  const openTrade = (tradeId) => {
    const trade = tradesById.get(String(tradeId));
    if (trade && onViewTrade) onViewTrade(trade);
  };

  const rowProps = (item) => ({
    item,
    isNew: !!newIds && newIds.has(item.id),
    agentName,
    now,
    zone,
    onEdit: (i) => setEditing({ item: i }),
    onPatch: patch,
    onOpenTrade: openTrade,
    canOpenTrade: !!onViewTrade && tradesById.has(String(item.trade_id)),
    showAccount: hasSubAccounts || item.kind !== 'order',
    ...(rowOptions || {}),
  });
  const list = (items) => <ul className={styles.list}>{items.map(item => <TodoRow key={item.id} {...rowProps(item)} />)}</ul>;
  const openForm = (item, preset) => setEditing({ item, preset });
  const form = editing && (
    <TodoForm
      item={editing.item || null}
      kind={editing.item ? undefined : editing.preset?.kind}
      preset={editing.item ? undefined : editing.preset}
      onClose={() => setEditing(null)}
    />
  );
  return { rowProps, list, openForm, form, agentName };
}
