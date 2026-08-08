// External API (v1) — read/write surface for external tools (e.g. an AI
// trade-analysis project) to consume this journal's data: accounts, trades
// (with computed side/status/PnL/return%), day notes, attachments, symbol
// settings, and historic/current prices. Also exposes a narrow write-back
// endpoint so an external tool can attach its analysis to a trade without
// touching the user's own hand-written journal notes.
//
// See EXTERNAL_API.md at the repo root for the full reference documentation.
//
// NOTE: unauthenticated by design (per product decision) — anyone who can
// reach this server can read the full trade history and write AI analysis
// onto trades. If this server is ever reachable outside a trusted network,
// put it behind a reverse proxy / VPN / firewall rule. Every route below is
// intentionally namespaced under /api/external/v1 and kept separate from the
// internal app API so auth middleware can be added here later without
// touching (or being affected by) the internal routes.

const express = require('express');
const router = express.Router();
const { logger } = require('../modules/logger.js');
const { computeTradeDerived } = require('../modules/tradeCalculations.js');

const API_VERSION = 'v1';

module.exports = (db, historicalDataService, yahoo, broadcastStatus, uuidv4, taskManager, triggerTaskProcessor) => {

    const attachmentUrl = (attachmentId) => `/api/external/${API_VERSION}/attachments/${attachmentId}`;

    // --- Discovery ---

    router.get('/', (req, res) => {
        res.json({
            name: "Jay's Journal External API",
            version: API_VERSION,
            documentation: 'EXTERNAL_API.md in the project repository',
            endpoints: [
                'GET    /api/external/v1/accounts',
                'GET    /api/external/v1/trades',
                'GET    /api/external/v1/trades/:id',
                'PATCH  /api/external/v1/trades/:id/ai-analysis',
                'GET    /api/external/v1/daynotes',
                'GET    /api/external/v1/attachments/:id',
                'GET    /api/external/v1/symbols',
                'GET    /api/external/v1/historical',
                'GET    /api/external/v1/quote/:symbol',
            ],
        });
    });

    // --- Accounts ---

    router.get('/accounts', async (req, res) => {
        try {
            const { rows } = await db.getPool().query('SELECT id, name, created_at, updated_at FROM accounts ORDER BY name');
            res.json({ accounts: rows });
        } catch (err) {
            logger.error('[External API] Error fetching accounts:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- Trades ---

    const TRADE_SELECT = `
        SELECT
            t.id, t.account_id, acc.name AS account_name, t.type, t.symbol, t.contract_month,
            t.target, t.stop_loss, t.tick_size, t.tick_value, t.created_at, t.updated_at,
            (
                SELECT COALESCE(json_agg(json_build_object(
                    'type', ta.type,
                    'date_time', ta.date_time,
                    'quantity', ta.quantity,
                    'price', ta.price,
                    'fee', ta.fee,
                    'exec_id', ta.exec_id
                ) ORDER BY ta.date_time ASC), '[]'::json)
                FROM trade_actions ta WHERE ta.trade_id = t.id
            ) AS actions,
            (
                SELECT row_to_json(j) FROM (
                    SELECT tags, notes_html, confidence, execution_rating,
                           ai_analysis, ai_analysis_source, ai_analysis_updated_at
                    FROM trade_journals WHERE trade_id = t.id LIMIT 1
                ) j
            ) AS journal,
            (
                SELECT COALESCE(json_agg(json_build_object(
                    'id', att.id, 'filename', att.filename, 'mime_type', att.mime_type
                )), '[]'::json)
                FROM trade_attachments att WHERE att.trade_id = t.id
            ) AS attachments
        FROM trades t
        JOIN accounts acc ON acc.id = t.account_id
    `;

    // Attaches computed side/status/PnL/etc. and resolves attachment URLs.
    // futuresSettings is passed in (fetched once per request) since
    // computeTradeDerived needs the full list for margin-based return% and
    // price-precision lookups.
    function enrichTrade(row, futuresSettings) {
        const derived = computeTradeDerived(row, futuresSettings);
        return {
            ...row,
            ...derived,
            attachments: (row.attachments || []).map(a => ({ ...a, url: attachmentUrl(a.id) })),
        };
    }

    router.get('/trades', async (req, res) => {
        try {
            const { account_id, symbol, type, status, from, to } = req.query;
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
            const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

            const conditions = [];
            const params = [];
            if (account_id) { params.push(parseInt(account_id, 10)); conditions.push(`t.account_id = $${params.length}`); }
            if (symbol) { params.push(symbol.toUpperCase()); conditions.push(`t.symbol = $${params.length}`); }
            if (type) { params.push(type.toUpperCase()); conditions.push(`t.type = $${params.length}::symbol_type`); }
            const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

            const { rows: tradeRows } = await db.getPool().query(
                `${TRADE_SELECT} ${whereClause} ORDER BY t.created_at DESC`,
                params
            );
            const { rows: futuresSettings } = await db.getPool().query('SELECT * FROM futures_settings');

            let trades = tradeRows.map(row => enrichTrade(row, futuresSettings));

            if (status) {
                const wanted = new Set(status.toUpperCase().split(',').map(s => s.trim()));
                trades = trades.filter(t => wanted.has(t.status));
            }
            // Filtered against first_action_at (when the trade was actually
            // opened in the market), not created_at (when the row was saved) —
            // the former is what "trades in this date range" usually means.
            if (from) trades = trades.filter(t => t.first_action_at && t.first_action_at >= from);
            if (to) trades = trades.filter(t => t.first_action_at && t.first_action_at <= to);

            const total = trades.length;
            const page = trades.slice(offset, offset + limit);

            res.json({ total, limit, offset, trades: page });
        } catch (err) {
            logger.error('[External API] Error fetching trades:', err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/trades/:id', async (req, res) => {
        try {
            const { rows } = await db.getPool().query(`${TRADE_SELECT} WHERE t.id = $1`, [req.params.id]);
            if (rows.length === 0) return res.status(404).json({ error: 'Trade not found' });
            const { rows: futuresSettings } = await db.getPool().query('SELECT * FROM futures_settings');
            res.json(enrichTrade(rows[0], futuresSettings));
        } catch (err) {
            logger.error('[External API] Error fetching trade:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // Write-back: lets an external tool attach its analysis to a trade
    // without touching notes_html (the user's own journal entry). Upserts by
    // trade_id — a trade_journals row is created if the trade has none yet.
    router.patch('/trades/:id/ai-analysis', async (req, res) => {
        const { id } = req.params;
        const { analysis, source } = req.body || {};
        if (typeof analysis !== 'string' || !analysis.trim()) {
            return res.status(400).json({ error: 'analysis (non-empty string) is required' });
        }
        try {
            const { rows: tradeRows } = await db.getPool().query('SELECT id FROM trades WHERE id = $1', [id]);
            if (tradeRows.length === 0) return res.status(404).json({ error: 'Trade not found' });

            await db.getPool().query(
                `INSERT INTO trade_journals (trade_id, ai_analysis, ai_analysis_source, ai_analysis_updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (trade_id) DO UPDATE SET
                    ai_analysis = EXCLUDED.ai_analysis,
                    ai_analysis_source = EXCLUDED.ai_analysis_source,
                    ai_analysis_updated_at = NOW()`,
                [id, analysis, source || null]
            );
            broadcastStatus(uuidv4(), `AI analysis updated for trade ${id}${source ? ` (${source})` : ''}`, 'info');
            res.json({ success: true });
        } catch (err) {
            logger.error('[External API] Error saving AI analysis:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- Day Notes ---

    router.get('/daynotes', async (req, res) => {
        try {
            const { account_id, from, to } = req.query;
            const conditions = [];
            const params = [];
            if (account_id) { params.push(parseInt(account_id, 10)); conditions.push(`dn.account_id = $${params.length}`); }
            if (from) { params.push(from); conditions.push(`dn.date >= $${params.length}`); }
            if (to) { params.push(to); conditions.push(`dn.date <= $${params.length}`); }
            const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

            const { rows } = await db.getPool().query(`
                SELECT dn.id, dn.account_id, acc.name AS account_name, dn.date, dn.mood, dn.market_condition,
                       dn.market_volume, dn.summary, dn.notes_html, dn.created_at, dn.updated_at,
                       (
                           SELECT COALESCE(json_agg(json_build_object(
                               'id', att.id, 'filename', att.filename, 'mime_type', att.mime_type
                           )), '[]'::json)
                           FROM trade_attachments att WHERE att.day_note_id = dn.id
                       ) AS attachments
                FROM day_notes dn
                JOIN accounts acc ON acc.id = dn.account_id
                ${whereClause}
                ORDER BY dn.date DESC
            `, params);

            const dayNotes = rows.map(n => ({
                ...n,
                attachments: (n.attachments || []).map(a => ({ ...a, url: attachmentUrl(a.id) })),
            }));
            res.json({ total: dayNotes.length, day_notes: dayNotes });
        } catch (err) {
            logger.error('[External API] Error fetching day notes:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- Attachments (raw binary, shared by trades and day notes) ---

    router.get('/attachments/:id', async (req, res) => {
        try {
            const { rows } = await db.getPool().query(
                'SELECT image_data, mime_type, filename FROM trade_attachments WHERE id = $1',
                [req.params.id]
            );
            if (rows.length === 0 || !rows[0].image_data) return res.status(404).json({ error: 'Attachment not found' });
            const att = rows[0];
            // Strip CR/LF/quotes from the filename before it goes into a header,
            // to rule out header injection via a maliciously-named upload.
            const safeFilename = String(att.filename || 'attachment').replace(/["\r\n]/g, '');
            res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
            res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
            res.send(att.image_data);
        } catch (err) {
            logger.error('[External API] Error fetching attachment:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- Symbol settings ---

    router.get('/symbols', async (req, res) => {
        try {
            const { rows } = await db.getPool().query(`
                SELECT fs.id, fs.symbol, fs.type, fs.tick_size, fs.tick_value, fs.fee, fs.exchange,
                       fs.rollover_months, fs.initial_margin, fs.maintenance_margin, fs.timeframe_settings,
                       e.timezone
                FROM futures_settings fs
                LEFT JOIN exchanges e ON fs.exchange = e.name
                WHERE fs.symbol != 'DEFAULT'
                ORDER BY fs.symbol
            `);
            res.json({ symbols: rows });
        } catch (err) {
            logger.error('[External API] Error fetching symbols:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- Historical & current prices ---

    router.get('/historical', async (req, res) => {
        try {
            const { symbol, type = 'FUT', timeframe, contract_month, from, to } = req.query;
            if (!symbol || !timeframe) {
                return res.status(400).json({ error: 'symbol and timeframe are required' });
            }
            if (!historicalDataService.VALID_TIMEFRAMES.includes(timeframe)) {
                return res.status(400).json({ error: `Invalid timeframe. Valid values: ${historicalDataService.VALID_TIMEFRAMES.join(', ')}` });
            }
            const upperSymbol = symbol.toUpperCase();
            const upperType = type.toUpperCase();
            const { rows: fsRows } = await db.getPool().query(
                'SELECT id, timeframe_settings FROM futures_settings WHERE symbol = $1 AND type = $2',
                [upperSymbol, upperType]
            );
            if (fsRows.length === 0) {
                return res.status(404).json({ error: `No symbol settings found for ${upperSymbol} (${upperType})` });
            }

            // Opportunistically queue a background refresh for this
            // symbol/timeframe — this response still returns whatever's
            // currently in the database immediately (no added latency here),
            // but a gap noticed now may well be filled by the next call. Same
            // cooldown key/mechanism the app's own charts use (so the two
            // don't double-trigger), but deliberately WITHOUT the internal
            // endpoint's "cancel whatever's running for other symbols" step —
            // that's meant for "a human is actively looking at this specific
            // chart right now", which doesn't fit a tool that might be
            // scanning many symbols in a loop and would otherwise keep
            // interrupting its own previous requests.
            if (historicalDataService.getEnabledTimeframes(fsRows[0].timeframe_settings).includes(timeframe)) {
                const COOLDOWN_PERIOD_MS = 60000;
                const requestIdBase = `external_api_${upperSymbol}_${timeframe}`;
                const lastActivity = taskManager.getRecentCompletions().get(`${upperSymbol}-${timeframe}-user_initiated_fg`);
                if (!lastActivity || (Date.now() - lastActivity > COOLDOWN_PERIOD_MS)) {
                    taskManager.addTask(upperSymbol, timeframe, 'yahoo_only', taskManager.PRIORITY.USER_FOREGROUND_YAHOO, `${requestIdBase}_yahoo_prio`, contract_month || null, upperType);
                    taskManager.addTask(upperSymbol, timeframe, 'ibkr_only', taskManager.PRIORITY.USER_FOREGROUND_IBKR, `${requestIdBase}_ibkr_prio`, contract_month || null, upperType);
                    triggerTaskProcessor();
                }
            }

            const bars = await historicalDataService.getMergedHistoricalSeries({
                futuresSettingId: fsRows[0].id,
                type: upperType,
                contractMonth: contract_month || null,
                timeframe,
                startDate: from,
                endDate: to,
            });

            res.json({
                symbol: upperSymbol,
                type: upperType,
                timeframe,
                contract_month: contract_month || null,
                bar_count: bars.length,
                bars,
            });
        } catch (err) {
            logger.error('[External API] Error fetching historical data:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // Falls back to the most recent bar already in our own DB (across any
    // timeframe — TradingView/IBKR/Yahoo, whichever is freshest) when a live
    // Yahoo quote can't be obtained. Yahoo's quote endpoint occasionally goes
    // down server-side entirely (e.g. their crumb-issuing page changes shape
    // and breaks extraction, or they rate-limit/block this server outright)
    // — independent of anything wrong on our end, and not something we can
    // fix by retrying harder. Rather than surface a bare error to an external
    // caller, degrade to the last known price so a consumer at least gets a
    // usable (if possibly slightly stale) answer, clearly labeled as such.
    async function fetchLatestBarFallback(baseSymbol, type) {
        const { rows: settingRows } = await db.getPool().query(
            'SELECT id FROM futures_settings WHERE symbol = $1 AND type = $2',
            [baseSymbol, type]
        );
        if (settingRows.length === 0) return null;

        const { rows } = await db.getPool().query(
            `SELECT close, time, source, timeframe FROM historical_data
             WHERE futures_setting_id = $1
             ORDER BY time DESC LIMIT 1`,
            [settingRows[0].id]
        );
        if (rows.length === 0) return null;
        return rows[0];
    }

    router.get('/quote/:symbol', async (req, res) => {
        const { type } = req.query;
        const baseSymbol = req.params.symbol.toUpperCase();
        const upperType = (type || 'FUT').toUpperCase();
        const yahooSymbol = baseSymbol + (upperType === 'FUT' ? '=F' : '');
        try {
            const data = await yahoo.quote(yahooSymbol);
            if (!data) throw new Error('No data returned from Yahoo');

            let price = null, priceSource = null;
            if (typeof data.regularMarketPrice === 'number') { price = data.regularMarketPrice; priceSource = 'regularMarketPrice'; }
            else if (typeof data.postMarketPrice === 'number' && data.marketState === 'POST') { price = data.postMarketPrice; priceSource = 'postMarketPrice'; }
            else if (typeof data.preMarketPrice === 'number' && data.marketState === 'PRE') { price = data.preMarketPrice; priceSource = 'preMarketPrice'; }
            else if (typeof data.bid === 'number') { price = data.bid; priceSource = 'bid'; }
            else if (typeof data.ask === 'number') { price = data.ask; priceSource = 'ask'; }

            if (price === null) throw new Error('No valid price field in Yahoo response');

            res.json({
                symbol: baseSymbol,
                price,
                price_source: priceSource,
                market_state: data.marketState || 'UNKNOWN',
                // modules/yahoo.js's quote() tries the yahoo-finance2 client library
                // first (regularMarketTime comes back as an already-parsed Date
                // object there) and only falls back to a raw REST call — whose JSON
                // has regularMarketTime as literal Unix epoch seconds — if that
                // fails. Blindly doing `* 1000` assumed the raw-REST shape always;
                // when the client path succeeds (the normal case), that multiplied
                // a Date by 1000, producing a garbage far-future timestamp with the
                // price itself still correct. Handle both shapes explicitly.
                last_updated: data.regularMarketTime
                    ? (data.regularMarketTime instanceof Date
                        ? data.regularMarketTime.toISOString()
                        : new Date(data.regularMarketTime * 1000).toISOString())
                    : new Date().toISOString(),
            });
        } catch (err) {
            logger.warn(`[External API] Live quote failed for ${baseSymbol} (${err.message}), falling back to latest stored bar.`);
            try {
                const fallback = await fetchLatestBarFallback(baseSymbol, upperType);
                if (!fallback) {
                    return res.status(502).json({ error: `Live quote unavailable (${err.message}) and no stored historical data to fall back to for ${baseSymbol}` });
                }
                res.json({
                    symbol: baseSymbol,
                    price: parseFloat(fallback.close),
                    price_source: `historical_bar_fallback (${fallback.source}, ${fallback.timeframe})`,
                    market_state: 'UNKNOWN',
                    last_updated: new Date(fallback.time).toISOString(),
                    live_quote_error: err.message,
                });
            } catch (fallbackErr) {
                logger.error(`[External API] Error fetching quote for ${baseSymbol} (both live and fallback failed):`, fallbackErr);
                res.status(500).json({ error: fallbackErr.message });
            }
        }
    });

    return router;
};
