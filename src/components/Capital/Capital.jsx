import React, { useContext, useState, useEffect, useCallback } from 'react';
import { TradeContext } from '../../context/TradeContext';
import styles from './Capital.module.css';

const apiBaseUrl = process.env.REACT_APP_API_URL || '';

const CASH_TX_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'OTHER'];
const HOLDING_TYPES = ['TBILL', 'BOND', 'OTHER'];
const COUPON_FREQUENCIES = ['ANNUAL', 'SEMI_ANNUAL', 'QUARTERLY'];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Cash ledger + non-trade holdings (T-bills/bonds) for the current account.
// See docs/CAPITAL_TRACKING_DESIGN.md for the design. Deliberately does NOT
// collapse different-currency balances into one number — summing them
// without FX conversion would be meaningless, so they're always shown as a
// per-currency breakdown instead.
const Capital = () => {
  const { accounts, currentAccountId } = useContext(TradeContext);

  const [transactions, setTransactions] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const currentAccount = accounts.find(a => String(a.id) === String(currentAccountId));
  const defaultIsVirtual = currentAccount ? !!currentAccount.default_is_virtual : false;

  const [txForm, setTxForm] = useState({ type: 'DEPOSIT', amount: '', currency: 'USD', date_time: todayISO(), is_virtual: defaultIsVirtual, note: '' });
  const [transferForm, setTransferForm] = useState({ to_account_id: '', amount: '', currency: 'USD', date_time: todayISO(), is_virtual: defaultIsVirtual, note: '' });
  const [holdingForm, setHoldingForm] = useState({
    type: 'TBILL', name: '', currency: 'USD', face_value: '', purchase_price: '', purchase_date: todayISO(),
    maturity_date: '', coupon_rate: '', coupon_frequency: '', notes: '', is_virtual: defaultIsVirtual,
  });
  const [showHoldingDetail, setShowHoldingDetail] = useState(false);

  // Keep the virtual-flag defaults in step with the currently-selected
  // account's mode, without clobbering whatever the user is mid-typing in
  // the rest of the form.
  useEffect(() => {
    setTxForm(prev => ({ ...prev, is_virtual: defaultIsVirtual }));
    setTransferForm(prev => ({ ...prev, is_virtual: defaultIsVirtual }));
    setHoldingForm(prev => ({ ...prev, is_virtual: defaultIsVirtual }));
  }, [defaultIsVirtual]);

  const fetchAll = useCallback(async () => {
    if (!currentAccountId) return;
    setLoading(true);
    setError(null);
    try {
      const headers = { 'X-Account-ID': currentAccountId };
      const [txRes, holdRes] = await Promise.all([
        fetch(`${apiBaseUrl}/api/cash-transactions`, { headers }),
        fetch(`${apiBaseUrl}/api/holdings`, { headers }),
      ]);
      if (!txRes.ok || !holdRes.ok) throw new Error('Failed to load capital data');
      setTransactions(await txRes.json());
      setHoldings(await holdRes.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [currentAccountId]);

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

  const deleteTransaction = async (id) => {
    if (!window.confirm('Delete this cash transaction? A transfer\'s matching entry in the other account is deleted too.')) return;
    try {
      const res = await fetch(`${apiBaseUrl}/api/cash-transactions/${id}`, { method: 'DELETE', headers: { 'X-Account-ID': currentAccountId } });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete');
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
        body: JSON.stringify({ amount, is_virtual: holding.is_virtual }),
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

  if (!currentAccountId) return <div className={styles.page}>No account selected.</div>;

  const balances = currentAccount?.cash_balances || [];

  return (
    <div className={styles.page}>
      <h2>Capital — {currentAccount?.name}</h2>
      {error && <p className={styles.negative}>{error}</p>}

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Balance</h3>
        {balances.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No cash activity yet for this account.</p>
        ) : (
          <div className={styles.balanceGrid}>
            {balances.map((b, i) => (
              <div key={i} className={styles.balanceCard}>
                <div className={`${styles.balanceAmount} ${Number(b.balance) >= 0 ? styles.positive : styles.negative}`}>
                  {Number(b.balance).toFixed(2)} {b.currency}
                </div>
                <div className={styles.balanceMeta}>{b.is_virtual ? 'Paper' : 'Real'}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Add Transaction</h3>
        <form onSubmit={submitTransaction} className={styles.formRow}>
          <div className={styles.formField}>
            <label>Type</label>
            <select value={txForm.type} onChange={e => setTxForm(p => ({ ...p, type: e.target.value }))}>
              {CASH_TX_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className={styles.formField}>
            <label>Amount</label>
            <input type="number" step="0.01" min="0.01" value={txForm.amount} onChange={e => setTxForm(p => ({ ...p, amount: e.target.value }))} />
          </div>
          <div className={styles.formField}>
            <label>Currency</label>
            <input value={txForm.currency} onChange={e => setTxForm(p => ({ ...p, currency: e.target.value.toUpperCase() }))} maxLength={3} style={{ width: '60px' }} />
          </div>
          <div className={styles.formField}>
            <label>Date</label>
            <input type="date" value={txForm.date_time} onChange={e => setTxForm(p => ({ ...p, date_time: e.target.value }))} />
          </div>
          <div className={styles.formField}>
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input type="checkbox" checked={txForm.is_virtual} onChange={e => setTxForm(p => ({ ...p, is_virtual: e.target.checked }))} />
              Paper
            </label>
          </div>
          <div className={styles.formField} style={{ flex: 1, minWidth: '160px' }}>
            <label>Note</label>
            <input value={txForm.note} onChange={e => setTxForm(p => ({ ...p, note: e.target.value }))} />
          </div>
          <button type="submit">Add</button>
        </form>

        <h4 style={{ margin: '16px 0 8px' }}>Transfer to another account</h4>
        <form onSubmit={submitTransfer} className={styles.formRow}>
          <div className={styles.formField}>
            <label>To</label>
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
            <input value={transferForm.currency} onChange={e => setTransferForm(p => ({ ...p, currency: e.target.value.toUpperCase() }))} maxLength={3} style={{ width: '60px' }} />
          </div>
          <div className={styles.formField}>
            <label>Date</label>
            <input type="date" value={transferForm.date_time} onChange={e => setTransferForm(p => ({ ...p, date_time: e.target.value }))} />
          </div>
          <div className={styles.formField}>
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input type="checkbox" checked={transferForm.is_virtual} onChange={e => setTransferForm(p => ({ ...p, is_virtual: e.target.checked }))} />
              Paper
            </label>
          </div>
          <button type="submit">Transfer</button>
        </form>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Ledger</h3>
        {loading ? <p>Loading…</p> : (
          <table className={styles.table}>
            <thead>
              <tr><th>Date</th><th>Type</th><th>Amount</th><th>Note</th><th></th></tr>
            </thead>
            <tbody>
              {transactions.map(tx => (
                <tr key={tx.id}>
                  <td>{new Date(tx.date_time).toLocaleDateString()}</td>
                  <td>{tx.type}{tx.is_virtual && <span className={styles.virtualBadge}>PAPER</span>}</td>
                  <td className={Number(tx.amount) >= 0 ? styles.positive : styles.negative}>
                    {Number(tx.amount) >= 0 ? '+' : ''}{Number(tx.amount).toFixed(2)} {tx.currency}
                  </td>
                  <td>{tx.note}</td>
                  <td><button onClick={() => deleteTransaction(tx.id)} title="Delete">×</button></td>
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr><td colSpan={5} className={styles.emptyRow}>No cash transactions yet.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Holdings (T-bills, bonds, other)</h3>
        <form onSubmit={submitHolding} className={styles.formRow}>
          <div className={styles.formField}>
            <label>Type</label>
            <select value={holdingForm.type} onChange={e => setHoldingForm(p => ({ ...p, type: e.target.value }))}>
              {HOLDING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className={styles.formField} style={{ flex: 1, minWidth: '160px' }}>
            <label>Name</label>
            <input value={holdingForm.name} onChange={e => setHoldingForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. US T-Bill 13w" />
          </div>
          <div className={styles.formField}>
            <label>Currency</label>
            <input value={holdingForm.currency} onChange={e => setHoldingForm(p => ({ ...p, currency: e.target.value.toUpperCase() }))} maxLength={3} style={{ width: '60px' }} />
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
          <div className={styles.formField}>
            <label>&nbsp;</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input type="checkbox" checked={holdingForm.is_virtual} onChange={e => setHoldingForm(p => ({ ...p, is_virtual: e.target.checked }))} />
              Paper
            </label>
          </div>
          <button type="button" onClick={() => setShowHoldingDetail(v => !v)} style={{ opacity: 0.8 }}>
            {showHoldingDetail ? 'Hide detail' : 'More detail'}
          </button>
          <button type="submit">Add Holding</button>
        </form>
        {showHoldingDetail && (
          <div className={styles.formRow}>
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
            <div className={styles.formField} style={{ flex: 1, minWidth: '200px' }}>
              <label>Notes</label>
              <input value={holdingForm.notes} onChange={e => setHoldingForm(p => ({ ...p, notes: e.target.value }))} />
            </div>
          </div>
        )}

        <table className={styles.table}>
          <thead>
            <tr><th>Name</th><th>Type</th><th>Face value</th><th>Purchase</th><th>Maturity</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {holdings.map(h => (
              <tr key={h.id}>
                <td>{h.name}{h.is_virtual && <span className={styles.virtualBadge}>PAPER</span>}</td>
                <td>{h.type}</td>
                <td>{Number(h.face_value).toFixed(2)} {h.currency}</td>
                <td>{new Date(h.purchase_date).toLocaleDateString()}</td>
                <td>{h.maturity_date ? new Date(h.maturity_date).toLocaleDateString() : '—'}</td>
                <td>{h.status}</td>
                <td>
                  {h.status === 'ACTIVE' && <button onClick={() => redeemHolding(h)} style={{ marginRight: '6px' }}>Redeem</button>}
                  <button onClick={() => deleteHolding(h.id)} title="Delete">×</button>
                </td>
              </tr>
            ))}
            {holdings.length === 0 && (
              <tr><td colSpan={7} className={styles.emptyRow}>No holdings yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Capital;
