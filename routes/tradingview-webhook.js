const express = require('express');
const router = express.Router();
const { logger } = require('../modules/logger.js');

// Receives live bars pushed from a TradingView alert webhook (e.g. a
// 1-minute chart with an alert firing "once per bar close"). TradingView's
// alert engine runs server-side in TradingView's own cloud, independent of
// whether the TradingView app is open locally — so this genuinely needs to
// be reachable from the public internet. See docs/tradingview-webhook.md for
// how to expose just this one path safely (a tunnel scoped to this route,
// not a general port-forward) and the exact Pine Script alert setup.
//
// Mounted directly on `app` (not `apiRouter`) at its own dedicated path,
// deliberately NOT nested under /api/external/v1 — that API is documented as
// unauthenticated-by-design for trusted-network use, and this endpoint is
// the one piece of the app meant to be reachable from outside that trust
// boundary. Keeping it a structurally separate path means a tunnel/
// reverse-proxy rule scoped to this route can't accidentally expose the rest
// of the unauthenticated external API too. It has its own secret-based check
// instead, since "no auth" isn't appropriate for something public internet
// clients can reach.
module.exports = (db, configManager, broadcastStatus, uuidv4, wss, WebSocket) => {

    router.post('/tradingview-bar', async (req, res) => {
        const requestId = uuidv4();
        try {
            const config = await configManager.loadConfig();
            const expectedSecret = config.tradingViewWebhookSecret;
            if (!expectedSecret) {
                logger.error('[TradingView webhook] Rejected: no tradingViewWebhookSecret configured on the server.');
                return res.status(503).json({ error: 'Webhook not configured' });
            }
            if (!req.body || req.body.secret !== expectedSecret) {
                logger.warn('[TradingView webhook] Rejected: missing or incorrect secret.');
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const { symbol, type, timeframe, time, open, high, low, close, volume } = req.body;
            if (!symbol || !timeframe || !time || open == null || high == null || low == null || close == null) {
                return res.status(400).json({ error: 'symbol, timeframe, time, open, high, low, close are required' });
            }
            const effectiveType = (type || 'FUT').toUpperCase();
            const upperSymbol = String(symbol).toUpperCase().trim();

            const { rows: settingRows } = await db.getPool().query(
                'SELECT id FROM futures_settings WHERE symbol = $1 AND type = $2',
                [upperSymbol, effectiveType]
            );
            if (settingRows.length === 0) {
                logger.warn(`[TradingView webhook] No futures settings for ${upperSymbol} (${effectiveType}) — add the symbol in the app (Settings) first.`);
                return res.status(404).json({ error: `No futures settings found for symbol ${upperSymbol} (${effectiveType})` });
            }
            const futuresSettingId = settingRows[0].id;

            // Stored the same shape Yahoo's continuous-style extension data
            // uses (contract_month NULL, is_continuous FALSE) — TradingView's
            // feed is itself a front-month continuous series, same role
            // Yahoo already plays for extending past IBKR's own backfill.
            // DO UPDATE (not DO NOTHING) so a TradingView bar always wins
            // over whatever was already there for this exact timestamp (an
            // older TradingView bar, or a same-timestamp Yahoo bar) — that's
            // what gives TradingView priority over Yahoo without needing any
            // extra logic in getMergedHistoricalSeries; IBKR's own raw
            // per-contract rows always carry a real contract_month, so this
            // insert can never collide with or overwrite those.
            await db.getPool().query(
                `INSERT INTO historical_data (futures_setting_id, contract_month, time, open, high, low, close, volume, timeframe, source, is_continuous)
                 VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 'TradingView', FALSE)
                 ON CONFLICT (futures_setting_id, (COALESCE(contract_month, '')), time, timeframe, is_continuous)
                 DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                               close = EXCLUDED.close, volume = EXCLUDED.volume, source = 'TradingView'`,
                // volume is a bigint column — Math.round guards against a
                // fractional value (e.g. from an instrument type where
                // TradingView reports volume with decimals), which Postgres
                // would otherwise reject outright rather than coerce.
                [futuresSettingId, time, open, high, low, close, Math.round(Number(volume) || 0), timeframe]
            );

            wss.clients.forEach(wsClient => {
                if (wsClient.readyState === WebSocket.OPEN) {
                    wsClient.send(JSON.stringify({
                        type: 'historicalDataUpdate',
                        symbol: upperSymbol,
                        timeframe,
                        contractMonth: null,
                        source: 'TradingView',
                        insertedCount: 1,
                    }));
                }
            });

            logger.debug(`[TradingView webhook] Stored ${upperSymbol} (${effectiveType}, ${timeframe}) bar for ${time}`);
            res.json({ success: true });
        } catch (err) {
            logger.error(`[TradingView webhook] ${err.message}`, { stack: err.stack });
            broadcastStatus(requestId, `TradingView webhook error: ${err.message}`, 'error');
            if (!res.headersSent) res.status(500).json({ error: err.message });
        }
    });

    return router;
};
