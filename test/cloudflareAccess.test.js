const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createAccessGuard } = require('../modules/cloudflare-access.js');

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const NOW = 1_800_000_000_000;

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64url(obj) {
    return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function sign(payload, { kid = 'k1', key = privateKey, alg = 'RS256' } = {}) {
    const head = b64url({ alg, kid, typ: 'JWT' });
    const body = b64url(payload);
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url');
    return `${head}.${body}.${sig}`;
}

function goodPayload(extra = {}) {
    const s = Math.floor(NOW / 1000);
    return { aud: [AUD], iss: `https://${TEAM}`, email: 'me@example.com', iat: s - 10, nbf: s - 10, exp: s + 3600, ...extra };
}

function guard(cfg = { teamDomain: TEAM, aud: AUD }, { keys = [jwk] } = {}) {
    let fetches = 0;
    const g = createAccessGuard({
        getConfig: async () => (cfg === null ? {} : { cloudflareAccess: cfg }),
        fetchJson: async (url) => {
            fetches++;
            assert.strictEqual(url, `https://${TEAM}/cdn-cgi/access/certs`);
            return { keys };
        },
        now: () => NOW,
        logger: { warn() {} },
    });
    g.fetches = () => fetches;
    return g;
}

function req(url, headers = {}) {
    return { url, method: 'GET', headers };
}

const viaCf = (token) => ({ 'cf-ray': 'abc-AMS', 'cf-connecting-ip': '203.0.113.9', ...(token ? { 'cf-access-jwt-assertion': token } : {}) });

test('a request from the LAN (no Cloudflare headers) passes untouched', async () => {
    assert.deepStrictEqual(await guard().check(req('/api/trades')), { ok: true });
});

test('a valid Access token through Cloudflare passes', async () => {
    assert.deepStrictEqual(await guard().check(req('/api/trades', viaCf(sign(goodPayload())))), { ok: true });
});

test('through Cloudflare without a token is refused', async () => {
    const r = await guard().check(req('/', viaCf()));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /no Cloudflare Access token/);
});

test('webhooks are exempt (they check their own secret)', async () => {
    assert.strictEqual((await guard().check(req('/api/webhooks/tradingview-bar', viaCf()))).ok, true);
    assert.strictEqual((await guard().check(req('/api/webhooksx', viaCf()))).ok, false);
});

test('only the exact icon/manifest files are public, and only for GET', async () => {
    const g = guard();
    for (const p of ['/favicon.ico', '/logo192.png', '/logo512.png', '/manifest.json', '/manifest.json?v=2']) {
        assert.strictEqual((await g.check(req(p, viaCf()))).ok, true, p);
    }
    for (const p of ['/favicon.ico/x', '/logo192.png.bak', '/static/js/main.js', '/manifest.jsonx', '/index.html']) {
        assert.strictEqual((await g.check(req(p, viaCf()))).ok, false, p);
    }
    assert.strictEqual((await g.check({ url: '/favicon.ico', method: 'POST', headers: viaCf() })).ok, false);
});

test('without a cloudflareAccess config nothing changes', async () => {
    assert.strictEqual((await guard(null).check(req('/', viaCf()))).ok, true);
});

test('an incomplete config refuses instead of letting everything through', async () => {
    const r = await guard({ teamDomain: TEAM }).check(req('/', viaCf(sign(goodPayload()))));
    assert.strictEqual(r.ok, false);
});

test('a token signed with another key is refused', async () => {
    const r = await guard().check(req('/', viaCf(sign(goodPayload(), { key: other.privateKey }))));
    assert.deepStrictEqual(r, { ok: false, reason: 'bad signature' });
});

test('a tampered payload is refused', async () => {
    const [h, , s] = sign(goodPayload()).split('.');
    const forged = `${h}.${b64url(goodPayload({ email: 'evil@example.com' }))}.${s}`;
    assert.deepStrictEqual(await guard().check(req('/', viaCf(forged))), { ok: false, reason: 'bad signature' });
});

test('wrong audience, wrong issuer, expired and alg none are refused', async () => {
    const g = guard();
    assert.strictEqual((await g.check(req('/', viaCf(sign(goodPayload({ aud: ['other-app'] })))))).reason, 'wrong audience');
    assert.strictEqual((await g.check(req('/', viaCf(sign(goodPayload({ iss: 'https://evil.cloudflareaccess.com' })))))).reason, 'wrong issuer');
    assert.strictEqual((await g.check(req('/', viaCf(sign(goodPayload({ exp: Math.floor(NOW / 1000) - 3600 })))))).reason, 'token expired');
    const none = `${b64url({ alg: 'none', kid: 'k1' })}.${b64url(goodPayload())}.`;
    assert.strictEqual((await g.check(req('/', viaCf(none)))).ok, false);
});

test('unknown key id is refused', async () => {
    const r = await guard().check(req('/', viaCf(sign(goodPayload(), { kid: 'k9' }))));
    assert.deepStrictEqual(r, { ok: false, reason: 'unknown signing key' });
});

test('allowedEmails limits who gets in', async () => {
    const g = guard({ teamDomain: TEAM, aud: AUD, allowedEmails: ['Me@Example.com'] });
    assert.strictEqual((await g.check(req('/', viaCf(sign(goodPayload()))))).ok, true);
    assert.strictEqual((await g.check(req('/', viaCf(sign(goodPayload({ email: 'x@example.com' })))))).reason, 'email not allowed');
});

test('keys are fetched once and reused', async () => {
    const g = guard();
    await g.check(req('/', viaCf(sign(goodPayload()))));
    await g.check(req('/', viaCf(sign(goodPayload()))));
    assert.strictEqual(g.fetches(), 1);
});

test('middleware answers 403 and never calls next when refused', async () => {
    const g = guard();
    const res = { code: 0, status(c) { this.code = c; return this; }, json(b) { this.body = b; } };
    let called = false;
    await new Promise(resolve => {
        res.json = (b) => { res.body = b; resolve(); };
        g.middleware(req('/', viaCf()), res, () => { called = true; resolve(); });
    });
    assert.strictEqual(called, false);
    assert.strictEqual(res.code, 403);
});

test('a refused WebSocket upgrade gets a 403 and is not accepted', async () => {
    const g = guard();
    let written = '';
    let accepted = false;
    await new Promise(resolve => {
        g.guardUpgrade(req('/', viaCf()), { end: (s) => { written = s; resolve(); }, destroy: resolve }, () => { accepted = true; resolve(); });
    });
    assert.strictEqual(accepted, false);
    assert.match(written, /^HTTP\/1\.1 403/);
});
