const express = require('express');
const fs = require('fs').promises;
const router = express.Router();
const { logger } = require('../modules/logger.js');
const { getTickMultiplier, computeFuturesRealizedPnLPerAction } = require('../modules/tradeCalculations.js');

module.exports = (pool, upload, broadcastStatus, uuidv4) => {

    // Auto-settles trade actions to the cash ledger. STK actions move the
    // full notional value (price*qty) plus fee — that's genuinely what
    // buying/selling a stock does to cash. FUT actions settle fee always
    // (a broker charges commission per fill regardless of PnL realisation),
    // PLUS the realised PnL for closing actions specifically — a futures
    // BUY/SELL doesn't move notional cash (only margin), the cash impact of
    // closing a position IS its realised PnL. Uses the same FIFO matching
    // TradeContext.js does client-side (computeFuturesRealizedPnLPerAction
    // in modules/tradeCalculations.js — price-difference only, no fee
    // attribution needed there since fees are already fully handled by the
    // flat per-action charge below).
    async function settleTradeActionsToCash(client, tradeId, accountId, type, symbol, actions, tickSize, tickValue) {
        if (!actions || actions.length === 0) return;

        const { rows: accRows } = await client.query('SELECT default_is_virtual FROM accounts WHERE id=$1', [accountId]);
        const isVirtual = accRows.length > 0 ? accRows[0].default_is_virtual : false;

        const { rows: fsRows } = await client.query('SELECT currency FROM futures_settings WHERE symbol=$1 AND type=$2', [symbol, type]);
        const currency = fsRows.length > 0 ? fsRows[0].currency : 'USD';

        // FIFO matching needs actions in chronological order regardless of
        // the order they were entered/submitted in — sort a copy, keeping
        // each entry's original array index so results can be looked back
        // up while building settlement rows in the original (submission)
        // order below.
        let realizedByOriginalIndex = new Map();
        if (type === 'FUT' && actions.length > 1) {
            const withOriginalIndex = actions.map((a, i) => ({ ...a, __originalIndex: i }));
            withOriginalIndex.sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime));
            const side = withOriginalIndex[0].type === 'BUY' ? 'LONG' : 'SHORT';
            const tickMultiplier = getTickMultiplier({ type, tick_size: tickSize, tick_value: tickValue });
            const realizedBySortedIndex = computeFuturesRealizedPnLPerAction(side, withOriginalIndex, tickMultiplier);
            realizedBySortedIndex.forEach((pnl, sortedIdx) => {
                realizedByOriginalIndex.set(withOriginalIndex[sortedIdx].__originalIndex, pnl);
            });
        }

        const values = [];
        const placeholders = [];
        actions.forEach((a, i) => {
            const qty = Number(a.quantity || 0);
            const price = Number(a.price || 0);
            const fee = Number(a.fee || 0);
            const realizedPnL = realizedByOriginalIndex.get(i) || 0;
            const amount = type === 'STK'
                ? (a.type === 'BUY' ? -1 : 1) * qty * price - fee
                : -fee + realizedPnL; // FUT: fee always, plus realised PnL if this action closed something
            const baseIndex = i * 7;
            placeholders.push(`($${baseIndex + 1}, $${baseIndex + 2}, 'TRADE_SETTLEMENT', $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7})`);
            values.push(accountId, a.dateTime, amount, currency, isVirtual, tradeId, `${a.type} ${qty} ${symbol}`);
        });

        await client.query(
            `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, is_virtual, linked_trade_id, note) VALUES ${placeholders.join(',')}`,
            values
        );
    }

    // --- Trades Endpoints ---

    // Optimized GET /trades: single query with JSON aggregation, no image data included
    router.get('/trades', async (req, res) => {
        try {
            const query = `
                SELECT
                    t.id, t.account_id, t.type, t.symbol, t.target, t.stop_loss,
                    t.tick_size, t.tick_value, t.contract_month, t.created_at, t.updated_at,
                    (
                        SELECT COALESCE(json_agg(
                            to_jsonb(a) || jsonb_build_object('execId', a.exec_id)
                            ORDER BY a.date_time ASC
                        ), '[]'::json)
                        FROM trade_actions a WHERE a.trade_id = t.id
                    ) as actions,
                    (
                        SELECT row_to_json(j)
                        FROM trade_journals j WHERE j.trade_id = t.id
                        LIMIT 1
                    ) as journal,
                    (
                        SELECT COALESCE(json_agg(json_build_object(
                            'id', att.id,
                            'filename', att.filename,
                            'mime_type', att.mime_type
                        )), '[]'::json)
                        FROM trade_attachments att WHERE att.trade_id = t.id
                    ) as attachments
                FROM trades t
                WHERE t.account_id = $1
                ORDER BY t.created_at DESC
            `;
            const { rows: trades } = await pool.query(query, [req.accountId]);
            res.json(trades);
        } catch (err) {
            broadcastStatus(uuidv4(), `Error fetching trades: ${err.message}`, 'error');
            logger.error('Error fetching trades:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // Optimized GET /trades/:id: single query fetching all related data including base64-encoded images
    router.get('/trades/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const query = `
        SELECT
          t.*,
          (
            SELECT COALESCE(json_agg(
                to_jsonb(a) || jsonb_build_object('execId', a.exec_id)
                ORDER BY a.date_time ASC
            ), '[]'::json)
            FROM trade_actions a WHERE a.trade_id = t.id
          ) as actions,
          (
            SELECT row_to_json(j)
            FROM trade_journals j WHERE j.trade_id = t.id
            LIMIT 1
          ) as journal,
          (
            SELECT COALESCE(json_agg(json_build_object(
              'id', att.id,
              'filename', att.filename,
              'mime_type', att.mime_type,
              'image_base64', encode(att.image_data, 'base64')
            )), '[]'::json)
            FROM trade_attachments att WHERE att.trade_id = t.id
          ) as attachments
        FROM trades t
        WHERE t.id = $1 AND t.account_id = $2
      `;
            const { rows } = await pool.query(query, [id, req.accountId]);
            if (rows.length === 0) {
                broadcastStatus(uuidv4(), `Trade ID ${id} not found`, 'error');
                return res.status(404).json({ error: 'Not found' });
            }
            res.json(rows[0]);
        } catch (err) {
            broadcastStatus(uuidv4(), `Error fetching trade ${id}: ${err.message}`, 'error');
            logger.error(`Error fetching trade ${id}:`, err);
            res.status(500).json({ error: err.message });
        }
    });

    // Optimized POST /trades: bulk insert trade_actions, journal, attachments update
    router.post('/trades', async (req, res) => {
        const client = await pool.connect();
        try {
            const { type, symbol, target, stopLoss, tickSize, tickValue, contract_month, actions, journal, attachments } = req.body;
            const accountId = req.accountId;

            await client.query('BEGIN');

            const { rows } = await client.query(
                `INSERT INTO trades (account_id, type, symbol, target, stop_loss, tick_size, tick_value, contract_month)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
                [accountId, type, symbol, target, stopLoss, tickSize, tickValue, contract_month || null]
            );
            const tradeId = rows[0].id;

            // Bulk insert trade_actions
            if (actions && actions.length > 0) {
                const actionValues = [];
                const placeholders = [];
                actions.forEach((a, i) => {
                    const baseIndex = i * 7;
                    placeholders.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7})`);
                    actionValues.push(tradeId, a.type, a.dateTime, a.quantity, a.price, a.fee, a.execId || null);
                });
                const insertActionsQuery = `
          INSERT INTO trade_actions (trade_id, type, date_time, quantity, price, fee, exec_id)
          VALUES ${placeholders.join(',')}
        `;
                await client.query(insertActionsQuery, actionValues);

                await settleTradeActionsToCash(client, tradeId, accountId, type, symbol, actions, tickSize, tickValue);
            }

            // Insert journal if present
            if (journal) {
                await client.query(
                    `INSERT INTO trade_journals (trade_id, tags, notes_html, confidence, execution_rating)
        VALUES ($1, $2, $3, $4, $5)`,
                    [tradeId, journal.tags, journal.notes_html, journal.confidence, journal.execution_rating || null]
                );
            }

            // Update attachments to link to trade
            if (attachments && attachments.length) {
                const attachmentValues = [];
                const attachmentPlaceholders = [];
                attachments.forEach((att, i) => {
                    const baseIndex = i * 3;
                    attachmentPlaceholders.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3})`);
                    attachmentValues.push(tradeId, att.attachment_id, accountId);
                });
                // We can run multiple UPDATEs in a single transaction but not as bulk, so run sequentially or in parallel:
                for (const att of attachments) {
                    await client.query(
                        `UPDATE trade_attachments SET trade_id=$1 WHERE id=$2 AND account_id=$3`,
                        [tradeId, att.attachment_id, accountId]
                    );
                }
            }

            await client.query('COMMIT');
            broadcastStatus(uuidv4(), `Created trade ID ${tradeId} for ${symbol}`, 'success');
            res.json({ success: true, id: tradeId });
        } catch (err) {
            await client.query('ROLLBACK');
            broadcastStatus(uuidv4(), `Error creating trade: ${err.message}`, 'error');
            logger.error('Error creating trade:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    router.post('/attachments', upload.single('file'), async (req, res) => {
        if (!req.file) {
            broadcastStatus(uuidv4(), 'No file provided for attachment', 'error');
            return res.status(400).json({ error: 'No file' });
        }

        const client = await pool.connect();
        try {
            const imageBuffer = await fs.readFile(req.file.path);
            const mimeType = req.file.mimetype;
            const filename = req.file.originalname;
            const accountId = req.accountId;

            const { rows } = await client.query(
                `INSERT INTO trade_attachments (account_id, image_data, mime_type, filename)
      VALUES ($1, $2, $3, $4) RETURNING id`,
                [accountId, imageBuffer, mimeType, filename]
            );
            await fs.unlink(req.file.path);
            broadcastStatus(uuidv4(), `Uploaded attachment: ${filename}`, 'success');
            res.json({ attachment_id: rows[0].id });
        } catch (err) {
            broadcastStatus(uuidv4(), `Error uploading attachment: ${err.message}`, 'error');
            logger.error('Error uploading attachment:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // Optimized PUT /trades/:id: bulk insert trade_actions after deletion, AND improved attachment handling
    router.put('/trades/:id', async (req, res) => {
        const client = await pool.connect();
        const { id } = req.params;
        try {
            const { type, symbol, target, stopLoss, tickSize, tickValue, contract_month, actions, journal, attachments } = req.body;
            const accountId = req.accountId;

            await client.query('BEGIN');

            // Update main trade details
            await client.query(
                `UPDATE trades SET type=$1, symbol=$2, target=$3, stop_loss=$4, tick_size=$5, tick_value=$6, contract_month=$7, updated_at=NOW()
         WHERE id=$8 AND account_id=$9`,
                [type, symbol, target, stopLoss, tickSize, tickValue, contract_month || null, id, accountId]
            );

            // Re-insert trade_actions (delete existing, then bulk insert new)
            await client.query(`DELETE FROM trade_actions WHERE trade_id=$1`, [id]);
            // Cash settlement is re-derived from scratch alongside trade_actions
            // (same delete-then-recreate pattern) rather than trying to diff
            // old vs. new actions — much simpler, and correct either way since
            // nothing else ever links to a specific settlement row by id.
            await client.query(`DELETE FROM cash_transactions WHERE linked_trade_id=$1`, [id]);
            if (actions && actions.length > 0) {
                const actionValues = [];
                const placeholders = [];
                actions.forEach((a, i) => {
                    const baseIndex = i * 7;
                    placeholders.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7})`);
                    actionValues.push(id, a.type, a.dateTime, a.quantity, a.price, a.fee, a.execId || null);
                });
                const insertActionsQuery = `
          INSERT INTO trade_actions (trade_id, type, date_time, quantity, price, fee, exec_id)
          VALUES ${placeholders.join(',')}
        `;
                await client.query(insertActionsQuery, actionValues);

                await settleTradeActionsToCash(client, id, accountId, type, symbol, actions, tickSize, tickValue);
            }

            // Re-insert journal (delete existing, then insert new if present)
            await client.query(`DELETE FROM trade_journals WHERE trade_id=$1`, [id]);
            if (journal) {
                await client.query(
                    `INSERT INTO trade_journals (trade_id, tags, notes_html, confidence, execution_rating)
           VALUES ($1, $2, $3, $4, $5)`,
                    [id, journal.tags, journal.notes_html, journal.confidence, journal.execution_rating || null]
                );
            }

            // --- IMPROVED ATTACHMENT MANAGEMENT FOR TRADES ---

            // 1. Get existing attachments for this trade
            const { rows: existingAttachments } = await client.query(
                'SELECT id FROM trade_attachments WHERE trade_id=$1 AND account_id=$2',
                [id, accountId]
            );
            const existingAttachmentIds = new Set(existingAttachments.map(att => att.id));

            // 2. Identify attachments to be linked (from the request)
            const incomingAttachmentIds = new Set(attachments.map(att => att.attachment_id));

            // 3. Identify attachments to DELETE (no longer in incoming list, but were previously linked)
            const attachmentsToDelete = Array.from(existingAttachmentIds).filter(
                attId => !incomingAttachmentIds.has(attId)
            );

            // 4. Perform deletions
            if (attachmentsToDelete.length > 0) {
                await client.query(
                    `DELETE FROM trade_attachments WHERE id = ANY($1::int[]) AND account_id = $2`,
                    [attachmentsToDelete, accountId]
                );
            }

            // 5. Link new/existing attachments from the incoming list to this trade
            if (attachments && attachments.length > 0) {
                // Unlink from any potential day_note_id (safety based on check_link constraint)
                // and link to this trade_id
                await client.query(
                    `UPDATE trade_attachments SET day_note_id=NULL, trade_id=$1
           WHERE id = ANY($2::int[]) AND account_id = $3`,
                    [id, Array.from(incomingAttachmentIds), accountId]
                );
            }

            await client.query('COMMIT');
            broadcastStatus(uuidv4(), `Updated trade ID ${id} for ${symbol}`, 'success');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK');
            broadcastStatus(uuidv4(), `Error updating trade: ${err.message}`, 'error');
            logger.error('Error updating trade:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });


    router.delete('/trades/:id', async (req, res) => {
        const client = await pool.connect();
        const { id } = req.params;
        try {
            await client.query('BEGIN');
            await client.query(`DELETE FROM trade_attachments WHERE trade_id=$1 AND account_id=$2`, [id, req.accountId]);
            await client.query(`DELETE FROM trade_journals WHERE trade_id=$1`, [id]);
            await client.query(`DELETE FROM trade_actions WHERE trade_id=$1`, [id]);
            await client.query(`DELETE FROM cash_transactions WHERE linked_trade_id=$1`, [id]);
            await client.query(`DELETE FROM trades WHERE id=$1 AND account_id=$2`, [id, req.accountId]);
            await client.query('COMMIT');
            broadcastStatus(uuidv4(), `Deleted trade ID ${id}`, 'success');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK');
            broadcastStatus(uuidv4(), `Error deleting trade: ${err.message}`, 'error');
            logger.error('Error deleting trade:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // --- DayNotes Endpoints ---

    // Optimized GET /daynotes: single query with JSON aggregation, no image data included
    router.get('/daynotes', async (req, res) => {
        try {
            const query = `
                SELECT
                    dn.*,
                    (
                        SELECT COALESCE(json_agg(json_build_object(
                            'id', att.id,
                            'filename', att.filename,
                            'mime_type', att.mime_type
                        )), '[]'::json)
                        FROM trade_attachments att WHERE att.day_note_id = dn.id
                    ) as attachments
                FROM day_notes dn
                WHERE dn.account_id = $1
                ORDER BY dn.date DESC
            `;
            const { rows: dayNotes } = await pool.query(query, [req.accountId]);
            res.json(dayNotes);
        } catch (err) {
            broadcastStatus(uuidv4(), `Error fetching day notes: ${err.message}`, 'error');
            logger.error('Error fetching day notes:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // Optimized GET /daynotes/:id: single query fetching attachments with images
    router.get('/daynotes/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const query = `
        SELECT
          dn.*,
          (
            SELECT COALESCE(json_agg(json_build_object(
              'id', att.id,
              'filename', att.filename,
              'mime_type', att.mime_type,
              'image_base64', encode(att.image_data, 'base64')
            )), '[]'::json)
            FROM trade_attachments att WHERE att.day_note_id = dn.id
          ) as attachments
        FROM day_notes dn
        WHERE dn.id = $1 AND dn.account_id = $2
      `;
            const { rows } = await pool.query(query, [id, req.accountId]);
            if (rows.length === 0) {
                broadcastStatus(uuidv4(), `Day note ID ${id} not found`, 'error');
                return res.status(404).json({ error: 'Not found' });
            }
            res.json(rows[0]);
        } catch (err) {
            broadcastStatus(uuidv4(), `Error fetching day note ${id}: ${err.message}`, 'error');
            logger.error(`Error fetching day note ${id}:`, err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /daynotes with upsert logic remains unchanged
    router.post('/daynotes', async (req, res) => {
        const client = await pool.connect();
        try {
            const { id, date, mood, marketCondition, marketVolume, summary, notes, attachments } = req.body;
            const accountId = req.accountId;

            await client.query('BEGIN');

            let noteId;
            if (id) {
                // Update existing note
                const { rows: conflictingNotes } = await client.query(
                    'SELECT id FROM day_notes WHERE date=$1 AND account_id=$2 AND id!=$3',
                    [date, accountId, id]
                );
                if (conflictingNotes.length > 0) {
                    broadcastStatus(uuidv4(), `A day note already exists for date ${date}`, 'error');
                    throw new Error(`A day note already exists for date ${date} in this account`);
                }
                await client.query(
                    `UPDATE day_notes
           SET date=$1, mood=$2, market_condition=$3, market_volume=$4, summary=$5, notes_html=$6, updated_at=NOW()
           WHERE id=$7 AND account_id=$8`,
                    [date, mood, marketCondition, marketVolume, summary, notes, id, accountId]
                );
                noteId = id;
                broadcastStatus(uuidv4(), `Updated day note ID ${id} for ${date}`, 'success');
            } else {
                // Insert new note with ON CONFLICT DO NOTHING to prevent duplicates
                const insertQuery = `
          INSERT INTO day_notes (account_id, date, mood, market_condition, market_volume, summary, notes_html)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (account_id, date) DO NOTHING
          RETURNING id
        `;
                const { rows } = await client.query(insertQuery, [accountId, date, mood, marketCondition, marketVolume, summary, notes]);
                if (rows.length === 0) {
                    broadcastStatus(uuidv4(), `A day note already exists for date ${date}`, 'error');
                    throw new Error(`A day note already exists for date ${date} in this account`);
                }
                noteId = rows[0].id;
                broadcastStatus(uuidv4(), `Created day note ID ${noteId} for ${date}`, 'success');
            }

            // --- ATTACHMENT MANAGEMENT FOR DAY NOTES (Crucial Fix) ---

            // 1. Get existing attachments for this day note
            const { rows: existingAttachments } = await client.query(
                'SELECT id FROM trade_attachments WHERE day_note_id=$1 AND account_id=$2',
                [noteId, accountId]
            );
            const existingAttachmentIds = new Set(existingAttachments.map(att => att.id));

            // 2. Identify attachments to be linked (from the request)
            const incomingAttachmentIds = new Set(attachments.map(att => att.attachment_id));

            // 3. Identify attachments to DELETE (no longer in incoming list, but were previously linked)
            const attachmentsToDelete = Array.from(existingAttachmentIds).filter(
                attId => !incomingAttachmentIds.has(attId)
            );

            // 4. Perform deletions
            if (attachmentsToDelete.length > 0) {
                await client.query(
                    `DELETE FROM trade_attachments WHERE id = ANY($1::int[]) AND account_id = $2`,
                    [attachmentsToDelete, accountId]
                );
            }

            // 5. Link new/existing attachments from the incoming list to this day note
            if (attachments && attachments.length > 0) {
                // First, unlink any that might be incorrectly linked to other trades/daynotes
                // This is a safety net; ideally, newly uploaded attachments have day_note_id/trade_id NULL
                await client.query(
                    `UPDATE trade_attachments SET trade_id=NULL, day_note_id=$1
           WHERE id = ANY($2::int[]) AND account_id = $3`,
                    [noteId, Array.from(incomingAttachmentIds), accountId]
                );
            } else {
                // If no attachments are provided in the request, and there were existing ones,
                // they've already been marked for deletion, so no further action needed here.
            }

            await client.query('COMMIT');
            res.json({ success: true, id: noteId });
        } catch (err) {
            await client.query('ROLLBACK');
            broadcastStatus(uuidv4(), `Error creating/updating day note: ${err.message}`, 'error');
            logger.error('Error creating/updating day note:', err);
            res.status(400).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // DELETE /daynotes/:id unchanged
    router.delete('/daynotes/:id', async (req, res) => {
        const client = await pool.connect();
        const { id } = req.params;
        try {
            await client.query('BEGIN');
            // Existing attachments linked to this day note are now deleted
            await client.query(`DELETE FROM trade_attachments WHERE day_note_id=$1 AND account_id=$2`, [id, req.accountId]);
            await client.query(`DELETE FROM day_notes WHERE id=$1 AND account_id=$2`, [id, req.accountId]);
            await client.query('COMMIT');
            broadcastStatus(uuidv4(), `Deleted day note ID ${id}`, 'success');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK');
            broadcastStatus(uuidv4(), `Error deleting day note: ${err.message}`, 'error');
            logger.error('Error deleting day note:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });
    return router;
};
