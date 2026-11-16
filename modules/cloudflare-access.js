// Second lock behind Cloudflare Access.
//
// The journal has no login of its own. When it's published through a
// Cloudflare Tunnel with a Cloudflare Access application in front, Access is
// the only lock — a mistake in the Cloudflare dashboard (a deleted Access
// app, a too-wide Bypass rule, a new tunnel route without Access) would
// silently leave the whole journal open. This guard closes that gap: every
// request that arrived through Cloudflare must carry the signed token Access
// adds to requests it let through (the Cf-Access-Jwt-Assertion header), and
// the token is checked here against Cloudflare's published keys, this app's
// audience tag, the issuer and the expiry.
//
// Off until config.json has a `cloudflareAccess` section:
//   "cloudflareAccess": {
//     "teamDomain": "yourteam.cloudflareaccess.com",
//     "aud": "<the Access application's Application Audience (AUD) tag>",
//     "allowedEmails": ["you@example.com"]        // optional
//   }
// `aud` may also be an array (several Access apps pointing at this server).
//
// Not affected:
//   - Requests that didn't come through Cloudflare (LAN, VPN): they carry no
//     Cloudflare headers, and reaching the server directly is the existing
//     trusted-network model.
//   - /api/webhooks/*: called by TradingView's servers, which can't log in
//     through Access; those routes check their own shared secret.
//   - GET of the app icon files and manifest.json (see PUBLIC_ASSETS).
//
// See docs/cloudflare-access.md.

const crypto = require('crypto');

const KEY_MAX_AGE_MS = 60 * 60 * 1000;     // refetch Cloudflare's keys hourly
const UNKNOWN_KID_REFETCH_MS = 30 * 1000;  // key rotation: refetch at most this often
const CONFIG_CACHE_MS = 5 * 1000;
const CLOCK_SKEW_S = 60;

// Headers Cloudflare's edge adds to every request it proxies. A request with
// none of them reached the server some other way (LAN, VPN).
const CLOUDFLARE_HEADERS = ['cf-ray', 'cf-connecting-ip', 'cf-access-jwt-assertion'];

function cameThroughCloudflare(headers) {
    return CLOUDFLARE_HEADERS.some(h => headers[h] !== undefined);
}

// The app icon and manifest are fetched by browsers and phones without the
// Access cookie (the web app manifest, Safari's home-screen icon), so they
// can't sit behind the login. They're the same files as in the public repo.
const PUBLIC_ASSETS = new Set(['/favicon.ico', '/logo192.png', '/logo512.png', '/manifest.json']);

function isExemptPath(url, method = 'GET') {
    const path = (url || '').split('?')[0];
    if (path.startsWith('/api/webhooks/')) return true;
    return (method === 'GET' || method === 'HEAD') && PUBLIC_ASSETS.has(path);
}

function base64urlDecode(s) {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function normalizeTeamDomain(d) {
    return String(d || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * @param {object} opts
 * @param {() => Promise<object>} opts.getConfig  resolves to the app config
 * @param {(url: string) => Promise<object>} [opts.fetchJson]  for the key set
 * @param {() => number} [opts.now]  ms since epoch
 * @param {object} [opts.logger]
 */
function createAccessGuard({ getConfig, fetchJson, now = Date.now, logger = console }) {
    fetchJson = fetchJson || (async (url) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    });

    let configCache = null;
    let configCachedAt = 0;
    async function accessConfig() {
        if (!configCache || now() - configCachedAt > CONFIG_CACHE_MS) {
            const config = await getConfig();
            configCache = { value: config && config.cloudflareAccess };
            configCachedAt = now();
        }
        return configCache.value;
    }

    // Per team domain: { keys: Map<kid, KeyObject>, fetchedAt }
    const keySets = new Map();
    async function loadKeys(teamDomain) {
        const set = await fetchJson(`https://${teamDomain}/cdn-cgi/access/certs`);
        const keys = new Map();
        for (const jwk of (set && set.keys) || []) {
            if (!jwk.kid || jwk.kty !== 'RSA') continue;
            keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        }
        const entry = { keys, fetchedAt: now() };
        keySets.set(teamDomain, entry);
        return entry;
    }
    async function keyFor(teamDomain, kid) {
        let entry = keySets.get(teamDomain);
        if (!entry || now() - entry.fetchedAt > KEY_MAX_AGE_MS) {
            entry = await loadKeys(teamDomain);
        } else if (!entry.keys.has(kid) && now() - entry.fetchedAt > UNKNOWN_KID_REFETCH_MS) {
            entry = await loadKeys(teamDomain);
        }
        return entry.keys.get(kid);
    }

    async function verifyToken(token, cfg) {
        const parts = String(token).split('.');
        if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
        let header, payload;
        try {
            header = JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
            payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
        } catch {
            return { ok: false, reason: 'malformed token' };
        }
        if (header.alg !== 'RS256') return { ok: false, reason: `unexpected alg ${header.alg}` };

        const teamDomain = normalizeTeamDomain(cfg.teamDomain);
        let key;
        try {
            key = await keyFor(teamDomain, header.kid);
        } catch (err) {
            return { ok: false, reason: `could not fetch Cloudflare keys: ${err.message}` };
        }
        if (!key) return { ok: false, reason: 'unknown signing key' };

        const valid = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, base64urlDecode(parts[2]));
        if (!valid) return { ok: false, reason: 'bad signature' };

        const nowS = Math.floor(now() / 1000);
        if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < nowS) return { ok: false, reason: 'token expired' };
        if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > nowS) return { ok: false, reason: 'token not yet valid' };
        if (payload.iss !== `https://${teamDomain}`) return { ok: false, reason: 'wrong issuer' };

        const wanted = Array.isArray(cfg.aud) ? cfg.aud : [cfg.aud];
        const got = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!got.some(a => wanted.includes(a))) return { ok: false, reason: 'wrong audience' };

        if (Array.isArray(cfg.allowedEmails) && cfg.allowedEmails.length > 0) {
            const email = String(payload.email || '').toLowerCase();
            if (!cfg.allowedEmails.some(e => String(e).toLowerCase() === email)) {
                return { ok: false, reason: 'email not allowed' };
            }
        }
        return { ok: true };
    }

    /** Decides one request. Resolves to { ok, reason }. */
    async function check(req) {
        if (!cameThroughCloudflare(req.headers)) return { ok: true };
        if (isExemptPath(req.url, req.method)) return { ok: true };

        let cfg;
        try {
            cfg = await accessConfig();
        } catch (err) {
            return { ok: false, reason: `could not read config: ${err.message}` };
        }
        if (!cfg) return { ok: true }; // guard not configured: unchanged behaviour
        if (!cfg.teamDomain || !cfg.aud) return { ok: false, reason: 'cloudflareAccess config needs teamDomain and aud' };

        const token = req.headers['cf-access-jwt-assertion'];
        if (!token) return { ok: false, reason: 'no Cloudflare Access token' };
        return verifyToken(token, cfg);
    }

    function logDenied(req, reason) {
        const ip = req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress);
        logger.warn(`[Cloudflare Access] Refused ${req.method} ${(req.url || '').split('?')[0]} from ${ip}: ${reason}`);
    }

    function middleware(req, res, next) {
        check(req).then(result => {
            if (result.ok) return next();
            logDenied(req, result.reason);
            res.status(403).json({ error: 'Forbidden' });
        }, next);
    }

    // For WebSocket upgrades, which never pass through Express middleware.
    // Calls accept() when allowed; otherwise answers 403 and closes.
    function guardUpgrade(req, socket, accept) {
        check(req).then(result => {
            if (result.ok) return accept();
            logDenied(req, result.reason);
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        }, () => socket.destroy());
    }

    return { check, middleware, guardUpgrade };
}

module.exports = { createAccessGuard, cameThroughCloudflare, isExemptPath };
