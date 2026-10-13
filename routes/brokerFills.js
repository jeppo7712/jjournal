const express = require('express');
const router = express.Router();
const { logger } = require('../modules/logger.js');
const brokerFills = require('../modules/brokerFills.js');

// IBKR fills not in the journal yet (modules/brokerFills.js). Not scoped to
// the X-Account-ID account: the menu shows them for every account.
module.exports = (pool) => {

    // GET /broker-fills — every waiting fill, oldest first.
    router.get('/broker-fills', async (req, res) => {
        try {
            res.json({ fills: await brokerFills.pendingFills(pool) });
        } catch (err) {
            logger.error('Error listing broker fills:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /broker-fills/scan — check IBKR now instead of at the next run.
    router.post('/broker-fills/scan', async (req, res) => {
        try {
            const { added } = await brokerFills.scanBrokerFills(pool);
            res.json({ added, fills: await brokerFills.pendingFills(pool) });
        } catch (err) {
            logger.error('Error scanning broker fills:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /broker-fills/dismiss { ids } — doesn't belong in the journal.
    router.post('/broker-fills/dismiss', async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
        if (ids.length === 0) return res.status(400).json({ error: 'ids is required' });
        try {
            const { rowCount } = await pool.query(
                `UPDATE broker_fills SET status = 'DISMISSED', updated_at = NOW() WHERE id = ANY($1) AND status = 'PENDING'`, [ids]
            );
            res.json({ success: true, dismissed: rowCount });
        } catch (err) {
            logger.error('Error dismissing broker fills:', err);
            res.status(500).json({ error: err.message });
        }
    });

    return { router, scan: () => brokerFills.scanBrokerFills(pool) };
};
