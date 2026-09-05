const express = require('express');
const router = express.Router();
const { logger } = require('../modules/logger.js');

// Export a function that accepts dependencies
module.exports = (pool, broadcastStatus, uuidv4) => {

    // GET /accounts
    // Includes parent_account_id/is_virtual (account hierarchy + paper-vs-
    // real, permanently for the whole account — not a per-transaction
    // choice, see docs/CAPITAL_TRACKING_DESIGN.md) and a per-currency cash
    // balance breakdown — deliberately NOT collapsed into one number, since
    // summing different currencies without FX conversion would be
    // meaningless.
    router.get('/', async (req, res) => {
        try {
            const { rows } = await pool.query(`
                SELECT a.*,
                    (
                        SELECT COALESCE(json_agg(json_build_object(
                            'currency', b.currency,
                            'balance', b.balance
                        )), '[]'::json)
                        FROM (
                            SELECT currency, SUM(amount) AS balance
                            FROM cash_transactions
                            WHERE account_id = a.id
                            GROUP BY currency
                        ) b
                    ) AS cash_balances
                FROM accounts a
                ORDER BY a.name
            `);
            res.json(rows);
        } catch (err) {
            broadcastStatus(uuidv4(), `Error fetching accounts: ${err.message}`, 'error');
            logger.error('Error fetching accounts:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /accounts
    router.post('/', async (req, res) => {
        const { name, parent_account_id, is_virtual } = req.body;
        if (!name) {
            broadcastStatus(uuidv4(), 'Account name is required', 'error');
            return res.status(400).json({ error: 'Name is required' });
        }
        try {
            const { rows } = await pool.query(
                'INSERT INTO accounts (name, parent_account_id, is_virtual) VALUES ($1, $2, $3) RETURNING id',
                [name, parent_account_id || null, !!is_virtual]
            );
            broadcastStatus(uuidv4(), `Created account: ${name}`, 'success');
            res.json({ success: true, id: rows[0].id });
        } catch (err) {
            if (err.code === '23505') {
                broadcastStatus(uuidv4(), 'Account name already exists', 'error');
                res.status(409).json({ error: 'Account name already exists' });
            } else {
                broadcastStatus(uuidv4(), `Error creating account: ${err.message}`, 'error');
                logger.error('Error creating account:', err);
                res.status(500).json({ error: err.message });
            }
        }
    });

    // PUT /accounts/:id
    // Sets parent_account_id/is_virtual directly (not COALESCE) — the
    // settings form always submits the full account state, including
    // explicitly clearing parent_account_id back to top-level.
    router.put('/:id', async (req, res) => {
        const { id } = req.params;
        const { name, parent_account_id, is_virtual } = req.body;
        if (!name) {
            broadcastStatus(uuidv4(), 'Account name is required for update', 'error');
            return res.status(400).json({ error: 'Name is required' });
        }
        if (parent_account_id && parseInt(parent_account_id, 10) === parseInt(id, 10)) {
            return res.status(400).json({ error: 'An account cannot be its own parent' });
        }
        try {
            const { rowCount } = await pool.query(
                `UPDATE accounts SET name=$1,
                    parent_account_id = $2,
                    is_virtual = $3,
                    updated_at=NOW()
                 WHERE id=$4`,
                [name, parent_account_id || null, !!is_virtual, id]
            );
            if (rowCount === 0) {
                broadcastStatus(uuidv4(), `Account ID ${id} not found`, 'error');
                return res.status(404).json({ error: 'Account not found' });
            }
            broadcastStatus(uuidv4(), `Updated account ID ${id} to ${name}`, 'success');
            res.json({ success: true });
        } catch (err) {
            broadcastStatus(uuidv4(), `Error updating account: ${err.message}`, 'error');
            logger.error('Error updating account:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /accounts/:id
    router.delete('/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const { rowCount } = await pool.query('DELETE FROM accounts WHERE id=$1', [id]);
            if (rowCount === 0) {
                broadcastStatus(uuidv4(), `Account ID ${id} not found`, 'error');
                return res.status(404).json({ error: 'Account not found' });
            }
            broadcastStatus(uuidv4(), `Deleted account ID ${id}`, 'success');
            res.json({ success: true });
        } catch (err) {
            broadcastStatus(uuidv4(), `Error deleting account: ${err.message}`, 'error');
            logger.error('Error deleting account:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // GET /accounts/:id/filters
    router.get('/:id/filters', async (req, res) => {
        const { id } = req.params;
        try {
            const { rows } = await pool.query('SELECT * FROM account_filters WHERE account_id = $1', [id]);
            if (rows.length > 0) {
                res.json(rows[0]);
            } else {
                // Return default filter settings
                res.json({
                    status_filters: [],
                    time_filter: null,
                    custom_start_date: null,
                    custom_end_date: null,
                    symbol_filter: '',
                    show_trades: true,
                    show_day_notes: true,
                    restrict_to_actions_in_range: false,
                    trades_per_page: 100,
                    hidden_columns: [],
                });
            }
        } catch (err) {
            logger.error('Error fetching filter settings:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // PUT /accounts/:id/filters
    router.put('/:id/filters', async (req, res) => {
        const { id } = req.params;
        const {
            status_filters,
            time_filter,
            custom_start_date,
            custom_end_date,
            symbol_filter,
            show_trades,
            show_day_notes,
            restrict_to_actions_in_range,
            trades_per_page,
            hidden_columns,
        } = req.body;
        try {
            await pool.query(
                `INSERT INTO account_filters (
        account_id,
        status_filters,
        time_filter,
        custom_start_date,
        custom_end_date,
        symbol_filter,
        show_trades,
        show_day_notes,
        restrict_to_actions_in_range,
        trades_per_page,
        hidden_columns
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (account_id) DO UPDATE SET
        status_filters = EXCLUDED.status_filters,
        time_filter = EXCLUDED.time_filter,
        custom_start_date = EXCLUDED.custom_start_date,
        custom_end_date = EXCLUDED.custom_end_date,
        symbol_filter = EXCLUDED.symbol_filter,
        show_trades = EXCLUDED.show_trades,
        show_day_notes = EXCLUDED.show_day_notes,
        restrict_to_actions_in_range = EXCLUDED.restrict_to_actions_in_range,
        trades_per_page = EXCLUDED.trades_per_page,
        hidden_columns = EXCLUDED.hidden_columns
      `,
                [
                    id,
                    JSON.stringify(status_filters),
                    time_filter,
                    custom_start_date,
                    custom_end_date,
                    symbol_filter,
                    show_trades,
                    show_day_notes,
                    restrict_to_actions_in_range,
                    trades_per_page,
                    JSON.stringify(hidden_columns || []),
                ]
            );
            res.json({ success: true });
        } catch (err) {
            logger.error('Error saving filter settings:', err);
            res.status(500).json({ error: err.message });
        }
    });
    
    return router;
};
