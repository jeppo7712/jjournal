const express = require('express');
const router = express.Router();
const { logger } = require('../modules/logger.js');
const { loadConfig } = require('../modules/config.js');
const { getFlexStatements } = require('./ibkrFlex.js');
const brokerCash = require('../modules/brokerCash.js');
const { checkFlexQuery } = require('../modules/flexCheck.js');

// Broker cash activity from IBKR Flex (modules/brokerCash.js) and the Flex
// query check (modules/flexCheck.js). Scoped like the Capital routes: the
// X-Account-ID header's account, resolved to its top-level account, which
// is where a broker account is mapped.
module.exports = (pool, broadcastStatus, uuidv4) => {

    const SYNC_MODES = ['OFF', 'SUGGEST', 'AUTO'];
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

    async function rootOf(req, res) {
        const rootId = await brokerCash.rootAccountId(pool, req.accountId);
        if (!rootId) res.status(404).json({ error: 'Account not found' });
        return rootId;
    }

    // Pulls the live Activity statement (from the shared cache while fresh)
    // and syncs every account it covers.
    async function runSync({ forceRefresh = false } = {}) {
        const config = await loadConfig();
        const token = config.ibkrFlexTokenReal;
        const queryId = config.ibkrFlexQueryIdActivityReal;
        if (!token || !queryId) {
            throw Object.assign(new Error('Set the real accounts\' Flex token and Activity Query ID in Settings → IBKR API first.'), { status: 400 });
        }
        const { statements } = await getFlexStatements(token, queryId, { forceRefresh });
        // Real credentials must only ever return real accounts.
        const paper = statements.filter(s => /^D/i.test(String(s.accountId || '')));
        if (paper.length > 0) {
            throw Object.assign(new Error('The real accounts\' Activity query returned a paper account. Nothing was synced — check the query in Settings → IBKR API.'), { status: 400 });
        }
        return brokerCash.syncBrokerCash(pool, statements);
    }

    // GET /broker-activity — the account's sync settings and items.
    router.get('/broker-activity', async (req, res) => {
        try {
            const rootId = await rootOf(req, res);
            if (!rootId) return;
            const { rows: [account] } = await pool.query(
                `SELECT id, name, broker_account_id, broker_sync_mode, broker_sync_from::text AS broker_sync_from, broker_synced_at, is_virtual
                 FROM accounts WHERE id = $1`,
                [rootId]
            );
            const { rows: items } = await pool.query(
                `SELECT b.id, b.kind, b.broker_type, (b.date_time AT TIME ZONE 'UTC')::date::text AS date, b.currency, b.amount,
                        b.symbol, b.description, b.action_id, b.status, b.manual_only, b.dividend_id,
                        COALESCE(json_agg(json_build_object('id', ct.id, 'type', ct.type, 'amount', ct.amount, 'date', (ct.date_time AT TIME ZONE 'UTC')::date::text, 'note', ct.note, 'account_name', a.name))
                            FILTER (WHERE ct.id IS NOT NULL), '[]') AS links,
                        d.symbol AS dividend_symbol, d.source AS dividend_source
                 FROM broker_cash_items b
                 LEFT JOIN broker_item_links l ON l.item_id = b.id
                 LEFT JOIN cash_transactions ct ON ct.id = l.cash_transaction_id
                 LEFT JOIN accounts a ON a.id = ct.account_id
                 LEFT JOIN dividends d ON d.id = b.dividend_id
                 WHERE b.account_id = $1
                 GROUP BY b.id, d.symbol, d.source
                 ORDER BY b.date_time DESC, b.id DESC`,
                [rootId]
            );
            res.json({
                account,
                items,
                balances: await brokerCash.balanceCheck(pool, rootId),
                suggestedFrom: account.broker_sync_from ? null : await brokerCash.defaultSyncFrom(pool, rootId),
            });
        } catch (err) {
            logger.error('Error loading broker activity:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // PUT /broker-activity/settings { mode, sync_from }
    router.put('/broker-activity/settings', async (req, res) => {
        const { mode, sync_from: syncFrom } = req.body || {};
        if (!SYNC_MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of: ${SYNC_MODES.join(', ')}` });
        if (syncFrom != null && !DATE_RE.test(String(syncFrom))) return res.status(400).json({ error: 'sync_from must be YYYY-MM-DD' });
        try {
            const rootId = await rootOf(req, res);
            if (!rootId) return;
            const { rows: [account] } = await pool.query(`SELECT broker_account_id, is_virtual FROM accounts WHERE id = $1`, [rootId]);
            if (mode !== 'OFF' && !account.broker_account_id) return res.status(400).json({ error: 'Link this account to its IBKR account first (Settings → Accounts → Broker account ID).' });
            if (mode !== 'OFF' && account.is_virtual) return res.status(400).json({ error: 'Paper accounts aren\'t synced: their cash is simulated.' });
            await pool.query(
                `UPDATE accounts SET broker_sync_mode = $2, broker_sync_from = COALESCE($3::date, broker_sync_from), updated_at = NOW() WHERE id = $1`,
                [rootId, mode, syncFrom || null]
            );
            res.json({ success: true });
        } catch (err) {
            logger.error('Error saving broker sync settings:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /broker-activity/sync — every account with sync on, not just this one:
    // they come from the same statement.
    router.post('/broker-activity/sync', async (req, res) => {
        try {
            const result = await runSync({ forceRefresh: req.body?.refresh === true });
            res.json(result);
        } catch (err) {
            logger.error(`[BrokerCash] sync failed: ${err.message}`);
            res.status(err.status || 500).json({ error: err.message });
        }
    });

    // POST /broker-activity/accept { ids, account_id? }
    router.post('/broker-activity/accept', async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
        if (ids.length === 0) return res.status(400).json({ error: 'ids is required' });
        const client = await pool.connect();
        try {
            const rootId = await rootOf(req, res);
            if (!rootId) return;
            await client.query('BEGIN');
            const booked = await brokerCash.bookItems(client, rootId, ids, req.body.account_id || null);
            await client.query('COMMIT');
            broadcastStatus(uuidv4(), `${booked} broker item(s) added to the ledger`, 'success');
            res.json({ success: true, booked });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            logger.error('Error booking broker items:', err);
            res.status(400).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // POST /broker-activity/align { currency } — books the part of the
    // difference with IBKR's cash that nothing waiting explains.
    router.post('/broker-activity/align', async (req, res) => {
        const currency = String(req.body?.currency || '').toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'currency is required' });
        const client = await pool.connect();
        try {
            const rootId = await rootOf(req, res);
            if (!rootId) return;
            await client.query('BEGIN');
            const { amount } = await brokerCash.alignBalance(client, rootId, currency);
            await client.query('COMMIT');
            if (amount) broadcastStatus(uuidv4(), `${currency} cash aligned with IBKR (${amount > 0 ? '+' : ''}${amount.toFixed(2)})`, 'success');
            res.json({ success: true, amount });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            logger.error('Error aligning cash with IBKR:', err);
            res.status(400).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // Status changes the user makes by hand.
    async function setStatus(req, res, { from, to, manualOnly = false, unlink = false }) {
        const client = await pool.connect();
        try {
            const rootId = await rootOf(req, res);
            if (!rootId) return;
            await client.query('BEGIN');
            const { rows } = await client.query(
                `UPDATE broker_cash_items SET status = $3, manual_only = manual_only OR $4, dividend_id = CASE WHEN $5 THEN NULL ELSE dividend_id END, updated_at = NOW()
                 WHERE id = $1 AND account_id = $2 AND status = ANY($6) RETURNING id`,
                [req.params.id, rootId, to, manualOnly, unlink, from]
            );
            if (rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: `No ${from.join('/').toLowerCase()} item with that id` });
            }
            if (unlink) await client.query(`DELETE FROM broker_item_links WHERE item_id = $1`, [req.params.id]);
            await client.query('COMMIT');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            logger.error('Error changing broker item:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    }

    router.post('/broker-activity/:id/dismiss', (req, res) => setStatus(req, res, { from: ['PENDING'], to: 'DISMISSED' }));
    router.post('/broker-activity/:id/restore', (req, res) => setStatus(req, res, { from: ['DISMISSED'], to: 'PENDING' }));
    // A wrong match: back to the inbox, and never matched automatically again.
    router.post('/broker-activity/:id/unmatch', (req, res) => setStatus(req, res, { from: ['MATCHED'], to: 'PENDING', manualOnly: true, unlink: true }));

    // GET /ibkr-flex/check?set=real|paper — checks both saved queries of a
    // credential set against what the journal reads (modules/flexCheck.js).
    router.get('/ibkr-flex/check', async (req, res) => {
        const kind = req.query.set === 'paper' ? 'paper' : 'real';
        const suffix = kind === 'paper' ? 'Paper' : 'Real';
        try {
            const config = await loadConfig();
            const token = config[`ibkrFlexToken${suffix}`];
            const queries = [
                { purpose: 'activity', id: config[`ibkrFlexQueryIdActivity${suffix}`] },
                { purpose: 'tradeConfirm', id: config[`ibkrFlexQueryIdTradeConf${suffix}`] },
            ];
            const { rows: accounts } = await pool.query(`SELECT name, broker_account_id, is_virtual, parent_account_id FROM accounts`);
            const results = [];
            // One at a time: IBKR refuses concurrent requests under one token.
            for (const q of queries) {
                if (!token || !q.id) {
                    results.push({ purpose: q.purpose, queryId: q.id || null, configured: false, checks: [] });
                    continue;
                }
                try {
                    const pulled = await getFlexStatements(token, q.id, { forceRefresh: req.query.refresh === 'true' });
                    results.push({ purpose: q.purpose, queryId: q.id, configured: true, fetchedAt: pulled.fetchedAt, checks: checkFlexQuery(pulled, q.purpose, { kind, accounts }) });
                } catch (err) {
                    results.push({ purpose: q.purpose, queryId: q.id, configured: true, error: err.message, checks: [] });
                }
            }
            res.json({ set: kind, tokenSet: !!token, results });
        } catch (err) {
            logger.error('Error checking Flex queries:', err);
            res.status(500).json({ error: err.message });
        }
    });

    return { router, runSync };
};
