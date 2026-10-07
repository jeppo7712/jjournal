const express = require('express');
const { logger } = require('../modules/logger.js');

// Trade tags and their groups, shared by all accounts (modules/database.js,
// createTagTables). A trade's own tags are saved with its journal
// (routes/trades.js, saveTradeTags).

const NAME_MAX = 60;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const cleanName = value => String(value ?? '').trim().replace(/^#+/, '').trim().slice(0, NAME_MAX);
const isUniqueViolation = err => err && err.code === '23505';

module.exports = (pool) => {
    const router = express.Router();

    // GET /tags — every group and tag, with how many trades carry each tag.
    router.get('/tags', async (req, res) => {
        try {
            const [{ rows: groups }, { rows: tags }] = await Promise.all([
                pool.query(`SELECT id, name, color, single_choice, sort_order FROM tag_groups ORDER BY sort_order, lower(name)`),
                pool.query(`
                    SELECT t.id, t.name, t.group_id, COUNT(tt.trade_id)::int AS trade_count
                    FROM tags t LEFT JOIN trade_tags tt ON tt.tag_id = t.id
                    GROUP BY t.id ORDER BY lower(t.name)`),
            ]);
            res.json({ groups, tags });
        } catch (err) {
            logger.error('Error fetching tags:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /tags { name, group_id } — a new tag, or the existing one with that
    // name (any case), so typing "fvg" picks the "FVG" already there.
    router.post('/tags', async (req, res) => {
        const name = cleanName(req.body?.name);
        const groupId = req.body?.group_id ?? null;
        if (!name) return res.status(400).json({ error: 'A tag needs a name' });
        try {
            const { rows: [found] } = await pool.query(`SELECT id, name, group_id FROM tags WHERE lower(name) = lower($1)`, [name]);
            if (found) return res.json({ ...found, existing: true });
            const { rows: [tag] } = await pool.query(
                `INSERT INTO tags (name, group_id) VALUES ($1, $2) RETURNING id, name, group_id`, [name, groupId]
            );
            res.status(201).json({ ...tag, trade_count: 0 });
        } catch (err) {
            if (err.code === '23503') return res.status(400).json({ error: 'That group no longer exists' });
            logger.error('Error creating tag:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // PUT /tags/:id { name?, group_id? } — rename it (on every trade at once)
    // or move it to another group.
    router.put('/tags/:id', async (req, res) => {
        const sets = [];
        const values = [req.params.id];
        if (req.body?.name !== undefined) {
            const name = cleanName(req.body.name);
            if (!name) return res.status(400).json({ error: 'A tag needs a name' });
            values.push(name); sets.push(`name = $${values.length}`);
        }
        if (req.body?.group_id !== undefined) {
            values.push(req.body.group_id); sets.push(`group_id = $${values.length}`);
        }
        if (sets.length === 0) return res.status(400).json({ error: 'Nothing to change' });
        try {
            const { rows: [tag] } = await pool.query(
                `UPDATE tags SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, group_id`, values
            );
            if (!tag) return res.status(404).json({ error: 'Tag not found' });
            res.json(tag);
        } catch (err) {
            if (isUniqueViolation(err)) {
                const { rows: [other] } = await pool.query(`SELECT id, name FROM tags WHERE lower(name) = lower($1)`, [cleanName(req.body.name)]);
                return res.status(409).json({ error: `There already is a tag "${other?.name}"`, conflict_id: other?.id });
            }
            if (err.code === '23503') return res.status(400).json({ error: 'That group no longer exists' });
            logger.error('Error updating tag:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // POST /tags/:id/merge { into_id } — its trades get the other tag
    // instead, and it's deleted.
    router.post('/tags/:id/merge', async (req, res) => {
        const from = Number(req.params.id);
        const into = Number(req.body?.into_id);
        if (!into || into === from) return res.status(400).json({ error: 'Pick another tag to merge into' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rowCount } = await client.query(`SELECT 1 FROM tags WHERE id = ANY($1)`, [[from, into]]);
            if (rowCount !== 2) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Tag not found' });
            }
            await client.query(
                `INSERT INTO trade_tags (trade_id, tag_id) SELECT trade_id, $2 FROM trade_tags WHERE tag_id = $1 ON CONFLICT DO NOTHING`,
                [from, into]
            );
            await client.query(`DELETE FROM tags WHERE id = $1`, [from]);
            await client.query('COMMIT');
            res.json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            logger.error('Error merging tags:', err);
            res.status(500).json({ error: err.message });
        } finally {
            client.release();
        }
    });

    // DELETE /tags/:id — off every trade too.
    router.delete('/tags/:id', async (req, res) => {
        try {
            const { rowCount } = await pool.query(`DELETE FROM tags WHERE id = $1`, [req.params.id]);
            if (rowCount === 0) return res.status(404).json({ error: 'Tag not found' });
            res.json({ success: true });
        } catch (err) {
            logger.error('Error deleting tag:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // --- Groups ---

    const groupFields = (body) => {
        const fields = {};
        if (body?.name !== undefined) {
            fields.name = cleanName(body.name);
            if (!fields.name) return { error: 'A group needs a name' };
        }
        if (body?.color !== undefined) {
            if (!COLOR_RE.test(String(body.color))) return { error: 'color must look like #3B82F6' };
            fields.color = body.color;
        }
        if (body?.single_choice !== undefined) fields.single_choice = !!body.single_choice;
        return { fields };
    };

    // POST /tag-groups { name, color?, single_choice? } — added last.
    router.post('/tag-groups', async (req, res) => {
        const { fields, error } = groupFields(req.body);
        if (error) return res.status(400).json({ error });
        if (!fields.name) return res.status(400).json({ error: 'A group needs a name' });
        try {
            const { rows: [group] } = await pool.query(
                `INSERT INTO tag_groups (name, color, single_choice, sort_order)
                 VALUES ($1, COALESCE($2, '#8B5CF6'), COALESCE($3, false), (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tag_groups))
                 RETURNING id, name, color, single_choice, sort_order`,
                [fields.name, fields.color ?? null, fields.single_choice ?? null]
            );
            res.status(201).json(group);
        } catch (err) {
            if (isUniqueViolation(err)) return res.status(409).json({ error: `There already is a group "${fields.name}"` });
            logger.error('Error creating tag group:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // PUT /tag-groups/order { ids } — the groups in this order.
    router.put('/tag-groups/order', async (req, res) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : null;
        if (!ids) return res.status(400).json({ error: 'ids must be a list of group ids' });
        try {
            await pool.query(
                `UPDATE tag_groups g SET sort_order = o.ord - 1 FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord) WHERE g.id = o.id`,
                [ids]
            );
            res.json({ success: true });
        } catch (err) {
            logger.error('Error ordering tag groups:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // PUT /tag-groups/:id { name?, color?, single_choice? }
    router.put('/tag-groups/:id', async (req, res) => {
        const { fields, error } = groupFields(req.body);
        if (error) return res.status(400).json({ error });
        const keys = Object.keys(fields);
        if (keys.length === 0) return res.status(400).json({ error: 'Nothing to change' });
        try {
            const { rows: [group] } = await pool.query(
                `UPDATE tag_groups SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1
                 RETURNING id, name, color, single_choice, sort_order`,
                [req.params.id, ...keys.map(k => fields[k])]
            );
            if (!group) return res.status(404).json({ error: 'Group not found' });
            res.json(group);
        } catch (err) {
            if (isUniqueViolation(err)) return res.status(409).json({ error: `There already is a group "${fields.name}"` });
            logger.error('Error updating tag group:', err);
            res.status(500).json({ error: err.message });
        }
    });

    // DELETE /tag-groups/:id — its tags stay, without a group.
    router.delete('/tag-groups/:id', async (req, res) => {
        try {
            const { rowCount } = await pool.query(`DELETE FROM tag_groups WHERE id = $1`, [req.params.id]);
            if (rowCount === 0) return res.status(404).json({ error: 'Group not found' });
            res.json({ success: true });
        } catch (err) {
            logger.error('Error deleting tag group:', err);
            res.status(500).json({ error: err.message });
        }
    });

    return router;
};
