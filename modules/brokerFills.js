const { DateTime } = require('luxon');
const { logger } = require('./logger.js');
const { loadConfig } = require('./config.js');
const { getFlexStatements, sectionRows, isPaperIbkrAccountId } = require('../routes/ibkrFlex.js');
const { futuresContractMonth } = require('./ibkrSymbols.js');
const { resettleTrades } = require('./tradeSettlement.js');

// IBKR fills that aren't in the journal yet, so the user hears about a
// filled order even when they missed IBKR's own notification. Every scan
// pulls the Flex queries (Trade Confirmation: today's fills; Activity: the
// history up to yesterday) of both credential sets, real and paper, and
// stores the fills of journal accounts linked to an IBKR account
// (accounts.broker_account_id) from the day watching started
// (accounts.broker_fills_from, set on the first scan) on. Whether a fill is
// in the journal is decided when reading (pendingFills): by its execution
// ID, or for a hand-entered fill by symbol, side, quantity, price and time.
// So a fill drops out as soon as the trade is saved, without a new scan.
//
// broker_fills.status: PENDING (shown unless it's in the journal) or
// DISMISSED (the user said it doesn't belong in the journal).

// Flex reports times in US/Eastern (see FLEX_REPORTED_TIMEZONE in
// TradeModal.jsx, which reads them the same way when importing).
const FLEX_TIMEZONE = 'America/New_York';
// A futures contract code after the root: month letter and year digits.
const CONTRACT_CODE = /^(.+?)([FGHJKMNQUVXZ]\d{1,2})$/;
// How far a hand-entered fill's time may be from IBKR's to count as it.
const HAND_ENTERED_SECONDS = 90;
// The execution ID of the opening part of a fill split at a flip.
const FLIP_SUFFIX = '.flip';
// Fees closer than this to IBKR's are the same fee.
const FEE_TOLERANCE = 0.005;
// Activity statements change once a day; no need to pull them every scan.
const ACTIVITY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const lastActivityPull = new Map(); // query id -> ms

// "20261012;094124" (US/Eastern) -> ISO in UTC; null when unreadable.
function flexTime(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  const time = digits.slice(8, 14).padEnd(6, '0');
  const dt = DateTime.fromFormat(`${digits.slice(0, 8)}${time}`, 'yyyyMMddHHmmss', { zone: FLEX_TIMEZONE });
  return dt.isValid ? dt.toUTC().toISO() : null;
}

/**
 * The fills in Flex statements, one per execution. Rows without an
 * execution ID (summaries, closed lots) and other asset types (currency
 * conversions, options) are left out. A Trade Confirmation query without
 * the asset type says nothing but e.g. "MNQZ6": a known futures root
 * followed by a contract code makes it a future. Pure.
 *
 * @param {object[]} statements
 * @param {Set<string>} futuresRoots  symbols set up as futures in the journal
 */
function parseFills(statements, futuresRoots = new Set()) {
  const fills = new Map();
  for (const statement of statements || []) {
    const rows = [...sectionRows(statement, 'Trades', 'Trade'), ...sectionRows(statement, 'TradeConfirms', 'TradeConfirm')];
    for (const row of rows) {
      const execId = String(row.ibExecID || row.execID || '').trim();
      if (!execId || fills.has(execId)) continue;
      if (row.levelOfDetail && String(row.levelOfDetail).toUpperCase() !== 'EXECUTION') continue;
      const rawSymbol = String(row.symbol || '').trim().toUpperCase();
      const code = rawSymbol.match(CONTRACT_CODE);
      let type = String(row.assetCategory || '').toUpperCase();
      if (!type) type = code && futuresRoots.has(code[1]) ? 'FUT' : 'STK';
      if (type !== 'FUT' && type !== 'STK') continue;
      const symbol = String(row.underlyingSymbol || '').trim().toUpperCase()
        || (type === 'FUT' && code ? code[1] : rawSymbol);
      const dateTime = flexTime(row.dateTime || row.tradeDate);
      const quantity = Math.abs(Number(row.quantity));
      const price = Number(row.tradePrice ?? row.price);
      if (!symbol || !dateTime || !(quantity > 0) || !Number.isFinite(price)) continue;
      fills.set(execId, {
        execId,
        brokerAccountId: String(row.accountId || statement.accountId || '').toUpperCase(),
        type,
        symbol,
        rawSymbol,
        contractMonth: type === 'FUT'
          ? futuresContractMonth({ localSymbol: row.localSymbol, symbol: row.symbol, expiry: row.expiry }, row.tradeDate || row.dateTime)
          : null,
        side: String(row.buySell || '').toUpperCase().startsWith('S') ? 'SELL' : 'BUY',
        quantity,
        price,
        commission: commissionOf(row),
        commissionCurrency: String(row.ibCommissionCurrency || row.commissionCurrency || '').toUpperCase() || null,
        currency: String(row.currency || '').toUpperCase() || null,
        exchange: String(row.listingExchange || row.exchange || '').toUpperCase() || null,
        dateTime,
      });
    }
  }
  return [...fills.values()];
}

// IBKR's fee for a fill, positive; null when the query doesn't have the
// field (a Trade Confirmation query without Commission): an unknown fee,
// not a zero one, or the fee check would set the journal's fees to 0.
function commissionOf(row) {
  const raw = row.ibCommission ?? row.commission;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = Math.abs(Number(raw));
  return Number.isFinite(value) ? value : null;
}

// One credential set's statements: Trade Confirmation every scan, Activity
// a few times a day. A query that fails is skipped; the next scan retries.
async function pullStatements(config, set) {
  const token = config[`ibkrFlexToken${set}`];
  if (!token) return [];
  const queries = [
    { id: config[`ibkrFlexQueryIdTradeConf${set}`], every: 0 },
    { id: config[`ibkrFlexQueryIdActivity${set}`], every: ACTIVITY_INTERVAL_MS },
  ].filter(q => q.id);
  const statements = [];
  // One at a time: IBKR refuses concurrent requests under one token.
  for (const q of queries) {
    if (q.every && Date.now() - (lastActivityPull.get(q.id) || 0) < q.every) continue;
    try {
      const result = await getFlexStatements(token, q.id);
      if (q.every) lastActivityPull.set(q.id, Date.now());
      // Real and paper never mix: a statement of the other kind is ignored.
      statements.push(...result.statements.filter(s => isPaperIbkrAccountId(s.accountId) === (set === 'Paper')));
    } catch (err) {
      // A paused query was announced once when it paused (ibkrFlex.js).
      const line = `[BrokerFills] ${set.toLowerCase()} Flex query ${q.id} failed: ${err.message}`;
      if (/paused until/.test(err.message)) logger.debug(line);
      else logger.warn(line);
    }
  }
  return statements;
}

async function scanBrokerFills(pool) {
  const { rows: accounts } = await pool.query(
    `SELECT id, name, broker_account_id, broker_fills_from::text AS broker_fills_from FROM accounts
     WHERE parent_account_id IS NULL AND broker_account_id IS NOT NULL AND broker_account_id <> '' AND NOT archived`
  );
  if (accounts.length === 0) return { added: 0 };
  const { rows: roots } = await pool.query(`SELECT DISTINCT UPPER(symbol) AS symbol FROM futures_settings WHERE type = 'FUT'`);
  const futuresRoots = new Set(roots.map(r => r.symbol));
  const config = await loadConfig();
  const fills = [];
  for (const set of ['Real', 'Paper']) fills.push(...parseFills(await pullStatements(config, set), futuresRoots));

  let added = 0;
  for (const account of accounts) {
    let from = account.broker_fills_from;
    if (!from) {
      // Watching starts today: older fills were handled (or not) before.
      from = DateTime.now().setZone(FLEX_TIMEZONE).toISODate();
      await pool.query(`UPDATE accounts SET broker_fills_from = $2 WHERE id = $1`, [account.id, from]);
    }
    const start = DateTime.fromISO(from, { zone: FLEX_TIMEZONE }).toUTC().toISO();
    for (const f of fills) {
      if (f.brokerAccountId !== account.broker_account_id.toUpperCase() || f.dateTime < start) continue;
      const { rows } = await pool.query(
        `INSERT INTO broker_fills (account_id, source, exec_id, broker_account_id, type, symbol, raw_symbol, contract_month,
                                   side, quantity, price, commission, currency, exchange, date_time, commission_currency)
         VALUES ($1, 'IBKR', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (source, exec_id) DO UPDATE SET commission = EXCLUDED.commission, commission_currency = EXCLUDED.commission_currency,
                                                     updated_at = NOW()
           -- A statement without the fee leaves the one already known.
           WHERE EXCLUDED.commission IS NOT NULL
             AND (broker_fills.commission IS DISTINCT FROM EXCLUDED.commission
              OR broker_fills.commission_currency IS DISTINCT FROM EXCLUDED.commission_currency)
         RETURNING (xmax = 0) AS inserted`,
        [account.id, f.execId, f.brokerAccountId, f.type, f.symbol, f.rawSymbol, f.contractMonth,
         f.side, f.quantity, f.price, f.commission, f.currency, f.exchange, f.dateTime, f.commissionCurrency]
      );
      added += rows.filter(r => r.inserted).length;
    }
  }
  if (added > 0) logger.info(`[BrokerFills] ${added} new IBKR fill(s) recorded`);
  const corrected = await correctFees(pool);
  return { added, corrected };
}

/**
 * Sets the fee of journal fills to what IBKR charged, by execution ID, and
 * rebuilds the trade's cash. A TWS import takes the fee from a commission
 * report TWS sends after the fill; when it hadn't arrived yet the fill was
 * saved with no fee, and the journal's cash drifted from IBKR's by it. A
 * fee IBKR charged in another currency than the fill's is left alone.
 */
async function correctFees(pool) {
  const { rows } = await pool.query(
    `SELECT ta.id AS action_id, ta.trade_id, ta.fee, f.id AS fill_id, f.commission, f.symbol, f.side, f.quantity::float AS quantity
     FROM broker_fills f JOIN trade_actions ta ON ta.exec_id = f.exec_id
     WHERE f.commission IS NOT NULL
       -- The same fill: one that also holds other fills (merged by hand) keeps its fee.
       AND ta.type = f.side AND ta.quantity = f.quantity
       AND (f.commission_currency IS NULL OR f.currency IS NULL OR f.commission_currency = f.currency)
       AND ABS(COALESCE(ta.fee, 0) - f.commission) >= $1`,
    [FEE_TOLERANCE]
  );
  let corrected = 0;
  for (const r of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Only if the journal still has the fee read above (the user may be saving the trade).
      const { rowCount } = await client.query(
        `UPDATE trade_actions SET fee = $2 WHERE id = $1 AND fee IS NOT DISTINCT FROM $3`,
        [r.action_id, r.commission, r.fee]
      );
      if (rowCount === 0) { await client.query('ROLLBACK'); continue; }
      await client.query(
        `UPDATE broker_fills SET journal_fee_was = $2, fee_corrected_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [r.fill_id, r.fee ?? 0]
      );
      await resettleTrades(client, [r.trade_id]);
      await client.query('COMMIT');
      corrected++;
      logger.info(`[BrokerFills] fee of ${r.symbol} ${r.side} ${r.quantity} (trade ${r.trade_id}) set to IBKR's ${Number(r.commission)} (was ${Number(r.fee ?? 0)})`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.warn(`[BrokerFills] fee correction of trade ${r.trade_id} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
  return corrected;
}

/**
 * Fills waiting for the user: PENDING, and not in the journal under the
 * account they belong to (or any of its sub-accounts) — by execution ID,
 * or entered by hand with the same symbol, side, quantity and price within
 * HAND_ENTERED_SECONDS. An execution ID anywhere in the journal counts
 * (for a fill split at a flip, both its parts).
 */
async function pendingFills(db) {
  const { rows } = await db.query(
    `WITH RECURSIVE tree AS (
        SELECT id AS root, id FROM accounts WHERE parent_account_id IS NULL
        UNION ALL SELECT t.root, a.id FROM accounts a JOIN tree t ON a.parent_account_id = t.id
     )
     SELECT f.id, f.account_id, a.name AS account_name, f.exec_id, f.type, f.symbol, f.raw_symbol, f.contract_month, f.side,
            f.quantity::float AS quantity, f.price::float AS price, f.commission::float AS commission,
            f.currency, f.exchange, f.date_time
     FROM broker_fills f JOIN accounts a ON a.id = f.account_id
     WHERE f.status = 'PENDING'
       -- A fill the import split at a flip (routes/ibkr.js) is in two
       -- trades: its own ID on the closing part, FLIP_SUFFIX on the other.
       -- It's in the journal once both are.
       AND NOT EXISTS (
         SELECT 1 FROM trade_actions ta WHERE ta.exec_id = f.exec_id
           AND (ta.quantity >= f.quantity OR EXISTS (SELECT 1 FROM trade_actions tf WHERE tf.exec_id = f.exec_id || '${FLIP_SUFFIX}'))
       )
       AND NOT EXISTS (
         SELECT 1 FROM trade_actions ta
         JOIN trades t ON t.id = ta.trade_id
         JOIN tree tr ON tr.root = f.account_id AND tr.id = t.account_id
         WHERE ta.exec_id IS NULL AND ta.type = f.side AND ta.quantity = f.quantity
           AND ABS(ta.price - f.price) < 0.000001
           AND ABS(EXTRACT(EPOCH FROM ta.date_time - f.date_time)) <= $1
           AND (UPPER(t.symbol) = f.symbol OR UPPER(t.symbol) LIKE f.symbol || '.%')
       )
     ORDER BY f.date_time`,
    [HAND_ENTERED_SECONDS]
  );
  return rows;
}

module.exports = { parseFills, flexTime, scanBrokerFills, correctFees, pendingFills, FLIP_SUFFIX };
