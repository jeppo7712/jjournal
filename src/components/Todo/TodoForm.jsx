import React, { useContext, useMemo, useState } from 'react';
import AppWindow, { WindowButton } from '../common/AppWindow';
import { confirmDialog, notify } from '../common/Dialogs';
import { TradeContext } from '../../context/TradeContext';
import { useTodos } from '../../context/TodosContext';
import { accountOptionGroups } from '../../utils/accountTree';
import {
  CONDITION_LABELS, describeTrigger, describeOrder, plainPrice, toUtcIso, fromUtcIso,
} from '../../utils/todos';
import styles from './Todo.module.css';

// Add or edit one item of the Todo list: a todo, a price alert or a
// pending order, one tab each. Times are entered in the page's zone
// (utils/todos.js, todoZone) and saved in UTC. The server checks
// everything again (modules/todos.js) and its message is shown as is.

const KIND_TABS = [
  { kind: 'todo', label: 'Todo' },
  { kind: 'trigger', label: 'Price alert' },
  { kind: 'order', label: 'Pending order' },
];
const ORDER_TYPES = ['LMT', 'STP', 'STP LMT', 'MOC', 'LOC'];
const needsLimit = type => ['LMT', 'STP LMT', 'LOC'].includes(type);
const needsStop = type => ['STP', 'STP LMT'].includes(type);

const str = value => (value === null || value === undefined ? '' : String(value));
// A decimal comma or point ("42,5", "42.5"). Anything else is sent as typed,
// so the server names the field instead of it being saved wrong or dropped.
const num = (value) => {
  const text = String(value).trim();
  if (text === '') return null;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? n : text;
};

// A title the form made from the alert or order itself (it had none of its
// own): edited as empty, so it's made again from what the item says then.
const generatedTitle = (item) => !!item && (
  (item.kind === 'trigger' && item.trigger && item.title === describeTrigger(item.trigger, plainPrice))
  || (item.kind === 'order' && item.order && item.title === describeOrder(item.order, plainPrice))
);

// preset (a new item only), what to start from: { trade_id, dueDate }, and
// from a trade its symbol, type, contract_month and account_id.
function initialForm(item, kind, defaultOrderAccount, zone, preset) {
  const due = fromUtcIso(item?.due_at, zone);
  const expires = fromUtcIso(item?.expires_at, zone);
  const fromTrade = !item && preset?.symbol
    ? { symbol: preset.symbol, type: preset.type === 'FUT' ? 'FUT' : 'STK', contract_month: preset.type === 'FUT' ? preset.contract_month : null }
    : {};
  const t = item?.trigger || fromTrade;
  const o = item?.order || fromTrade;
  const presetAccount = !item && preset?.account_id ? str(preset.account_id) : null;
  return {
    kind: item?.kind || kind || 'todo',
    title: generatedTitle(item) ? '' : str(item?.title),
    notes: str(item?.notes),
    then: str(item?.then),
    dueDate: item ? due.date : (preset?.dueDate || ''),
    dueTime: item ? due.time : (preset?.dueDate ? '09:00' : ''),
    // On by default once a date is set (as the server does).
    alert: item?.due_at ? !!item.alert : true,
    tradeId: str(item ? item.trade_id : preset?.trade_id),
    accountId: item ? str(item.account_id) : (presetAccount || ''),
    orderAccountId: item?.kind === 'order' ? str(item.account_id) : (presetAccount || str(defaultOrderAccount)),
    expiresDate: expires.date,
    expiresTime: expires.time,
    tSymbol: str(t.symbol),
    tType: t.type || 'STK',
    tMonth: str(t.contract_month),
    tCondition: t.condition || 'touch',
    tDirection: t.direction || 'above',
    tLevel: str(t.level),
    tVoidAbove: str(t.void_above),
    tVoidBelow: str(t.void_below),
    oSymbol: str(o.symbol),
    oType: o.type || 'STK',
    oMonth: str(o.contract_month),
    oSide: o.side || 'BUY',
    oQuantity: str(o.quantity),
    oOrderType: o.order_type || 'LMT',
    oLimit: str(o.limit_price),
    oStop: str(o.stop_price),
    oTif: o.tif || 'GTC',
    oGoodTill: str(o.good_till),
    oCurrency: str(o.currency),
    oStopLoss: str(o.stop_loss),
    oTarget: str(o.profit_target),
  };
}

// The request body for the form as it stands (the fields of its kind).
//   fromKind  the item's kind before (editing): an alert's "then" and expiry
//             go when it becomes a todo or order (the form has no fields
//             for them there)
function bodyOf(f, zone, fromKind) {
  const dueAt = toUtcIso(f.dueDate, f.dueTime, zone);
  const body = {
    kind: f.kind,
    notes: f.notes.trim() || null,
    due_at: dueAt,
    alert: dueAt ? f.alert : false,
    trade_id: f.tradeId ? Number(f.tradeId) : null,
    trigger: null,
    order: null,
  };
  if (fromKind === 'trigger' && f.kind !== 'trigger') {
    body.then = null;
    body.expires_at = null;
  }
  if (f.kind === 'todo') {
    body.account_id = f.accountId ? Number(f.accountId) : null;
  } else if (f.kind === 'trigger') {
    body.account_id = f.accountId ? Number(f.accountId) : null;
    body.then = f.then.trim() || null;
    body.expires_at = toUtcIso(f.expiresDate, f.expiresTime || '23:59', zone);
    body.trigger = {
      symbol: f.tSymbol.trim().toUpperCase(),
      type: f.tType,
      contract_month: f.tType === 'FUT' && f.tMonth.trim() ? f.tMonth.trim() : null,
      condition: f.tCondition,
      direction: f.tDirection,
      level: num(f.tLevel),
      void_above: num(f.tVoidAbove),
      void_below: num(f.tVoidBelow),
    };
  } else {
    body.account_id = f.orderAccountId ? Number(f.orderAccountId) : null;
    body.order = {
      symbol: f.oSymbol.trim().toUpperCase(),
      type: f.oType,
      contract_month: f.oType === 'FUT' && f.oMonth.trim() ? f.oMonth.trim() : null,
      side: f.oSide,
      quantity: num(f.oQuantity),
      order_type: f.oOrderType,
      limit_price: needsLimit(f.oOrderType) ? num(f.oLimit) : null,
      stop_price: needsStop(f.oOrderType) ? num(f.oStop) : null,
      tif: f.oTif,
      good_till: f.oTif === 'GTD' ? f.oGoodTill || null : null,
      currency: f.oCurrency.trim().toUpperCase() || null,
      stop_loss: num(f.oStopLoss),
      profit_target: num(f.oTarget),
    };
  }
  // An alert or order without a title of its own is named after itself.
  const title = f.title.trim();
  if (title) body.title = title;
  else if (f.kind === 'trigger' && body.trigger.symbol && body.trigger.level) body.title = describeTrigger(body.trigger, plainPrice);
  else if (f.kind === 'order' && body.order.symbol) body.title = describeOrder(body.order, plainPrice);
  else body.title = '';
  return body;
}

function Field({ label, wide, hint, children }) {
  return (
    <div className={`${styles.formField} ${wide ? styles.formFieldWide : ''}`}>
      <label>{label}</label>
      {children}
      {hint && <span className={styles.fieldHint}>{hint}</span>}
    </div>
  );
}

function Toggle({ options, value, onChange }) {
  return (
    <div className={styles.toggle}>
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          className={`${styles.toggleBtn} ${value === o.value ? styles.toggleBtnActive : ''}`}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function TodoForm({ item, kind, preset, onClose }) {
  const { accounts, currentAccountId, scopedTrades } = useContext(TradeContext);
  const { zone, save, remove } = useTodos();

  const groups = useMemo(() => accountOptionGroups(accounts), [accounts]);
  const usableAccounts = useMemo(() => groups.filter(g => g.key !== 'archived'), [groups]);
  // An order goes on the account that's picked, unless it's archived.
  const usableIds = usableAccounts.flatMap(g => g.options.map(o => String(o.account.id)));
  const defaultOrderAccount = usableIds.includes(String(currentAccountId)) ? currentAccountId : usableIds[0];

  const [form, setForm] = useState(() => initialForm(item, kind, defaultOrderAccount, zone, preset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (field) => (e) => {
    const value = e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setForm(f => ({ ...f, [field]: value }));
  };

  // The newest trades first, the linked one kept even when it's older.
  const tradeOptions = useMemo(() => {
    const list = [...(scopedTrades || [])]
      .sort((a, b) => String(b.firstActionDate || b.created_at || '').localeCompare(String(a.firstActionDate || a.created_at || '')))
      .slice(0, 100);
    const linked = item?.trade_id || preset?.trade_id;
    if (linked && !list.some(t => String(t.id) === String(linked))) {
      list.unshift({ id: linked, symbol: item?.trade_symbol || preset?.trade_symbol || `Trade ${linked}`, openDate: '' });
    }
    return list;
  }, [scopedTrades, item, preset]);

  const submit = async () => {
    setBusy(true);
    setError('');
    const body = bodyOf(form, zone, item?.kind);
    // Times not touched keep their exact value (the agent's can have
    // seconds the inputs don't show): a changed due_at would re-arm it.
    const initial = initialForm(item, kind, defaultOrderAccount, zone);
    if (item && form.dueDate === initial.dueDate && form.dueTime === initial.dueTime) body.due_at = item.due_at;
    if (item && form.kind === 'trigger' && form.expiresDate === initial.expiresDate && form.expiresTime === initial.expiresTime) {
      body.expires_at = item.expires_at;
    }
    try {
      await save(item?.id, body);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async () => {
    if (!await confirmDialog(`Delete "${item.title}"? Closing it (Done, Dismiss) keeps it in the list's history instead.`, { title: 'Delete', confirmLabel: 'Delete', danger: true })) return;
    setBusy(true);
    try {
      await remove(item.id);
      onClose();
    } catch (err) {
      notify(err.message, 'error');
      setBusy(false);
    }
  };

  // defaultTime: filled in when a date is picked without a time.
  const dateTime = (dateField, timeField, label, hint, defaultTime = '09:00') => (
    <Field label={label} hint={hint}>
      <div className={styles.dateTime}>
        <input type="date" className={styles.input} value={form[dateField]} onChange={e => {
          const value = e.target.value;
          setForm(f => ({
            ...f,
            [dateField]: value,
            // A date picked without a time: the default time.
            [timeField]: value && !f[timeField] ? defaultTime : f[timeField],
          }));
        }} aria-label={`${label}: date`} />
        <input type="time" className={styles.input} value={form[timeField]} onChange={set(timeField)} disabled={!form[dateField]} aria-label={`${label}: time`} />
        {form[dateField] && (
          <button type="button" className={styles.clearBtn} onClick={() => setForm(f => ({ ...f, [dateField]: '', [timeField]: '' }))} title="No date" aria-label={`${label}: clear`}>×</button>
        )}
      </div>
    </Field>
  );

  const accountSelect = (field, { required } = {}) => (
    <select className={styles.input} value={form[field]} onChange={set(field)}>
      {!required && <option value="">All accounts</option>}
      {usableAccounts.map(g => (
        <optgroup key={g.key} label={g.label}>
          {g.options.map(({ account, depth }) => (
            <option key={account.id} value={account.id}>{`${'  '.repeat(depth)}${account.name}`}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );

  const reminder = (
    <>
      {dateTime('dueDate', 'dueTime', form.kind === 'todo' ? 'When' : 'Remind me', form.kind === 'todo' ? 'Optional. Without a date it goes under Someday.' : 'Optional.')}
      <Field label="Alert">
        <label className={styles.checkLine}>
          <input type="checkbox" checked={!!form.dueDate && form.alert} disabled={!form.dueDate} onChange={set('alert')} />
          Ping me at that time
        </label>
      </Field>
    </>
  );

  return (
    <AppWindow
      title={item ? 'Edit' : 'Add to the list'}
      subtitle={item?.created_by === 'agent' ? `Written by the agent${item.source ? ` (${item.source})` : ''}` : undefined}
      onClose={onClose}
      storageKey="todoFormPosition"
      width={620}
      onSave={submit}
      busy={busy}
      leftActions={item ? <WindowButton variant="danger" onClick={deleteItem} disabled={busy}>Delete</WindowButton> : null}
    >
      <div className={styles.tabRow} role="tablist">
        {KIND_TABS.map(t => (
          <button
            key={t.kind}
            type="button"
            role="tab"
            aria-selected={form.kind === t.kind}
            className={`${styles.tabBtn} ${form.kind === t.kind ? styles.tabBtnActive : ''}`}
            onClick={() => setForm(f => ({ ...f, kind: t.kind }))}
          >
            {t.label}
          </button>
        ))}
      </div>

      <form className={styles.formGrid} onSubmit={e => { e.preventDefault(); submit(); }}>
        {form.kind === 'trigger' && (
          <>
            <Field label="Symbol">
              <input className={styles.input} value={form.tSymbol} onChange={set('tSymbol')} placeholder="ABC, ETFA.DE, MES" autoCapitalize="characters" />
            </Field>
            <Field label="Type">
              <Toggle options={[{ value: 'STK', label: 'Stock' }, { value: 'FUT', label: 'Future' }]} value={form.tType} onChange={v => setForm(f => ({ ...f, tType: v, tCondition: v !== 'FUT' && f.tCondition === 'close_1m' ? 'touch' : f.tCondition }))} />
            </Field>
            {form.tType === 'FUT' && (
              <Field label="Contract month" hint="Optional, e.g. 202606. Empty: the front month.">
                <input className={styles.input} value={form.tMonth} onChange={set('tMonth')} inputMode="numeric" maxLength={6} />
              </Field>
            )}
            <Field label="Condition">
              <select className={styles.input} value={form.tCondition} onChange={set('tCondition')}>
                {CONDITION_LABELS.filter(c => form.tType === 'FUT' || c.value !== 'close_1m').map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Direction">
              <Toggle options={[{ value: 'above', label: 'Above' }, { value: 'below', label: 'Below' }]} value={form.tDirection} onChange={set('tDirection')} />
            </Field>
            <Field label="Level">
              <input className={styles.input} value={form.tLevel} onChange={set('tLevel')} inputMode="decimal" />
            </Field>
            <Field label="Void above">
              <input className={styles.input} value={form.tVoidAbove} onChange={set('tVoidAbove')} inputMode="decimal" placeholder="optional" />
            </Field>
            <Field label="Void below">
              <input className={styles.input} value={form.tVoidBelow} onChange={set('tVoidBelow')} inputMode="decimal" placeholder="optional" />
            </Field>
            <p className={`${styles.fieldHint} ${styles.formFieldWide} ${styles.gridNote}`}>
              Void: if price trades there first, the alert no longer applies (a stop or target already hit).
            </p>
            <Field label="Then" wide>
              <input className={styles.input} value={form.then} onChange={set('then')} placeholder="What to do when it happens" maxLength={300} />
            </Field>
            {dateTime('expiresDate', 'expiresTime', 'Expires', 'Optional. After this it no longer matters.', '23:59')}
          </>
        )}

        {form.kind === 'order' && (
          <>
            <Field label="Account">{accountSelect('orderAccountId', { required: true })}</Field>
            <Field label="Symbol">
              <input className={styles.input} value={form.oSymbol} onChange={set('oSymbol')} placeholder="ABC, ETFA.DE, MES" autoCapitalize="characters" />
            </Field>
            <Field label="Type">
              <Toggle options={[{ value: 'STK', label: 'Stock' }, { value: 'FUT', label: 'Future' }]} value={form.oType} onChange={set('oType')} />
            </Field>
            {form.oType === 'FUT' && (
              <Field label="Contract month" hint="Optional, e.g. 202606.">
                <input className={styles.input} value={form.oMonth} onChange={set('oMonth')} inputMode="numeric" maxLength={6} />
              </Field>
            )}
            <Field label="Side">
              <Toggle options={[{ value: 'BUY', label: 'Buy' }, { value: 'SELL', label: 'Sell' }]} value={form.oSide} onChange={set('oSide')} />
            </Field>
            <Field label="Quantity">
              <input className={styles.input} value={form.oQuantity} onChange={set('oQuantity')} inputMode="decimal" />
            </Field>
            <Field label="Order type">
              <select className={styles.input} value={form.oOrderType} onChange={set('oOrderType')}>
                {ORDER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            {needsStop(form.oOrderType) && (
              <Field label="Stop price">
                <input className={styles.input} value={form.oStop} onChange={set('oStop')} inputMode="decimal" />
              </Field>
            )}
            {needsLimit(form.oOrderType) && (
              <Field label="Limit price">
                <input className={styles.input} value={form.oLimit} onChange={set('oLimit')} inputMode="decimal" />
              </Field>
            )}
            <Field label="Time in force">
              <Toggle options={[{ value: 'DAY', label: 'Day' }, { value: 'GTC', label: 'GTC' }, { value: 'GTD', label: 'GTD' }]} value={form.oTif} onChange={set('oTif')} />
            </Field>
            {form.oTif === 'GTD' && (
              <Field label="Good till">
                <input type="date" className={styles.input} value={form.oGoodTill} onChange={set('oGoodTill')} />
              </Field>
            )}
            <Field label="Bracket stop" hint="Optional.">
              <input className={styles.input} value={form.oStopLoss} onChange={set('oStopLoss')} inputMode="decimal" />
            </Field>
            <Field label="Bracket target" hint="Optional.">
              <input className={styles.input} value={form.oTarget} onChange={set('oTarget')} inputMode="decimal" />
            </Field>
            <Field label="Currency" hint="Optional; the symbol's own otherwise.">
              <input className={styles.input} value={form.oCurrency} onChange={set('oCurrency')} maxLength={3} autoCapitalize="characters" />
            </Field>
          </>
        )}

        <Field label="Title" wide hint={form.kind !== 'todo' ? 'Optional: without one it is named after the alert or order.' : undefined}>
          <input className={styles.input} value={form.title} onChange={set('title')} maxLength={300} placeholder={form.kind === 'todo' ? 'Call the broker' : bodyOf({ ...form, title: '' }, zone).title || 'Made from the alert or order'} autoFocus={!item && form.kind === 'todo'} />
        </Field>
        <Field label="Notes" wide>
          <textarea className={`${styles.input} ${styles.textarea}`} value={form.notes} onChange={set('notes')} rows={3} />
        </Field>

        {reminder}

        {form.kind !== 'order' && (
          <Field label="Account" hint="All accounts: shown whichever account is picked.">{accountSelect('accountId')}</Field>
        )}
        <Field label="Trade" hint="Optional: shown on that trade.">
          <select className={styles.input} value={form.tradeId} onChange={set('tradeId')}>
            <option value="">No trade</option>
            {tradeOptions.map(t => (
              <option key={t.id} value={t.id}>{[t.symbol, t.openDate, t.side].filter(Boolean).join(' · ')}</option>
            ))}
          </select>
        </Field>
        {/* Enter in a field saves. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
      {error && <p className={styles.formError} role="alert">{error}</p>}
    </AppWindow>
  );
}
