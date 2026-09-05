const express = require('express');
const router = express.Router();
const { logger } = require('../modules/logger.js');
const { DEFAULT_TIMEFRAME_SETTINGS } = require('../modules/historical-data-service.js');

// Export a function that accepts dependencies
module.exports = (pool, broadcastStatus, uuidv4) => {

    // --- Futures Settings Endpoints ---

    router.get('/futures-settings', async (req, res) => {
        try {
            const { rows } = await pool.query(`
SELECT fs.symbol, fs.type, fs.tick_size, fs.tick_value, fs.fee, fs.exchange, fs.currency,
       fs.rollover_months, fs.initial_margin, fs.maintenance_margin, fs.timeframe_settings, e.timezone
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
'INSERT INTO futures_settings (symbol, type, tick_size, tick_value, fee, exchange, currency, rollover_months, initial_margin, maintenance_margin, timeframe_settings) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
[symbol, type, tick_size, tick_value, fee, exchange || null, currency || 'USD', type === 'FUT' ? rollover_months : null, initial_margin || null, maintenance_margin || null, JSON.stringify(timeframe_settings || DEFAULT_TIMEFRAME_SETTINGS)]
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
            const { rowCount } = await pool.query(
'UPDATE futures_settings SET symbol=$1, type=$2, tick_size=$3, tick_value=$4, fee=$5, exchange=$6, currency=$7, rollover_months=$8, initial_margin=$9, maintenance_margin=$10, timeframe_settings=$11 WHERE symbol=$12 AND type=$13',
[symbol, type, tick_size, tick_value, fee, exchange || null, currency || 'USD', type === 'FUT' ? rollover_months : null, initial_margin || null, maintenance_margin || null, JSON.stringify(resolvedTimeframeSettings), originalSymbol, originalType]
            );
            if (rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Symbol and type not found for update (unexpected)' });
            }
            await client.query('COMMIT');
            res.json({ success: true });
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

            // 2. Delete associated historical data
            logger.info(`[FuturesSettings] Deleting historical data for ${symbol}/${type} (ID: ${futuresSettingId}) before deleting the setting.`);
            const historicalDeleteResult = await client.query('DELETE FROM historical_data WHERE futures_setting_id = $1', [futuresSettingId]);
            logger.info(`[FuturesSettings] Deleted ${historicalDeleteResult.rowCount} historical data rows.`);
            broadcastStatus(uuidv4(), `Historical data for ${symbol} (${type}) deleted.`, 'info');

            // 3. Delete the futures_setting
            const { rowCount } = await pool.query('DELETE FROM futures_settings WHERE symbol=$1 AND type=$2', [symbol, type]);

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

    router.post('/exchanges', async (req, res) => {
        const { name, timezone, opening_hours } = req.body;
        if (!name || !timezone || !opening_hours) {
            return res.status(400).json({ error: 'Name, timezone, and opening hours are required' });
        }
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

    router.put('/exchanges/:id', async (req, res) => {
        const { id } = req.params;
        const { name, timezone, opening_hours } = req.body;
        try {
            const result = await pool.query(
                'UPDATE exchanges SET name = $1, timezone = $2, opening_hours = $3 WHERE id = $4 RETURNING *',
                [name, timezone, JSON.stringify(opening_hours), parseInt(id)]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Exchange not found' });
            }
            res.json(result.rows[0]);
        } catch (err) {
            logger.error('Error updating exchange:', err);
            res.status(500).json({ error: 'Failed to update exchange' });
        }
    });

    router.delete('/exchanges/:id', async (req, res) => {
        const { id } = req.params;
        try {
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
