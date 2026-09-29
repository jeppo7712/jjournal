import React, { useContext, useEffect, useState } from 'react';
import { TradeContext } from '../../context/TradeContext';

// Settings → Checklists: each account's Entry and Exit checklist. Every
// trade's Journal tab shows these as tick boxes (see TradeChecklist), so the
// same checks don't have to be typed into the notes each time. Lists are per
// account because the rules differ per trading style.
const EMPTY = { entry: [], exit: [] };
const SECTIONS = [
  { key: 'entry', title: 'Entry', hint: 'Checked when opening a trade, e.g. "Higher timeframe bias agrees".' },
  { key: 'exit', title: 'Exit', hint: 'Checked when closing it, e.g. "Exited at the planned level, not on emotion".' },
];

const smallBtn = {
  background: 'transparent', border: '1px solid #4B5563', color: '#A5ADBA', borderRadius: 6,
  padding: '2px 8px', cursor: 'pointer', fontSize: '0.85em',
};

function ChecklistSettings({ styles, apiBaseUrl }) {
  const { accounts, setAccounts, currentAccountId } = useContext(TradeContext);
  const [accountId, setAccountId] = useState(currentAccountId ? String(currentAccountId) : '');
  const [lists, setLists] = useState(EMPTY);
  const [newItem, setNewItem] = useState({ entry: '', exit: '' });
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  const account = (accounts || []).find(a => String(a.id) === accountId);

  // Load the selected account's saved lists (and reset unsaved edits).
  useEffect(() => {
    const saved = account?.checklists || EMPTY;
    setLists({ entry: [...(saved.entry || [])], exit: [...(saved.exit || [])] });
    setNewItem({ entry: '', exit: '' });
    setMessage(null);
  }, [accountId, account?.checklists]);

  useEffect(() => {
    if (!accountId && accounts?.length) setAccountId(String(accounts[0].id));
  }, [accountId, accounts]);

  const savedLists = account?.checklists || EMPTY;
  const isDirty = JSON.stringify(lists) !== JSON.stringify({ entry: savedLists.entry || [], exit: savedLists.exit || [] });

  const update = (key, fn) => setLists(prev => ({ ...prev, [key]: fn([...prev[key]]) }));
  const addItem = (key) => {
    const text = newItem[key].trim();
    if (!text || lists[key].includes(text)) return;
    update(key, items => [...items, text]);
    setNewItem(prev => ({ ...prev, [key]: '' }));
  };
  const move = (key, index, delta) => update(key, items => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return items;
    [items[index], items[target]] = [items[target], items[index]];
    return items;
  });

  const copyFrom = (sourceId) => {
    const source = (accounts || []).find(a => String(a.id) === sourceId);
    if (!source) return;
    const c = source.checklists || EMPTY;
    setLists({ entry: [...(c.entry || [])], exit: [...(c.exit || [])] });
    setMessage({ type: 'info', text: `Copied from ${source.name}. Save to keep it.` });
  };

  const save = async () => {
    if (!account) return;
    setSaving(true);
    setMessage(null);
    try {
      // Anything still typed in an "add" box counts too, so it isn't lost.
      const toSave = {
        entry: newItem.entry.trim() ? [...lists.entry, newItem.entry.trim()] : lists.entry,
        exit: newItem.exit.trim() ? [...lists.exit, newItem.exit.trim()] : lists.exit,
      };
      const res = await fetch(`${apiBaseUrl}/api/accounts/${account.id}/checklists`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Account-ID': currentAccountId },
        body: JSON.stringify(toSave),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setAccounts(prev => prev.map(a => (a.id === account.id ? { ...a, checklists: data.checklists } : a)));
      setMessage({ type: 'success', text: 'Saved.' });
    } catch (err) {
      setMessage({ type: 'error', text: `Could not save: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  if (!accounts?.length) return <p style={{ color: '#9CA3AF' }}>Create an account first.</p>;

  return (
    <div>
      <p style={{ color: '#9CA3AF', fontSize: '0.85rem', marginTop: 0 }}>
        Checks you want to tick off for every trade. They appear in each trade's Journal tab, above the
        notes; a trade keeps the wording it was ticked with, so editing a list here never changes older
        trades. Each account has its own lists.
      </p>
      <div className={styles.formGrid}>
        <div className={styles.formField}>
          <label htmlFor="checklistAccount">Account</label>
          <select id="checklistAccount" className={styles.inputBubble} value={accountId} onChange={e => setAccountId(e.target.value)}>
            {accounts.map(a => <option key={a.id} value={String(a.id)}>{a.name}</option>)}
          </select>
        </div>
        <div className={styles.formField}>
          <label htmlFor="checklistCopy">Copy lists from</label>
          <select id="checklistCopy" className={styles.inputBubble} value="" onChange={e => copyFrom(e.target.value)}>
            <option value="">Choose an account…</option>
            {accounts.filter(a => String(a.id) !== accountId).map(a => (
              <option key={a.id} value={String(a.id)}>
                {a.name} ({(a.checklists?.entry?.length || 0) + (a.checklists?.exit?.length || 0)} items)
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24, marginTop: 20 }}>
        {SECTIONS.map(({ key, title, hint }) => (
          <div key={key}>
            <h3 style={{ margin: '0 0 4px' }}>{title}</h3>
            <p style={{ color: '#9CA3AF', fontSize: '0.8rem', margin: '0 0 10px' }}>{hint}</p>
            {lists[key].length === 0 && <p style={{ color: '#6B7280', fontSize: '0.85rem' }}>No items yet.</p>}
            {lists[key].map((item, i) => (
              <div key={`${key}-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                <input
                  className={styles.inputBubble}
                  style={{ flex: 1, padding: '6px 12px' }}
                  value={item}
                  aria-label={`${title} item ${i + 1}`}
                  onChange={e => update(key, items => { items[i] = e.target.value; return items; })}
                />
                <button type="button" style={smallBtn} title="Move up" disabled={i === 0} onClick={() => move(key, i, -1)}>↑</button>
                <button type="button" style={smallBtn} title="Move down" disabled={i === lists[key].length - 1} onClick={() => move(key, i, 1)}>↓</button>
                <button type="button" style={smallBtn} title="Remove" onClick={() => update(key, items => items.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <input
                className={styles.inputBubble}
                style={{ flex: 1, padding: '6px 12px' }}
                placeholder={`Add ${title.toLowerCase()} check…`}
                value={newItem[key]}
                onChange={e => setNewItem(prev => ({ ...prev, [key]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addItem(key); } }}
              />
              <button type="button" className={styles.actionBtn} onClick={() => addItem(key)}>Add</button>
            </div>
          </div>
        ))}
      </div>

      <div className={styles.footerRow} style={{ alignItems: 'center', gap: 12 }}>
        {message && (
          <span style={{ color: message.type === 'error' ? '#EF4444' : message.type === 'success' ? '#22C55E' : '#A5ADBA', fontSize: '0.9em' }}>
            {message.text}
          </span>
        )}
        <button type="button" className={styles.actionBtn} onClick={save} disabled={saving || (!isDirty && !newItem.entry.trim() && !newItem.exit.trim())}>
          {saving ? 'Saving…' : 'Save checklists'}
        </button>
      </div>
    </div>
  );
}

export default ChecklistSettings;
