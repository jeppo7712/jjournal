const { logger } = require('./logger.js');

// Forwards TradingView traffic to an external listener (an agent that would
// otherwise have to poll the journal), as {"event": <name>, "data": <body>}.
// The journal never reads `data`: it passes the body along minus the webhook
// secret, so a new kind of TradingView message needs no change here.
//
// Configured by two config.json keys, read on every call (no restart needed):
//   kateEventsUrl    e.g. http://<host>:<port>/api/journal-event
//   kateEventsToken  sent as "Authorization: Bearer <token>"
// Either one unset: nothing is sent. Leave them unset on a dev copy that
// shares the same TradingView feed, or the listener gets every bar twice.
//
// Fire and forget: one attempt, 3 s timeout, no retries. send() never throws
// and never rejects, so callers don't await it and a dead listener can't
// slow down or fail a bar insert or the reply to TradingView.

const TIMEOUT_MS = 3000;
const MAX_BODY_BYTES = 16 * 1024;
const LOG_INTERVAL_MS = 60 * 1000;

let lastLogAt = 0;
let suppressed = 0;

// At most one warning a minute: with a dead listener this runs every bar.
function warnThrottled(message) {
    const now = Date.now();
    if (now - lastLogAt < LOG_INTERVAL_MS) {
        suppressed++;
        return;
    }
    const extra = suppressed > 0 ? ` (${suppressed} similar since the last message)` : '';
    lastLogAt = now;
    suppressed = 0;
    logger.warn(`[Kate events] ${message}${extra}`);
}

function withoutSecret(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body ?? {};
    const { secret, ...rest } = body;
    return rest;
}

async function post(url, token, event, data) {
    const body = JSON.stringify({ event, data });
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        warnThrottled(`Not sent: "${event}" event is ${Buffer.byteLength(body)} bytes, limit ${MAX_BODY_BYTES}.`);
        return;
    }
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // Drain the body so the connection is released.
        await res.text().catch(() => {});
        if (res.status !== 202) warnThrottled(`"${event}" event answered HTTP ${res.status}.`);
    } catch (err) {
        warnThrottled(`"${event}" event not delivered: ${err.cause?.code || err.name || err.message}.`);
    }
}

// config: an already-loaded config object. Returns a promise that always
// resolves (only tests await it).
function send(config, event, data) {
    const url = config?.kateEventsUrl;
    const token = config?.kateEventsToken;
    if (!url || !token) return Promise.resolve();
    return post(url, token, event, data).catch(() => {});
}

module.exports = { send, withoutSecret, _resetForTests: () => { lastLogAt = 0; suppressed = 0; } };
