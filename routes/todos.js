const express = require('express');
const { logger } = require('../modules/logger.js');
const { TodoError } = require('../modules/todos.js');

// The Todo list's routes (rules and storage: modules/todos.js). Two sets
// over the same service:
//   appRouter       /api/todos, the app's own (items written here are the
//                   user's: created_by "user")
//   externalRouter  /api/external/v1/todos, for the agent (created_by
//                   "agent"), documented in EXTERNAL_API.md
// Which one a write came through is its `origin` ('app' / 'agent'): the
// agent is only told about the app's changes (changeNotifier below), so it
// never hears its own writes.

const fail = (res, err, what) => {
    if (err instanceof TodoError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    logger.error(`[Todos] Error ${what}:`, err);
    return res.status(500).json({ error: err.message });
};

const idParam = (router) => router.param('id', (req, res, next, value) => (
    /^\d+$/.test(value) ? next() : res.status(400).json({ error: 'Invalid id' })
));

function appRouter(service) {
    const router = express.Router();
    idParam(router);

    router.get('/todos', async (req, res) => {
        try {
            const { total, items } = await service.list({ limit: 1000, ...req.query });
            res.json({ total, todos: items });
        } catch (err) { fail(res, err, 'listing todos'); }
    });

    // The user has seen the fired items (opened the Todo page).
    router.post('/todos/seen', async (req, res) => {
        try {
            res.json({ success: true, seen: await service.markSeen('app') });
        } catch (err) { fail(res, err, 'marking todos seen'); }
    });

    router.post('/todos', async (req, res) => {
        try {
            res.status(201).json(await service.create(req.body, 'app'));
        } catch (err) { fail(res, err, 'creating a todo'); }
    });

    router.patch('/todos/:id', async (req, res) => {
        try {
            res.json(await service.update(Number(req.params.id), req.body, 'app'));
        } catch (err) { fail(res, err, 'updating a todo'); }
    });

    router.delete('/todos/:id', async (req, res) => {
        try {
            await service.remove(Number(req.params.id), 'app');
            res.json({ success: true });
        } catch (err) { fail(res, err, 'deleting a todo'); }
    });

    return router;
}

function externalRouter(service) {
    const router = express.Router();
    idParam(router);

    router.get('/todos', async (req, res) => {
        try {
            const { total, limit, offset, items } = await service.list(req.query);
            res.json({ total, limit, offset, todos: items });
        } catch (err) { fail(res, err, 'listing todos'); }
    });

    router.get('/todos/key/:key', async (req, res) => {
        try {
            res.json(await service.getByKey(req.params.key));
        } catch (err) { fail(res, err, 'fetching a todo'); }
    });

    router.get('/todos/:id', async (req, res) => {
        try {
            res.json(await service.get(Number(req.params.id)));
        } catch (err) { fail(res, err, 'fetching a todo'); }
    });

    router.post('/todos', async (req, res) => {
        try {
            res.status(201).json(await service.create(req.body, 'agent'));
        } catch (err) { fail(res, err, 'creating a todo'); }
    });

    router.put('/todos/key/:key', async (req, res) => {
        try {
            const { saved, created } = await service.upsertByKey(req.params.key, req.body || {}, 'agent');
            res.status(created ? 201 : 200).json(saved);
        } catch (err) { fail(res, err, 'saving a todo'); }
    });

    router.patch('/todos/:id', async (req, res) => {
        try {
            res.json(await service.update(Number(req.params.id), req.body, 'agent'));
        } catch (err) { fail(res, err, 'updating a todo'); }
    });

    router.delete('/todos/:id', async (req, res) => {
        try {
            await service.remove(Number(req.params.id), 'agent');
            res.json({ success: true });
        } catch (err) { fail(res, err, 'deleting a todo'); }
    });

    return router;
}

// The service's onChange: every change refreshes the open apps (a
// "todosChanged" message on the WebSocket), and a change made in the app is
// sent to the agent as a "todo" event (modules/kate-events.js send()); one
// the agent made itself through the external API, and the user having seen
// the fired items, are not.
//   broadcast(message)  sends a message to every open app
//   loadConfig()        the current config.json (the event's url and token)
//   send(config, event, data)
function changeNotifier({ broadcast, loadConfig, send }) {
    return ({ id, key, change, origin }) => {
        broadcast({ type: 'todosChanged', id, change });
        if (origin !== 'app' || !['created', 'updated', 'deleted'].includes(change)) return;
        Promise.resolve()
            .then(loadConfig)
            .then(config => send(config, 'todo', { id, key, change }))
            .catch(err => logger.warn(`[Todos] Event not sent: ${err.message}`));
    };
}

module.exports = { appRouter, externalRouter, changeNotifier };
