import React, { useContext, useState, useEffect, useCallback } from 'react';
import { TradeContext } from '../../context/TradeContext';
import styles from './Capital.module.css';

const apiBaseUrl = process.env.REACT_APP_API_URL || '';

const CASH_TX_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'OTHER'];
const HOLDING_TYPES = ['TBILL', 'BOND', 'OTHER'];
const COUPON_FREQUENCIES = ['ANNUAL', 'SEMI_ANNUAL', 'QUARTERLY'];
const CASH_TABS = [
  { key: 'ADD', label: 'Deposit / Withdraw' },
  { key: 'TRANSFER', label: 'Transfer' },
  { key: 'EXCHANGE', label: 'Exchange' },
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' -> locale date, without going through UTC midnight (which
// shows the previous day west of Greenwich).
function formatISODate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString();
}

const EMPTY_DIVIDEND_FORM = {
  symbol: '', kind: 'DIVIDEND', currency: 'USD', pay_date: todayISO(), ex_date: '',
  gross_amount: '', withholding_tax: '', note: '',
};

// Cash ledger + non-trade holdings (T-bills/bonds) for the current account.
// See docs/CAPITAL_TRACKING_DESIGN.md for the design. Deliberately does NOT
// collapse different-currency balances into one number — summing them
// without FX conversion would be meaningless, so they're always shown as a
// per-currency breakdown instead.
const Capital = () => {
  // holdings/refreshHoldings and refreshAccounts come from TradeContext,
  // shared with Navigation.jsx — so its Cash/Total Portfolio (which read
  // accounts[...].cash_balances and this same holdings list) update live
  // the moment something changes here, instead of staying stale until a
  // page reload.
  const { accounts, currentAccountId, holdings, refreshHoldings, refreshAccounts, futuresSettings } = useContext(TradeContext);

  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cashTab, setCashTab] = useState('ADD');

  const currentAccount = accounts.find(a => String(a.id) === String(currentAccountId));
  // Paper-vs-real is an ACCOUNT-level property (set in Settings), not a
  // per-transaction choice — every transaction under this account is
  // whatever the account is. See docs/CAPITAL_TRACKING_DESIGN.md.
  const isVirtualAccount = currentAccount ? !!currentAccount.is_virtual : false;

  const [txForm, setTxForm] = useState({ type: 'DEPOSIT', amount: '', currency: 'USD', date_time: todayISO(), note: '' });
  const [transferForm, setTransferForm] = useState({ to_account_id: '', amount: '', currency: 'USD', date_time: todayISO(), note: '' });
  const [exchangeForm, setExchangeForm] = useState({ from_amount: '', from_currency: 'USD', to_amount: '', to_currency: 'EUR', date_time: todayISO(), note: '' });
  const [holdingForm, setHoldingForm] = useState({
    type: 'TBILL', name: '', currency: 'USD', face_value: '', purchase_price: '', purchase_date: todayISO(),
    maturity_date: '', coupon_rate: '', coupon_frequency: '', notes: '',
  });
  const [showHoldingDetail, setShowHoldingDetail] = useState(false);
  const [dividends, setDividends] = useState([]);
  const [dividendForm, setDividendForm] = useState(EMPTY_DIVIDEND_FORM);
  const [editingDividendId, setEditingDividendId] = useState(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [checkingAccrual, setCheckingAccrual] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!currentAccountId) return;
    setLoading(true);
    setError(null);
    try {
      const headers = { 'X-Account-ID': currentAccountId };
      const [txRes, divRes] = await Promise.all([
        fetch(`${apiBaseUrl}/api/cash-transactions`, { headers }),
        fetch(`${apiBaseUrl}/api/dividends`, { headers }),
        refreshHoldings(),
        refreshAccounts(), // keeps the Balance card (and Navigation's Cash/Total Portfolio) live
      ]);
      if (!txRes.ok || !divRes.ok) throw new Error('Failed to load capital data');
      setTransactions(await txRes.json());
      setDividends(await divRes.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [currentAccountId, refreshHoldings, refreshAccounts]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const submitTransaction = async (e) => {
    e.preventDefault();
    if (!txForm.amount || Number(txForm.amount) <= 0) { alert('Enter a positive amount.'); return; }
    try {
      const res = await fetch(`${apiBaseUrl}/api/cash-transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Account-ID': currentAccountId },
        body: JSON.stringify({ ...txForm, amount: Number(txForm.amount), date_time: new Date(txForm.date_time).toISOString() }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to save transaction');
      setTxForm(prev => ({ ...prev, amount: '', note: '' }));
      fetchAll();
    } catch (err) { alert(err.message); }
  };

  const submitTransfer = async (e) => {
    e.preventDefault();
    if (!transferForm.to_account_id) { alert('Choose a destination account.'); return; }
    if (!transferForm.amount || Number(transferForm.amount) <= 0) { alert('Enter a positive amount.'); return; }
    try {
      const res = await fetch(`${apiBaseUrl}/api/cash-transactions/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Account-ID': currentAccountId },
        body: JSON.stringify({ ...transferForm, amount: Number(transferForm.amount), date_time: new Date(transferForm.date_time).toISOString() }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to save transfer');
      setTransferForm(prev => ({ ...prev, amount: '', note: '' }));
      fetchAll();
    } catch (err) { alert(err.message); }
  };

  const submitExchange = async (e) => {
    e.preventDefault();
    if (!exchangeForm.from_amount || Number(exchangeForm.from_amount) <= 0 || !exchangeForm.to_amount || Number(exchangeForm.to_amount) <= 0) {
      alert('Enter positive amounts on both sides.'); return;
    }
    if (exchangeForm.from_currency.toUpperCase() === exchangeForm.to_currency.toUpperCase()) {
      alert('From/To currencies must differ — use a plain deposit/withdrawal for same-currency amounts.'); return;
    }
    try {
      const res = await fetch(`${apiBaseUrl}/api/cash-transactions/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Account-ID': currentAccountId },
        body: JSON.stringify({
          ...exchangeForm,
          from_amount: Number(exchangeForm.from_amount),
          to_amount: Number(exchangeForm.to_amount),
          date_time: new Date(exchangeForm.date_time).toISOString(),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to save exchange');
      setExchangeForm(prev => ({ ...prev, from_amount: '', to_amount: '', note: '' }));
      fetchAll();
    } catch (err) { alert(err.message); }
  };

  const deleteTransaction = async (id) => {
    if (!window.confirm('Delete this cash transaction? A transfer\'s matching entry in the other account is deleted too.')) return;
    try {
      const res = await fetch(`${apiBaseUrl}/api/cash-transactions/${id}`, { method: 'DELETE', headers: { 'X-Account-ID': currentAccountId } });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete');
      fetchAll();
    } catch (err) { alert(err.message); }
  };

  // Typing a symbol that has a stock setting pre-fills its currency; the
  // field stays editable, since a dividend can be paid in a different
  // currency than the shares trade in.
  const onDividendSymbolChange = (value) => {
    const symbol = value.toUpperCase();
    const setting = (futuresSettings || []).find(fs => fs.type === 'STK' && fs.symbol === symbol);
    setDividendForm(p => ({ ...p, symbol, ...(setting?.currency ? { currency: setting.currency } : {}) }));
  };

  const resetDividendForm = () => {
    setEditingDividendId(null);
    setDividendForm(prev => ({ ...EMPTY_DIVIDEND_FORM, currency: prev.currency }));
  };

  const editDividend = (d) => {
    setEditingDividendId(d.id);
    setDividendForm({
      symbol: d.symbol, kind: d.kind, currency: d.currency, pay_date: d.pay_date, ex_date: d.ex_date || '',
      gross_amount: String(Number(d.gross_amount)), withholding_tax: Number(d.withholding_tax) ? String(Number(d.withholding_tax)) : '',
      note: d.note || '',
    });
  };

  const submitDividend = async (e) => {
    e.preventDefault();
    const gross = Number(dividendForm.gross_amount);
    const tax = dividendForm.withholding_tax === '' ? 0 : Number(dividendForm.withholding_tax);
    if (!dividendForm.symbol.trim()) { alert('Enter a symbol.'); return; }
    if (!gross) { alert('Enter the gross amount.'); return; }
    if (tax < 0 || tax > Math.abs(gross)) { alert('Tax withheld must be between 0 and the gross amount.'); return; }
    try {
      const res = await fetch(`${apiBaseUrl}/api/dividends${editingDividendId ? `/${editingDividendId}` : ''}`, {
        method: editingDividendId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Account-ID': currentAccountId },
        body: JSON.stringify({
          ...dividendForm,
          ex_date: dividendForm.ex_date || null,
          gross_amount: gross,
          withholding_tax: tax,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to save dividend');
      resetDividendForm();
      fetchAll();
    } catch (err) { alert(err.message); }
  };

  const deleteDividend = async (d) => {
    const msg = d.source === 'MANUAL'
      ? `Delete this ${d.symbol} dividend? Its ledger entries are removed too.`
      : `Remove this imported ${d.symbol} dividend? Its ledger entries are removed and it won't be imported again (you can restore it).`;
    if (!window.confirm(msg)) return;
    try {
      const res = await fetch(`${apiBaseUrl}/api/dividends/${d.id}`, { method: 'DELETE', headers: { 'X-Account-ID': currentAccountId } });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete');
      if (editingDividendId === d.id) resetDividendForm();
      fetchAll();
    } catch (err) { alert(err.message); }
  };

  const restoreDividend = async (d) => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/dividends/${d.id}/restore`, { method: 'POST', headers: { 'X-Account-ID': currentAccountId } });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to restore');
      fetchAll();
    } catch (err) { alert(err.message); }
  };

  const submitHolding = async (e) => {
    e.preventDefault();
    if (!holdingForm.name.trim() || !holdingForm.face_value || !holdingForm.purchase_price || !holdingForm.purchase_date) {
      alert('Name, face value, purchase price, and purchase date are required.');
      return;
    }
    try {
      const res = await fetch(`${apiBaseUrl}/api/holdings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Account-ID': currentAccountId },
        body: JSON.stringify({
          ...holdingForm,
          face_value: Number(holdingForm.face_value),
          purchase_price: Number(holdingForm.purchase_price),
          coupon_rate: holdingForm.coupon_rate ? Number(holdingForm.coupon_rate) : null,
          coupon_frequency: holdingForm.coupon_frequency || null,
          maturity_date: holdingForm.maturity_date || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to save holding');
      setHoldingForm(prev => ({ ...prev, name: '', face_value: '', purchase_price: '', maturity_date: '', coupon_rate: '', coupon_frequency: '', notes: '' }));
      fetchAll();
    } catch (err) { alert(err.message); }
  };

  const redeemHolding = async (holding) => {
    const input = window.prompt(`Redemption amount for "${holding.name}" (${holding.currency}):`, holding.face_value);
    if (input === null) return;
    const amount = Number(input);
    if (!amount || amount <= 0) { alert('Enter a positive amount.'); return; }
    try {
      const res = await fetch(`${apiBaseUrl}/api/holdings/${holding.id}/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Account-ID': currentAccountId },
        body: JSON.stringify({ amount }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to redeem');
      fetchAll();
    } catch (err) { alert(err.message); }
  };

  const deleteHolding = async (id) => {
    if (!window.confirm('Delete this holding? Its linked cash transactions are removed too.')) return;
    try {
      const res = await fetch(`${apiBaseUrl}/api/holdings/${id}`, { method: 'DELETE', headers: { 'X-Account-ID': currentAccountId } });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete');
      fetchAll();
    } catch (err) { alert(err.message); }
  };

  // Manually runs the same check the server does automatically every 6
  // hours (see modules/holdingsAccrual.js) — posts any due bond coupons and
  // auto-redeems anything past maturity, across ALL accounts, not just this
  // one.
  const checkAccrual = async () => {
    setCheckingAccrual(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/holdings/process-accrual`, {
        method: 'POST',
        headers: { 'X-Account-ID': currentAccountId },
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to check');
      const { couponsPosted, maturedCount } = await res.json();
      if (couponsPosted === 0 && maturedCount === 0) {
        alert('Nothing due right now.');
      } else {
        alert(`${couponsPosted} coupon payment(s) posted, ${maturedCount} holding(s) matured.`);
      }
      fetchAll();
    } catch (err) {
      alert(err.message);
    } finally {
      setCheckingAccrual(false);
    }
  };

  if (!currentAccountId) return <div className={styles.page}>No account selected.</div>;

  const balances = currentAccount?.cash_balances || [];
  // Accounts with children represent one real broker account split across
  // several journal accounts that share the same cash pool (see
  // docs/CAPITAL_TRACKING_DESIGN.md) — balance/ledger/holdings below already
  // include descendants' rows from the API. childAccountNames is just for
  // the UI to say so; rows list which physical account they came from via
  // account_name whenever it isn't this one.
  const childAccountNames = accounts
    .filter(a => String(a.parent_account_id) === String(currentAccountId))
    .map(a => a.name);
  const hasChildAccounts = childAccountNames.length > 0;

  const dismissedCount = dividends.filter(d => d.dismissed).length;
  const visibleDividends = dividends.filter(d => showDismissed || !d.dismissed);
  const formNet = (Number(dividendForm.gross_amount) || 0) - (Number(dividendForm.withholding_tax) || 0);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>Capital — {currentAccount?.name}</h2>
        <span
          className={styles.virtualBadge}
          style={{
            background: isVirtualAccount ? 'rgba(245, 158, 11, 0.15)' : 'rgba(34, 197, 94, 0.15)',
            color: isVirtualAccount ? '#F59E0B' : '#22C55E',
          }}
        >
          {isVirtualAccount ? 'PAPER ACCOUNT' : 'REAL ACCOUNT'}
        </span>
      </div>
      {hasChildAccounts && (
        <p className={styles.subNote}>
          Combined with {childAccountNames.join(', ')} — same real broker account, sharing cash.
          To add, edit, or delete an entry that belongs to one of those, switch to it directly.
        </p>
      )}
      {error && <p className={styles.errorBanner}>{error}</p>}

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Balance</h3>
        {balances.length === 0 ? (
          <p className={styles.emptyState}>No cash activity yet for this account.</p>
        ) : (
          <div className={styles.balanceGrid}>
            {balances.map((b, i) => (
              <div key={i} className={styles.balanceCard}>
                <div className={styles.balanceCurrency}>{b.currency}</div>
                <div className={`${styles.balanceAmount} ${Number(b.balance) >= 0 ? styles.positive : styles.negative}`}>
                  {/* No minus sign: the card is already red when the balance
                      is negative, so the glyph only adds noise. */}
                  {Math.abs(Number(b.balance)).toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Cash Activity</h3>
        <div className={styles.tabRow}>
          {CASH_TABS.map(t => (
            <button
              key={t.key}
              type="button"
              className={`${styles.tabBtn} ${cashTab === t.key ? styles.tabBtnActive : ''}`}
              onClick={() => setCashTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {cashTab === 'ADD' && (
          <form onSubmit={submitTransaction} className={styles.formGrid}>
            <div className={`${styles.formField} ${styles.formFieldWide}`}>
              <label>Type</label>
              <div className={styles.typeToggleGroup}>
                {CASH_TX_TYPES.map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTxForm(p => ({ ...p, type: t }))}
                    className={`${styles.typeToggleBtn} ${txForm.type === t ? styles.typeToggleBtnActive : ''} ${t === 'DEPOSIT' ? styles.typeToggleIn : ''} ${t === 'WITHDRAWAL' ? styles.typeToggleOut : ''}`}
                  >
                    {t === 'DEPOSIT' ? '+ Deposit' : t === 'WITHDRAWAL' ? '− Withdraw' : t.charAt(0) + t.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.formField}>
              <label>Amount</label>
              <input type="number" step="0.01" min="0.01" value={txForm.amount} onChange={e => setTxForm(p => ({ ...p, amount: e.target.value }))} />
            </div>
            <div className={styles.formField}>
              <label>Currency</label>
              <input value={txForm.currency} onChange={e => setTxForm(p => ({ ...p, currency: e.target.value.toUpperCase() }))} maxLength={3} />
            </div>
            <div className={styles.formField}>
              <label>Date</label>
              <input type="date" value={txForm.date_time} onChange={e => setTxForm(p => ({ ...p, date_time: e.target.value }))} />
            </div>
            <div className={`${styles.formField} ${styles.formFieldWide}`}>
              <label>Note</label>
              <input value={txForm.note} onChange={e => setTxForm(p => ({ ...p, note: e.target.value }))} placeholder="optional" />
            </div>
            <div className={styles.formActions}>
              <span />
              <button type="submit" className={styles.primaryBtn}>Add</button>
            </div>
          </form>
        )}

        {cashTab === 'TRANSFER' && (
          <form onSubmit={submitTransfer} className={styles.formGrid}>
            <div className={styles.formField}>
              <label>To account</label>
              <select value={transferForm.to_account_id} onChange={e => setTransferForm(p => ({ ...p, to_account_id: e.target.value }))}>
                <option value="">Choose account…</option>
                {accounts.filter(a => String(a.id) !== String(currentAccountId)).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className={styles.formField}>
              <label>Amount</label>
              <input type="number" step="0.01" min="0.01" value={transferForm.amount} onChange={e => setTransferForm(p => ({ ...p, amount: e.target.value }))} />
            </div>
            <div className={styles.formField}>
              <label>Currency</label>
              <input value={transferForm.currency} onChange={e => setTransferForm(p => ({ ...p, currency: e.target.value.toUpperCase() }))} maxLength={3} />
            </div>
            <div className={styles.formField}>
              <label>Date</label>
              <input type="date" value={transferForm.date_time} onChange={e => setTransferForm(p => ({ ...p, date_time: e.target.value }))} />
            </div>
            <div className={styles.formActions}>
              <span />
              <button type="submit" className={styles.primaryBtn}>Transfer</button>
            </div>
          </form>
        )}

        {cashTab === 'EXCHANGE' && (
          <form onSubmit={submitExchange} className={styles.formGrid}>
            <p className={styles.hint}>
              Converting cash from one currency to another, within this account. Enter what you actually
              received on the "To" side — the implied rate is just to/from, no rate lookup needed.
            </p>
            <div className={styles.formField}>
              <label>From amount</label>
              <input type="number" step="0.01" min="0.01" value={exchangeForm.from_amount} onChange={e => setExchangeForm(p => ({ ...p, from_amount: e.target.value }))} />
            </div>
            <div className={styles.formField}>
              <label>From currency</label>
              <input value={exchangeForm.from_currency} onChange={e => setExchangeForm(p => ({ ...p, from_currency: e.target.value.toUpperCase() }))} maxLength={3} />
            </div>
            <div className={styles.formField}>
              <label>To amount</label>
              <input type="number" step="0.01" min="0.01" value={exchangeForm.to_amount} onChange={e => setExchangeForm(p => ({ ...p, to_amount: e.target.value }))} />
            </div>
            <div className={styles.formField}>
              <label>To currency</label>
              <input value={exchangeForm.to_currency} onChange={e => setExchangeForm(p => ({ ...p, to_currency: e.target.value.toUpperCase() }))} maxLength={3} />
            </div>
            <div className={styles.formField}>
              <label>Date</label>
              <input type="date" value={exchangeForm.date_time} onChange={e => setExchangeForm(p => ({ ...p, date_time: e.target.value }))} />
            </div>
            <div className={styles.formActions}>
              <span />
              <button type="submit" className={styles.primaryBtn}>Exchange</button>
            </div>
          </form>
        )}
      </div>

      {!isVirtualAccount && (
        <div className={styles.section}>
          <div className={styles.sectionHeaderRow}>
            <h3 className={styles.sectionTitle}>Dividends</h3>
            {dismissedCount > 0 && (
              <button type="button" className={styles.secondaryBtn} onClick={() => setShowDismissed(v => !v)}>
                {showDismissed ? 'Hide removed' : `Show removed (${dismissedCount})`}
              </button>
            )}
          </div>
          <p className={styles.hint} style={{ margin: '-8px 0 16px' }}>
            Each dividend books its gross amount and any tax withheld to the ledger, on the pay date.
          </p>
          <form onSubmit={submitDividend} className={styles.formGrid}>
            <div className={`${styles.formField} ${styles.formFieldWide}`}>
              <label>Type</label>
              <div className={styles.typeToggleGroup}>
                {[['DIVIDEND', 'Dividend'], ['PAYMENT_IN_LIEU', 'Payment in lieu']].map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setDividendForm(p => ({ ...p, kind: k }))}
                    className={`${styles.typeToggleBtn} ${dividendForm.kind === k ? styles.typeToggleBtnActive : ''}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.formField}>
              <label>Symbol</label>
              <input value={dividendForm.symbol} onChange={e => onDividendSymbolChange(e.target.value)} />
            </div>
            <div className={styles.formField}>
              <label>Currency</label>
              <input value={dividendForm.currency} onChange={e => setDividendForm(p => ({ ...p, currency: e.target.value.toUpperCase() }))} maxLength={3} />
            </div>
            <div className={styles.formField}>
              <label>Pay date</label>
              <input type="date" value={dividendForm.pay_date} onChange={e => setDividendForm(p => ({ ...p, pay_date: e.target.value }))} />
            </div>
            <div className={styles.formField}>
              <label>Ex-date</label>
              <input type="date" value={dividendForm.ex_date} onChange={e => setDividendForm(p => ({ ...p, ex_date: e.target.value }))} />
            </div>
            <div className={styles.formField}>
              <label title="Before tax. Negative for a dividend owed on a short position.">Gross amount</label>
              <input type="number" step="0.01" value={dividendForm.gross_amount} onChange={e => setDividendForm(p => ({ ...p, gross_amount: e.target.value }))} />
            </div>
            <div className={styles.formField}>
              <label>Tax withheld</label>
              <input type="number" step="0.01" min="0" value={dividendForm.withholding_tax} onChange={e => setDividendForm(p => ({ ...p, withholding_tax: e.target.value }))} placeholder="0" />
            </div>
            <div className={`${styles.formField} ${styles.formFieldWide}`}>
              <label>Note</label>
              <input value={dividendForm.note} onChange={e => setDividendForm(p => ({ ...p, note: e.target.value }))} placeholder="optional" />
            </div>
            <div className={styles.formActions}>
              <span style={{ fontSize: '0.85rem', color: '#A5ADBA' }}>
                Net: <span className={formNet >= 0 ? styles.positive : styles.negative}>{formNet.toFixed(2)} {dividendForm.currency}</span>
              </span>
              <span>
                {editingDividendId && (
                  <button type="button" className={styles.secondaryBtn} onClick={resetDividendForm} style={{ marginRight: '8px' }}>Cancel</button>
                )}
                <button type="submit" className={styles.primaryBtn}>{editingDividendId ? 'Save changes' : 'Add Dividend'}</button>
              </span>
            </div>
          </form>

          <div className={styles.tableWrap} style={{ marginTop: '20px' }}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Pay date</th>
                  {hasChildAccounts && <th>Account</th>}
                  <th>Symbol</th><th>Gross</th><th>Tax</th><th>Net</th><th>Source</th><th></th>
                </tr>
              </thead>
              <tbody>
                {visibleDividends.map(d => {
                  const isOwnAccount = String(d.account_id) === String(currentAccountId);
                  const net = Number(d.net_amount);
                  return (
                    <tr key={d.id} className={d.dismissed ? styles.mutedCell : undefined}>
                      <td>{formatISODate(d.pay_date)}</td>
                      {hasChildAccounts && <td className={!isOwnAccount ? styles.mutedCell : undefined}>{d.account_name}</td>}
                      <td>{d.symbol}{d.kind === 'PAYMENT_IN_LIEU' && <span className={styles.mutedCell}> (in lieu)</span>}</td>
                      <td>{Number(d.gross_amount).toFixed(2)} {d.currency}</td>
                      <td>{Number(d.withholding_tax) ? `${Number(d.withholding_tax).toFixed(2)} ${d.currency}` : '—'}</td>
                      <td className={net >= 0 ? styles.positive : styles.negative}>{net.toFixed(2)} {d.currency}</td>
                      <td>{d.source === 'MANUAL' ? 'Manual' : `${d.source}${d.edited ? ' (edited)' : ''}`}{d.dismissed ? ' — removed' : ''}</td>
                      <td>
                        {!isOwnAccount ? (
                          <span className={styles.mutedCell} title={`Belongs to ${d.account_name} — switch to it to manage this`}>switch to manage</span>
                        ) : d.dismissed ? (
                          <button onClick={() => restoreDividend(d)} className={styles.redeemBtn}>Restore</button>
                        ) : (
                          <>
                            <button onClick={() => editDividend(d)} className={styles.redeemBtn}>Edit</button>
                            <button onClick={() => deleteDividend(d)} className={styles.iconBtn} title="Delete">×</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {visibleDividends.length === 0 && (
                  <tr><td colSpan={hasChildAccounts ? 8 : 7} className={styles.emptyRow}>No dividends yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Ledger</h3>
        {loading ? <p className={styles.emptyState}>Loading…</p> : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  {hasChildAccounts && <th>Account</th>}
                  <th>Type</th><th>Amount</th><th>Note</th><th></th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(tx => {
                  const isOwnAccount = String(tx.account_id) === String(currentAccountId);
                  // Dividend rows are derived from their dividend (see the
                  // Dividends section) and can't be deleted on their own.
                  const isDividendRow = !!tx.linked_dividend_id;
                  const canDelete = isOwnAccount && !isDividendRow;
                  return (
                    <tr key={tx.id}>
                      <td>{new Date(tx.date_time).toLocaleDateString()}</td>
                      {hasChildAccounts && <td className={!isOwnAccount ? styles.mutedCell : undefined}>{tx.account_name}</td>}
                      <td>{tx.type}</td>
                      <td className={Number(tx.amount) >= 0 ? styles.positive : styles.negative}>
                        {Number(tx.amount) >= 0 ? '+' : ''}{Number(tx.amount).toFixed(2)} {tx.currency}
                      </td>
                      <td>{tx.note}</td>
                      <td>
                        <button
                          className={styles.iconBtn}
                          onClick={() => canDelete && deleteTransaction(tx.id)}
                          disabled={!canDelete}
                          title={isDividendRow ? 'Part of a dividend — edit or remove it under Dividends'
                            : isOwnAccount ? 'Delete' : `Belongs to ${tx.account_name} — switch to it to delete this`}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {transactions.length === 0 && (
                  <tr><td colSpan={hasChildAccounts ? 6 : 5} className={styles.emptyRow}>No cash transactions yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHeaderRow}>
          <h3 className={styles.sectionTitle}>Holdings (T-bills, bonds, other)</h3>
          <button type="button" className={styles.secondaryBtn} onClick={checkAccrual} disabled={checkingAccrual}>
            {checkingAccrual ? 'Checking…' : 'Check for due coupons/maturity'}
          </button>
        </div>
        <p className={styles.hint} style={{ margin: '-8px 0 16px' }}>
          Bond coupons post to the ledger automatically as they come due, and any holding auto-redeems
          at face value once matured — checked every 6 hours in the background, or on demand here.
        </p>
        <form onSubmit={submitHolding} className={styles.formGrid}>
          <div className={styles.formField}>
            <label>Type</label>
            <select value={holdingForm.type} onChange={e => setHoldingForm(p => ({ ...p, type: e.target.value }))}>
              {HOLDING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className={`${styles.formField} ${styles.formFieldWide}`}>
            <label>Name</label>
            <input value={holdingForm.name} onChange={e => setHoldingForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. US T-Bill 13w" />
          </div>
          <div className={styles.formField}>
            <label>Currency</label>
            <input value={holdingForm.currency} onChange={e => setHoldingForm(p => ({ ...p, currency: e.target.value.toUpperCase() }))} maxLength={3} />
          </div>
          <div className={styles.formField}>
            <label>Face value</label>
            <input type="number" step="0.01" value={holdingForm.face_value} onChange={e => setHoldingForm(p => ({ ...p, face_value: e.target.value }))} />
          </div>
          <div className={styles.formField}>
            <label>Purchase price</label>
            <input type="number" step="0.01" value={holdingForm.purchase_price} onChange={e => setHoldingForm(p => ({ ...p, purchase_price: e.target.value }))} />
          </div>
          <div className={styles.formField}>
            <label>Purchase date</label>
            <input type="date" value={holdingForm.purchase_date} onChange={e => setHoldingForm(p => ({ ...p, purchase_date: e.target.value }))} />
          </div>
          <div className={styles.formField}>
            <label>Maturity date</label>
            <input type="date" value={holdingForm.maturity_date} onChange={e => setHoldingForm(p => ({ ...p, maturity_date: e.target.value }))} />
          </div>
          <div className={styles.formActions}>
            <button type="button" className={styles.detailToggle} onClick={() => setShowHoldingDetail(v => !v)}>
              {showHoldingDetail ? '− Hide coupon detail' : '+ Coupon detail (optional)'}
            </button>
            <button type="submit" className={styles.primaryBtn}>Add Holding</button>
          </div>
          {showHoldingDetail && (
            <div className={`${styles.formGrid} ${styles.detailGrid}`} style={{ gridColumn: '1 / -1' }}>
              <div className={styles.formField}>
                <label>Coupon rate (%)</label>
                <input type="number" step="0.01" value={holdingForm.coupon_rate} onChange={e => setHoldingForm(p => ({ ...p, coupon_rate: e.target.value }))} placeholder="leave blank if none" />
              </div>
              <div className={styles.formField}>
                <label>Coupon frequency</label>
                <select value={holdingForm.coupon_frequency} onChange={e => setHoldingForm(p => ({ ...p, coupon_frequency: e.target.value }))}>
                  <option value="">—</option>
                  {COUPON_FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
              <div className={`${styles.formField} ${styles.formFieldWide}`}>
                <label>Notes</label>
                <input value={holdingForm.notes} onChange={e => setHoldingForm(p => ({ ...p, notes: e.target.value }))} />
              </div>
            </div>
          )}
        </form>

        <div className={styles.tableWrap} style={{ marginTop: '20px' }}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                {hasChildAccounts && <th>Account</th>}
                <th>Type</th><th>Face value</th><th>Purchase</th><th>Maturity</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {holdings.map(h => {
                const isOwnAccount = String(h.account_id) === String(currentAccountId);
                return (
                  <tr key={h.id}>
                    <td>{h.name}</td>
                    {hasChildAccounts && <td className={!isOwnAccount ? styles.mutedCell : undefined}>{h.account_name}</td>}
                    <td>{h.type}</td>
                    <td>{Number(h.face_value).toFixed(2)} {h.currency}</td>
                    <td>{new Date(h.purchase_date).toLocaleDateString()}</td>
                    <td>{h.maturity_date ? new Date(h.maturity_date).toLocaleDateString() : '—'}</td>
                    <td>{h.status}</td>
                    <td>
                      {isOwnAccount ? (
                        <>
                          {h.status === 'ACTIVE' && <button onClick={() => redeemHolding(h)} className={styles.redeemBtn}>Redeem</button>}
                          <button onClick={() => deleteHolding(h.id)} className={styles.iconBtn} title="Delete">×</button>
                        </>
                      ) : (
                        <span className={styles.mutedCell} title={`Belongs to ${h.account_name} — switch to it to manage this`}>switch to manage</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {holdings.length === 0 && (
                <tr><td colSpan={hasChildAccounts ? 8 : 7} className={styles.emptyRow}>No holdings yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Capital;
