const { XMLParser } = require('fast-xml-parser'); // npm install fast-xml-parser --save
const { logger } = require('../modules/logger.js');

// ─── IBKR Flex Web Service ────────────────────────────────────────────────
// Unlike TWS reqExecutions (only sees the current session), Flex Queries pull
// trade confirmations directly from IB's servers. Two query types are meant
// to be combined here:
//   - Activity Flex Query: wide date range (e.g. "Last 365 Calendar Days"),
//     but only refreshes end-of-day — won't show today's trades.
//   - Trade Confirmation Flex Query: same-day trades, ready roughly
//     15-30 minutes after each fill, but period is fixed to "Today".
// Used together, TWS is no longer needed at all.
//
// One-time setup on IB's Account Management site (repeat for each query type):
//   1. Reports (or Performance & Reports) → Flex Queries → create one
//      Activity Flex Query (Trades → Executions section, period: Last 365
//      Calendar Days) and one Trade Confirmation Flex Query (Executions,
//      period is locked to Today). Note each Query ID.
//   2. Settings → Account Settings → Flex Web Service → enable it,
//      generate a token, and copy it. One token works for both queries.
//   3. Enter the token and both Query IDs in the app's Settings → TWS tab.
//
// IB rate-limits this to roughly one request per statement per 5-10 minutes,
// so this is meant to be called on-demand from the UI, not polled.

const FLEX_BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';

// Converts whatever date/time format Flex returns (e.g. "20250110;123456" or
// "20250110;123456 EST") into "yyyyMMdd HH:mm:ss", the exact format the
// front end's parseIBKRTime() already expects (same format TWS uses).
function formatFlexDateTime(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, ''); // strip separators/timezone letters
  const datePart = digits.slice(0, 8);
  const timeDigits = digits.slice(8, 14).padEnd(6, '0');
  const timePart = `${timeDigits.slice(0, 2)}:${timeDigits.slice(2, 4)}:${timeDigits.slice(4, 6)}`;
  return `${datePart} ${timePart}`;
}

// Runs the SendRequest → GetStatement flow and returns the raw <Trade> entries.
async function requestFlexStatement(token, queryId) {
  const sendUrl = `${FLEX_BASE}/SendRequest?t=${token}&q=${queryId}&v=3`;
  const sendRes = await fetch(sendUrl);
  if (!sendRes.ok) {
    throw new Error(`Flex SendRequest HTTP ${sendRes.status} for query ${queryId}`);
  }
  const sendXml = await sendRes.text();
  const sendParsed = new XMLParser().parse(sendXml);

  const status = sendParsed?.FlexStatementResponse?.Status;
  if (status !== 'Success') {
    const errMsg = sendParsed?.FlexStatementResponse?.ErrorMessage || 'Unknown Flex error';
    throw new Error(`Flex request failed for query ${queryId}: ${errMsg}`);
  }
  const refCode = sendParsed.FlexStatementResponse.ReferenceCode;
  logger.debug(`[Flex] reference code ${refCode}, polling for statement…`);

  const getUrl = `${FLEX_BASE}/GetStatement?q=${refCode}&t=${token}&v=3`;
  const maxAttempts = 10;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, 3000));

    const res = await fetch(getUrl);
    if (!res.ok) {
      throw new Error(`Flex GetStatement HTTP ${res.status} for query ${queryId} (attempt ${attempt})`);
    }
    const xml = await res.text();

    // A "not ready yet" (or error) response comes back wrapped in <FlexStatementResponse>.
    // A ready one comes back as a raw <FlexQueryResponse> with the trade data.
    // Anything that's neither is unexpected (rate-limit text, a proxy error page,
    // a truncated body, etc.) — treat it as a hard error rather than silently
    // parsing it into an empty result, which previously looked identical to
    // "genuinely zero trades" from the caller's perspective.
    if (xml.includes('<FlexStatementResponse')) {
      const parsed = new XMLParser().parse(xml);
      const errMsg = parsed?.FlexStatementResponse?.ErrorMessage;
      if (errMsg && !errMsg.toLowerCase().includes('not yet available')) {
        throw new Error(`Flex statement failed for query ${queryId}: ${errMsg}`);
      }
      logger.debug(`[Flex] attempt ${attempt}: statement not ready yet`);
      continue;
    }

    if (!xml.includes('<FlexQueryResponse')) {
      const snippet = xml.slice(0, 300).replace(/\s+/g, ' ').trim();
      throw new Error(`Flex GetStatement for query ${queryId} returned an unrecognized response (not FlexStatementResponse or FlexQueryResponse): "${snippet}"`);
    }

    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const statement = parsed?.FlexQueryResponse?.FlexStatements?.FlexStatement;
    // Handle either a single statement or an array (multi-account queries)
    const statements = Array.isArray(statement) ? statement : [statement].filter(Boolean);

    if (statements.length === 0) {
      // FlexQueryResponse root was present but had no FlexStatement inside it —
      // genuinely malformed rather than "zero trades" (a real empty result still
      // has a FlexStatement with an empty/absent Trades node, handled below).
      const snippet = xml.slice(0, 300).replace(/\s+/g, ' ').trim();
      throw new Error(`Flex GetStatement for query ${queryId} returned no FlexStatement: "${snippet}"`);
    }

    const allTrades = statements.flatMap(s => {
      // Activity Flex Query ("Trades" section, type="AF") uses <Trades><Trade>.
      // Trade Confirmation Flex Query (type="TCF") uses <TradeConfirms><TradeConfirm>
      // instead — different tag, and (below) some different field names too.
      const activityTrades = s?.Trades?.Trade;
      const confirmTrades = s?.TradeConfirms?.TradeConfirm;
      const combined = [
        ...(activityTrades ? (Array.isArray(activityTrades) ? activityTrades : [activityTrades]) : []),
        ...(confirmTrades ? (Array.isArray(confirmTrades) ? confirmTrades : [confirmTrades]) : []),
      ];
      return combined;
    });

    logger.debug(`[Flex] query ${queryId} statement ready, ${allTrades.length} raw trade rows`);
    return allTrades;
  }

  throw new Error(`Flex GetStatement for query ${queryId} timed out — IB did not finish generating the report in time`);
}

// ─── In-memory cache for raw Flex pulls ───────────────────────────────────
// IB only refreshes Flex report data every 5-10 minutes on their end, so
// re-fetching more often than that gains nothing except getting rate-limited.
// Cache the raw (all-symbols) pull here; each symbol's fetch just re-filters
// the cached data instead of hitting IBKR again.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let rawTradesCache = null; // { key, trades, fetchedAt }

function cacheKeyFor(queryIds) {
  return [...queryIds].sort().join(',');
}

// Fetches raw (unfiltered, all-symbols) trade rows from all configured Flex
// queries, using the cache when it's fresh and matches the same query IDs.
async function fetchRawFlexTrades(token, queryIds, { forceRefresh = false } = {}) {
  const ids = (Array.isArray(queryIds) ? queryIds : [queryIds]).filter(Boolean);
  if (ids.length === 0) throw new Error('No Flex Query ID configured');
  const key = cacheKeyFor(ids);

  const isFresh = rawTradesCache
    && rawTradesCache.key === key
    && (Date.now() - rawTradesCache.fetchedAt) < CACHE_TTL_MS;

  if (isFresh && !forceRefresh) {
    logger.debug(`[Flex] serving from cache (${Math.round((Date.now() - rawTradesCache.fetchedAt) / 1000)}s old)`);
    return { trades: rawTradesCache.trades, fetchedAt: rawTradesCache.fetchedAt, fromCache: true, failedQueryIds: rawTradesCache.failedQueryIds || [] };
  }

  // Fetch each configured query one at a time, NOT in parallel. IBKR's Flex
  // Web Service appears to reject a second concurrent request under the same
  // token with "Too many requests have been made from this token" — this is
  // a concurrency limit, not a time-based one, so waiting between attempts
  // doesn't help if two queries are always fired together. A failing query
  // still doesn't block the other from returning data; it just runs after it.
  const results = [];
  for (const id of ids) {
    try {
      const trades = await requestFlexStatement(token, id);
      results.push({ status: 'fulfilled', value: trades });
    } catch (err) {
      results.push({ status: 'rejected', reason: err });
    }
  }

  const trades = [];
  const failedQueryIds = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      trades.push(...r.value);
    } else {
      logger.warn(`[Flex] query ${ids[i]} failed: ${r.reason?.message || r.reason}`);
      failedQueryIds.push(ids[i]);
    }
  });

  if (trades.length === 0 && results.every(r => r.status === 'rejected')) {
    // All configured queries failed outright. Fall back to a stale cache
    // rather than surfacing an error, if one happens to exist — better to
    // show slightly old data than nothing when IB is having a hiccup.
    if (rawTradesCache && rawTradesCache.key === key) {
      logger.warn('[Flex] all queries failed, falling back to stale cache');
      return { trades: rawTradesCache.trades, fetchedAt: rawTradesCache.fetchedAt, fromCache: true, stale: true, failedQueryIds: [] };
    }
    throw new Error(results[0].reason?.message || 'All Flex queries failed');
  }

  const fetchedAt = Date.now();
  rawTradesCache = { key, trades, fetchedAt, failedQueryIds };
  logger.debug(`[Flex] fetched fresh, ${trades.length} raw rows across ${ids.length} quer${ids.length !== 1 ? 'ies' : 'y'}${failedQueryIds.length ? ` (${failedQueryIds.length} failed)` : ''}`);
  return { trades, fetchedAt, fromCache: false, failedQueryIds };
}

// Filters + maps raw Flex trade rows down to one symbol's executions,
// shaped to match TWS's fetchExecutions() output.
function filterAndMapExecutions(rawTrades, symbol, effectiveType) {
  const upperSymbol = symbol.toUpperCase();

  // Futures come back with the FULL contract symbol in `symbol`
  // (e.g. "MNQU6" for a Sept 2026 MNQ contract), not the bare root "MNQ".
  // Match on: exact symbol, symbol starting with the root, or a separate
  // underlyingSymbol field if the query happens to include it.
  const matchesSymbol = (t) => {
    const rawSymbol = String(t.symbol || '').toUpperCase();
    const underlying = String(t.underlyingSymbol || '').toUpperCase();
    return rawSymbol === upperSymbol || rawSymbol.startsWith(upperSymbol) || underlying === upperSymbol;
  };

  // Only enforce the assetCategory check if the query actually includes that
  // field — otherwise every row gets silently dropped for no reason.
  const matchesType = (t) => {
    if (t.assetCategory === undefined) return true;
    return String(t.assetCategory).toUpperCase() === effectiveType;
  };

  const filtered = rawTrades.filter(t => matchesSymbol(t) && matchesType(t));

  if (filtered.length === 0 && rawTrades.length > 0) {
    logger.warn(`[Flex] 0/${rawTrades.length} rows matched symbol=${upperSymbol} type=${effectiveType} — sample row: ${JSON.stringify(rawTrades[0])}`);
  }

  const mapped = filtered.map(t => {
      // Activity Trade rows use ibExecID/tradePrice/ibCommission/ibOrderID;
      // Trade Confirmation rows use execID/price/commission and have no order ID.
      const execId = t.ibExecID || t.execID;
      return {
        execId,
        orderId: t.ibOrderID || execId,
        permId: null,
        time: formatFlexDateTime(t.dateTime || t.tradeDate),
        side: String(t.buySell || '').toUpperCase() === 'BUY' ? 'BOT' : 'SLD',
        quantity: Math.abs(Number(t.quantity)),
        price: Number(t.tradePrice ?? t.price),
        commission: Math.abs(Number(t.ibCommission ?? t.commission ?? 0)),
      };
    });

  // The same fill can legitimately appear in both queries (e.g. a trade from
  // this morning shows up in both the Trade Confirmation query and, once
  // tonight's Activity refresh runs, the Activity query too). Dedupe by execId.
  const seen = new Set();
  const deduped = [];
  for (const exec of mapped) {
    if (seen.has(exec.execId)) continue;
    seen.add(exec.execId);
    deduped.push(exec);
  }

  return deduped;
}

/**
 * Fetches historical trades for a symbol from one or more Flex queries,
 * merges them, dedupes by execId, and shapes them to match TWS's
 * fetchExecutions() output — so they can go straight into buildBracketGroups().
 *
 * Typically called with two query IDs: an Activity Flex Query (wide date
 * range, but only refreshes end-of-day) and a Trade Confirmation Flex Query
 * (same-day trades, ready ~15-30 min after each fill). Between the two,
 * nothing needs to be pulled from TWS anymore.
 *
 * The raw (all-symbols) pull is cached for a few minutes — see
 * fetchRawFlexTrades above — so fetching several symbols back-to-back
 * (e.g. entering a backlog of trades) only hits IBKR once.
 *
 * @param {string} token         Flex Web Service token (same for all queries on the account)
 * @param {string[]} queryIds    One or more saved Flex Query IDs
 * @param {string} symbol        e.g. "MNQ"
 * @param {string} effectiveType 'STK' | 'FUT'
 * @param {object} [opts]
 * @param {boolean} [opts.forceRefresh] Bypass the cache and hit IBKR directly
 */
async function fetchFlexExecutions(token, queryIds, symbol, effectiveType, opts = {}) {
  const { trades, fetchedAt, fromCache, stale, failedQueryIds } = await fetchRawFlexTrades(token, queryIds, opts);
  const executions = filterAndMapExecutions(trades, symbol, effectiveType);
  logger.debug(`[Flex] ${trades.length} raw rows (${fromCache ? 'cached' : 'fresh'}) → ${executions.length} unique executions for ${symbol.toUpperCase()}`);
  return { executions, fetchedAt, fromCache, stale: !!stale, failedQueryIds: failedQueryIds || [] };
}

module.exports = { fetchFlexExecutions };
