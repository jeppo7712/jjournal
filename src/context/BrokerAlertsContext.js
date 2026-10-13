import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { TradeContext } from './TradeContext';

// What IBKR has waiting for the user, over all accounts: on the Capital page
// (cash items for the inbox, cash that differs from IBKR's —
// routes/brokerActivity.js) and IBKR fills not in the journal yet
// (routes/brokerFills.js). The menu shows it per page and per account, the
// Dashboard lists the fills. Refreshed every few minutes, when the Capital
// page changes something ('broker-activity-changed') and when the trades
// change (a saved trade takes its fills out).
const BrokerAlertsContext = createContext({
  capital: { total: 0, accounts: [] },
  fills: [],
  rootOf: () => null,
  countsByAccount: {},
  refresh: () => {},
  dismissFills: async () => {},
});

const REFRESH_MS = 5 * 60 * 1000;

const getJson = async (path, accountId) => {
  const res = await fetch(`${process.env.REACT_APP_API_URL}/api${path}`, { headers: { 'X-Account-ID': accountId } });
  return res.ok ? res.json() : null;
};

export function BrokerAlertsProvider({ children }) {
  const { accounts, currentAccountId, trades } = useContext(TradeContext);
  const [capital, setCapital] = useState({ total: 0, accounts: [] });
  const [fills, setFills] = useState([]);
  const cancelled = useRef(false);

  const refresh = useCallback(() => {
    if (!currentAccountId) return;
    getJson('/broker-activity/pending', currentAccountId)
      .then(data => { if (!cancelled.current && data) setCapital(data); })
      .catch(() => {});
    getJson('/broker-fills', currentAccountId)
      .then(data => { if (!cancelled.current && data) setFills(data.fills || []); })
      .catch(() => {});
  }, [currentAccountId]);

  useEffect(() => {
    cancelled.current = false;
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener('broker-activity-changed', refresh);
    return () => {
      cancelled.current = true;
      clearInterval(timer);
      window.removeEventListener('broker-activity-changed', refresh);
    };
  }, [refresh]);

  // A saved or deleted trade can take fills out (or put them back).
  useEffect(() => { refresh(); }, [trades, refresh]);

  // Cash items and fills belong to a top-level account (the one linked to
  // IBKR); a sub-account shows its top-level account's.
  const rootOf = useCallback((accountId) => {
    const byId = new Map((accounts || []).map(a => [String(a.id), a]));
    let account = byId.get(String(accountId));
    for (let i = 0; account?.parent_account_id && i < 20; i += 1) account = byId.get(String(account.parent_account_id));
    return account ? String(account.id) : null;
  }, [accounts]);

  // Per top-level account: { capital, fills }.
  const countsByAccount = useMemo(() => {
    const counts = {};
    const entry = id => (counts[String(id)] = counts[String(id)] || { capital: 0, fills: 0 });
    for (const a of capital.accounts || []) entry(a.id).capital += (a.count || 0) + (a.offBalance || []).length;
    for (const f of fills) entry(f.account_id).fills += 1;
    return counts;
  }, [capital, fills]);

  const dismissFills = useCallback(async (ids) => {
    await fetch(`${process.env.REACT_APP_API_URL}/api/broker-fills/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Account-ID': currentAccountId },
      body: JSON.stringify({ ids }),
    });
    refresh();
  }, [currentAccountId, refresh]);

  const value = useMemo(
    () => ({ capital, fills, rootOf, countsByAccount, refresh, dismissFills }),
    [capital, fills, rootOf, countsByAccount, refresh, dismissFills]
  );
  return <BrokerAlertsContext.Provider value={value}>{children}</BrokerAlertsContext.Provider>;
}

export const useBrokerAlerts = () => useContext(BrokerAlertsContext);
