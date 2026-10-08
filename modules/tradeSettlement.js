const { DateTime } = require('luxon');
const { logger } = require('./logger.js');
const { resolveTradeCurrency, getFuturesSetting, settlementEntries, settlementNote } = require('./tradeCalculations.js');

// A trade's cash in the ledger: one TRADE_SETTLEMENT row per fill, on its
// own date (settlementEntries), rebuilt from scratch whenever the trade
// changes. docs/CAPITAL_TRACKING_DESIGN.md.
//
// accounts.opening_covers_before, on a top-level account: its opening
// balance was taken from the broker's cash on that day, so it already holds
// every fill before it — those book no cash (they'd count twice). Unset (the
// default), every fill books its cash: an opening balance entered as if the
// earlier trades hadn't happened yet.

async function openingCoversBefore(db, accountId) {
    const { rows } = await db.query(
        `WITH RECURSIVE up AS (
            SELECT id, parent_account_id FROM accounts WHERE id = $1
            UNION SELECT a.id, a.parent_account_id FROM accounts a JOIN up u ON a.id = u.parent_account_id
        )
        SELECT a.opening_covers_before::text AS cutoff FROM up JOIN accounts a ON a.id = up.id WHERE up.parent_account_id IS NULL`,
        [accountId]
    );
    return rows[0]?.cutoff || null;
}

// The calendar day of a fill where it traded: the broker's statement (and
// so an opening balance taken from it) closes the day in the market's own
// time. In UTC a New York evening fill would already be the next day.
const DEFAULT_TIMEZONE = 'America/New_York';
function fillDay(dateTime, timezone) {
    const dt = DateTime.fromJSDate(new Date(dateTime), { zone: timezone || DEFAULT_TIMEZONE });
    return (dt.isValid ? dt : DateTime.fromJSDate(new Date(dateTime), { zone: DEFAULT_TIMEZONE })).toISODate();
}

// The timezone of the exchange the symbol's setting names, if any.
async function exchangeTimezone(db, symbol, type, allSettings) {
    const setting = getFuturesSetting(symbol, type, allSettings);
    if (!setting || !setting.exchange) return null;
    const { rows } = await db.query('SELECT timezone FROM exchanges WHERE name = $1', [setting.exchange]);
    return rows[0]?.timezone || null;
}

/**
 * Books a trade's fills as cash. Its old rows must already be gone.
 * @returns {{ currencyResolved: boolean }}
 */
async function settleTrade(db, { tradeId, accountId, type, symbol, actions, tickSize, tickValue }) {
    if (!actions || actions.length === 0) return { currencyResolved: true };
    // The symbol's currency, through the same startsWith+DEFAULT logic the
    // rest of the app uses (an exact match missed MNQZ5 for an "MNQ" setting).
    const { rows: allSettings } = await db.query('SELECT symbol, type, currency, exchange FROM futures_settings');
    const resolved = resolveTradeCurrency(symbol, type, allSettings);
    const currency = resolved || 'USD';
    if (!resolved) logger.warn(`[Settlement] No futures_settings currency for ${symbol} (${type}); settling as USD`);

    const cutoff = await openingCoversBefore(db, accountId);
    const timezone = cutoff ? await exchangeTimezone(db, symbol, type, allSettings) : null;
    for (const entry of settlementEntries(type, actions, tickSize, tickValue)) {
        if (cutoff && fillDay(entry.dateTime, timezone) < cutoff) continue; // in the opening balance
        await db.query(
            `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, linked_trade_id, note)
             VALUES ($1, $2, 'TRADE_SETTLEMENT', $3, $4, $5, $6)`,
            [accountId, entry.dateTime, entry.amount, currency, tradeId, settlementNote(symbol, entry)]
        );
    }
    return { currencyResolved: !!resolved };
}

// Rebuilds the cash of existing trades from their fills (after a trade moved
// account, or an account's opening_covers_before changed).
async function resettleTrades(db, tradeIds) {
    for (const tradeId of tradeIds) {
        const { rows: [trade] } = await db.query(
            `SELECT id, account_id, type, symbol, tick_size, tick_value FROM trades WHERE id = $1`, [tradeId]
        );
        if (!trade) continue;
        const { rows: actions } = await db.query(
            `SELECT type, quantity, price, fee, date_time AS "dateTime" FROM trade_actions WHERE trade_id = $1`, [tradeId]
        );
        await db.query(`DELETE FROM cash_transactions WHERE linked_trade_id = $1`, [tradeId]);
        await settleTrade(db, {
            tradeId, accountId: trade.account_id, type: trade.type, symbol: trade.symbol,
            actions, tickSize: trade.tick_size, tickValue: trade.tick_value,
        });
    }
}

module.exports = { settleTrade, resettleTrades, openingCoversBefore, fillDay };
