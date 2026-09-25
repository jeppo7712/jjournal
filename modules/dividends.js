const { logger } = require('./logger.js');

// A dividend's cash effect is derived from its row in `dividends`, never
// edited directly: a DIVIDEND ledger row for the gross amount and, when tax
// was withheld, a WITHHOLDING_TAX row for minus that tax. Both are rebuilt
// from scratch on every change, the same way trade settlement is (see
// settleTradeActionsToCash in routes/trades.js), so the ledger can't drift
// from the dividend it describes. A dismissed dividend has no ledger rows.
//
// `db` is a pg client inside the caller's transaction, or a pool.
async function syncDividendLedger(db, dividendId) {
    await db.query(`DELETE FROM cash_transactions WHERE linked_dividend_id = $1`, [dividendId]);

    const { rows } = await db.query(`SELECT * FROM dividends WHERE id = $1`, [dividendId]);
    const dividend = rows[0];
    if (!dividend || dividend.dismissed) return;

    const label = dividend.kind === 'PAYMENT_IN_LIEU'
        ? `${dividend.symbol} payment in lieu of dividend`
        : `${dividend.symbol} dividend`;
    // Built in SQL straight from the row so pay_date (a DATE) never passes
    // through a JS Date, which the pg driver would shift by the server's
    // UTC offset. Booked at midnight UTC, the same instant a date-only
    // manual cash entry from the Capital page gets.
    await db.query(
        `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, linked_dividend_id, note)
         SELECT account_id, pay_date::timestamp AT TIME ZONE 'UTC', 'DIVIDEND', gross_amount, currency, id, $2
         FROM dividends WHERE id = $1`,
        [dividend.id, label]
    );
    await db.query(
        `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, linked_dividend_id, note)
         SELECT account_id, pay_date::timestamp AT TIME ZONE 'UTC', 'WITHHOLDING_TAX', -withholding_tax, currency, id, $2
         FROM dividends WHERE id = $1 AND withholding_tax <> 0`,
        [dividend.id, `${label}: tax withheld`]
    );
    logger.debug(`[Dividends] ledger synced for dividend ${dividend.id} (${dividend.symbol})`);
}

module.exports = { syncDividendLedger };
