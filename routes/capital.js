const express = require('express');
const router = express.Router();
const { logger } = require('../modules/logger.js');

// Cash ledger + non-trade holdings (T-bills/bonds). See
// docs/CAPITAL_TRACKING_DESIGN.md for the design this implements.
//
// Endpoints here are scoped to req.accountId (the X-Account-ID header, same
// convention as routes/trades.js) EXCEPT the transfer endpoint, which
// necessarily involves two accounts at once.
module.exports = (pool, broadcastStatus, uuidv4) => {

    // --- Cash transactions ---

    // GET /cash-transactions
    router.get('/cash-transactions', async (req, res) => {
        try {
            const { rows } = await pool.query(
                `SELECT * FROM cash_transactions WHERE account_id = $1 ORDER BY date_time DESC, id DESC`,
                [req.accountId]
            );
            res.json(rows);
        } catch (err) {
            logger.error('Error fetching cash transactions:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /cash-transactions — deposit / withdrawal / interest / other.
    // Not for transfers (see /cash-transactions/transfer) or trade
    // settlements (created automatically by routes/trades.js).
    router.post('/cash-transactions', async (req, res) => {
        const { type, amount, currency, date_time, is_virtual, note } = req.body;
        const allowedTypes = ['DEPOSIT', 'WITHDRAWAL', 'INTEREST', 'OTHER'];
        if (!allowedTypes.includes(type)) {
            return res.status(400).json({ error: `type must be one of: ${allowedTypes.join(', ')}` });
        }
        if (typeof amount !== 'number' || amount === 0) {
            return res.status(400).json({ error: 'amount (non-zero number) is required' });
        }
        // Sign is implied by type, not left to the caller to get right —
        // a WITHDRAWAL is always cash out regardless of the sign the form
        // happened to submit.
        const signedAmount = (type === 'WITHDRAWAL') ? -Math.abs(amount) : Math.abs(amount);
        try {
            const { rows } = await pool.query(
                `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, is_virtual, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [req.accountId, date_time || new Date().toISOString(), type, signedAmount, currency || 'USD', !!is_virtual, note || null]
            );
            broadcastStatus(uuidv4(), `${type} of ${signedAmount} ${currency || 'USD'} recorded`, 'success');
            res.json({ success: true, id: rows[0].id });
        } catch (err) {
            logger.error('Error creating cash transaction:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /cash-transactions/transfer — req.accountId is the FROM account;
    // to_account_id is the destination. Creates a matched TRANSFER_OUT /
    // TRANSFER_IN pair, linked via transfer_pair_id, so a transfer is always
    // a traceable, balanced two-sided entry rather than one free-floating row.
    router.post('/cash-transactions/transfer', async (req, res) => {
        const { to_account_id, amount, currency, date_time, is_virtual, note } = req.body;
        if (!to_account_id) {
            return res.status(400).json({ error: 'to_account_id is required' });
        }
        if (parseInt(to_account_id, 10) === req.accountId) {
            return res.status(400).json({ error: 'Cannot transfer an account to itself' });
        }
        if (typeof amount !== 'number' || amount <= 0) {
            return res.status(400).json({ error: 'amount (positive number) is required' });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const dt = date_time || new Date().toISOString();
            const cur = currency || 'USD';
            const virtual = !!is_virtual;

            const { rows: outRows } = await client.query(
                `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, is_virtual, note)
                 VALUES ($1, $2, 'TRANSFER_OUT', $3, $4, $5, $6) RETURNING id`,
                [req.accountId, dt, -Math.abs(amount), cur, virtual, note || null]
            );
            const { rows: inRows } = await client.query(
                `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, is_virtual, note, transfer_pair_id)
                 VALUES ($1, $2, 'TRANSFER_IN', $3, $4, $5, $6, $7) RETURNING id`,
                [to_account_id, dt, Math.abs(amount), cur, virtual, note || null, outRows[0].id]
            );
            await client.query(
                `UPDATE cash_transactions SET transfer_pair_id = $1 WHERE id = $2`,
                [inRows[0].id, outRows[0].id]
            );

            await client.query('COMMIT');
            broadcastStatus(uuidv4(), `Transferred ${amount} ${cur} to account ${to_account_id}`, 'success');
            res.json({ success: true, out_id: outRows[0].id, in_id: inRows[0].id });
        } catch (err) {
            await client.query('ROLLBACK');
            logger.error('Error creating transfer:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // DELETE /cash-transactions/:id — also removes the matched other side of
    // a transfer, so a transfer is always deleted as a balanced pair, never
    // leaving one side dangling.
    router.delete('/cash-transactions/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const { rows } = await pool.query(
                `SELECT transfer_pair_id FROM cash_transactions WHERE id = $1 AND account_id = $2`,
                [id, req.accountId]
            );
            if (rows.length === 0) {
                return res.status(404).json({ error: 'Cash transaction not found' });
            }
            const pairId = rows[0].transfer_pair_id;
            await pool.query(`DELETE FROM cash_transactions WHERE id = $1`, [id]);
            if (pairId) {
                await pool.query(`DELETE FROM cash_transactions WHERE id = $1`, [pairId]);
            }
            broadcastStatus(uuidv4(), `Deleted cash transaction ${id}`, 'success');
            res.json({ success: true });
        } catch (err) {
            logger.error('Error deleting cash transaction:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- Holdings (T-bills, bonds, other non-trade assets) ---

    // GET /holdings
    router.get('/holdings', async (req, res) => {
        try {
            const { rows } = await pool.query(
                `SELECT * FROM holdings WHERE account_id = $1 ORDER BY purchase_date DESC, id DESC`,
                [req.accountId]
            );
            res.json(rows);
        } catch (err) {
            logger.error('Error fetching holdings:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /holdings — purchasing a holding also debits cash automatically,
    // same reasoning as trade settlement: one action, not two records to
    // keep in sync by hand.
    router.post('/holdings', async (req, res) => {
        const {
            type, name, currency, face_value, purchase_price, purchase_date,
            maturity_date, coupon_rate, coupon_frequency, notes, is_virtual,
        } = req.body;
        const allowedTypes = ['TBILL', 'BOND', 'OTHER'];
        if (!allowedTypes.includes(type)) {
            return res.status(400).json({ error: `type must be one of: ${allowedTypes.join(', ')}` });
        }
        if (!name || typeof face_value !== 'number' || typeof purchase_price !== 'number' || !purchase_date) {
            return res.status(400).json({ error: 'name, face_value, purchase_price, purchase_date are required' });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                `INSERT INTO holdings (account_id, type, name, currency, face_value, purchase_price, purchase_date, maturity_date, coupon_rate, coupon_frequency, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
                [req.accountId, type, name, currency || 'USD', face_value, purchase_price, purchase_date, maturity_date || null, coupon_rate || null, coupon_frequency || null, notes || null]
            );
            const holdingId = rows[0].id;
            await client.query(
                `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, is_virtual, linked_holding_id, note)
                 VALUES ($1, $2, 'OTHER', $3, $4, $5, $6, $7)`,
                [req.accountId, purchase_date, -Math.abs(purchase_price), currency || 'USD', !!is_virtual, holdingId, `Purchased ${name}`]
            );
            await client.query('COMMIT');
            broadcastStatus(uuidv4(), `Purchased holding: ${name}`, 'success');
            res.json({ success: true, id: holdingId });
        } catch (err) {
            await client.query('ROLLBACK');
            logger.error('Error creating holding:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // PUT /holdings/:id
    router.put('/holdings/:id', async (req, res) => {
        const { id } = req.params;
        const {
            type, name, currency, face_value, purchase_price, purchase_date,
            maturity_date, coupon_rate, coupon_frequency, notes, status,
        } = req.body;
        try {
            const { rowCount } = await pool.query(
                `UPDATE holdings SET type=$1, name=$2, currency=$3, face_value=$4, purchase_price=$5,
                    purchase_date=$6, maturity_date=$7, coupon_rate=$8, coupon_frequency=$9, notes=$10,
                    status=$11, updated_at=NOW()
                 WHERE id=$12 AND account_id=$13`,
                [type, name, currency || 'USD', face_value, purchase_price, purchase_date, maturity_date || null,
                 coupon_rate || null, coupon_frequency || null, notes || null, status || 'ACTIVE', id, req.accountId]
            );
            if (rowCount === 0) return res.status(404).json({ error: 'Holding not found' });
            res.json({ success: true });
        } catch (err) {
            logger.error('Error updating holding:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /holdings/:id/redeem — marks a holding matured/sold and credits
    // cash for the redemption amount (face value by default, or a specific
    // amount if provided — e.g. a bond sold before maturity at a different
    // price, or a final coupon added on top of face value).
    router.post('/holdings/:id/redeem', async (req, res) => {
        const { id } = req.params;
        const { amount, date_time, is_virtual, status } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                `SELECT * FROM holdings WHERE id = $1 AND account_id = $2`,
                [id, req.accountId]
            );
            if (rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Holding not found' });
            }
            const holding = rows[0];
            const redemptionAmount = typeof amount === 'number' ? amount : Number(holding.face_value);
            const redemptionDate = date_time || new Date().toISOString();

            await client.query(
                `UPDATE holdings SET status = $1, updated_at = NOW() WHERE id = $2`,
                [status || 'MATURED', id]
            );
            await client.query(
                `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, is_virtual, linked_holding_id, note)
                 VALUES ($1, $2, 'OTHER', $3, $4, $5, $6, $7)`,
                [req.accountId, redemptionDate, Math.abs(redemptionAmount), holding.currency, !!is_virtual, id, `Redeemed ${holding.name}`]
            );
            await client.query('COMMIT');
            broadcastStatus(uuidv4(), `Redeemed holding: ${holding.name}`, 'success');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK');
            logger.error('Error redeeming holding:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // DELETE /holdings/:id — also removes its linked purchase/redemption
    // cash_transactions (ON DELETE CASCADE on linked_holding_id), so deleting
    // a holding doesn't leave orphaned ledger entries behind.
    router.delete('/holdings/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const { rowCount } = await pool.query(
                `DELETE FROM holdings WHERE id = $1 AND account_id = $2`,
                [id, req.accountId]
            );
            if (rowCount === 0) return res.status(404).json({ error: 'Holding not found' });
            res.json({ success: true });
        } catch (err) {
            logger.error('Error deleting holding:', err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
