import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TradeContext } from '../../context/TradeContext';
import { useTodos } from '../../context/TodosContext';
import { notify } from '../common/Dialogs';
import { getAgentName, subscribeAgentName } from '../../utils/agentName';
import { formatNumber } from '../../utils/numberFormat';
import {
  CLOSED_STATUSES, isLapsing, describeTrigger, describeOrder, describeOrderTerms, orderPrices, instrument, triggerVoids,
  statusLabel, price, whenText, dayText, tileDay, snoozeTimes, toUtcIso, fromUtcIso,
} from '../../utils/todos';
import TodoForm from './TodoForm';
import styles from './Todo.module.css';

// One item of the Todo list as a row (the Todo page, its calendar's day
// window, the trade view): a tile with the alert's level, the order or the
// due day, the title and "then", a line of details, and one button with the
// rest in a "⋯" menu; and useTodoRows(), which gives a row everything
// it needs: the agent's name, the actions (saved through TodosContext, with
// a toast), opening the item's trade, and the add/edit form.

const KIND_LABEL = { todo: 'Todo', trigger: 'Price alert', order: 'Order' };
const TILE_CONDITION = { touch: 'touch', close_1m: '1-min close', close_1d: 'daily close', close_1w: 'weekly close' };

// Closes a popover on a click outside `ref` (the popover and its button) or
// Escape.
function useDismiss(ref, onClose) {
  useEffect(() => {
    const outside = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', esc); };
  }, [ref, onClose]);
}

function SnoozePicker({ item, now, zone, onSnooze }) {
  const times = snoozeTimes(item, now, zone);
  const start = fromUtcIso(times.tomorrow, zone);
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  return (
    <>
      <button type="button" role="menuitem" onClick={() => onSnooze(times.hour)}>In an hour <span>{whenText(times.hour, now, zone)}</span></button>
      <button type="button" role="menuitem" onClick={() => onSnooze(times.tomorrow)}>Tomorrow <span>{whenText(times.tomorrow, now, zone)}</span></button>
      <div className={styles.snoozePick}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Snooze until: date" />
        <input type="time" value={time} onChange={e => setTime(e.target.value)} aria-label="Snooze until: time" />
        <button type="button" onClick={() => { const iso = toUtcIso(date, time, zone); if (iso) onSnooze(iso); }} disabled={!date}>Set</button>
      </div>
    </>
  );
}

// The nearest scrolling box around `el` (a window's body), or null.
function scrollParent(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

// The "⋯" menu: the row's other actions, and the snooze times behind
// "Snooze…". `primary` (the row's own button) is in it on a phone only,
// where the row shows just "⋯". It opens upwards when there's no room
// below in the window or the box it scrolls in (a calendar day window).
function RowMenu({ primary, actions, snooze, snoozeLabel, boundary, onClose }) {
  const [snoozing, setSnoozing] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef(null);
  useDismiss(boundary, onClose);
  useLayoutEffect(() => {
    const menu = ref.current;
    const button = boundary.current;
    if (!menu || !button) return;
    const box = scrollParent(button);
    const boxRect = box ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const bottom = Math.min(window.innerHeight, boxRect.bottom);
    const top = Math.max(0, boxRect.top);
    const buttonRect = button.getBoundingClientRect();
    const height = menu.offsetHeight + 4;
    setUp(buttonRect.bottom + height > bottom && buttonRect.top - height >= top);
  }, [boundary, snoozing]);
  return (
    <div className={`${styles.snoozeMenu} ${up ? styles.menuUp : ''}`} role="menu" ref={ref}>
      {snoozing ? snooze : (<>
        <button type="button" role="menuitem" className={styles.phoneOnly} onClick={() => { onClose(); primary.onClick(); }}>{primary.label}</button>
        {actions.map(a => (
          <button key={a.label} type="button" role="menuitem" onClick={() => { onClose(); a.onClick(); }}>{a.label}</button>
        ))}
        {snooze && <button type="button" role="menuitem" onClick={() => setSnoozing(true)}>{snoozeLabel}</button>}
      </>)}
    </div>
  );
}

// The square on the left of a row: what the item is about at a glance.
//   alert  symbol, ▲/▼ and its level, the condition
//   order  side and quantity, symbol, type and price
//   todo   its day and time (or "someday")
function Tile({ item, now, zone, overdue }) {
  if (item.kind === 'trigger' && item.trigger) {
    const t = item.trigger;
    const up = t.direction === 'above';
    return (
      <div className={styles.tile} title={`${KIND_LABEL.trigger}: ${describeTrigger(t)}`}>
        <span className={styles.tileTop}>{instrument(t)}</span>
        <span className={`${styles.tileMain} ${up ? styles.tileUp : styles.tileDown}`}>
          <span className={styles.tileArrow} aria-hidden="true">{up ? '▲' : '▼'}</span><span className={styles.nowrap}>{price(t.level)}</span>
        </span>
        <span className={styles.tileSub}>{TILE_CONDITION[t.condition] || t.condition}</span>
      </div>
    );
  }
  if (item.kind === 'order' && item.order) {
    const o = item.order;
    return (
      <div className={styles.tile} title={`${KIND_LABEL.order}: ${describeOrder(o)}`}>
        <span className={`${styles.tileTop} ${o.side === 'BUY' ? styles.tileUp : styles.tileDown}`}>{o.side} {formatNumber(Number(o.quantity), 8, true)}</span>
        <span className={styles.tileMain}>{instrument(o)}</span>
        <span className={styles.tileSub}>{[o.order_type, orderPrices(o)].filter(Boolean).join(' ')}</span>
      </div>
    );
  }
  if (!item.due_at) {
    return <div className={`${styles.tile} ${styles.tileQuiet}`}><span className={styles.tileSub}>someday</span></div>;
  }
  const day = tileDay(item.due_at, now, zone);
  return (
    <div className={`${styles.tile} ${overdue ? styles.tileLate : ''}`} title={`Due ${whenText(item.due_at, now, zone)}`}>
      <span className={styles.tileTop}>{day.top}</span>
      <span className={styles.tileMain}>{day.date}</span>
      <span className={styles.tileSub}>{day.time}</span>
    </div>
  );
}

export function TodoRow({ item, isNew, agentName, now, zone, onEdit, onPatch, onOpenTrade, canOpenTrade, showAccount, showTrade = true }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closed = CLOSED_STATUSES.includes(item.status);
  const lapsing = isLapsing(item, now);
  const overdue = item.status === 'open' && item.due_at && Date.parse(item.due_at) <= now.getTime();
  const voids = item.kind === 'trigger' ? triggerVoids(item.trigger) : '';
  const terms = item.kind === 'order' ? [item.order?.currency, describeOrderTerms(item.order)].filter(Boolean).join(' · ') : '';
  const byAgent = item.created_by === 'agent';

  const act = (body, message) => onPatch(item, body, message);
  // The first is the row's button; the rest go in its "⋯" menu.
  const actions = [];
  if (closed) {
    actions.push({ label: 'Reopen', onClick: () => act({ status: 'open' }) });
  } else if (item.kind === 'order') {
    actions.push({ label: 'Filled', onClick: () => act({ status: 'done', closed_note: 'filled' }, 'Marked filled') });
    actions.push({ label: 'Cancelled', onClick: () => act({ status: 'dismissed', closed_note: 'cancelled' }, 'Marked cancelled') });
  } else {
    actions.push({ label: 'Done', onClick: () => act({ status: 'done' }, 'Done') });
    if (item.kind === 'trigger' && item.status === 'fired') actions.push({ label: 'Re-arm', onClick: () => act({ status: 'open' }, 'Watching again') });
    actions.push({ label: 'Dismiss', onClick: () => act({ status: 'dismissed' }, 'Dismissed') });
  }
  actions.push({ label: 'Edit', onClick: () => onEdit(item) });
  const [primary, ...more] = actions;
  const canSnooze = !closed && (item.due_at || item.kind === 'todo');

  return (
    <li className={`${styles.row} ${closed || lapsing ? styles.rowDim : ''} ${item.status === 'fired' ? styles.rowFired : ''} ${overdue ? styles.rowOverdue : ''}`}>
      <Tile item={item} now={now} zone={zone} overdue={overdue} />
      <div className={styles.rowMain}>
        <div className={styles.rowTitleLine}>
          <button type="button" className={styles.rowTitle} onClick={() => onEdit(item)} title="Edit">{item.title}</button>
          {isNew && item.status === 'fired' && <span className={styles.newChip}>new</span>}
          {item.status !== 'open' && (
            <span className={`${styles.statusChip} ${styles[`status_${item.status}`]}`}>{statusLabel(item)}</span>
          )}
          {lapsing && <span className={styles.statusChip}>Past expiry</span>}
        </div>
        {item.status === 'fired' && (
          <div className={styles.firedLine}>
            {item.fired_note || 'Fired'}
            {item.fired_at && <span className={styles.metaTime}> · {whenText(item.fired_at, now, zone)}</span>}
          </div>
        )}
        {item.then && <div className={styles.rowThen}><span className={styles.thenMark}>Then</span>{item.then}</div>}
        {item.notes && <div className={styles.rowSub}>{item.notes}</div>}
        {closed && item.closed_note && <div className={styles.rowSub}>{item.closed_note}</div>}
        <div className={styles.meta}>
          <span
            className={`${styles.byChip} ${byAgent ? styles.byAgent : ''}`}
            title={item.source && item.source !== 'app' ? `From ${item.source}` : undefined}
          >
            {byAgent ? agentName : 'you'}
          </span>
          {terms && <span>{terms}</span>}
          {voids && <span>{voids}</span>}
          {item.due_at && item.kind !== 'todo' && (
            <span className={overdue ? styles.metaLate : ''}>remind {whenText(item.due_at, now, zone)}</span>
          )}
          {item.due_at && !closed && !item.alert && <span>no ping</span>}
          {item.due_at && !closed && item.reminded_at && <span>pinged</span>}
          {item.expires_at && !closed && <span title={whenText(item.expires_at, now, zone)}>until {dayText(item.expires_at, now, zone)}</span>}
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
        <button type="button" className={`${styles.actBtn} ${styles.actPrimary}`} onClick={primary.onClick}>{primary.label}</button>
        <span className={styles.snoozeWrap} ref={menuRef}>
          <button
            type="button"
            className={`${styles.actBtn} ${styles.moreBtn}`}
            onClick={() => setMenuOpen(o => !o)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label="More actions"
            title="More actions"
          >
            ⋯
          </button>
          {menuOpen && (
            <RowMenu
              primary={primary}
              boundary={menuRef}
              actions={more}
              onClose={closeMenu}
              snoozeLabel={item.due_at ? 'Snooze…' : 'Set a date…'}
              snooze={canSnooze ? (
                <SnoozePicker
                  item={item}
                  now={now}
                  zone={zone}
                  onSnooze={(iso) => { closeMenu(); act({ due_at: iso }, `Moved to ${whenText(iso, now, zone)}`); }}
                />
              ) : null}
            />
          )}
        </span>
      </div>
    </li>
  );
}

// rowProps(item) for a TodoRow; list(items, extra) renders them (extra:
// TodoRow props for all of them); openForm(item)
// edits an item, openForm(null, { kind, trade_id, dueDate }) adds one;
// `form` is the open form (render it).
//   onViewTrade(trade)  opens a linked trade (not given: no trade link)
//   newIds              fired items to mark "new"
//   rowOptions          extra TodoRow props (e.g. showTrade: false)
export function useTodoRows({ onViewTrade, newIds, rowOptions } = {}) {
  const { currentAccountId, scopedTrades } = useContext(TradeContext);
  const { zone, now, save } = useTodos();
  const [agentName, setAgentNameState] = useState(getAgentName);
  useEffect(() => subscribeAgentName(setAgentNameState), []);
  const [editing, setEditing] = useState(null);
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
    // Only another account's name (a sub-account's): this one's goes without saying.
    showAccount: item.account_id != null && String(item.account_id) !== String(currentAccountId),
    ...(rowOptions || {}),
  });
  const list = (items, extra) => <ul className={styles.list}>{items.map(item => <TodoRow key={item.id} {...rowProps(item)} {...extra} />)}</ul>;
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
