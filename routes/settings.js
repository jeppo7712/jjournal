const express = require('express');
const router = express.Router();
const { logger } = require('../modules/logger.js');
const { DEFAULT_TIMEFRAME_SETTINGS, clearExchangeInfoCache } = require('../modules/historical-data-service.js');
const { resolveTradeCurrency, getFuturesSetting } = require('../modules/tradeCalculations.js');
const { resettleTrades } = require('../modules/tradeSettlement.js');

// A trade's currency is derived from its symbol's settings rather than
// stored (see resolveTradeCurrency), but a TRADE_SETTLEMENT cash row stamps
// the currency at the moment it's written. Correcting a mis-set symbol
// currency therefore reinterprets the trade while leaving its already-
// written settlement row denominated in the old currency — the row's AMOUNT
// was always in the instrument's real currency, only the label was wrong, so
// relabelling is exactly the right fix (it moves the amount into the correct
// per-currency bucket in every balance that reads it).
//
// Reconciles every mismatch rather than just the symbol being edited, so any
// drift that already exists gets healed too. Returns the number of rows fixed.
async function reconcileSettlementCurrencies(client) {
    const { rows: settings } = await client.query('SELECT symbol, type, currency FROM futures_settings');
    const { rows: settlements } = await client.query(
        `SELECT ct.id, ct.currency, t.symbol, t.type
         FROM cash_transactions ct
         JOIN trades t ON t.id = ct.linked_trade_id
         WHERE ct.type = 'TRADE_SETTLEMENT'`
    );

    let fixed = 0;
    for (const row of settlements) {
        const expected = resolveTradeCurrency(row.symbol, row.type, settings) || 'USD';
        if (expected !== row.currency) {
            await client.query('UPDATE cash_transactions SET currency = $1 WHERE id = $2', [expected, row.id]);
            fixed++;
        }
    }
    return fixed;
}

// Trades whose currency would change if `removed` (a futures_settings row)
// went, or became `replacement`: a trade takes its currency from the
// symbol setting it matches (resolveTradeCurrency), and its cash rows
// stamped that currency. Renaming or deleting the setting left them on the
// USD fallback in the journal while their cash stayed in the real one.
async function tradesChangingCurrency(client, removed, replacement = null) {
    const { rows: settings } = await client.query('SELECT symbol, type, currency FROM futures_settings');
    const after = settings.filter(s => !(s.symbol === removed.symbol && s.type === removed.type));
    if (replacement) after.push(replacement);
    const { rows: instruments } = await client.query('SELECT symbol, type, COUNT(*)::int AS count FROM trades GROUP BY symbol, type');
    return instruments
        // USD is what a trade without a setting is counted in (GET /trades, settleTrade).
        .filter(i => (resolveTradeCurrency(i.symbol, i.type, settings) || 'USD') !== (resolveTradeCurrency(i.symbol, i.type, after) || 'USD'))
        .map(i => ({ symbol: i.symbol, count: i.count }));
}

function changingCurrencyMessage(affected, what) {
    const count = affected.reduce((sum, a) => sum + a.count, 0);
    return `${count} trade(s) (${affected.map(a => a.symbol).join(', ')}) take their currency from this setting; ${what} would change it. Add a setting that covers them first, or keep this one.`;
}

// Export a function that accepts dependencies
module.exports = (pool, broadcastStatus, uuidv4) => {

    // --- Futures Settings Endpoints ---

    router.get('/futures-settings', async (req, res) => {
        try {
            const { rows } = await pool.query(`
SELECT fs.symbol, fs.type, fs.tick_size, fs.tick_value, fs.fee, fs.exchange, fs.currency,
       fs.rollover_months, fs.initial_margin, fs.maintenance_margin, fs.timeframe_settings,
       fs.ibkr_symbol, fs.ibkr_exchange, e.timezone
      FROM futures_settings fs
      LEFT JOIN exchanges e ON fs.exchange = e.name
    `);
            res.json(rows);
        } catch (err) {
            broadcastStatus(uuidv4(), `Error fetching futures settings: ${err.message}`, 'error');
            logger.error('Error fetching futures settings:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // Optional IBKR override fields: trimmed, uppercased, blank -> NULL
    // (NULL = translate the journal symbol automatically).
    const cleanIbkrField = (value) => String(value || '').trim().toUpperCase() || null;

    router.post('/futures-settings', async (req, res) => {
const { symbol, type, tick_size, tick_value, fee, exchange, currency, rollover_months, initial_margin, maintenance_margin, timeframe_settings } = req.body;

        if (!symbol || !type || tick_size === undefined || tick_value === undefined || fee === undefined) {
            return res.status(400).json({ error: 'Symbol, type, tick size, tick value, and fee are required' });
        }

// For futures, initial_margin is required
if (type === 'FUT' && (initial_margin === undefined || initial_margin === null)) {
return res.status(400).json({ error: 'Initial margin is required for futures contracts' });
}

        try {
            await pool.query(
'INSERT INTO futures_settings (symbol, type, tick_size, tick_value, fee, exchange, currency, rollover_months, initial_margin, maintenance_margin, timeframe_settings, ibkr_symbol, ibkr_exchange) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
[symbol, type, tick_size, tick_value, fee, exchange || null, currency || 'USD', type === 'FUT' ? rollover_months : null, initial_margin || null, maintenance_margin || null, JSON.stringify(timeframe_settings || DEFAULT_TIMEFRAME_SETTINGS), cleanIbkrField(req.body.ibkr_symbol), cleanIbkrField(req.body.ibkr_exchange)]
            );
            res.json({ success: true });
        } catch (err) {
            if (err.code === '23505') {
                res.status(409).json({ error: 'Symbol and type combination already exists' });
            } else {
                res.status(500).json({ error: err.message });
            }
        }
    });

    router.put('/futures-settings', async (req, res) => {
const { symbol, type, tick_size, tick_value, fee, exchange, currency, rollover_months, initial_margin, maintenance_margin, timeframe_settings, originalSymbol, originalType } = req.body;

        if (!symbol || !type || tick_size === undefined || tick_value === undefined || fee === undefined) {
            return res.status(400).json({ error: 'New symbol, type, tick size, tick value, and fee are required' });
        }
        if (!originalSymbol || !originalType) {
            return res.status(400).json({ error: 'Original symbol and type are required for updating' });
        }

// For futures, initial_margin is required
if (type === 'FUT' && (initial_margin === undefined || initial_margin === null)) {
return res.status(400).json({ error: 'Initial margin is required for futures contracts' });
}

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows: existingSettings } = await client.query(
                'SELECT id, exchange, currency, timeframe_settings FROM futures_settings WHERE symbol = $1 AND type = $2',
                [originalSymbol, originalType]
            );
            if (existingSettings.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Original symbol and type not found' });
            }
            const futuresSettingId = existingSettings[0].id;
            if (symbol !== originalSymbol || type !== originalType) {
                const affected = await tradesChangingCurrency(client, { symbol: originalSymbol, type: originalType },
                    { symbol, type, currency: (currency || 'USD').toUpperCase() });
                if (affected.length > 0) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({ error: changingCurrencyMessage(affected, 'renaming it') });
                }
            }
            const currentExchangeInDb = existingSettings[0].exchange;
            // Preserve the existing value if the request didn't include one, rather
            // than silently resetting it to the (smaller, new-symbol) default.
            const resolvedTimeframeSettings = timeframe_settings || existingSettings[0].timeframe_settings || DEFAULT_TIMEFRAME_SETTINGS;
            const symbolChanged = symbol.toUpperCase() !== originalSymbol.toUpperCase();
            const typeChanged = type !== originalType;
            const newExchangeNormalized = exchange || null;
            const currentExchangeNormalized = currentExchangeInDb || null;
            const exchangeChanged = newExchangeNormalized !== currentExchangeNormalized;
            // Currency identifies which real-world instrument this is fetched
            // from IBKR (contract lookups key on it), same as exchange — a
            // change here means "this is now a different instrument," so
            // stored historical data needs invalidating the same way.
            const newCurrencyNormalized = (currency || 'USD').toUpperCase();
            const currentCurrencyNormalized = (existingSettings[0].currency || 'USD').toUpperCase();
            const currencyChanged = newCurrencyNormalized !== currentCurrencyNormalized;
            if (symbolChanged || typeChanged || exchangeChanged || currencyChanged) {
                logger.info(`[FuturesSettings] Key identifier changed for ${originalSymbol}/${originalType}. Deleting associated historical data (ID: ${futuresSettingId}).`);
                await client.query('DELETE FROM historical_data WHERE futures_setting_id = $1', [futuresSettingId]);
                broadcastStatus(uuidv4(), `Historical data for old settings of ${originalSymbol} (${originalType}) deleted due to settings change.`, 'info');
            }
            // client.query, not pool.query — this runs inside the BEGIN above,
            // so a later failure/ROLLBACK has to be able to undo it. On a
            // separate pool connection it committed independently of the
            // transaction that deleted this symbol's historical data.
            const { rowCount } = await client.query(
// ibkr_symbol/ibkr_exchange are only touched when sent, so a client that
// doesn't know them can't wipe them.
`UPDATE futures_settings SET symbol=$1, type=$2, tick_size=$3, tick_value=$4, fee=$5, exchange=$6, currency=$7, rollover_months=$8, initial_margin=$9, maintenance_margin=$10, timeframe_settings=$11,
    ibkr_symbol = CASE WHEN $14 THEN $15 ELSE ibkr_symbol END,
    ibkr_exchange = CASE WHEN $16 THEN $17 ELSE ibkr_exchange END
 WHERE symbol=$12 AND type=$13`,
[symbol, type, tick_size, tick_value, fee, exchange || null, currency || 'USD', type === 'FUT' ? rollover_months : null, initial_margin || null, maintenance_margin || null, JSON.stringify(resolvedTimeframeSettings), originalSymbol, originalType,
 'ibkr_symbol' in req.body, cleanIbkrField(req.body.ibkr_symbol), 'ibkr_exchange' in req.body, cleanIbkrField(req.body.ibkr_exchange)]
            );
            if (rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Symbol and type not found for update (unexpected)' });
            }

            // Settlement rows stamped the old currency — relabel them to match
            // (see reconcileSettlementCurrencies). Only worth running when the
            // currency actually moved.
            let settlementsFixed = 0;
            if (currencyChanged) {
                settlementsFixed = await reconcileSettlementCurrencies(client);
                if (settlementsFixed > 0) {
                    broadcastStatus(uuidv4(), `${symbol}: currency changed to ${newCurrencyNormalized} — relabelled ${settlementsFixed} existing cash settlement row(s) to match.`, 'info');
                    logger.info(`[FuturesSettings] Reconciled ${settlementsFixed} TRADE_SETTLEMENT currencies after ${originalSymbol} currency change`);
                }
            }

            await client.query('COMMIT');
            res.json({ success: true, settlement_rows_relabelled: settlementsFixed });
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.code === '23505') {
                res.status(409).json({ error: 'The new symbol and type combination already exists for another setting.' });
            } else {
                logger.error('Error updating futures_settings:', err);
                res.status(500).json({ error: err.message });
            }
        } finally {
            client.release();
        }
    });

    router.delete('/futures-settings', async (req, res) => {
        const { symbol, type } = req.query;
        if (!symbol || !type) {
            return res.status(400).json({ error: 'Symbol and type are required' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Fetch the existing setting to get its ID
            const { rows: existingSettings } = await client.query(
                'SELECT id FROM futures_settings WHERE symbol = $1 AND type = $2',
                [symbol, type]
            );

            if (existingSettings.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Symbol and type not found' });
            }
            const futuresSettingId = existingSettings[0].id;
            const affected = await tradesChangingCurrency(client, { symbol, type });
            if (affected.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: changingCurrencyMessage(affected, 'deleting it') });
            }

            // 2. Delete associated historical data
            logger.info(`[FuturesSettings] Deleting historical data for ${symbol}/${type} (ID: ${futuresSettingId}) before deleting the setting.`);
            const historicalDeleteResult = await client.query('DELETE FROM historical_data WHERE futures_setting_id = $1', [futuresSettingId]);
            logger.info(`[FuturesSettings] Deleted ${historicalDeleteResult.rowCount} historical data rows.`);
            broadcastStatus(uuidv4(), `Historical data for ${symbol} (${type}) deleted.`, 'info');

            // 3. Delete the futures_setting. On `client`, inside the same
            // transaction: on a separate pool connection this DELETE's
            // foreign-key check waited on the historical_data rows this
            // transaction had just deleted but not committed, while the
            // transaction waited on it — a deadlock Postgres can't see, so
            // deleting any symbol with price history hung forever.
            const { rowCount } = await client.query('DELETE FROM futures_settings WHERE symbol=$1 AND type=$2', [symbol, type]);

            if (rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Symbol and type not found during delete (unexpected)' });
            }

            await client.query('COMMIT');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK');
            logger.error('Error deleting futures_settings:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // --- Exchanges Endpoints ---

    router.get('/exchanges', async (req, res) => {
        try {
            const { rows } = await pool.query('SELECT * FROM exchanges ORDER BY name');
            res.json(rows);
        } catch (err) {
            broadcastStatus(uuidv4(), `Error fetching exchanges: ${err.message}`, 'error');
            logger.error('Error fetching exchanges:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // An IANA zone name (Europe/Amsterdam): an unknown one made every fill's
    // day silently New York's (modules/tradeSettlement.js fillDay).
    const validTimezone = (zone) => {
        try { new Intl.DateTimeFormat('en-US', { timeZone: String(zone) }); return true; } catch { return false; }
    };

    // Any change to an exchange: the data service's cached hours and
    // timezone go (clearExchangeInfoCache), so it applies right away.
    router.use('/exchanges', (req, res, next) => {
        if (req.method !== 'GET') {
            res.on('finish', () => { if (res.statusCode < 400) clearExchangeInfoCache(); });
        }
        next();
    });

    router.post('/exchanges', async (req, res) => {
        const { name, timezone, opening_hours } = req.body;
        if (!name || !timezone || !opening_hours) {
            return res.status(400).json({ error: 'Name, timezone, and opening hours are required' });
        }
        if (!validTimezone(timezone)) return res.status(400).json({ error: `Unknown timezone "${timezone}" — use a name like Europe/Amsterdam` });
        try {
            const result = await pool.query(
                'INSERT INTO exchanges (name, timezone, opening_hours) VALUES ($1, $2, $3) RETURNING *',
                [name, timezone, JSON.stringify(opening_hours)]
            );
            res.json(result.rows[0]);
        } catch (err) {
            logger.error('Error adding exchange:', err);
            res.status(500).json({ error: 'Failed to add exchange' });
        }
    });

    // Symbols name their exchange (futures_settings.exchange, no foreign
    // key): a rename follows to them, else they lost its timezone and hours.
    // A new timezone can move a fill to another trading day, and so across
    // an opening balance date: those trades' cash is rebuilt.
    router.put('/exchanges/:id', async (req, res) => {
        const { id } = req.params;
        const { name, timezone, opening_hours } = req.body;
        if (!name || !timezone || !opening_hours) {
            return res.status(400).json({ error: 'Name, timezone, and opening hours are required' });
        }
        if (!validTimezone(timezone)) return res.status(400).json({ error: `Unknown timezone "${timezone}" — use a name like Europe/Amsterdam` });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows: [before] } = await client.query('SELECT name, timezone FROM exchanges WHERE id = $1 FOR UPDATE', [parseInt(id)]);
            if (!before) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Exchange not found' });
            }
            const result = await client.query(
                'UPDATE exchanges SET name = $1, timezone = $2, opening_hours = $3 WHERE id = $4 RETURNING *',
                [name, timezone, JSON.stringify(opening_hours), parseInt(id)]
            );
            if (before.name !== name) {
                await client.query('UPDATE futures_settings SET exchange = $1 WHERE exchange = $2', [name, before.name]);
            }
            let resettled = 0;
            if (before.timezone !== timezone) {
                const { rows: settings } = await client.query('SELECT symbol, type, currency, exchange FROM futures_settings');
                const { rows: trades } = await client.query('SELECT id, symbol, type FROM trades');
                const ids = trades.filter(t => getFuturesSetting(t.symbol, t.type, settings)?.exchange === name).map(t => t.id);
                await resettleTrades(client, ids);
                resettled = ids.length;
            }
            await client.query('COMMIT');
            res.json({ ...result.rows[0], trades_resettled: resettled });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            logger.error('Error updating exchange:', err);
            res.status(err.code === '23505' ? 409 : 500).json({ error: err.code === '23505' ? 'An exchange with that name already exists' : 'Failed to update exchange' });
        } finally {
            client.release();
        }
    });

    router.delete('/exchanges/:id', async (req, res) => {
        const { id } = req.params;
        try {
            // Still named by symbols: they'd lose its timezone and hours.
            const { rows: users } = await pool.query(
                'SELECT fs.symbol FROM futures_settings fs JOIN exchanges e ON e.name = fs.exchange WHERE e.id = $1 ORDER BY fs.symbol', [id]
            );
            if (users.length > 0) {
                return res.status(409).json({ error: `${users.length} symbol(s) use this exchange (${users.map(u => u.symbol).join(', ')}) — move them to another exchange first` });
            }
            const { rowCount } = await pool.query('DELETE FROM exchanges WHERE id=$1', [id]);
            if (rowCount === 0) {
                broadcastStatus(uuidv4(), `Exchange ID ${id} not found`, 'error');
                res.status(404).json({ error: 'Exchange not found' });
            } else {
                broadcastStatus(uuidv4(), `Deleted exchange ID ${id}`, 'success');
                res.json({ success: true });
            }
        } catch (err) {
            broadcastStatus(uuidv4(), `Error deleting exchange: ${err.message}`, 'error');
            logger.error('Error deleting exchange:', err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
