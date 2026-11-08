const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const kateEvents = require('../modules/kate-events.js');

function listener(handler) {
    return new Promise(resolve => {
        const received = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                received.push({ method: req.method, url: req.url, headers: req.headers, body });
                handler(req, res);
            });
        });
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, received, url: `http://127.0.0.1:${server.address().port}/api/journal-event` });
        });
    });
}

test('posts {event, data} with the bearer token', async () => {
    const l = await listener((req, res) => { res.statusCode = 202; res.end('{"ok":true}'); });
    try {
        await kateEvents.send({ kateEventsUrl: l.url, kateEventsToken: 'tok' }, 'bar', { symbol: 'MNQ', close: 1 });
        assert.strictEqual(l.received.length, 1);
        const r = l.received[0];
        assert.strictEqual(r.method, 'POST');
        assert.strictEqual(r.url, '/api/journal-event');
        assert.strictEqual(r.headers.authorization, 'Bearer tok');
        assert.match(r.headers['content-type'], /application\/json/);
        assert.deepStrictEqual(JSON.parse(r.body), { event: 'bar', data: { symbol: 'MNQ', close: 1 } });
    } finally {
        l.server.close();
    }
});

test('sends nothing when either key is unset', async () => {
    const l = await listener((req, res) => { res.statusCode = 202; res.end(); });
    try {
        await kateEvents.send({ kateEventsUrl: l.url }, 'bar', {});
        await kateEvents.send({ kateEventsToken: 'tok' }, 'bar', {});
        await kateEvents.send({}, 'bar', {});
        await kateEvents.send(undefined, 'bar', {});
        assert.strictEqual(l.received.length, 0);
    } finally {
        l.server.close();
    }
});

test('a listener that never answers resolves after the timeout, without throwing', async () => {
    kateEvents._resetForTests();
    const l = await listener(() => { /* never responds */ });
    try {
        const started = Date.now();
        await kateEvents.send({ kateEventsUrl: l.url, kateEventsToken: 'tok' }, 'bar', {});
        const took = Date.now() - started;
        assert.ok(took >= 2900 && took < 4500, `took ${took} ms`);
    } finally {
        l.server.closeAllConnections();
        l.server.close();
    }
});

test('an unreachable listener and a non-202 answer resolve quietly', async () => {
    kateEvents._resetForTests();
    await kateEvents.send({ kateEventsUrl: 'http://127.0.0.1:1/x', kateEventsToken: 'tok' }, 'bar', {});
    const l = await listener((req, res) => { res.statusCode = 401; res.end(); });
    try {
        await kateEvents.send({ kateEventsUrl: l.url, kateEventsToken: 'tok' }, 'bar', {});
        assert.strictEqual(l.received.length, 1);
    } finally {
        l.server.close();
    }
});

test('a body over 16 KB is not sent', async () => {
    const l = await listener((req, res) => { res.statusCode = 202; res.end(); });
    try {
        await kateEvents.send({ kateEventsUrl: l.url, kateEventsToken: 'tok' }, 'tradingview', { note: 'x'.repeat(17 * 1024) });
        assert.strictEqual(l.received.length, 0);
    } finally {
        l.server.close();
    }
});

test('withoutSecret drops only the secret', () => {
    assert.deepStrictEqual(kateEvents.withoutSecret({ secret: 's', type: 'trade-idea', tp2: null }), { type: 'trade-idea', tp2: null });
    assert.deepStrictEqual(kateEvents.withoutSecret(undefined), {});
});
