import { useEffect, useRef, useState } from 'react';
import { describeFetchStatus, formatElapsed, nearestWindow } from './chartWaiting';

const API = process.env.REACT_APP_API_URL;
const POLL_MS = 2000;
const RESUME_WAIT_MS = 10000;

/**
 * While `active` (a chart waiting for its first bars): what the server is
 * downloading for this symbol+timeframe, and how long the chart has waited.
 * @returns {{ status: string|null, elapsed: string }}
 */
export function useFetchStatus(active, symbol, timeframe) {
  const [status, setStatus] = useState(null);
  const [elapsed, setElapsed] = useState('0:00');
  // One wait can be several short ones: each new-bars message reloads the
  // chart, which ends the wait for a moment. The clock goes on through
  // those, it restarts only for another chart or after a real pause.
  const waitRef = useRef({ key: null, startedAt: 0, endedAt: 0 });

  useEffect(() => {
    if (!active || !symbol) return undefined;
    const key = `${symbol}|${timeframe}`;
    const now = Date.now();
    const wait = waitRef.current;
    if (wait.key !== key || now - wait.endedAt > RESUME_WAIT_MS) {
      waitRef.current = { key, startedAt: now, endedAt: 0 };
      setStatus(null);
      setElapsed('0:00');
    }
    const { startedAt } = waitRef.current;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API}/api/historical/queue-status`);
        if (res.ok) {
          const queue = await res.json();
          if (!stopped) setStatus(describeFetchStatus(queue, symbol, timeframe));
        }
      } catch {
        // The next poll tries again; the spinner stays meanwhile.
      }
    };
    poll();
    const pollTimer = setInterval(poll, POLL_MS);
    const clock = setInterval(() => setElapsed(formatElapsed(Date.now() - startedAt)), 1000);
    return () => {
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(clock);
      waitRef.current.endedAt = Date.now();
    };
  }, [active, symbol, timeframe]);

  return { status, elapsed };
}

/**
 * The stored bars nearest to a window around a trade that has none (a trade
 * from this morning, before its first bar is complete; a weekend), so the
 * chart shows them instead of waiting for bars that come later or never.
 * Only reads what's stored. null when the series has no stored bars at all.
 */
export async function fetchNearestStoredBars({ symbol, type, timeframe, contractMonth, windowStart, windowEnd, bars, barSeconds, signal }) {
  const base = `symbol=${encodeURIComponent(symbol)}&type=${encodeURIComponent(type)}&timeframe=${timeframe}`
    + (contractMonth ? `&contractMonth=${encodeURIComponent(contractMonth)}` : '');
  const getJson = async (url) => {
    const res = await fetch(url, { headers: { 'x-account-id': '1' }, signal });
    return res.ok ? res.json() : null;
  };
  const before = await getJson(`${API}/api/historical/nearest?${base}&before=${encodeURIComponent(windowEnd)}`);
  const after = before?.time ? null : await getJson(`${API}/api/historical/nearest?${base}&after=${encodeURIComponent(windowStart)}`);
  const range = nearestWindow({ before: before?.time, after: after?.time }, bars, barSeconds);
  if (!range) return null;
  const data = await getJson(`${API}/api/historical/db?${base}&startDate=${encodeURIComponent(range.startDate)}&endDate=${encodeURIComponent(range.endDate)}&noRefresh=true`);
  return Array.isArray(data) && data.length > 0 ? data : null;
}
