import React, { useCallback, useEffect, useMemo, useState } from 'react';
import capitalStyles from './Capital.module.css';
import styles from './BrokerActivity.module.css';
import { formatNumber } from '../../utils/numberFormat';
import { notify, confirmDialog } from '../common/Dialogs';

const apiBaseUrl = process.env.REACT_APP_API_URL || '';

const KIND_LABELS = {
  DEPOSIT: 'Deposit',
  WITHDRAWAL: 'Withdrawal',
  INTEREST: 'Interest',
  FEE: 'Fee',
  DIVIDEND: 'Dividend',
  PAYMENT_IN_LIEU: 'Payment in lieu',
  WITHHOLDING_TAX: 'Tax withheld',
  OTHER: 'Other',
};

const MODES = [
  { key: 'OFF', label: 'Off', hint: 'The journal is its own ledger: nothing is read from IBKR beyond your trades.' },
  { key: 'SUGGEST', label: 'Suggest', hint: 'New IBKR activity waits here until you add or dismiss it.' },
  { key: 'AUTO', label: 'Automatic', hint: 'New IBKR activity is added to the ledger by itself; you can still delete any entry.' },
];

function formatISODate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString();
}

const amountText = (amount, currency) => `${Number(amount) >= 0 ? '+' : ''}${formatNumber(Number(amount), 2)} ${currency}`;

// What IBKR reported for a top-level account mapped to an IBKR account:
// fees, interest, dividends and tax, deposits and withdrawals. See
// modules/brokerCash.js for how items are matched and booked.
const BrokerActivity = ({ accountId, accounts, onLedgerChange }) => {
  const [data, setData] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [targets, setTargets] = useState({});

  const headers = useMemo(() => ({ 'Content-Type': 'application/json', 'X-Account-ID': accountId }), [accountId]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/broker-activity`, { headers });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to load IBKR activity');
      const next = await res.json();
      setData(next);
      setFromDate(next.account.broker_sync_from || next.suggestedFrom || '');
    } catch (err) {
      notify(err.message);
    }
  }, [headers]);

  useEffect(() => { load(); }, [load]);

  const post = async (path, body) => {
    const res = await fetch(`${apiBaseUrl}/api/broker-activity${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Request failed');
    return result;
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const { accounts: synced, unmapped } = await post('/sync');
      const mine = synced.find(a => String(a.accountId) === String(data.account.id));
      notify(mine
        ? `IBKR: ${mine.added} new, ${mine.matched} already in the journal${mine.booked ? `, ${mine.booked} added` : ''}, ${mine.pending} waiting.`
        : 'IBKR returned nothing for this account.', 'success');
      if (unmapped.length) notify(`IBKR account${unmapped.length > 1 ? 's' : ''} ${unmapped.join(', ')} ${unmapped.length > 1 ? 'have' : 'has'} activity but no journal account (Settings → Accounts → Broker account ID).`, 'info');
      await load();
      onLedgerChange();
    } catch (err) {
      notify(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const saveSettings = async (mode, from = fromDate) => {
    if (mode === 'AUTO' && data.account.broker_sync_mode !== 'AUTO' && !await confirmDialog(
      'Add new IBKR activity to the ledger automatically? Activity that matches an entry you made yourself is only linked, never added twice, and you can delete anything it adds.',
      { title: 'Automatic sync', confirmLabel: 'Turn on' }
    )) return;
    try {
      const res = await fetch(`${apiBaseUrl}/api/broker-activity/settings`, {
        method: 'PUT', headers, body: JSON.stringify({ mode, sync_from: from || null }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to save');
      await load();
    } catch (err) {
      notify(err.message);
    }
  };

  const act = async (path, body, message) => {
    try {
      await post(path, body);
      if (message) notify(message, 'success');
      await load();
      onLedgerChange();
    } catch (err) {
      notify(err.message);
    }
  };

  if (!data) return null;
  const { account, items } = data;
  const mode = account.broker_sync_mode;
  const pending = items.filter(i => i.status === 'PENDING');
  const done = items.filter(i => i.status === 'BOOKED' || i.status === 'MATCHED');
  const dismissed = items.filter(i => i.status === 'DISMISSED');
  const treeAccounts = accounts.filter(a => String(a.id) === String(account.id) || String(a.parent_account_id) === String(account.id));
  const isDividend = kind => ['DIVIDEND', 'PAYMENT_IN_LIEU', 'WITHHOLDING_TAX'].includes(kind);

  const describe = item => (
    <>
      <span className={styles.kind}>{KIND_LABELS[item.kind] || item.kind}{item.symbol ? ` · ${item.symbol}` : ''}</span>
      {item.description && <span className={styles.description}>{item.description}</span>}
    </>
  );

  return (
    <div className={capitalStyles.section}>
      <div className={capitalStyles.sectionHeaderRow}>
        <h3 className={capitalStyles.sectionTitle}>From IBKR <span className={styles.brokerId}>{account.broker_account_id}</span></h3>
        <div className={styles.headerActions}>
          <div className={styles.modes} role="radiogroup" aria-label="IBKR sync">
            {MODES.map(m => (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={mode === m.key}
                className={`${styles.mode} ${mode === m.key ? styles.modeActive : ''}`}
                onClick={() => mode !== m.key && saveSettings(m.key)}
                title={m.hint}
              >
                {m.label}
              </button>
            ))}
          </div>
          {mode !== 'OFF' && (
            <button type="button" className={capitalStyles.secondaryBtn} onClick={sync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          )}
        </div>
      </div>

      <p className={capitalStyles.hint} style={{ margin: '-8px 0 14px' }}>
        {MODES.find(m => m.key === mode)?.hint}{' '}
        {mode !== 'OFF' && account.broker_synced_at && <>Last synced {new Date(account.broker_synced_at).toLocaleString()}.</>}
      </p>

      <div className={styles.fromRow}>
        <label htmlFor="broker-sync-from">Read activity from</label>
        <input
          id="broker-sync-from"
          type="date"
          value={fromDate}
          onChange={e => setFromDate(e.target.value)}
          onBlur={() => mode !== 'OFF' && fromDate && fromDate !== account.broker_sync_from && saveSettings(mode, fromDate)}
        />
        <span className={styles.fromHint}>Your opening balance already holds everything before this day, so nothing earlier is read.</span>
      </div>

      {mode !== 'OFF' && (
        <>
          <div className={styles.listHead}>
            <h4>Waiting for you {pending.length > 0 && <span className={styles.count}>{pending.length}</span>}</h4>
            {pending.length > 1 && (
              <button type="button" className={capitalStyles.primaryBtn} onClick={() => act('/accept', { ids: pending.map(i => i.id) }, `${pending.length} entries added to the ledger.`)}>
                Add all
              </button>
            )}
          </div>
          {pending.length === 0 ? (
            <p className={styles.empty}>Nothing waiting. {items.length === 0 && 'Sync to read what IBKR reported since the day above.'}</p>
          ) : (
            <ul className={styles.items}>
              {pending.map(item => (
                <li key={item.id} className={styles.item}>
                  <span className={styles.date}>{formatISODate(item.date)}</span>
                  <span className={styles.what}>{describe(item)}</span>
                  <span className={`${styles.amount} ${Number(item.amount) >= 0 ? capitalStyles.positive : capitalStyles.negative}`}>{amountText(item.amount, item.currency)}</span>
                  <span className={styles.actions}>
                    {treeAccounts.length > 1 && (
                      <select
                        className={styles.target}
                        value={targets[item.id] || ''}
                        onChange={e => setTargets(prev => ({ ...prev, [item.id]: e.target.value }))}
                        aria-label="Account to add it to"
                        title="Account to add it to"
                      >
                        <option value="">{isDividend(item.kind) ? 'Account holding it' : account.name}</option>
                        {treeAccounts.filter(a => String(a.id) !== String(account.id) || isDividend(item.kind)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    )}
                    <button type="button" className={capitalStyles.redeemBtn} onClick={() => act('/accept', { ids: [item.id], account_id: targets[item.id] || null })}>Add</button>
                    <button type="button" className={capitalStyles.iconBtn} onClick={() => act(`/${item.id}/dismiss`)} title="Dismiss: doesn't belong in the journal">×</button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {(done.length > 0 || dismissed.length > 0) && (
            <button type="button" className={styles.toggleDone} onClick={() => setShowDone(v => !v)} aria-expanded={showDone}>
              {showDone ? 'Hide' : 'Show'} handled ({done.length} in the journal{dismissed.length ? `, ${dismissed.length} dismissed` : ''})
            </button>
          )}
          {showDone && (
            <ul className={`${styles.items} ${styles.doneItems}`}>
              {[...done, ...dismissed].map(item => (
                <li key={item.id} className={styles.item}>
                  <span className={styles.date}>{formatISODate(item.date)}</span>
                  <span className={styles.what}>
                    {describe(item)}
                    <span className={styles.outcome}>
                      {item.status === 'DISMISSED' && 'Dismissed'}
                      {item.status === 'BOOKED' && (item.dividend_id ? `Added as a ${item.dividend_symbol || ''} dividend` : 'Added to the ledger')}
                      {item.status === 'MATCHED' && (item.dividend_id
                        ? `Same as your ${item.dividend_symbol || ''} dividend`
                        : `Same as your ${item.links.map(l => `${KIND_LABELS[l.type] || l.type.toLowerCase()} of ${formatISODate(l.date)} (${amountText(l.amount, item.currency)})`).join(' + ')}`)}
                    </span>
                  </span>
                  <span className={`${styles.amount} ${Number(item.amount) >= 0 ? capitalStyles.positive : capitalStyles.negative}`}>{amountText(item.amount, item.currency)}</span>
                  <span className={styles.actions}>
                    {item.status === 'MATCHED' && (
                      <button type="button" className={capitalStyles.redeemBtn} onClick={() => act(`/${item.id}/unmatch`)} title="Not the same: put it back in the list above">Not the same</button>
                    )}
                    {item.status === 'DISMISSED' && (
                      <button type="button" className={capitalStyles.redeemBtn} onClick={() => act(`/${item.id}/restore`)}>Restore</button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
};

export default BrokerActivity;
