// Runs _buildAndStoreContinuousSeries (modules/historical-data-service.js)
// in its own worker thread instead of on the main thread.
//
// That function has to walk a symbol's entire raw history to run rollover
// detection — for a high-frequency timeframe on a symbol with a lot of
// history (e.g. CL 1M, 10M+ rows), that's genuinely tens of seconds to
// minutes of synchronous JS work. Running it inline on the main thread (as
// it used to) meant every other request — every API call, every WebSocket
// message, the whole app for every user — queued up behind it, since
// Node's main thread has exactly one event loop. A worker thread has its
// own separate event loop and its own separate heap; the main thread stays
// fully responsive the entire time this runs, no matter how long it takes.
//
// This file is intentionally a thin harness, not a reimplementation:
// _buildAndStoreContinuousSeries itself still lives in and is exported from
// historical-data-service.js, so there's exactly one copy of that
// (intricate, correctness-critical) rollover logic to keep correct — this
// file just gives it its own DB connection and transaction to run against,
// mirroring what the main-thread callers used to set up around it directly.
const { parentPort, workerData } = require('worker_threads');
const { Pool } = require('pg');
const { DateTime } = require('luxon');
const { _buildAndStoreContinuousSeries } = require('./historical-data-service.js');
const { logger } = require('./logger.js');

(async () => {
    const { databaseUrl, futuresSettingId, timeframe, rolloverMonths, exchangeInfo, invalidationTimestampISO } = workerData;
    // max: 1 — this worker only ever runs one query at a time itself; no
    // need for a full pool the way the main thread's shared one is.
    const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, max: 1 });
    let client;
    try {
        client = await pool.connect();
        const invalidationTimestamp = invalidationTimestampISO
            ? DateTime.fromISO(invalidationTimestampISO, { zone: 'utc' })
            : null;

        await client.query('BEGIN');
        try {
            await _buildAndStoreContinuousSeries(client, futuresSettingId, timeframe, rolloverMonths, exchangeInfo, invalidationTimestamp);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        }
        parentPort.postMessage({ success: true });
    } catch (err) {
        logger.error(`[continuous-series-worker] Failed for futuresSettingId=${futuresSettingId} (${timeframe}): ${err.message}`, { stack: err.stack });
        parentPort.postMessage({ success: false, error: err.message });
    } finally {
        if (client) client.release();
        await pool.end();
    }
})();
