import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { TradeContext } from './TradeContext';
import { useBrokerAlerts } from './BrokerAlertsContext';
import { setAppBadge, APP_BADGE_PERMISSION_EVENT } from '../utils/appBadge';
import { descendantAccountIds } from '../utils/accountTree';
import { loadStoredDisplayTimezone } from '../utils/timezonePreference';
import { todoZone, inScope, badgeCount } from '../utils/todos';

// The Todo list (routes/todos.js): every item, loaded once for the whole
// app, so the menu badge and the Todo page agree. Open and fired items are
// always loaded, closed ones from the last CLOSED_DAYS days (the page can
// ask for older ones). Refreshed when the server says the list changed (the
// "todosChanged" WebSocket message, passed on by StatusContext as the
// 'todos-changed' event: the agent writes too), when the page comes back
// into view, and every few minutes as a fallback.
//
// The page follows the account picker: `scoped` holds the current account's
// items, its sub-accounts' and the ones with no account (utils/todos.js,
// inScope). `badge` counts those; the app's icon counts every account's,
// on top of the IBKR items (BrokerAlertsContext).

const API = `${process.env.REACT_APP_API_URL}/api/todos`;
export const CLOSED_DAYS = 30;
const REFRESH_MS = 5 * 60 * 1000;

const TodosContext = createContext({
  todos: [], scoped: [], loaded: false, loadFailed: false, badge: 0, zone: 'local', now: new Date(),
  refresh: () => {}, save: async () => {}, remove: async () => {}, markSeen: async () => {}, loadOlderClosed: async () => [],
});

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `The server answered ${res.status}`);
  return body;
}

const closedSince = () => new Date(Date.now() - CLOSED_DAYS * 864e5).toISOString();

export function TodosProvider({ children }) {
  const { accounts, currentAccountId } = useContext(TradeContext);
  const { total: brokerTotal } = useBrokerAlerts();
  const [todos, setTodos] = useState([]);
  const [loaded, setLoaded] = useState(false);
  // The last load failed.
  const [loadFailed, setLoadFailed] = useState(false);
  // Moves on every minute, so an item becomes overdue without a reload.
  const [now, setNow] = useState(() => new Date());
  const zone = todoZone(loadStoredDisplayTimezone());
  const latest = useRef(0);

  const refresh = useCallback(() => {
    const call = ++latest.current;
    request(`${API}?closed_since=${encodeURIComponent(closedSince())}`)
      .then(data => {
        // An older answer arriving after a newer one doesn't win.
        if (call !== latest.current) return;
        setTodos(data.todos || []);
        setLoaded(true);
        setLoadFailed(false);
      })
      .catch(() => { if (call === latest.current) setLoadFailed(true); });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    const tick = setInterval(() => setNow(new Date()), 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') { setNow(new Date()); refresh(); }
    };
    window.addEventListener('todos-changed', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      clearInterval(tick);
      window.removeEventListener('todos-changed', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const scopeIds = useMemo(
    () => (currentAccountId ? [String(currentAccountId), ...descendantAccountIds(accounts, currentAccountId).map(String)] : []),
    [accounts, currentAccountId]
  );
  const scoped = useMemo(() => todos.filter(item => inScope(item, scopeIds)), [todos, scopeIds]);
  const badge = useMemo(() => badgeCount(scoped, now, zone), [scoped, now, zone]);
  const allBadge = useMemo(() => badgeCount(todos, now, zone), [todos, now, zone]);

  // The app icon: everything the menu's badges count, over all accounts.
  useEffect(() => {
    const apply = () => setAppBadge(brokerTotal + allBadge);
    apply();
    window.addEventListener(APP_BADGE_PERMISSION_EVENT, apply);
    return () => window.removeEventListener(APP_BADGE_PERMISSION_EVENT, apply);
  }, [brokerTotal, allBadge]);

  // Creates (no id) or changes an item; resolves the saved item, rejects
  // with the server's message.
  const save = useCallback(async (id, body) => {
    const saved = await request(id ? `${API}/${id}` : API, {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(body),
    });
    setTodos(list => (id ? list.map(t => (t.id === id ? saved : t)) : [...list, saved]));
    refresh();
    return saved;
  }, [refresh]);

  const remove = useCallback(async (id) => {
    await request(`${API}/${id}`, { method: 'DELETE' });
    setTodos(list => list.filter(t => t.id !== id));
    refresh();
  }, [refresh]);

  // The user has seen these fired items (on the Todo page).
  const markSeen = useCallback(async (ids) => {
    if (!ids || ids.length === 0) return;
    await request(`${API}/seen`, { method: 'POST', body: JSON.stringify({ ids }) }).catch(() => {});
    refresh();
  }, [refresh]);

  // Closed items older than the ones loaded, in scope, newest first (the
  // newest 1000 of every account).
  const loadOlderClosed = useCallback(async () => {
    const data = await request(`${API}?closed_before=${encodeURIComponent(closedSince())}`);
    return (data.todos || []).filter(t => inScope(t, scopeIds));
  }, [scopeIds]);

  const value = useMemo(
    () => ({ todos, scoped, loaded, loadFailed, badge, zone, now, refresh, save, remove, markSeen, loadOlderClosed }),
    [todos, scoped, loaded, loadFailed, badge, zone, now, refresh, save, remove, markSeen, loadOlderClosed]
  );
  return <TodosContext.Provider value={value}>{children}</TodosContext.Provider>;
}

export const useTodos = () => useContext(TodosContext);
