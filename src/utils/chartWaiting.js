// A trade chart waiting for bars: what the server is downloading for its
// symbol and timeframe, in one line, from GET /api/historical/queue-status.
// A real percentage can't be given: IBKR is asked one chunk at a time going
// back until it answers nothing, so the total isn't known in advance.
import { DateTime } from 'luxon';
import { timeframeLabel } from './timeframeLabel.js';

const INTRADAY = ['1M', '5M', '15M'];

function formatChunkDate(iso, timeframe) {
  const dt = DateTime.fromISO(iso);
  if (!dt.isValid) return '';
  return dt.toFormat(INTRADAY.includes(timeframe) ? 'd LLL yyyy' : 'LLL yyyy');
}

/**
 * @param {object} queue - GET /api/historical/queue-status's answer.
 * @param {string} symbol
 * @param {string} timeframe - '1M' … '1W'.
 * @returns {string} what is happening for this symbol+timeframe.
 */
export function describeFetchStatus(queue, symbol, timeframe) {
  const sym = String(symbol || '').toUpperCase();
  const isThis = (t) => !!t && String(t.symbol || '').toUpperCase() === sym && t.timeframe === timeframe;
  const current = queue?.currentTask;
  const pending = Array.isArray(queue?.pendingPreview) ? queue.pendingPreview : [];

  if (isThis(current)) {
    if (current.phase === 'yahoo_only') return 'Downloading from Yahoo…';
    // Chunks name IBKR's symbol (STKA for STKA.L), so they're matched by
    // the running task: only one runs at a time.
    const chunks = (Array.isArray(queue.activeChunks) ? queue.activeChunks : []).filter(c => c.timeframe === timeframe);
    if (chunks.length === 0) return current.phase === 'ibkr_only' ? 'Downloading from IBKR…' : 'Downloading…';
    const from = chunks.map(c => c.chunkStart).sort()[0];
    const to = chunks.map(c => c.chunkEnd).sort().pop();
    const fromText = formatChunkDate(from, timeframe);
    const toText = formatChunkDate(to, timeframe);
    return `Downloading from IBKR: ${fromText === toText ? fromText : `${fromText} – ${toText}`}`;
  }
  if (pending.some(isThis)) {
    return current
      ? `Queued: ${current.symbol} ${timeframeLabel(current.timeframe)} is downloading first`
      : 'Queued…';
  }
  // Beyond the preview this one may still be queued; within it, it isn't.
  if ((queue?.pendingCount || 0) > pending.length) return 'Waiting for other downloads to finish…';
  return `Nothing is downloading for ${timeframeLabel(timeframe)} now: Yahoo and IBKR may have no bars for it`;
}

// 75 s -> "1:15".
export function formatElapsed(ms) {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

// The window to load when the one around a trade holds no stored bars:
// `bars` bars' time ending at the newest stored bar before it, else
// starting at the oldest one after it. Times in ISO; null without either.
export function nearestWindow({ before, after }, bars, barSeconds) {
  const span = bars * barSeconds;
  if (before) {
    const t = DateTime.fromISO(before);
    return { startDate: t.minus({ seconds: span }).toISO(), endDate: t.plus({ seconds: 1 }).toISO() };
  }
  if (after) {
    const t = DateTime.fromISO(after);
    return { startDate: t.minus({ seconds: 1 }).toISO(), endDate: t.plus({ seconds: span }).toISO() };
  }
  return null;
}
