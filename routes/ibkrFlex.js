const { XMLParser } = require('fast-xml-parser'); // npm install fast-xml-parser --save
const { logger } = require('../modules/logger.js');
const { isSameStockListing, futuresContractMonth } = require('../modules/ibkrSymbols.js');

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

// Runs the SendRequest → GetStatement flow and returns the statement(s): one
// per IBKR account the query covers, every section as parsed.
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

    logger.debug(`[Flex] query ${queryId} statement ready, ${statements.length} statement(s)`);
    return { statements, type: parsed?.FlexQueryResponse?.type || null };
  }

  throw new Error(`Flex GetStatement for query ${queryId} timed out — IB did not finish generating the report in time`);
}

// A section's rows as an array, whatever the XML held: several (array), one
// (object), or none (absent, or an empty element parsed as '').
function sectionRows(statement, section, row) {
  const rows = statement?.[section]?.[row];
  if (!rows) return [];
  return Array.isArray(rows) ? rows : [rows];
}

function extractTrades(statements) {
  return statements.flatMap(s => {
    // Activity Flex Query ("Trades" section, type="AF") uses <Trades><Trade>.
    // Trade Confirmation Flex Query (type="TCF") uses <TradeConfirms><TradeConfirm>
    // instead — different tag, and (below) some different field names too.
    const combined = [...sectionRows(s, 'Trades', 'Trade'), ...sectionRows(s, 'TradeConfirms', 'TradeConfirm')];
    // A query without the row-level Account ID field still says whose
    // statement it is; carry that onto each row so the paper/live check
    // (assertAccountKind) can always verify it.
    return combined.map(t => (t.accountId || !s?.accountId ? t : { ...t, accountId: s.accountId }));
  });
}

// ─── In-memory cache for raw Flex pulls ───────────────────────────────────
// IB only refreshes Flex report data every 5-10 minutes on their end, so
// re-fetching more often than that gains nothing except getting rate-limited.
// Cache the raw (all-symbols) pull here; each symbol's fetch just re-filters
// the cached data instead of hitting IBKR again.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Per query ID: { statements, type, fetchedAt }. Shared by everything that
// reads Flex (trade imports, the broker cash sync, the query check), so they
// don't each pull the same statement.
const statementCache = new Map();
// Per query ID: the pull in progress. IBKR refuses a second concurrent
// request under the same token ("Too many requests have been made from this
// token"), so a caller arriving mid-pull waits for that one instead.
const inFlight = new Map();

/**
 * One Flex query's statements, from the cache while fresh.
 * @returns {Promise<{ statements: object[], type: string|null, fetchedAt: number, fromCache: boolean }>}
 */
async function getFlexStatements(token, queryId, { forceRefresh = false } = {}) {
  const cached = statementCache.get(queryId);
  if (cached && !forceRefresh && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    logger.debug(`[Flex] query ${queryId} from cache (${Math.round((Date.now() - cached.fetchedAt) / 1000)}s old)`);
    return { ...cached, fromCache: true };
  }
  if (inFlight.has(queryId)) return inFlight.get(queryId);
  const pull = (async () => {
    try {
      const { statements, type } = await requestFlexStatement(token, queryId);
      const entry = { statements, type, fetchedAt: Date.now() };
      statementCache.set(queryId, entry);
      return { ...entry, fromCache: false };
    } finally {
      inFlight.delete(queryId);
    }
  })();
  inFlight.set(queryId, pull);
  return pull;
}

// Fetches raw (unfiltered, all-symbols) trade rows from all configured Flex
// queries, using the cache when it's fresh.
async function fetchRawFlexTrades(token, queryIds, { forceRefresh = false } = {}) {
  const ids = (Array.isArray(queryIds) ? queryIds : [queryIds]).filter(Boolean);
  if (ids.length === 0) throw new Error('No Flex Query ID configured');

  // One query at a time, NOT in parallel: IBKR's Flex Web Service rejects a
  // second concurrent request under the same token — a concurrency limit,
  // not a time-based one. A failing query still doesn't block the other.
  const trades = [];
  const failedQueryIds = [];
  const fetchedTimes = [];
  let allFromCache = true;
  let stale = false;
  let firstError = null;
  for (const id of ids) {
    try {
      const result = await getFlexStatements(token, id, { forceRefresh });
      trades.push(...extractTrades(result.statements));
      fetchedTimes.push(result.fetchedAt);
      allFromCache = allFromCache && result.fromCache;
    } catch (err) {
      logger.warn(`[Flex] query ${id} failed: ${err.message || err}`);
      firstError = firstError || err;
      // Better slightly old data than nothing when IB is having a hiccup.
      const old = statementCache.get(id);
      if (old) {
        trades.push(...extractTrades(old.statements));
        fetchedTimes.push(old.fetchedAt);
        stale = true;
      } else {
        failedQueryIds.push(id);
      }
    }
  }

  if (failedQueryIds.length === ids.length) {
    throw new Error(firstError?.message || 'All Flex queries failed');
  }
  logger.debug(`[Flex] ${trades.length} raw trade rows across ${ids.length} quer${ids.length !== 1 ? 'ies' : 'y'}${failedQueryIds.length ? ` (${failedQueryIds.length} failed)` : ''}`);
  return { trades, fetchedAt: Math.min(...fetchedTimes), fromCache: allFromCache, stale, failedQueryIds };
}

// Filters + maps raw Flex trade rows down to one symbol's executions,
// shaped to match TWS's fetchExecutions() output. `identity` (from
// modules/ibkrSymbols.js) is how IBKR names a stock: Flex reports XEON on
// IBIS2 for a journal symbol XEON.DE, so stocks are matched on that bare
// ticker plus listing exchange and currency — the exact ticker alone would
// also take e.g. a London GDX line for a US GDX.
function filterAndMapExecutions(rawTrades, symbol, effectiveType, identity = null) {
  const upperSymbol = symbol.toUpperCase();

  // Futures come back with the FULL contract symbol in `symbol`
  // (e.g. "MNQU6" for a Sept 2026 MNQ contract), not the bare root "MNQ".
  // Match on: exact symbol, symbol starting with the root, or a separate
  // underlyingSymbol field if the query happens to include it.
  //
  // A bare prefix match was too loose: "SI" (silver) also took "SILZ5"
  // (micro silver) fills. After the root, a futures symbol may only
  // continue with a contract code (month letter + year digits, "U6"/"U26")
  // or a space-separated expiry ("MNQ   SEP26"). Stocks match exactly.
  const FUTURES_CONTRACT_SUFFIX = /^([FGHJKMNQUVXZ]\d{1,2}|\s.*)$/;
  const matchesSymbol = (t) => {
    if (effectiveType === 'STK' && identity) return isSameStockListing(identity, t);
    const rawSymbol = String(t.symbol || '').toUpperCase();
    const underlying = String(t.underlyingSymbol || '').toUpperCase();
    if (rawSymbol === upperSymbol || underlying === upperSymbol) return true;
    return effectiveType === 'FUT'
      && rawSymbol.startsWith(upperSymbol)
      && FUTURES_CONTRACT_SUFFIX.test(rawSymbol.slice(upperSymbol.length));
  };

  // Only enforce the assetCategory check if the query actually includes that
  // field — otherwise every row gets silently dropped for no reason.
  const matchesType = (t) => {
    if (t.assetCategory === undefined) return true;
    return String(t.assetCategory).toUpperCase() === effectiveType;
  };

  const filtered = rawTrades.filter(t => matchesSymbol(t) && matchesType(t));

  if (filtered.length === 0 && rawTrades.length > 0) {
    // Only what's needed to see why nothing matched: a whole raw row carries
    // the account number and every figure of that trade.
    const seen = [...new Set(rawTrades.map(t => `${t.symbol}@${t.listingExchange || '?'}/${t.currency || '?'}`))].slice(0, 30);
    logger.warn(`[Flex] 0/${rawTrades.length} rows matched symbol=${upperSymbol} type=${effectiveType}${identity ? ` (IBKR ${identity.symbol} ${identity.currency || ''} on ${identity.venues ? identity.venues.join('/') : 'any venue'})` : ''} — symbols present: ${seen.join(', ')}`);
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
        contractMonth: effectiveType === 'FUT'
          ? futuresContractMonth({ localSymbol: t.localSymbol, symbol: t.symbol, expiry: t.expiry }, t.tradeDate || t.dateTime)
          : null,
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

// IBKR paper account IDs start with "D" (e.g. DU…); live ones don't. The
// paper and real Flex settings are separate, but a query ID pasted into the
// wrong slot would otherwise silently import one account type's fills into
// the other. Refuses the whole pull rather than filtering, so the
// misconfiguration gets fixed instead of half-working.
function isPaperIbkrAccountId(accountId) {
  return /^D/i.test(String(accountId || ''));
}

function assertAccountKind(rows, accountKind) {
  const wantPaper = accountKind === 'paper';
  const wrong = rows.filter(r => r.accountId && isPaperIbkrAccountId(r.accountId) !== wantPaper);
  if (wrong.length > 0) {
    const other = wantPaper ? 'live' : 'paper';
    throw new Error(`The ${accountKind === 'paper' ? 'paper' : 'real'} Flex queries returned ${wrong.length} row(s) from a ${other} IBKR account — one of the ${accountKind === 'paper' ? 'paper' : 'real'} Query IDs in Settings → TWS belongs to the ${other} account. Nothing was imported.`);
  }
  const unchecked = rows.filter(r => !r.accountId).length;
  if (unchecked > 0) {
    throw new Error(`${unchecked} Flex row(s) carry no IBKR account ID, so it can't be verified they belong to a ${accountKind} account. Nothing was imported — add the Account ID field to the Flex query.`);
  }
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
 * @param {'live'|'paper'} [opts.accountKind] Refuse rows from the other kind of IBKR account
 * @param {object} [opts.identity] How IBKR names this stock (modules/ibkrSymbols.js)
 */
async function fetchFlexExecutions(token, queryIds, symbol, effectiveType, opts = {}) {
  const { trades, fetchedAt, fromCache, stale, failedQueryIds } = await fetchRawFlexTrades(token, queryIds, opts);
  if (opts.accountKind) assertAccountKind(trades, opts.accountKind);
  const executions = filterAndMapExecutions(trades, symbol, effectiveType, opts.identity || null);
  logger.debug(`[Flex] ${trades.length} raw rows (${fromCache ? 'cached' : 'fresh'}) → ${executions.length} unique executions for ${symbol.toUpperCase()}`);
  return { executions, fetchedAt, fromCache, stale: !!stale, failedQueryIds: failedQueryIds || [] };
}

module.exports = { fetchFlexExecutions, isPaperIbkrAccountId, getFlexStatements, sectionRows, formatFlexDateTime };
