import { DateTime } from 'luxon';

// Daily closes per symbol (ISO date → close) for the Dashboard's unrealised
// P&L chart, kept for the session rather than per mount: leaving the
// Dashboard and coming back used to fetch every symbol again, one request
// each, before the chart could draw. Entries are reused for 10 minutes.

const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // `${type}:${symbol}` → { at, closes }
const inflight = new Map(); // same key → Promise<closes>

const keyOf = (symbol, type) => `${type}:${symbol}`;

function fresh(entry) {
  return entry && Date.now() - entry.at < TTL_MS;
}

function fetchOne(symbol, type) {
  const key = keyOf(symbol, type);
  if (inflight.has(key)) return inflight.get(key);
  const promise = fetch(`${process.env.REACT_APP_API_URL}/api/historical/db?symbol=${encodeURIComponent(symbol)}&type=${type}&timeframe=1D&noRefresh=true`, {
    headers: { 'x-account-id': '1' },
  })
    .then(res => (res.ok ? res.json() : []))
    .then(data => new Map((Array.isArray(data) ? data : []).map(bar => [DateTime.fromISO(bar.time).toISODate(), bar.close])))
    .catch(error => {
      console.error(`Error fetching ${symbol} (${type}):`, error);
      return new Map();
    })
    .then(closes => {
      cache.set(key, { at: Date.now(), closes });
      inflight.delete(key);
      return closes;
    });
  inflight.set(key, promise);
  return promise;
}

// The symbols (of [{ symbol, type }]) with no fresh closes in the cache.
export function missingCloses(list) {
  return list.filter(({ symbol, type }) => !fresh(cache.get(keyOf(symbol, type))));
}

// What the cache holds for these symbols, as { symbol: closes }.
export function cachedCloses(list) {
  const out = {};
  list.forEach(({ symbol, type }) => {
    const entry = cache.get(keyOf(symbol, type));
    if (entry) out[symbol] = entry.closes;
  });
  return out;
}

// Loads whatever is missing, a few requests at a time so a long symbol list
// doesn't queue up behind the browser's per-host connection limit all at
// once, then resolves with { symbol: closes } for the whole list.
export async function loadDailyCloses(list, { concurrency = 4 } = {}) {
  const todo = missingCloses(list);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { symbol, type } = todo[next++];
      await fetchOne(symbol, type);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return cachedCloses(list);
}
