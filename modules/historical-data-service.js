/*
rules:

populating the database with historical data for a specific symbol and timeframe:

There is no configurable target duration per timeframe — for every timeframe
enabled on a symbol, data is fetched as far back as the provider will allow
(see MAX_LOOKBACK_DURATION below). Yahoo's limits are fixed/known in advance
(YAHOO_MAX_LOOKBACK_DAYS); IBKR's are not published and are instead discovered
empirically the first time a fetch comes back empty for a safely-past chunk,
then persisted (historical_data_bounds table) so later fetches/cron runs don't
keep re-attempting a range that's already confirmed unfetchable.
4H is IBKR-only — Yahoo has no native 4-hour bar size (see performYahooFetch).
Once data is fetched for a period or contract, it can be assumed without gaps.
The data shall always be up to date -taking exchange opening times into account. 
Up to date means: for example for the 1h timeframe, if the last bar in the database is from 3 hours ago, it needs to fetch the last 3 bars. 
The database shall be filled as soon as possible from Yahoo, meaning fetching from Yahoo will be attempted first, because it is fast and almost always available.
Data from IBKR is higher quality but maybe not always available due to no connection to TWS.
So after all data is fetched (or tried to be fetched) from Yahoo, data will be fetched from IBKR.
IBKR or Yahoo data already in the database does not need to be refetched
When fetching futures contracts from IBKR, data will be fetched for the individual contracts, not for the continuous contract.
When fetching futures contracts from IBKR, data will be fetched including the current and the next contract so a proper continuous series can be built.
When fetching futures contracts from Yahoo, the data will be in continuous series format as per Yahoo specification.
It is not needed to keep Yahoo data in the database up to the point where IBKR data is available (as a result of the rules below)

Preparing futures data for a requester:

IBKR data for futures contracts will be used to build a continuous series of futures data, based on volume.
An IBKR futures continuous series will be kept in the database based on the individual contracts.
As soon as new futures data from IBKR is done fetching and placed in the database, the IBKR futures continuous series will be updated.
There is no need to "prepare" IBKR data for stocks.

providing the data to a requester:

Data already in the database will be provided immediately if requested. 
As soon as newly fetched data is in the database (and processing on the data to form continuous series is done) it will be provided.
IBKR data is of higher quality than yahoo data, so if both are available, ibkr data will be used.
IBKR data for futures contracts will taken from the "prepared" continuous series
It will be checked until which point IBKR data is available. If after that point yahoo data is available, the data provided will be extended with yahoo data.
Before this point, only IBKR data will be provided, after that point only Yahoo data will be provided. For the rest yahoo and IBKR data will not be mixed.
If no IBKR data is available, only Yahoo data will be provided.
The requester shall always know the origin of the data (IBKR or Yahoo), and the contract month for futures contracts.
It shall be possible for a requester to request data for a specific period.
*/


const { DateTime, Duration } = require('luxon');
const { Contract, EventName } = require('@stoqey/ib'); // Import Contract and EventName
const yahoo = require('./yahoo.js');
const { withRetries, timeout, normalizeDate, extractIBKRTimezoneSuffix, getTimeframeDuration, parseDuration, formatDurationForIBKR, generateContractChain, validateContract, delay, generateIbReqId } = require('./utils.js');
const db = require('./database.js');
const ibkr = require('./ibkr-conn.js');
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const { logger } = require('./logger.js');
const path = require('path');
const { Worker } = require('worker_threads');

// --- Constants ---
const VALID_TIMEFRAMES = ['1M', '5M', '15M', '1H', '4H', '1D', '1W'];
const IBKR_CONCURRENCY_LIMIT = 4; // OPTIMIZATION: Limit concurrent requests to IBKR

// There's no per-symbol configurable duration anymore — every enabled
// timeframe is fetched as far back as the provider will allow. This is just a
// nominal outer bound so the various DateTime math below has a concrete
// "start of time" to work from; it's never itself the reason a fetch stops —
// Yahoo's real limits (YAHOO_MAX_LOOKBACK_DAYS) and IBKR's discovered ones
// (historical_data_bounds) are what actually stop backfilling.
const MAX_LOOKBACK_DURATION = { years: 100 };

// Yahoo's own hard limits on how far back it will return intraday bars (a
// couple of days' safety margin under Yahoo's actual cutoff — 60 days for
// 5M/15M, ~2 years for 1H — baked in deliberately). No entry for 1D/1W: Yahoo
// provides effectively unlimited daily/weekly history. No entry for 1M/4H:
// 1M has its own much shorter window handled separately in
// fetchYahooHistoricalData, and 4H is IBKR-only (see performYahooFetch)
// so Yahoo never fetches it at all. This is the single source of truth for
// these limits — also used to answer "how far back can Yahoo actually go"
// for the Settings UI (see getProviderLimits below).
const YAHOO_MAX_LOOKBACK_DAYS = {
    '5M': 58,
    '15M': 58,
    '1H': 728,
};

// How long a discovered "IBKR has no data before this point" boundary is
// trusted before we allow one re-check. Not permanent — IBKR's available
// history could in principle change (e.g. a retention window shifting).
const IBKR_BOUND_RECHECK_DAYS = 30;
// A boundary is only trusted from a chunk request that's safely in the past —
// a chunk near "now" coming back empty is much more likely to just mean
// "market hasn't closed yet" / "today's data hasn't propagated" than "IBKR's
// history ends here", so those are left alone (existing behavior: keep
// trying older chunks, just without recording anything).
const IBKR_BOUND_MIN_AGE_DAYS = 3;

// Default per-symbol timeframe configuration for newly created futures_settings
// rows (a smaller, more deliberate default set — e.g. a long-held stock
// probably doesn't need 1-minute bars). Existing rows from before this feature
// existed instead default to every timeframe enabled, to preserve their prior
// behavior — see the migration in modules/database.js, which hardcodes an
// equivalent JSON literal and must be kept in sync with the keys below.
const DEFAULT_TIMEFRAME_SETTINGS = {
    '1M': { enabled: false },
    '5M': { enabled: true },
    '15M': { enabled: false },
    '1H': { enabled: true },
    '4H': { enabled: false },
    '1D': { enabled: true },
    '1W': { enabled: false },
};

// Resolves the effective {enabled, duration} for a symbol+timeframe from its
// stored timeframe_settings JSON (futures_settings.timeframe_settings),
// falling back to DEFAULT_TIMEFRAME_SETTINGS for anything missing/malformed.
// duration is always MAX_LOOKBACK_DURATION — how much history to keep is no
// longer user-configurable, only which timeframes to fetch at all is.
function resolveTimeframeConfig(timeframeSettings, timeframe) {
    const entry = timeframeSettings && timeframeSettings[timeframe];
    const fallback = DEFAULT_TIMEFRAME_SETTINGS[timeframe];
    const enabled = entry && typeof entry.enabled === 'boolean' ? entry.enabled : fallback.enabled;
    return { enabled, duration: MAX_LOOKBACK_DURATION };
}

// Which of VALID_TIMEFRAMES are enabled for a symbol, in chronological order —
// used everywhere a task gets queued (cron, populate-all, populate-symbol, and
// the auto-queue on chart requests) so disabled timeframes are never fetched.
function getEnabledTimeframes(timeframeSettings) {
    return VALID_TIMEFRAMES.filter(tf => resolveTimeframeConfig(timeframeSettings, tf).enabled);
}

// Yahoo's max lookback for a given timeframe, in days — null means
// effectively unlimited (1D/1W). Single source of truth for both the actual
// fetch-clamping logic and the "known limits" shown in the Settings UI (see
// GET /historical/limits in routes/historical.js).
function getYahooMaxLookbackDays(timeframe) {
    if (timeframe === '1M') return 7;
    return YAHOO_MAX_LOOKBACK_DAYS[timeframe] || null;
}

const barSizeMap = {
    '1M': '1 min',
    '5M': '5 mins',
    '15M': '15 mins',
    '1H': '1 hour',
    '4H': '4 hours',
    '1D': '1 day',
    '1W': '1 week',
};
const barIntervalUnitMap = {
    '1M': 'minute', '5M': 'minute', '15M': 'minute', '1H': 'hour', '4H': 'hour', '1D': 'day', '1W': 'week'
};
// OPTIMIZATION: Cache for exchange details to reduce DB queries
const exchangeInfoCache = new Map();

// In-memory (not persisted, cleared on restart) snapshot of what each active
// IBKR contract fetch is currently doing, purely to surface "what is it
// working on right now" to the Settings UI. A single populate task can be
// chunking through several contracts concurrently (see IBKR_CONCURRENCY_LIMIT
// above), so task-level status alone ("MNQ 1M ibkr_only") doesn't say which
// contract/date-range is actually in flight — that's especially opaque for
// 1-minute data, where one contract's backfill can take hours. Keyed by
// taskId+contractMonth since several contracts progress in parallel within
// one task.
const activeChunkProgress = new Map();

function setChunkProgress(taskId, symbol, timeframe, contractMonth, chunkStart, chunkEnd) {
    activeChunkProgress.set(`${taskId}:${contractMonth || 'continuous'}`, {
        taskId,
        symbol,
        timeframe,
        contractMonth: contractMonth || null,
        chunkStart: chunkStart.toISO(),
        chunkEnd: chunkEnd.toISO(),
        updatedAt: DateTime.now().toISO(),
    });
}

function clearChunkProgress(taskId, contractMonth) {
    activeChunkProgress.delete(`${taskId}:${contractMonth || 'continuous'}`);
}

// Clears every in-flight entry for a task — used when the task ends
// (success, failure, or cancellation) so a stalled/aborted fetch doesn't
// leave a stale "still working on this" entry behind forever.
function clearTaskChunkProgress(taskId) {
    for (const key of activeChunkProgress.keys()) {
        if (key.startsWith(`${taskId}:`)) activeChunkProgress.delete(key);
    }
}

function getActiveChunkProgress() {
    return Array.from(activeChunkProgress.values());
}

// Node is single-threaded — a long, CPU-heavy synchronous stretch (like
// iterating millions of bars while rebuilding a continuous series) blocks
// the entire event loop, so the API stops responding to anything at all
// (even a simple queue-status poll) until that stretch finishes. This
// doesn't reduce the total work or speed it up — it just periodically hands
// control back to the event loop so pending HTTP requests actually get a
// chance to run in between chunks of it, instead of queuing up behind the
// whole operation. setImmediate (not setTimeout) is the intended tool for
// this: it defers to after already-pending I/O callbacks with no timer delay.
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));
const YIELD_EVERY_N_ITEMS = 5000;


/**
 * OPTIMIZATION: Executes an array of promise-returning functions with a specified concurrency limit.
 * @param {Array<Function>} tasks - An array of functions that each return a promise.
 * @param {number} limit - The maximum number of promises to run in parallel.
 * @returns {Promise<Array<PromiseSettledResult>>} - A promise that resolves with an array of settled promise results.
 */
async function executePromisesWithConcurrency(tasks, limit) {
    const results = [];
    const activePromises = new Set();
    let taskIndex = 0;

    const executeNext = async () => {
        if (taskIndex >= tasks.length) {
            return;
        }

        const currentTaskIndex = taskIndex++;
        const task = tasks[currentTaskIndex];
        const promise = task();

        activePromises.add(promise);
        const result = await Promise.resolve(promise).catch(e => e);
        activePromises.delete(promise);

        results[currentTaskIndex] = result;

        if (taskIndex < tasks.length) {
            await executeNext();
        }
    };

    const initialWorkers = Array.from({ length: Math.min(limit, tasks.length) }, executeNext);
    await Promise.all(initialWorkers);

    // This converts the results into a format consistent with Promise.allSettled
    return results.map(result => {
        if (result instanceof Error) {
            return { status: 'rejected', reason: result };
        }
        return { status: 'fulfilled', value: result };
    });
}


async function populateHistoricalData(task, broadcastStatus, wss) { // Task object: { id, symbol, timeframe, phase, cancellationController, contractMonth, type }
    const { id: taskId, symbol, timeframe, phase: fetchPhase, cancellationController, contractMonth, type } = task;
    const { signal: cancellationSignal } = cancellationController; // Get the AbortSignal

    // Initial check if task was cancelled even before starting its main logic
    if (cancellationSignal.aborted) {
        logger.debug(`[populate][${taskId}] Task was already cancelled before execution for ${symbol} (${timeframe}, ${fetchPhase}).`);
        throw new Error(`Task ${taskId} cancelled.`); // Propagate to task processor
    }

    broadcastStatus(taskId, `Processing task for ${symbol} (${timeframe}, phase ${fetchPhase})`, 'info');
    logger.info(`[populate][${taskId}] Executing task for ${symbol} (${timeframe}, type=${type}, contractMonth=${contractMonth || 'N/A'}, phase=${fetchPhase})`);

    let client; // Define client here to be accessible in finally if connection fails early
    let earliestInvalidationTimestamp = null; // OPTIMIZATION: Track the earliest time data was changed

    try {
        // Cancellation Check Point
        if (cancellationSignal.aborted) throw new Error(`Task ${taskId} cancelled at setup stage.`);

        const { rows: futuresSettings } = await db.getPool().query(
            'SELECT id, symbol, exchange, type, rollover_months, timeframe_settings FROM futures_settings WHERE symbol = $1 AND type = $2',
            [symbol, type]
        );

        if (futuresSettings.length === 0) {
            logger.error(`[populate][${taskId}] No futures settings found for symbol ${symbol} with type ${type}`);
            throw new Error(`No futures settings for ${symbol} ${type}`);
        }
        const { id: futuresSettingId, exchange, type: settingType, rollover_months, timeframe_settings: timeframeSettings } = futuresSettings[0];

        if (!VALID_TIMEFRAMES.includes(timeframe)) {
            logger.error(`[populate][${taskId}] Invalid timeframe: ${timeframe}`);
            throw new Error(`Invalid timeframe ${timeframe}`);
        }

        // The user can disable specific timeframes per symbol (e.g. no intraday
        // bars for a stock held long-term) — respect that even if a task somehow
        // still got queued for it (queuers already filter, but this is the
        // authoritative check).
        const { enabled: timeframeEnabled, duration: requiredConfig } = resolveTimeframeConfig(timeframeSettings, timeframe);
        if (!timeframeEnabled) {
            logger.debug(`[populate][${taskId}] Timeframe ${timeframe} is disabled for ${symbol} (${type}). Skipping.`);
            return;
        }

        // Use getExchangeInfo to get the full exchange details including timezone
        const exchangeInfo = await getExchangeInfo(exchange, broadcastStatus); // 'exchangeName' from getExchangeInfo might be more canonical
        const { timezone: exchangeTimezone, name: exchangeName } = exchangeInfo;

        const nowInExchangeTimezone = DateTime.now().setZone(exchangeTimezone);
        const requiredStartDateForDuration = nowInExchangeTimezone.minus(requiredConfig);

        // Yahoo's own limits are fixed/known (unlike IBKR's, which are only
        // discovered from real fetch attempts) — so for deciding whether Yahoo
        // backfill is "done", target Yahoo's actual reachable limit rather than
        // the nominal MAX_LOOKBACK_DURATION target, which real data will never
        // reach. Without this, a timeframe Yahoo caps (5M/15M/1H) would look
        // permanently under-duration and get re-queued for a Yahoo fetch every
        // cron cycle forever, even once it already holds everything Yahoo has.
        const yahooMaxLookbackDaysForTf = getYahooMaxLookbackDays(timeframe);
        const yahooRequiredStartDate = yahooMaxLookbackDaysForTf != null
            ? DateTime.max(requiredStartDateForDuration, nowInExchangeTimezone.minus({ days: yahooMaxLookbackDaysForTf }))
            : requiredStartDateForDuration;

        // Cancellation Check Point
        if (cancellationSignal.aborted) throw new Error(`Task ${taskId} cancelled before market status check.`);

        const isMarketCurrentlyOpen = await isExchangeOpen(nowInExchangeTimezone.toJSDate(), exchangeName, exchangeTimezone);
        const lastMarketActivityTime = await getLastTradingDay(nowInExchangeTimezone.toJSDate(), exchangeName, exchangeTimezone);

        // FIX: Correctly assign completionCheckTime. `lastMarketActivityTime` is already a Luxon object.
        const completionCheckTime = isMarketCurrentlyOpen ? nowInExchangeTimezone : lastMarketActivityTime;
        logger.debug(`[populate][${taskId}] Market is ${isMarketCurrentlyOpen ? 'OPEN' : 'CLOSED'}. Completion check time set to: ${completionCheckTime.isValid ? completionCheckTime.toISO() : 'Invalid Time'}`);


        // Fetch existing data for THIS specific contract (or the continuous/null
        // placeholder) only — not other contract months. Yahoo has no per-contract
        // data of its own (see performYahooFetch below), and IBKR's own fetch-range
        // decision already re-queries scoped to the exact contract in
        // fetchAndStoreIBKRContractData, so mixing other contracts' bars in here
        // would only mislead the "is this contract's data recent/long enough?"
        // check below.
        //
        // Deliberately excludes source = 'TradingView': this query feeds the
        // recency/duration checks below, which decide whether Yahoo/IBKR need
        // to run at all. The whole system assumes a fetched period is
        // gap-free — true for Yahoo/IBKR's own bulk contiguous fetches, but
        // TradingView bars arrive one at a time from a live webhook and can
        // have a real hole in them (e.g. the webhook wasn't running yet, or a
        // network blip). If TradingView bars counted here, their
        // ever-advancing "latest" timestamp would make the data look
        // permanently up to date and silently mask that hole from ever being
        // backfilled by Yahoo/IBKR again. Keeping this scoped to Yahoo/IBKR's
        // own bars means their recency is judged only by their own last
        // successful fetch, so a real gap always eventually gets retried.
        const { rows: existingDataRows } = await db.getPool().query(
            `SELECT time, source, contract_month FROM historical_data
        WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = FALSE
             AND (contract_month = $3 OR ($3 IS NULL AND contract_month IS NULL))
             AND source != 'TradingView'
             ORDER BY time ASC`,
            [futuresSettingId, timeframe, contractMonth]
        );


        let attemptYahooFetch = fetchPhase === 'yahoo_only' || fetchPhase === 'full';
        let attemptIBKRFetch = fetchPhase === 'ibkr_only' || fetchPhase === 'full';
        let isRecencyFetchOnly = false;
        let needsDataPopulation = false;

        const earliestTimeInDb = existingDataRows.length > 0 ? DateTime.fromJSDate(existingDataRows[0].time, { zone: 'utc' }).setZone(exchangeTimezone) : null;
        const latestTimeInDb = existingDataRows.length > 0 ? DateTime.fromJSDate(existingDataRows[existingDataRows.length - 1].time, { zone: 'utc' }).setZone(exchangeTimezone) : null;
        const DURATION_MET_TOLERANCE_BARS = 3; // Allow up to 3 bars of tolerance at the start
        const barIntervalDuration = getTimeframeDuration(timeframe); // Your existing helper
        const toleranceDuration = Duration.fromMillis(barIntervalDuration.toMillis() * DURATION_MET_TOLERANCE_BARS);

        const isDurationMet = earliestTimeInDb
            ? earliestTimeInDb <= yahooRequiredStartDate.plus(toleranceDuration) // Check if earliestTimeInDb is within tolerance
            : false;

        let reasonToFetch = "Reason to fetch: ";
        // Determine if Yahoo fetch is needed based on overall data status and phase
        // Yahoo is primarily for initial fill and recency if IBKR is not available or slow.
        // Yahoo fetch is needed if there's no data, duration isn't met, recency is needed, or if it's the yahoo_only phase.
        let needsYahooFetch = false;
        let needsIBKRFetch = false;
        let yahooFetchConfig = { isRecencyOnly: false, scanUntil: requiredStartDateForDuration };
        let ibkrFetchConfig = { isRecencyOnly: false, scanUntil: requiredStartDateForDuration };
        const recencyThreshold = lastMarketActivityTime.startOf(barIntervalUnitMap[timeframe]); // Calculate recency threshold here
        const hasAnyData = existingDataRows.length > 0;

        // --- Decision Logic ---

        if (!hasAnyData) {
            reasonToFetch += "No data found in database. ";
            needsYahooFetch = true; // Initial fill with Yahoo
        } else {
            // Since we ignore the last bar from Yahoo, the DB is considered "recent" for Yahoo
            // if its last bar is the one right before the most recent completed bar.
            const yahooTargetRecency = recencyThreshold.minus(barIntervalDuration);

            // General recency check. We need to fetch if the data is not up-to-date.
            const overallRecencyNeeded = latestTimeInDb < recencyThreshold;
            if (overallRecencyNeeded) {
                // The data is outdated by general standards.
                // We check if it's also outdated by Yahoo's more lenient standard.
                if (latestTimeInDb < yahooTargetRecency) {
                    reasonToFetch += `Overall data is outdated (latest DB: ${latestTimeInDb.toISO()}, market requires up to: ${recencyThreshold.toISO()}). Triggering Yahoo fetch. `;
                    // Set Yahoo to perform a recency update.
                    needsYahooFetch = true;
                    yahooFetchConfig.isRecencyOnly = true;
                    yahooFetchConfig.scanUntil = latestTimeInDb.minus({ days: 1 }); // Use latest overall time for the starting point
                } else {
                    reasonToFetch += `Data is recent enough by Yahoo standards (latest DB: ${latestTimeInDb.toISO()}) but not IBKR. Letting IBKR check handle it. `;
                }
            }

            // A lack of duration always triggers a Yahoo backfill, overriding any recency logic.
            if (!isDurationMet) {
                reasonToFetch += `Data history is too short. `;
                needsYahooFetch = true;
                yahooFetchConfig.isRecencyOnly = false; // Override for full backfill
                yahooFetchConfig.scanUntil = yahooRequiredStartDate;
            }
        }


        // Ensure scanUntil dates don't go past the absolute required start
        if (yahooFetchConfig.scanUntil < requiredStartDateForDuration) yahooFetchConfig.scanUntil = requiredStartDateForDuration;
        if (ibkrFetchConfig.scanUntil < requiredStartDateForDuration) ibkrFetchConfig.scanUntil = requiredStartDateForDuration;



        // 4H is IBKR-only by design: Yahoo has no native 4-hour bar size, and
        // relabeling its 1H bars as 4H without real OHLC aggregation would
        // silently store wrong candles (each 1H bar would overwrite the
        // previous one at the same rounded 4H timestamp instead of merging
        // into it). Until proper 1H->4H aggregation is implemented, 4H charts
        // depend entirely on an IBKR/TWS connection.
        //
        // Yahoo is also skipped entirely for specific-contract tasks
        // (contractMonth !== null): Yahoo only ever returns one continuous
        // price series per symbol, never a specific contract's actual prices.
        // Storing it under a specific contract_month would mislabel generic
        // continuous data as if it were that contract's real history.
        const performYahooFetch = needsYahooFetch && (fetchPhase === 'yahoo_only' || fetchPhase === 'full') && timeframe !== '4H' && contractMonth === null;

        const performIBKRCheck = (fetchPhase === 'ibkr_only' || fetchPhase === 'full') && !(type === 'FUT' && timeframe === '1W');

        if (type === 'FUT' && timeframe === '1W' && (fetchPhase === 'ibkr_only' || fetchPhase === 'full')) {
            logger.debug(`[populate][${taskId}] Skipping IBKR check for 1W FUT as per configuration.`);
        }

        if (cancellationSignal.aborted) throw new Error(`Task ${taskId} cancelled before decision to fetch.`);

        if (!performYahooFetch && !performIBKRCheck) {
            // If client is null, it means we are in the main try-catch of populateHistoricalData.
            logger.debug(`[populate][${taskId}] No fetch operation needed for ${symbol} (${timeframe}, phase=${fetchPhase}). Reason: ${reasonToFetch.trim() || 'Data is complete and up-to-date.'}`);
            // If client is null, it means we are in the main try-catch of populateHistoricalData.
            // We should only release if we actually connected.
            // No need to commit/rollback if no operations were performed.
            return;
        }

        logger.info(`[populate][${taskId}] Proceeding. Reason: ${reasonToFetch.trim() || 'General fetch determined.'}`);
        if (performYahooFetch) logger.info(`[populate][${taskId}] Will attempt Yahoo fetch. Config: RecencyOnly=${yahooFetchConfig.isRecencyOnly}, ScanUntil=${yahooFetchConfig.scanUntil.toISO()}`);
        // Note: performIBKRCheck means we *might* fetch from IBKR, depending on the ranges calculated below.
        if (performIBKRCheck) logger.info(`[populate][${taskId}] Will check IBKR data status and potentially fetch.`);


        client = await db.getPool().connect(); // Get client for the task's DB writes.
        // Each source below (Yahoo, then IBKR) opens its own short transaction
        // scoped tightly around its writes, rather than one transaction held
        // open for the whole task — that previously spanned minutes of network
        // I/O (contract validation, chunked historical fetches with retries and
        // pacing delays), risking pool exhaustion and long-running-transaction
        // bloat for no benefit, since the two sources' writes are independent.

        // --- YAHOO FETCH BLOCK ---
        if (performYahooFetch) {
            if (cancellationSignal.aborted) throw new Error(`Task ${taskId} cancelled before Yahoo fetch.`);

            // Use yahooFetchConfig.scanUntil for the start date of Yahoo fetch
            let yahooEffectiveStartDate = yahooFetchConfig.scanUntil;
            // If it's a recency only fetch, and we have data, start from latestTimeInDb minus a bit
            if (yahooFetchConfig.isRecencyOnly && latestTimeInDb) {
                yahooEffectiveStartDate = latestTimeInDb.minus({ days: 1 }); // Fetch slightly overlapping for recency
                if (yahooEffectiveStartDate < requiredStartDateForDuration) yahooEffectiveStartDate = requiredStartDateForDuration; // Don't go newer than full req
            }

            if (YAHOO_MAX_LOOKBACK_DAYS[timeframe]) {
                const maxAllowedStartDate = nowInExchangeTimezone.minus({ days: YAHOO_MAX_LOOKBACK_DAYS[timeframe] });
                if (yahooEffectiveStartDate < maxAllowedStartDate) {
                    logger.warn(`[populate][${taskId}] Clamping Yahoo start date from ${yahooEffectiveStartDate.toISO()} to ${maxAllowedStartDate.toISO()} to respect Yahoo's ${YAHOO_MAX_LOOKBACK_DAYS[timeframe]}-day limit for ${timeframe} data.`);
                    yahooEffectiveStartDate = maxAllowedStartDate;
                }
            }


            logger.debug(`[populate][${taskId}] Yahoo effective fetch range: ${yahooEffectiveStartDate.toISO()} to ${nowInExchangeTimezone.toISO()}`);

            try {
                let yahooBars = await fetchYahooHistoricalData(symbol, timeframe, taskId, exchangeTimezone, yahooEffectiveStartDate, nowInExchangeTimezone, type, broadcastStatus, 2, completionCheckTime);
                if (cancellationSignal.aborted) throw new Error(`Task ${taskId} cancelled during Yahoo processing.`);

                if (yahooBars.length > 0) {
                    const firstYahooBarTime = DateTime.fromISO(yahooBars[0].time);
                    if (!earliestInvalidationTimestamp || firstYahooBarTime < earliestInvalidationTimestamp) {
                        earliestInvalidationTimestamp = firstYahooBarTime;
                    }

                    // FIX: De-duplicate bars from Yahoo before attempting to insert
                    const uniqueBarsMap = new Map();
                    for (const bar of yahooBars) {
                        uniqueBarsMap.set(bar.time, bar);
                    }
                    yahooBars = Array.from(uniqueBarsMap.values());


                    // FIX: Batch insert Yahoo data
                    const times = yahooBars.map(b => b.time);
                    const opens = yahooBars.map(b => b.open);
                    const highs = yahooBars.map(b => b.high);
                    const lows = yahooBars.map(b => b.low);
                    const closes = yahooBars.map(b => b.close);
                    const volumes = yahooBars.map(b => b.volume);

                    const query = `
                        INSERT INTO historical_data (futures_setting_id, contract_month, time, open, high, low, close, volume, timeframe, source, is_continuous)
                        SELECT $1, $2, unnest($3::timestamptz[]), unnest($4::numeric[]), unnest($5::numeric[]), unnest($6::numeric[]), unnest($7::numeric[]), unnest($8::integer[]), $9, 'Yahoo', FALSE
                        ON CONFLICT (futures_setting_id, (COALESCE(contract_month, '')), time, timeframe, is_continuous) DO NOTHING
                    `;
                    const params = [futuresSettingId, contractMonth, times, opens, highs, lows, closes, volumes, timeframe];

                    await client.query('BEGIN');
                    let result;
                    try {
                        result = await client.query(query, params);
                        await client.query('COMMIT');
                    } catch (writeErr) {
                        await client.query('ROLLBACK').catch(() => {});
                        throw writeErr;
                    }
                    logger.debug(`[populate][${taskId}] Yahoo Finance returned ${yahooBars.length} unique bars, ${result.rowCount} were inserted.`);

                    if (result.rowCount > 0) {
                        wss.clients.forEach(wsClient => {
                            if (wsClient.readyState === WebSocket.OPEN) {
                                wsClient.send(JSON.stringify({ type: 'historicalDataUpdate', symbol, timeframe, contractMonth, source: 'Yahoo', insertedCount: result.rowCount }));
                            }
                        });
                    }
                }
            } catch (err) {
                logger.warn(`[populate][${taskId}] Yahoo Finance fetch failed for ${symbol} (${timeframe}): ${err.message}.`);
                broadcastStatus(taskId, `Yahoo Finance fetch failed for ${symbol} (${timeframe}): ${err.message}`, 'warning');
                if (cancellationSignal.aborted) throw err;
                // Continue on to the IBKR block regardless of a Yahoo failure —
                // the two sources' writes are independent.
            }
        } // End of performYahooFetch block

        let ibkrDataWasModified = false;
        // --- IBKR FETCH BLOCK ---
        if (performIBKRCheck) {
            logger.debug(`[populate][${taskId}] IBKR FETCH BLOCK ENTERED for phase: ${fetchPhase}`);

            let ibkrSuccessfullyInitialized = false;

            // Attempt IBKR initialization FIRST
            try {
                logger.debug(`[populate][${taskId}] Attempting IBKR initialization for task.`);
                await ibkr.initializeIBKR(taskId, broadcastStatus);
                ibkrSuccessfullyInitialized = true;
                logger.debug(`[populate][${taskId}] initializeIBKR call completed. Assumed successful or existing connection is usable.`);
            } catch (initError) { // Catches error from initializeIBKR
                const errorMsg = `Error during IBKR operations for task ${taskId} (${fetchPhase}): ${initError.message}.`;
                logger.error(`[populate][${taskId}] ${errorMsg}`);
                broadcastStatus(taskId, errorMsg, 'error');
                logger.warn(`[populate][${taskId}] IBKR initialization failed. Skipping IBKR data fetches for this task.`);
                // ibkrSuccessfullyInitialized remains false, so the following blocks won't run IBKR fetches.
            }

            if (ibkrSuccessfullyInitialized) {
                let contractsToFetch = [];

                // --- Determine Contracts to Fetch from IBKR ---
                if (type === 'FUT' && contractMonth === null) {
                    // Continuous Futures: Fetch individual contracts covering the required period
                    logger.debug(`[populate][${taskId}] Futures (Continuous): Generating contract chain for ${symbol} from ${requiredStartDateForDuration.toISODate()}.`);
                    try {
                        // generateContractChain requires IBKR connection, so it must be called AFTER initializeIBKR
                        contractsToFetch = await generateContractChain(symbol, exchangeName, requiredStartDateForDuration, taskId, broadcastStatus, cancellationSignal, rollover_months);
                        if (contractsToFetch.length === 0) {
                            logger.warn(`[populate][${taskId}] No relevant individual futures contracts found for ${symbol} covering the required period.`);
                            broadcastStatus(taskId, `No relevant futures contracts found for ${symbol}.`, 'warning');
                            // If no contracts found, no IBKR fetch is possible for this continuous symbol.
                            // No need to set performIBKRCheck = false here, as we are already inside the ibkrSuccessfullyInitialized block.
                        } else {
                            logger.debug(`[populate][${taskId}] Found ${contractsToFetch.length} individual contracts for ${symbol}.`);
                        }
                    } catch (chainErr) {
                        logger.error(`[populate][${taskId}] Failed to generate contract chain for ${symbol}: ${chainErr.message}`);
                        broadcastStatus(taskId, `Failed to get futures contract chain for ${symbol}: ${chainErr.message}`, 'error');
                        // If chain generation fails, we cannot fetch IBKR data for this symbol/timeframe.
                        contractsToFetch = []; // Ensure the loop below doesn't run
                    }
                } else {
                    // Specific Futures Contract or Stock: Validate and fetch the single contract
                    logger.debug(`[populate][${taskId}] Specific Contract (${type}, ${contractMonth || 'N/A'}): Validating contract for ${symbol}.`);
                    try {
                        let secTypeResolved = type;
                        if (type === 'FUT' && contractMonth) {
                            secTypeResolved = 'FUT'; // Specific future
                        } else if (type === 'STK') {
                            secTypeResolved = 'STK'; // Stock
                        } else {
                            logger.error(`[populate][${taskId}] Invalid type/contractMonth combination for single contract fetch: type=${type}, contractMonth=${contractMonth}`);
                            throw new Error("Invalid contract details for single fetch.");
                        }
                        const initialContract = {
                            symbol: symbol.toUpperCase(),
                            secType: secTypeResolved,
                            currency: 'USD', // Assuming USD, might need to be dynamic
                            exchange: exchangeName.toUpperCase(),
                            ...(type === 'FUT' && contractMonth && { lastTradeDateOrContractMonth: contractMonth }),
                        };
                        // validateContract requires IBKR connection, so it must be called AFTER initializeIBKR
                        const validatedContract = await validateContract(initialContract, taskId, cancellationSignal, broadcastStatus);
                        if (validatedContract) contractsToFetch.push(validatedContract);
                    } catch (valErr) {
                        logger.error(`[populate][${taskId}] Failed to validate contract for ${symbol} (${type}, ${contractMonth || 'N/A'}): ${valErr.message}`);
                        broadcastStatus(taskId, `Failed to validate contract for ${symbol}: ${valErr.message}`, 'error');
                        contractsToFetch = []; // Ensure the loop below doesn't run
                    }
                }

                // --- OPTIMIZATION: PARALLEL FETCH LOGIC ---
                if (contractsToFetch.length > 0) {
                    logger.debug(`[populate][${taskId}] IBKR is connected. Starting parallel fetch for ${contractsToFetch.length} contracts with concurrency limit of ${IBKR_CONCURRENCY_LIMIT}.`);
                    let totalUpserted = 0;

                    // Deliberately NOT wrapped in a transaction: this fetch can span
                    // many contracts and, for 1-minute data, genuinely hours of
                    // chunked requests (7-day chunks with IBKR's own pacing delay
                    // between each). Each chunk's storeHistoricalData write commits
                    // on its own as it succeeds. Wrapping the whole multi-contract
                    // fetch in one transaction was tried before — it meant a single
                    // cancellation (e.g. the user opening a different symbol's chart
                    // partway through, which deliberately aborts whatever background
                    // task is currently running) rolled back and discarded EVERY
                    // chunk fetched in that run, not just the interrupted one,
                    // making real progress on a long 1-minute backfill nearly
                    // impossible whenever the app is also being used normally.
                    // Individual chunk writes are idempotent (ON CONFLICT upserts),
                    // so committing them independently is safe.

                    // Create an array of task functions to be executed in parallel
                    const fetchTasks = contractsToFetch.map(contractDetails => {
                        return async () => {
                            if (cancellationSignal.aborted) throw new Error(`Task ${taskId} cancelled before processing IBKR fetch for contract ${contractDetails.conId}.`);
                            logger.debug(`[populate][${taskId}] Processing IBKR fetch for contract ${contractDetails.lastTradeDateOrContractMonth || 'N/A'} (conId: ${contractDetails.conId})...`);
                            // Each task will return the result from fetchAndStoreIBKRContractData
                            return await fetchAndStoreIBKRContractData(
                                client,
                                futuresSettingId,
                                contractDetails,
                                timeframe,
                                exchangeTimezone,
                                cancellationSignal,
                                broadcastStatus,
                                taskId,
                                completionCheckTime,
                                requiredConfig
                            );
                        };
                    });

                    // Execute tasks with the concurrency manager
                    const settledResults = await executePromisesWithConcurrency(fetchTasks, IBKR_CONCURRENCY_LIMIT);

                    // Process the results after all fetches have settled
                    for (const result of settledResults) {
                        if (cancellationSignal.aborted) break; // Stop processing results if task was cancelled

                        if (result.status === 'fulfilled') {
                            const { upsertedCount, earliestTime } = result.value;
                            if (upsertedCount > 0) {
                                ibkrDataWasModified = true;
                                if (earliestTime && (!earliestInvalidationTimestamp || earliestTime < earliestInvalidationTimestamp)) {
                                    earliestInvalidationTimestamp = earliestTime;
                                }
                                totalUpserted += upsertedCount;
                            }
                        } else {
                            // The task function itself might throw an error, or fetchAndStoreIBKRContractData might.
                            const contractDesc = "a contract"; // Hard to know which one without more info in the error
                            const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);

                            // Avoid logging cancellation errors as warnings
                            if (!cancellationSignal.aborted) {
                                logger.warn(`[populate][${taskId}] IBKR fetch failed for ${contractDesc} in parallel batch: ${errorMessage}`);
                                broadcastStatus(taskId, `An IBKR fetch failed: ${errorMessage}`, 'warning');
                            }
                        }
                    }

                    if (cancellationSignal.aborted) throw new Error(`Task ${taskId} cancelled during parallel IBKR fetch processing.`);

                } else {
                    logger.debug(`[populate][${taskId}] No contracts were determined for IBKR fetch for ${symbol} (${timeframe}).`);
                }

                if (ibkr.isIbkrConnected()) {
                    logger.debug(`[populate][${taskId}] Attempting to disconnect IBKR after IBKR fetch block.`);
                    await ibkr.disconnectIBKR();
                }
            }
        } // End of performIBKRCheck block

        // --- Continuous Series Update ---
        // ibkrDataWasModified alone isn't a reliable trigger: a *previous*
        // run can have committed real raw data (its own chunks persist even
        // if that run was later cancelled — see the transaction-scope fix
        // above) without ever reaching this rebuild step, leaving the
        // continuous series permanently empty even though THIS run finds
        // nothing new to fetch (ibkrDataWasModified stays false forever
        // after that point, since there's no future gap to detect). Catch
        // that orphaned case with one cheap existence check: raw IBKR data
        // exists but no continuous series does.
        let continuousSeriesMissing = false;
        if (type === 'FUT' && !ibkrDataWasModified) {
            const { rows: existsRows } = await client.query(
                `SELECT
                    EXISTS(SELECT 1 FROM historical_data WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = FALSE AND source = 'IBKR') AS has_raw,
                    EXISTS(SELECT 1 FROM historical_data WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = TRUE) AS has_continuous`,
                [futuresSettingId, timeframe]
            );
            continuousSeriesMissing = existsRows[0].has_raw && !existsRows[0].has_continuous;
            if (continuousSeriesMissing) {
                logger.info(`[populate][${taskId}] Found raw IBKR data but no continuous series for ${symbol} (${timeframe}) — rebuilding despite no new data this run (likely orphaned by an earlier interrupted run).`);
            }
        }

        // Runs in its own worker thread now (runContinuousSeriesRebuild),
        // with its own connection and its own transaction — it deletes the
        // old continuous range and inserts the rebuilt one, and those two
        // still need to land together, just no longer on this task's own
        // client/transaction (a rebuild here can be tens of
        // seconds-to-minutes for a high-frequency symbol; doing that inline
        // used to block every other request the app was handling for the
        // same stretch).
        if (type === 'FUT' && (ibkrDataWasModified || continuousSeriesMissing)) {
            logger.debug(`[populate][${taskId}] IBKR data was modified. Rebuilding continuous series for ${symbol} (${timeframe}) from ${earliestInvalidationTimestamp ? earliestInvalidationTimestamp.toISO() : 'the beginning'}.`);
            await runContinuousSeriesRebuild(futuresSettingId, timeframe, rollover_months, exchangeInfo, earliestInvalidationTimestamp);
        }

        logger.debug(`[populate][${taskId}] (phase: ${fetchPhase}) completed and committed for ${symbol} (${timeframe}, contract: ${contractMonth || 'N/A'})`);
        broadcastStatus(taskId, `Population (phase: ${fetchPhase}) completed for ${symbol} (${timeframe})`, 'success');

        wss.clients.forEach(wsClient => {
            if (wsClient.readyState === WebSocket.OPEN) {
                wsClient.send(JSON.stringify({
                    type: 'historicalDataUpdate',
                    symbol,
                    timeframe,
                    contractMonth: null,
                    source: 'IBKR',
                    insertedCount: 'N/A'
                }));
            }
        });

        if (cancellationSignal.aborted) {
            throw new Error(`Task ${taskId} cancelled during commit phase.`);
        }

    } catch (err) {
        // No IBKR transaction to roll back here anymore — the continuous-
        // series rebuild that used to run (and hold a transaction open) on
        // this task's own client now runs in its own worker thread with its
        // own connection/transaction (runContinuousSeriesRebuild). The IBKR
        // raw-data write above already commits/rolls back on its own,
        // tightly scoped around just that write.
        logger.error(`[populate][${taskId}] Error for ${symbol} (${timeframe}, ${fetchPhase}): ${err.message}`);
        throw err; // Re-throw the error for the task processor
    } finally {
        // Always release the client connection
        if (client) client.release();
        // Safety net: per-contract cleanup already happens where each
        // contract's fetch loop returns, but cancellation/an uncaught error
        // could skip that — don't leave a stale "still working on this"
        // entry behind for a task that's actually done.
        clearTaskChunkProgress(taskId);
        logger.info(`[populate][${taskId}] Execution finished for ${symbol} (${timeframe}, phase=${fetchPhase}).`);
    }
}

/**
 * Fetches historical data from IBKR for a specific, already validated contract.
 * This function is now a helper called by fetchAndStoreIBKRContractData.
 * @param {object} validatedContract - The validated IBKR Contract object.
 * @param {string} duration - The IBKR duration string (e.g., '1 Y', '300 S').
 * @param {string} barSize - The IBKR bar size string (e.g., '1 day', '15 mins').
 * @param {string} timeframe - The timeframe string ('15M', '1H', etc.).
 * @param {string} taskId - The task ID for logging.
 * @param {string} exchangeTimezone - The timezone of the exchange.
 * @param {string} endDateTime - The end date/time for the fetch range (IBKR format).
 * @param {AbortSignal} cancellationSignal - Signal to abort the operation.
 * @param {function} broadcastStatus - Function to send status updates.
 * @returns {Promise<Array<object>>} - An array of bar objects.
 */
async function fetchHistoricalDataFromIBKR(validatedContract, duration, barSize, timeframe, taskId, exchangeTimezone, endDateTime = '', cancellationSignal = null, broadcastStatus) {
    let ibkrDuration = duration;
    if (parseDuration(duration).years > 1) {
        ibkrDuration = '1 Y';
    }
    try {
        if (cancellationSignal && cancellationSignal.aborted) {
            throw new Error(`Task ${taskId} (fetchHistoricalDataFromIBKR) cancelled before IBKR request.`);
        }

        // Ensure IBKR is connected before making the request
        if (!ibkr.isIbkrConnected()) {
            logger.error(`[Historical][${taskId}] IBKR is not connected. Cannot fetch historical data for conId ${validatedContract.conId}.`);
            // Attempt to re-initialize? Or rely on the calling function's initialization?
            // For now, let's throw, assuming initializeIBKR was supposed to be called before this.
            throw new Error("IBKR connection is not available for historical data fetch.");
        }

        logger.info(`[Historical][${taskId}] Requesting IBKR historical data for conId ${validatedContract.conId}: duration=${duration}, barSize=${barSize}, endDateTime=${endDateTime || "'' (Current Time)"}`);
        broadcastStatus(taskId, `Requesting historical data from TWS for ${validatedContract.symbol} (${timeframe})`, 'info');

        // OPTIMIZATION: Dynamic timeout based on requested duration
        const durationInSeconds = parseDuration(duration)?.days * 86400 || 3600; // Simplified calculation
        const adaptiveTimeout = Math.max(60000, durationInSeconds * 100); // Base 1 min, plus 100ms per day

        const bars = await Promise.race([
            new Promise((resolve, reject) => {
                const ibReqId = generateIbReqId(); // IBKR's internal request ID for this data fetch
                let resolvedOrRejected = false; // Flag to prevent multiple resolutions/rejections

                const cleanupAndAction = (action, value) => {
                    if (resolvedOrRejected) return;
                    resolvedOrRejected = true;

                    // Remove specific listeners for this reqId
                    if (ibkr.isIbkrConnected()) {
                        const ibApi = ibkr.getIbApi();
                        if (ibApi) { // Check if ibApi is not null before removing listeners
                            ibApi.off(EventName.historicalData, specificHistoricalDataHandler);
                            ibApi.off(EventName.historicalDataEnd, specificHistoricalDataEndHandler); // Use off for safety
                            ibApi.off(EventName.error, specificErrorHandlerForThisReq);
                        }
                    }
                    if (cancellationSignal) {
                        cancellationSignal.removeEventListener('abort', onAbort);
                    }
                    logger.debug(`[Historical][${taskId}] cleanupAndAction called for ibReqId ${ibReqId}. Action: ${action === resolve ? 'resolve' : 'reject'}. Value: ${value instanceof Error ? value.message : `Array(${value.length})`}`);
                    action(value);
                };

                const onAbort = () => {
                    if (resolvedOrRejected) return;
                    logger.debug(`[Historical][${taskId}] Abort signalled for IBKR historical data reqId ${ibReqId}. Attempting to cancel.`);
                    if (ibkr.isIbkrConnected()) {
                        const ibApi = ibkr.getIbApi();
                        if (ibApi) ibApi.cancelHistoricalData(ibReqId); // Attempt to cancel the active IBKR request
                    }
                    cleanupAndAction(reject, new Error(`IBKR request for task ${taskId} (ibReqId ${ibReqId}) cancelled.`));
                };

                if (cancellationSignal) {
                    if (cancellationSignal.aborted) { // Re-check before attaching listener or making request
                        return cleanupAndAction(reject, new Error(`Task ${taskId} already cancelled before IBKR reqHistoricalData for ibReqId ${ibReqId}.`));
                    }
                    cancellationSignal.addEventListener('abort', onAbort, { once: true });
                }

                const data = [];
                const specificHistoricalDataHandler = (id, dateStr, open, high, low, close, volume, count, WAP, hasGaps) => {
                    if (resolvedOrRejected) return; // Already handled
                    if (cancellationSignal && cancellationSignal.aborted) {
                        return cleanupAndAction(reject, new Error(`Task ${taskId} cancelled during IBKR historicalData event for ibReqId ${ibReqId}.`));
                    }

                    if (id === ibReqId) {
                        // MODIFIED: Check for 'finished-' signal string from IBKR and resolve if received
                        if (typeof dateStr === 'string' && dateStr.startsWith('finished-')) {
                            logger.debug(`[Historical][${taskId}] Received 'finished-' signal from IBKR for reqId ${ibReqId}: ${dateStr}. Finalizing data stream with ${data.length} bars.`);
                            // Resolve the promise here, similar to how server_old.js did.
                            // This handles cases where historicalDataEnd might not fire after a finished- signal if 0 bars were truly sent for the request.
                            cleanupAndAction(resolve, data); // Resolve with currently collected data
                            return;
                        }

                        // Proceed with normal bar processing (this part is fine)
                        const normalizedDateStr = normalizeDate(dateStr);
                        if (!normalizedDateStr) {
                            logger.warn(`[Historical][${taskId}] Skipping bar with unnormalizable original date from IBKR: '${dateStr}' (ibReqId ${ibReqId})`);
                            return;
                        }
                        // IBKR doesn't always report bar times in the contract's own
                        // exchange timezone — it depends on TWS's global time-zone
                        // display setting. Use whatever zone IBKR actually attached
                        // to this bar if present; only fall back to assuming
                        // exchangeTimezone when it didn't send one.
                        const reportedZone = extractIBKRTimezoneSuffix(dateStr);
                        const parseZone = reportedZone || exchangeTimezone;
                        let dt;
                        if (normalizedDateStr.includes(' ')) {
                            dt = DateTime.fromFormat(normalizedDateStr, 'yyyyMMdd HH:mm:ss', { zone: parseZone });
                        } else {
                            dt = DateTime.fromFormat(normalizedDateStr, 'yyyyMMdd', { zone: parseZone });
                        }
                        if (reportedZone && !dt.isValid) {
                            // Zone name IBKR sent wasn't recognized (e.g. an
                            // unusual alias) — better to fall back to the exchange
                            // timezone than to drop the bar entirely.
                            logger.warn(`[Historical][${taskId}] Unrecognized IBKR timezone '${reportedZone}' in '${dateStr}', falling back to exchange timezone ${exchangeTimezone}.`);
                            dt = normalizedDateStr.includes(' ')
                                ? DateTime.fromFormat(normalizedDateStr, 'yyyyMMdd HH:mm:ss', { zone: exchangeTimezone })
                                : DateTime.fromFormat(normalizedDateStr, 'yyyyMMdd', { zone: exchangeTimezone });
                        }
                        if (!dt.isValid) {
                            logger.warn(`[Historical][${taskId}] Invalid date after normalization for IBKR bar: Original='${dateStr}', Normalized='${normalizedDateStr}', LuxonReason='${dt.invalidReason || 'Unknown'}' (ibReqId ${ibReqId})`);
                            return;
                        }
                        data.push({
                            time: dt.toISO(),
                            open: parseFloat(open),
                            high: parseFloat(high),
                            low: parseFloat(low),
                            close: parseFloat(close),
                            volume: parseInt(volume, 10),
                        });
                    }
                };

                const specificHistoricalDataEndHandler = (id) => {
                    // This handler now acts as a confirmation or alternative path if 'finished-' wasn't caught.
                    // The resolvedOrRejected flag in cleanupAndAction will prevent double resolution.
                    if (id === ibReqId) {
                        logger.debug(`[Historical][${taskId}] --- historicalDataEnd event received for ibReqId ${ibReqId}. Bars collected: ${data.length} ---`);
                        cleanupAndAction(resolve, data);
                    } else {
                        logger.debug(`[Historical][${taskId}] historicalDataEnd event for different reqId ${id} (expected ${ibReqId})`);
                    }
                };
                const specificErrorHandlerForThisReq = (err, code, id) => {
                    logger.debug(`[Historical][${taskId}] specificErrorHandlerForThisReq: id=${id}, expected_ibReqId=${ibReqId}, code=${code}, err=${err.message}`);
                    if (id === ibReqId || id === -1 || id === 0) { // Handle general errors not tied to reqId too
                        // Handle code 162 as a valid "no data" response (resolve with empty array)
                        if (code === 162) {
                            logger.debug(`[Historical][${taskId}] Handling code 162 as empty data for ibReqId ${ibReqId}. Resolving with 0 bars.`);
                            cleanupAndAction(resolve, []); // Treat as successful empty response
                            return;
                        }
                        logger.error(`[Historical][${taskId}] IB API error (ibReqId ${ibReqId}, code ${code}): ${err.message}`);
                        cleanupAndAction(reject, new Error(`IB API error ${code}: ${err.message} (ibReqId ${ibReqId})`)); // Reject for other codes
                    }
                };
                // Use 'on' for historicalData as it can fire multiple times
                ibkr.getIbApi().on(EventName.historicalData, specificHistoricalDataHandler);
                // Use 'once' for historicalDataEnd as it fires only once per request
                ibkr.getIbApi().once(EventName.historicalDataEnd, specificHistoricalDataEndHandler);
                // Use 'on' for error as multiple errors might occur, but check reqId carefully
                ibkr.getIbApi().on(EventName.error, specificErrorHandlerForThisReq);

                // Use the validatedContract (which includes conId) for the request
                ibkr.getIbApi().reqHistoricalData(
                    ibReqId,
                    validatedContract, // IMPORTANT: Use the contract object passed in
                    endDateTime,
                    duration,
                    barSize,
                    'TRADES', // whatToShow
                    0,        // useRTH (0 for all data, 1 for RTH only)
                    1,        // formatDate (1 for yyyyMMdd HH:mm:ss, 2 for system time seconds)
                    false,    // keepUpToDate (false for historical, true for streaming updates)
                    []        // chartOptions (pass-through for API)
                );
            }),
            timeout(adaptiveTimeout, `Historical data request (task ${taskId}) timed out after ${adaptiveTimeout / 1000} seconds`)
        ]);

        logger.info(`[Historical][${taskId}] Returning ${bars.length} bars from IBKR for conId ${validatedContract?.conId}`);
        return bars;

    } catch (err) {
        logger.error(`[Historical][${taskId}] Error in fetchHistoricalDataFromIBKR for conId ${validatedContract?.conId}: ${err.message}`);
        // Check for error codes or messages that indicate a disconnect
        const errStr = err.message.toLowerCase();
        const disconnectIndicators = ["connection broken", "socket closed", "not connected", "connection reset", "connectivity between IBKR and TWS has been lost"];
        const errorCodesIndicatingDisconnect = [502, 504, 1100, 2104, 2106, 2158]; // IBKR error codes

        let isDisconnectError = disconnectIndicators.some(indicator => errStr.includes(indicator));
        if (err.code && errorCodesIndicatingDisconnect.includes(err.code)) {
            isDisconnectError = true;
        }
        // Re-throw for the task processor to handle (e.g., retry or mark as failed).
        // The calling function (populateHistoricalData) will catch this and handle the transaction rollback.
        throw err;
    }
}

/**
 * Stores historical data bars in the database using a single, efficient batch operation.
 * @param {object} client - The database client for the current transaction.
 * @param {number} futuresSettingId - The ID from the futures_settings table.
 * @param {string|null} contractMonth - The contract month (yyyyMM) or null for continuous/stocks.
 * @param {string} timeframe - The timeframe string.
 * @param {Array<object>} bars - The array of bar objects to store.
 * @param {string} taskId - The task ID for logging.
 * @returns {Promise<{upsertedCount: number, earliestTime: DateTime|null}>} - The number of bars upserted and the earliest timestamp.
 */
async function storeHistoricalData(client, futuresSettingId, contractMonth, timeframe, bars, taskId) {
    if (bars.length === 0) return { upsertedCount: 0, earliestTime: null };

    // FIX: De-duplicate bars by timestamp before inserting to prevent conflicts within a single batch.
    // This is crucial for preventing the "ON CONFLICT ... cannot affect row a second time" error.
    const uniqueBarsMap = new Map();
    for (const bar of bars) {
        uniqueBarsMap.set(bar.time, bar);
    }
    const uniqueBars = Array.from(uniqueBarsMap.values());

    // Sort bars by time after de-duplication to ensure earliestTime is correct.
    uniqueBars.sort((a, b) => a.time.localeCompare(b.time));

    const earliestTime = DateTime.fromISO(uniqueBars[0].time);

    // OPTIMIZATION: Prepare arrays for batch insert using unnest
    const times = uniqueBars.map(b => b.time);
    const opens = uniqueBars.map(b => b.open);
    const highs = uniqueBars.map(b => b.high);
    const lows = uniqueBars.map(b => b.low);
    const closes = uniqueBars.map(b => b.close);
    const volumes = uniqueBars.map(b => b.volume);

    const query = `
        INSERT INTO historical_data (futures_setting_id, contract_month, time, open, high, low, close, volume, timeframe, source, is_continuous)
        SELECT
            $1,                                     -- futures_setting_id
            $2,                                     -- contract_month
            unnest($3::timestamptz[]),               -- time
            unnest($4::numeric[]),                  -- open
            unnest($5::numeric[]),                  -- high
            unnest($6::numeric[]),                  -- low
            unnest($7::numeric[]),                  -- close
            unnest($8::integer[]),                  -- volume
            $9,                                     -- timeframe
            'IBKR',                                 -- source
            FALSE                                   -- is_continuous
ON CONFLICT (futures_setting_id, (COALESCE(contract_month, '')), time, timeframe, is_continuous)
             DO UPDATE SET
                open = EXCLUDED.open, 
                high = EXCLUDED.high, 
                low = EXCLUDED.low, 
                close = EXCLUDED.close, 
                volume = EXCLUDED.volume, 
            source = 'IBKR'
    `;

    const params = [futuresSettingId, contractMonth, times, opens, highs, lows, closes, volumes, timeframe];
    const result = await client.query(query, params);

    return { upsertedCount: result.rowCount, earliestTime: earliestTime };
}

/**
 * Returns the stored "IBKR has no data before this point" boundary for a
 * symbol/contract/timeframe, or null if none has been discovered yet, or if
 * it's due for re-verification (see IBKR_BOUND_RECHECK_DAYS) — treating a
 * stale boundary as "unknown" means we'll naturally re-probe it on the next
 * fetch attempt rather than trusting it forever.
 */
async function getIbkrDataBound(client, futuresSettingId, contractMonth, timeframe) {
    const { rows } = await client.query(
        `SELECT earliest_available, checked_at FROM historical_data_bounds
         WHERE futures_setting_id = $1 AND (contract_month = $2 OR ($2 IS NULL AND contract_month IS NULL)) AND timeframe = $3`,
        [futuresSettingId, contractMonth, timeframe]
    );
    if (rows.length === 0) return null;
    const checkedAt = DateTime.fromJSDate(rows[0].checked_at, { zone: 'utc' });
    if (DateTime.now().diff(checkedAt, 'days').days > IBKR_BOUND_RECHECK_DAYS) return null;
    return DateTime.fromJSDate(rows[0].earliest_available, { zone: 'utc' });
}

/**
 * Records (upserts) the discovered "IBKR has no data before this point"
 * boundary for a symbol/contract/timeframe.
 */
async function recordIbkrDataBound(client, futuresSettingId, contractMonth, timeframe, earliestAvailable) {
    await client.query(
        `INSERT INTO historical_data_bounds (futures_setting_id, contract_month, timeframe, earliest_available, checked_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (futures_setting_id, (COALESCE(contract_month, '')), timeframe) DO UPDATE SET
            earliest_available = EXCLUDED.earliest_available,
            checked_at = NOW()`,
        [futuresSettingId, contractMonth, timeframe, earliestAvailable.toUTC().toISO()]
    );
}

/**
 * Fetches historical data from IBKR for a specific, already validated contract and stores it in the database.
 * Includes logic to determine the fetch range needed based on existing IBKR data for *that specific contract*.
 * @param {object} client - The database client for the current transaction.
 * @param {number} futuresSettingId - The ID from the futures_settings table.
 * @param {object} validatedContract - The validated IBKR Contract object.
 * @param {string} timeframe - The timeframe string ('15M', '1H', etc.).
 * @param {string} exchangeTimezone - The timezone of the exchange.
 * @param {AbortSignal} cancellationSignal - Signal to abort the operation.
 * @param {function} broadcastStatus - Function to send status updates.
 * @returns {Promise<{upsertedCount: number, earliestTime: DateTime|null}>} - The number of bars successfully upserted and the earliest timestamp.
 */
async function fetchAndStoreIBKRContractData(client, futuresSettingId, validatedContract, timeframe, exchangeTimezone, cancellationSignal, broadcastStatus, taskId, completionCheckTime, requiredConfig) {
    const specificContractMonth = validatedContract.lastTradeDateOrContractMonth?.substring(0, 6) || null;
    const contractDesc = `${validatedContract.symbol} (${timeframe}, contract: ${specificContractMonth || 'N/A'}, conId: ${validatedContract.conId})`;

    logger.debug(`[populate][${taskId}] Determining fetch range for IBKR contract ${contractDesc}...`);

    const nowInExchangeTimezone = DateTime.now().setZone(exchangeTimezone);
    // Symbol-configured duration (falls back to the hardcoded default inside
    // resolveTimeframeConfig if the caller didn't have one — see call site).
    const globalRequiredStartDate = nowInExchangeTimezone.minus(requiredConfig || MAX_LOOKBACK_DURATION);

    // A contract is not relevant after its expiry month. Use end of month as a safe upper bound.
    const contractExpiryDate = specificContractMonth ? DateTime.fromFormat(specificContractMonth, 'yyyyMM', { zone: exchangeTimezone }).endOf('month') : nowInExchangeTimezone;

    const isExpired = contractExpiryDate.plus({ days: 2 }) < nowInExchangeTimezone; // Add 2 days buffer

    // The fetch window for a specific futures contract must respect the contract's lifetime.
    const contractLifeStartDate = specificContractMonth ? DateTime.fromFormat(specificContractMonth, 'yyyyMM', { zone: exchangeTimezone }).minus({ months: 15 }) : globalRequiredStartDate;
    let fetchLowerBound = DateTime.max(globalRequiredStartDate, contractLifeStartDate);
    const fetchUpperBound = DateTime.min(contractExpiryDate, nowInExchangeTimezone);

    // If we've already confirmed (recently — see IBKR_BOUND_RECHECK_DAYS) that
    // IBKR has no data before some point, don't bother asking again — this is
    // what stops cron from endlessly re-requesting a range that's already
    // known to be empty every single cycle.
    const knownBound = await getIbkrDataBound(client, futuresSettingId, specificContractMonth, timeframe);
    if (knownBound && knownBound > fetchLowerBound) {
        logger.debug(`[populate][${taskId}] Clamping fetch lower bound for ${contractDesc} to previously-confirmed IBKR limit ${knownBound.toISO()} (was ${fetchLowerBound.toISO()}).`);
        fetchLowerBound = knownBound;
    }

    if (fetchLowerBound >= fetchUpperBound) {
        logger.debug(`[populate][${taskId}] Skipping fetch for ${contractDesc}: its valid time window is empty or in the past.`);
        return { upsertedCount: 0, earliestTime: null };
    }

    // Query for existing IBKR data range for *this specific contract*
    const { rows: existingSpecificContractData } = await client.query(
        `SELECT time FROM historical_data
         WHERE futures_setting_id = $1 AND (contract_month = $2 OR ($2 IS NULL AND contract_month IS NULL)) AND timeframe = $3 AND source = 'IBKR' AND is_continuous = FALSE ORDER BY time ASC`,
        [futuresSettingId, specificContractMonth, timeframe]
    );

    const oldestSpecificIBKRLuxon = existingSpecificContractData.length > 0 ? DateTime.fromJSDate(existingSpecificContractData[0].time, { zone: 'utc' }).setZone(exchangeTimezone) : null;
    const latestSpecificIBKRLuxon = existingSpecificContractData.length > 0 ? DateTime.fromJSDate(existingSpecificContractData[existingSpecificContractData.length - 1].time, { zone: 'utc' }).setZone(exchangeTimezone) : null;

    let totalUpserted = 0;
    let earliestFetchTime = null;

    // --- Determine fetch ranges based on needs for THIS SPECIFIC CONTRACT within its valid window ---
    const rangesToFetch = [];
    if (!oldestSpecificIBKRLuxon) {
        // No data exists, fetch the whole valid window
        rangesToFetch.push({ start: fetchLowerBound, end: fetchUpperBound });
        logger.debug(`[populate][${taskId}] No existing IBKR data for ${contractDesc}. Planning full fetch from ${fetchLowerBound.toISO()} to ${fetchUpperBound.toISO()}.`);
    } else {
        // Data exists, check for gaps at the start and end.
        // Backfill gap
        if (oldestSpecificIBKRLuxon > fetchLowerBound) {
            rangesToFetch.push({ start: fetchLowerBound, end: oldestSpecificIBKRLuxon });
            logger.debug(`[populate][${taskId}] Backfill needed for ${contractDesc}. Planning fetch from ${fetchLowerBound.toISO()} to ${oldestSpecificIBKRLuxon.toISO()}.`);
        }

        // Recency gap
        if (!isExpired && latestSpecificIBKRLuxon < fetchUpperBound) {
            rangesToFetch.push({ start: latestSpecificIBKRLuxon, end: fetchUpperBound });
            logger.debug(`[populate][${taskId}] Recency update needed for ${contractDesc}. Planning fetch from ${latestSpecificIBKRLuxon.toISO()} to ${fetchUpperBound.toISO()}.`);
        }
    }

    if (rangesToFetch.length === 0) {
        logger.debug(`[populate][${taskId}] No data fetching needed for ${contractDesc}. Data is up to date within its valid window.`);
        return { upsertedCount: 0, earliestTime: null };
    }

    // --- DEFINE CHUNK LIMITS ---
    // IBKR cannot handle large requests for small bars. We chunk the request.
    const MAX_CHUNK_DURATION_MAP = {
        '1M': { amount: 1, unit: 'weeks' },   // 1 Week limit for 1M bars
        '5M': { amount: 1, unit: 'months' }, // 1 Month limit for 5M bars
        '15M': { amount: 1, unit: 'months' }, // 1 Month limit for 15M bars
        '1H': { amount: 6, unit: 'months' },  // 6 Months limit for 1H bars
        '4H': { amount: 1, unit: 'years' },   // 1 Year limit for 4H bars
        'default': { amount: 1, unit: 'years' }
    };
    const chunkLimit = MAX_CHUNK_DURATION_MAP[timeframe] || MAX_CHUNK_DURATION_MAP['default'];

    // Only trust an empty chunk as "IBKR's real limit" once we've already
    // seen at least one non-empty chunk for THIS contract in this walk.
    // Without this, the very first chunk attempted for an already-expired
    // contract — right around its own expiry, where trading has typically
    // thinned to nothing as everyone rolls to the next contract — comes back
    // empty for a completely unrelated reason (near-expiry illiquidity, not
    // "no history exists"), and would otherwise get permanently recorded as
    // the contract's boundary, silently discarding a full year of real,
    // perfectly fetchable history earlier in that contract's life.
    let hasFetchedAnyBarsForThisContract = false;

    for (const range of rangesToFetch) {
        try {
            // We loop BACKWARDS from range.end to range.start in chunks
            let currentChunkEnd = range.end;

            while (currentChunkEnd > range.start) {
                if (cancellationSignal && cancellationSignal.aborted) throw new Error(`Task ${taskId} cancelled during IBKR chunk loop.`);

                // Calculate the start of this chunk based on the limit
                let currentChunkStart = currentChunkEnd.minus({ [chunkLimit.unit]: chunkLimit.amount });
                
                // If the chunk start goes beyond the required start, clip it
                if (currentChunkStart < range.start) {
                    currentChunkStart = range.start;
                }

                const duration = currentChunkEnd.diff(currentChunkStart);

                // Safety check for tiny durations (e.g., milliseconds difference)
                if (duration.as('seconds') <= 1) {
                    break;
            }

            let ibkrDurationString;
                // Ensure we request exactly 1 D minimum if the diff is small, or format typically
            if (duration.as('days') < 1) {
                ibkrDurationString = '1 D';
            } else {
                ibkrDurationString = formatDurationForIBKR(duration);
            }

                // If formatDurationForIBKR returns "2 Y" or similar large values due to rounding, force it down to safe string if possible,
                // or rely on the loop logic above which ensures `duration` is small.
                // Note: The loop ensures `duration` is never larger than chunkLimit (e.g. 1 Month).

                logger.info(`[populate][${taskId}] Fetching CHUNK for ${contractDesc}. Range: ${currentChunkStart.toISO()} to ${currentChunkEnd.toISO()}. IBKR Request: ${ibkrDurationString}`);
                setChunkProgress(taskId, validatedContract.symbol, timeframe, specificContractMonth, currentChunkStart, currentChunkEnd);

            const bars = await withRetries(() => fetchHistoricalDataFromIBKR(
                validatedContract,
                ibkrDurationString,
                barSizeMap[timeframe],
                timeframe,
                taskId,
                exchangeTimezone,
                    currentChunkEnd.toUTC().toFormat('yyyyMMdd-HH:mm:ss'), // End date is crucial here
                cancellationSignal,
                broadcastStatus
            ), {
                    taskName: `IBKR fetch chunk for ${contractDesc}`,
                retries: 2,
                taskId: taskId
            });

                if (bars.length > 0) {
                    hasFetchedAnyBarsForThisContract = true;
                    // Filter incomplete bars if this is the most recent chunk
                    if (completionCheckTime && completionCheckTime.isValid && currentChunkEnd >= completionCheckTime) {
                const barDuration = getTimeframeDuration(timeframe);
                const threshold = completionCheckTime.minus(barDuration);
                while (bars.length > 0) {
                    const lastBar = bars[bars.length - 1];
                    const lastBarStart = DateTime.fromISO(lastBar.time, { zone: exchangeTimezone });
                    if (lastBarStart > threshold) {
                        bars.pop();
                    } else {
                        break;
                    }
                }
            }
                    
            if (bars.length > 0) {
                const { upsertedCount, earliestTime } = await storeHistoricalData(client, futuresSettingId, specificContractMonth, timeframe, bars, taskId);
                totalUpserted += upsertedCount;
                if (earliestTime && (!earliestFetchTime || earliestTime < earliestFetchTime)) {
                    earliestFetchTime = earliestTime;
                }
                    }
                } else if (hasFetchedAnyBarsForThisContract && currentChunkEnd < nowInExchangeTimezone.minus({ days: IBKR_BOUND_MIN_AGE_DAYS })) {
                    // IBKR returned zero bars (not "trimmed to zero" — that's the
                    // `bars.length > 0` branch above, which can legitimately empty
                    // out near `now`; this is the raw response having nothing at
                    // all) for a chunk safely in the past. Trust it: IBKR has no
                    // data before this point, so record the boundary and stop
                    // digging further back — older chunks would just be more of
                    // the same empty result, and this is exactly what lets cron
                    // stop re-requesting an already-known-empty range every cycle.
                    //
                    // Requiring hasFetchedAnyBarsForThisContract first matters for
                    // already-expired contracts: the very first chunk attempted is
                    // right around the contract's own expiry, where trading has
                    // typically thinned to nothing — an empty result there means
                    // "this contract's last few days were illiquid," not "this
                    // contract has no history at all." Only once we've proven IBKR
                    // does have data for this contract do we trust a later empty
                    // chunk as the genuine start-of-history boundary.
                    logger.info(`[populate][${taskId}] IBKR has no data before ${currentChunkEnd.toISO()} for ${contractDesc}. Recording as the confirmed limit.`);
                    await recordIbkrDataBound(client, futuresSettingId, specificContractMonth, timeframe, currentChunkEnd);
                    break;
                }

                // Move the end cursor back to the start of the chunk we just fetched
                currentChunkEnd = currentChunkStart;
                
                // Optional: Short delay to be nice to IBKR pacing violator
                await new Promise(resolve => setTimeout(resolve, 200)); 
            }

        } catch (err) {
            logger.warn(`[populate][${taskId}] Failed to fetch a range chunk for ${contractDesc}. Error: ${err.message}. Continuing to next range if available.`);
            // Depending on severity, you might want to break the loop or throw.
            // For timeouts, often better to try the next range/contract than fail the whole task.
        }
    }

    clearChunkProgress(taskId, specificContractMonth);
    return { upsertedCount: totalUpserted, earliestTime: earliestFetchTime };
}
async function _buildAndStoreContinuousSeries(client, futuresSettingId, timeframe, rolloverMonths, exchangeInfo, invalidationTimestamp = null) {
    const logPrefix = `[Historical/DB|${futuresSettingId}|${timeframe}]`;
    logger.debug(`${logPrefix} Rebuilding continuous series. Invalidation point: ${invalidationTimestamp ? invalidationTimestamp.toISO() : 'Full Rebuild'}`);

    // Fetch manual rollover overrides
    const { rows: overrideRows } = await client.query(
        `SELECT from_contract_month, to_contract_month, override_date
         FROM futures_rollover_overrides
         WHERE futures_setting_id = $1 ORDER BY override_date ASC`,
        [futuresSettingId]
    );

    // Create a map for manual overrides: key = `${from_contract}-${to_contract}`, value = override_date as DateTime
    const manualOverridesMap = new Map();
    for (const row of overrideRows) {
        const key = `${row.from_contract_month}-${row.to_contract_month}`;
        const overrideDate = DateTime.fromJSDate(row.override_date, { zone: 'utc' })
            .setZone(exchangeInfo.timezone)
            .startOf('day');
        manualOverridesMap.set(key, overrideDate);
    }

    let initialCurrentContract = null;

    // --- FIX: ALWAYS fetch ALL raw data to ensure the rollover algorithm has a complete picture. ---
    // The invalidationTimestamp will be used later to determine which part of the *output* series to replace.

    // Check if a series existed before the invalidation point to determine the starting contract.
    if (invalidationTimestamp) {
        const { rows: existingContinuousRows } = await client.query(
            `SELECT contract_month FROM historical_data
             WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = TRUE AND time < $3
             ORDER BY time DESC LIMIT 1`,
            [futuresSettingId, timeframe, invalidationTimestamp.toISO()]
        );
        if (existingContinuousRows.length > 0) {
            initialCurrentContract = existingContinuousRows[0].contract_month;
        }
    }

    logger.debug(`${logPrefix} Fetching all raw IBKR data for series construction. Initial contract hint: ${initialCurrentContract || 'None'}`);

    // This single query provides the complete dataset needed for accurate rollover detection.
    let { rows: rawHistoricalData } = await client.query(
        `SELECT time, open, high, low, close, volume, source, contract_month
         FROM historical_data
         WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = FALSE AND source = 'IBKR'
         ORDER BY time ASC;`,
        [futuresSettingId, timeframe]
    );

    if (rawHistoricalData.length === 0) {
        logger.debug(`${logPrefix} No raw IBKR data found to build continuous series. Aborting.`);
        // Ensure any potentially stale continuous data is cleared.
        const deleteQuery = invalidationTimestamp
            ? `DELETE FROM historical_data WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = TRUE AND time >= $3`
            : `DELETE FROM historical_data WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = TRUE`;
        const deleteParams = invalidationTimestamp
            ? [futuresSettingId, timeframe, invalidationTimestamp.toISO()]
            : [futuresSettingId, timeframe];
        await client.query(deleteQuery, deleteParams);
        return;
    }

    const { timezone: exchangeTimezone, opening_hours: openingHours } = exchangeInfo;

    // Daily per-contract volumes, aggregated in SQL rather than by summing
    // every raw bar in JS. This used to require grouping the entire raw
    // dataset by contract month first (barsByContractMonth) just to run this
    // one reduction — a full second copy of a 10M+-row dataset held
    // alongside barsByTimestamp below, which is what was pushing this past
    // the heap limit. Postgres can produce the same per-day sums directly
    // without ever materializing per-bar JS objects for this part at all.
    // `(time AT TIME ZONE $3)::date` converts each bar's timestamptz to the
    // exchange's local calendar date, matching what
    // DateTime.fromJSDate(bar.time, { zone: exchangeTimezone }).toISODate()
    // computed before, bar by bar.
    const { rows: dailyVolumeRows } = await client.query(
        `SELECT (time AT TIME ZONE $3)::date AS day, contract_month, SUM(COALESCE(volume, 0))::bigint AS volume
         FROM historical_data
         WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = FALSE AND source = 'IBKR' AND contract_month IS NOT NULL
         GROUP BY day, contract_month`,
        [futuresSettingId, timeframe, exchangeTimezone]
    );

    const dailyContractVolumes = new Map();
    for (const row of dailyVolumeRows) {
        const dateISO = row.day.toISOString().slice(0, 10);
        if (!dailyContractVolumes.has(dateISO)) dailyContractVolumes.set(dateISO, new Map());
        dailyContractVolumes.get(dateISO).set(row.contract_month, Number(row.volume));
    }

    const dailyWinnerContract = new Map();
    for (const [date, contractVolumes] of dailyContractVolumes.entries()) {
        let winnerContract = null;
        let maxVolume = -1;
        for (const [contractMonth, volume] of contractVolumes.entries()) {
            if (volume > maxVolume) {
                maxVolume = volume;
                winnerContract = contractMonth;
            }
        }
        if (winnerContract) {
            dailyWinnerContract.set(date, winnerContract);
        }
    }

    // Every contract that has any row in the raw data appears in at least
    // one (day, contract) group above, so this set is exactly the same
    // sortedContracts the old barsByContractMonth.keys() produced.
    const sortedContracts = Array.from(new Set(dailyVolumeRows.map(r => r.contract_month))).sort();

    // Group bars by (normalized) timestamp directly from the raw rows, in a
    // single pass — building barsByContractMonth first, only to immediately
    // regroup the exact same bars by timestamp, meant holding both
    // groupings (each the size of the whole dataset) alive at once for no
    // real reason once the daily-volume computation above no longer needs
    // the by-contract grouping either.
    const barsByTimestamp = new Map();
    for (let i = 0; i < rawHistoricalData.length; i++) {
        if (i > 0 && i % YIELD_EVERY_N_ITEMS === 0) await yieldToEventLoop();
        const row = rawHistoricalData[i];
        const barTime = row.time;
        let dt = DateTime.fromJSDate(barTime).setZone(exchangeTimezone);
        let normalizedTimeMillis;
        switch (timeframe) {
            case '1W': normalizedTimeMillis = dt.startOf('week').toMillis(); break;
            case '1D': normalizedTimeMillis = dt.startOf('day').toMillis(); break;
            case '4H': const hour4H = dt.hour - (dt.hour % 4); normalizedTimeMillis = dt.set({ hour: hour4H, minute: 0, second: 0, millisecond: 0 }).toMillis(); break;
            case '1H': normalizedTimeMillis = dt.startOf('hour').toMillis(); break;
            case '15M': const minute15M = dt.minute - (dt.minute % 15); normalizedTimeMillis = dt.set({ minute: minute15M, second: 0, millisecond: 0 }).toMillis(); break;
            case '5M': const minute5M = dt.minute - (dt.minute % 5); normalizedTimeMillis = dt.set({ minute: minute5M, second: 0, millisecond: 0 }).toMillis(); break;
            case '1M': normalizedTimeMillis = dt.set({ second: 0, millisecond: 0 }).toMillis(); break;
            default: normalizedTimeMillis = dt.toMillis(); break;
        }
        if (!barsByTimestamp.has(normalizedTimeMillis)) {
            barsByTimestamp.set(normalizedTimeMillis, []);
        }
        barsByTimestamp.get(normalizedTimeMillis).push({
            time: barTime,
            open: parseFloat(row.open),
            high: parseFloat(row.high),
            low: parseFloat(row.low),
            close: parseFloat(row.close),
            volume: parseInt(row.volume, 10),
            source: row.source,
            contractMonth: row.contract_month,
            timeMillis: dt.toMillis(),
        });
    }
    // Release the raw query result now that every bar has been copied into
    // barsByTimestamp — same reasoning as before, just now only ever one
    // grouped structure needs to coexist with it, not two.
    rawHistoricalData = null;

    const continuousSeries = [];
    const sortedTimestamps = Array.from(barsByTimestamp.keys()).sort();

    if (sortedContracts.length > 0) {
        let currentContract = initialCurrentContract;
        let firstRolloverCalculated = false;
        let lastRolloverDate = DateTime.fromMillis(0);

        if (invalidationTimestamp && initialCurrentContract) {
            const { rows: lastRolloverRows } = await client.query(
                `SELECT time FROM historical_data
                 WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = TRUE AND is_rollover = TRUE AND time < $3
                 ORDER BY time DESC LIMIT 1`,
                [futuresSettingId, timeframe, invalidationTimestamp.toISO()]
            );
            if (lastRolloverRows.length > 0) {
                lastRolloverDate = DateTime.fromJSDate(lastRolloverRows[0].time, { zone: 'utc' });
                logger.debug(`${logPrefix} Seeding last rollover date for partial rebuild: ${lastRolloverDate.toISO()}`);
            }
        }


        for (let tsIndex = 0; tsIndex < sortedTimestamps.length; tsIndex++) {
            if (tsIndex > 0 && tsIndex % YIELD_EVERY_N_ITEMS === 0) await yieldToEventLoop();
            const timestamp = sortedTimestamps[tsIndex];
            const allAvailableBars = barsByTimestamp.get(timestamp);
            const barDate = DateTime.fromMillis(timestamp, { zone: exchangeTimezone });

            if (invalidationTimestamp && barDate < invalidationTimestamp) {
                continue;
            }

            const validBars = allAvailableBars.filter(bar => {
                if (bar.contractMonth === null) return true;
                const contractDate = DateTime.fromFormat(bar.contractMonth, 'yyyyMM', { zone: exchangeTimezone });
                if (!contractDate.isValid) return false;
                const validStartDate = contractDate.minus({ months: 7 }).startOf('month');
                return barDate >= validStartDate;
            });
            if (validBars.length === 0) continue;
            const barDateISO = barDate.toISODate();
            const dailyWinner = dailyWinnerContract.get(barDateISO);
            let isRolloverToday = false;
            let rolloverType = null;

            const barDateInExchangeTz = barDate.setZone(exchangeTimezone);
            const dayOfWeekIndex = barDateInExchangeTz.weekday - 1;
            let openingTimeStr = null;
            if (timeframe !== '1D' && openingHours && Array.isArray(openingHours[dayOfWeekIndex])) {
                const daySlots = openingHours[dayOfWeekIndex];
                const prevDayOfWeekIndex = (dayOfWeekIndex === 0) ? 6 : dayOfWeekIndex - 1;
                const prevDaySlots = openingHours[prevDayOfWeekIndex];

                for (let i = 0; i < daySlots.length; i++) {
                    const currentSlotIsOpen = daySlots[i];
                    const previousSlotIsOpen = (i === 0) ? prevDaySlots[prevDaySlots.length - 1] : daySlots[i - 1];
                    if (currentSlotIsOpen === true && previousSlotIsOpen === false) {
                        const hour = Math.floor(i / 2);
                        const minute = (i % 2) * 30;
                        openingTimeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
                        break;
                    }
                }
            }
            const openingDateTime = openingTimeStr ? DateTime.fromISO(`${barDateInExchangeTz.toISODate()}T${openingTimeStr}`, { zone: exchangeTimezone }) : null;

            // --- FIX: This block reliably initializes the `currentContract` ---
            if (currentContract === null) {
                // If a partial rebuild provided a hint, use it. Otherwise, start with the first chronological contract.
                currentContract = initialCurrentContract || (sortedContracts.length > 0 ? sortedContracts[0] : null);

                if (!currentContract) {
                    logger.debug(`${logPrefix} Cannot determine a starting contract. Skipping timestamp.`);
                    continue; // If no contracts exist at all, skip.
                }
                logger.debug(`${logPrefix} Initializing continuous series with contract: ${currentContract}`);
            }
            // --- END FIX ---

            let shouldRollover = false;
            let nextContract = null;

            // A contract must already have a bar that clears the validBars sanity
            // window (see the `validBars` filter above) at THIS timestamp before we
            // commit to rolling into it. Without this, a single noisy day (e.g. a
            // far-dated contract's thin/near-zero volume briefly outnumbering the
            // real front month's) can flip `currentContract` to a contract whose
            // bars validBars won't accept for months — silently producing an
            // extended gap in the continuous series until that contract's window
            // opens, since nothing else ever re-evaluates the decision once made.
            const hasValidBarFor = (cm) => validBars.some(b => b.contractMonth === cm);

            const possibleOverrides = Array.from(manualOverridesMap.entries())
                .filter(([key, overrideDate]) =>
                    key.startsWith(currentContract + '-') &&
                    overrideDate.hasSame(barDate, 'day')
                );

            if (possibleOverrides.length > 0) {
                const [key, overrideDate] = possibleOverrides[0];
                const [, toContract] = key.split('-');
                if ((timeframe === '1D' || (openingDateTime && barDate >= openingDateTime) || !openingDateTime) && hasValidBarFor(toContract)) {
                    shouldRollover = true;
                    nextContract = toContract;
                    rolloverType = 'MANUAL';
                }
            } else {
                const currentContractIndex = sortedContracts.indexOf(currentContract);
                const isLastContractInDB = currentContractIndex === sortedContracts.length - 1;
                if (!isLastContractInDB) {
                    const potentialNextContract = sortedContracts[currentContractIndex + 1];
                    const transitionKey = `${currentContract}-${potentialNextContract}`;
                    const manualOverrideDate = manualOverridesMap.get(transitionKey);

                    if ((!manualOverrideDate || barDate >= manualOverrideDate) && hasValidBarFor(potentialNextContract)) {
                        if (timeframe === '1D') {
                            if (dailyWinner === potentialNextContract && currentContract !== potentialNextContract) {
                                shouldRollover = true;
                                nextContract = potentialNextContract;
                                rolloverType = 'VOLUME';
                            }
                        } else {
                            const contractExpiryDate = DateTime.fromFormat(currentContract, 'yyyyMM', { zone: exchangeTimezone });
                            const rolloverWindowStart = contractExpiryDate.minus({ months: 1 }).startOf('month');
                            if (barDate >= rolloverWindowStart && dailyWinner === potentialNextContract && currentContract !== potentialNextContract) {
                                if (openingDateTime && barDate >= openingDateTime) {
                                    shouldRollover = true;
                                    nextContract = potentialNextContract;
                                    rolloverType = 'VOLUME';
                                } else if (!openingDateTime) {
                                    shouldRollover = true;
                                    nextContract = potentialNextContract;
                                    rolloverType = 'VOLUME';
                                }
                            }
                        }
                    }
                }
            }

            if (!shouldRollover) {
                const currentContractIndex = sortedContracts.indexOf(currentContract);
                if (currentContractIndex >= 0 && currentContractIndex < sortedContracts.length - 1) {
                    const potentialNextContract = sortedContracts[currentContractIndex + 1];
                    const toContractDate = DateTime.fromFormat(potentialNextContract, 'yyyyMM', { zone: exchangeTimezone });

                    const isNextContractExpired = toContractDate.endOf('month') < DateTime.now();

                    if (isNextContractExpired) {
                        const fallbackDate = toContractDate.minus({ months: 1 }).endOf('month');

                        if (barDate >= fallbackDate && fallbackDate > lastRolloverDate && hasValidBarFor(potentialNextContract)) {
                            logger.debug(`${logPrefix} Applying FALLBACK rollover from ${currentContract} to ${potentialNextContract} on ${barDate.toISODate()}`);
                            shouldRollover = true;
                            nextContract = potentialNextContract;
                            rolloverType = 'FALLBACK';
                        }
                    }
                }
            }

            if (shouldRollover && nextContract && sortedContracts.includes(nextContract)) {
                currentContract = nextContract;
                isRolloverToday = true;
                lastRolloverDate = barDate;
            }


            const winnerBar = validBars.find(bar => bar.contractMonth === currentContract && bar.source === 'IBKR');

            if (winnerBar) {
                if (invalidationTimestamp && !firstRolloverCalculated && initialCurrentContract !== null) {
                    if (winnerBar.contractMonth !== initialCurrentContract) {
                        isRolloverToday = true;
                    }
                    firstRolloverCalculated = true;
                }
                // Mutate in place rather than spreading into a new object —
                // same reasoning as the barsByTimestamp fix above: winnerBar's
                // timestamp bucket is never revisited after this iteration, so
                // there's nothing relying on it staying unmutated, and for a
                // large (1-minute-scale) symbol this output array can approach
                // the size of the raw dataset itself.
                winnerBar.isRollover = isRolloverToday;
                winnerBar.rolloverType = rolloverType;
                continuousSeries.push(winnerBar);
            }
        }
    }

    // Same principle again: add the computed `time` field in place instead of
    // mapping into a whole new array of new objects — continuousSeries isn't
    // read again after this, so there's no reason to duplicate it just to
    // rename/compute one field.
    for (const currentBar of continuousSeries) {
        currentBar.time = DateTime.fromMillis(currentBar.timeMillis).setZone('utc').toISO();
    }
    const finalSeriesToStore = continuousSeries;

    if (invalidationTimestamp) {
        logger.debug(`${logPrefix} Deleting old continuous bars from ${invalidationTimestamp.toISO()}`);
        const deleteResult = await client.query(
            `DELETE FROM historical_data WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = TRUE AND time >= $3`,
            [futuresSettingId, timeframe, invalidationTimestamp.toISO()]
        );
        logger.debug(`${logPrefix} Truncated ${deleteResult.rowCount} old continuous bars.`);
    } else {
        const deleteResult = await client.query(
            `DELETE FROM historical_data WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = TRUE`,
            [futuresSettingId, timeframe]
        );
        logger.debug(`${logPrefix} Truncated ${deleteResult.rowCount} old continuous bars for full rebuild.`);
    }

    if (finalSeriesToStore.length === 0) {
        logger.debug(`${logPrefix} No new bars to store for the continuous series.`);
        return;
    }

    logger.debug(`${logPrefix} Storing ${finalSeriesToStore.length} bars for continuous series.`);
    // Bulk upsert via unnest() instead of one round-trip per bar — matches the
    // pattern already used for Yahoo/IBKR contract writes elsewhere in this file.
    await client.query(
        `INSERT INTO historical_data (futures_setting_id, contract_month, time, open, high, low, close, volume, timeframe, source, is_continuous, is_rollover, rollover_type)
         SELECT $1, unnest($2::varchar[]), unnest($3::timestamptz[]), unnest($4::numeric[]), unnest($5::numeric[]), unnest($6::numeric[]), unnest($7::numeric[]), unnest($8::integer[]), $9, unnest($10::varchar[]), TRUE, unnest($11::boolean[]), unnest($12::varchar[])
         ON CONFLICT (futures_setting_id, (COALESCE(contract_month, '')), time, timeframe, is_continuous)
         DO UPDATE SET
            open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
            volume = EXCLUDED.volume, source = EXCLUDED.source, is_rollover = EXCLUDED.is_rollover, rollover_type = EXCLUDED.rollover_type`,
        [
            futuresSettingId,
            finalSeriesToStore.map(b => b.contractMonth),
            finalSeriesToStore.map(b => b.time),
            finalSeriesToStore.map(b => b.open),
            finalSeriesToStore.map(b => b.high),
            finalSeriesToStore.map(b => b.low),
            finalSeriesToStore.map(b => b.close),
            finalSeriesToStore.map(b => b.volume),
            timeframe,
            finalSeriesToStore.map(b => b.source),
            finalSeriesToStore.map(b => !!b.isRollover),
            finalSeriesToStore.map(b => b.rolloverType || null),
        ]
    );
    logger.info(`${logPrefix} Successfully stored ${finalSeriesToStore.length} bars for the continuous series.`);
}

// Runs _buildAndStoreContinuousSeries in a worker thread (see
// continuous-series-worker.js) instead of inline on the main thread, so a
// long rebuild (minutes, for a high-frequency/high-history symbol) can't
// block every other request the app is handling. The worker gets its own
// DB connection and manages its own transaction — callers no longer wrap
// this in BEGIN/COMMIT themselves (see the two call sites below).
function runContinuousSeriesRebuild(futuresSettingId, timeframe, rolloverMonths, exchangeInfo, invalidationTimestamp = null) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'continuous-series-worker.js'), {
            workerData: {
                databaseUrl: db.getPool().options.connectionString,
                futuresSettingId,
                timeframe,
                rolloverMonths,
                exchangeInfo,
                invalidationTimestampISO: invalidationTimestamp ? invalidationTimestamp.toISO() : null,
            },
        });
        worker.on('message', (msg) => {
            if (msg.success) resolve();
            else reject(new Error(msg.error));
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`continuous-series-worker exited with code ${code}`));
        });
    });
}

async function fetchYahooHistoricalData(symbol, timeframe, requestId, timezone, startDate, endDate, type = 'STK', broadcastStatus, retries = 3, completionCheckTime) {
    let yahooSymbol = symbol;
    if (type === 'FUT' && !yahooSymbol.endsWith('=F')) {
        yahooSymbol = `${yahooSymbol}=F`;
        logger.debug(`[Yahoo] Appending =F for futures: ${yahooSymbol}`);
    }
    broadcastStatus(requestId, `Fetching historical data from Yahoo Finance for ${yahooSymbol} (${timeframe}, type=${type})`, 'info');
    logger.info(`[Yahoo] Fetching historical data for ${yahooSymbol} (${timeframe}, type=${type}) from ${startDate.toISO()} to ${endDate.toISO()}`);

    // No '4H' entry: this function is never called with timeframe='4H' (see
    // performYahooFetch above) since Yahoo has no native 4-hour bar size.
    const intervalMap = {
        '1M': '1m',
        '5M': '5m',
        '15M': '15m',
        '1H': '1h',
        '1D': '1d',
        '1W': '1wk'
    };

    const interval = intervalMap[timeframe];
    if (!interval) {
        throw new Error(`Invalid timeframe: ${timeframe}`);
    }

    let adjustedStartDate = startDate;
    // '1M' has its own much shorter window, not part of YAHOO_MAX_LOOKBACK_DAYS.
    let maxDays = timeframe === '1M' ? 7 : (YAHOO_MAX_LOOKBACK_DAYS[timeframe] || Infinity);

    if (maxDays !== Infinity) {
        const maxStart = endDate.minus({ days: maxDays });
        if (adjustedStartDate < maxStart) {
            logger.warn(`[Yahoo] Adjusting startDate for ${yahooSymbol} (${timeframe}) to ${maxStart.toISO()} (was ${adjustedStartDate.toISO()}) due to Yahoo limits.`);
            adjustedStartDate = maxStart;
        }
    }

    let yahooEndDate = endDate.startOf('day').plus({ days: 1 });
    if (yahooEndDate > DateTime.now().setZone(timezone)) {
        yahooEndDate = DateTime.now().setZone(timezone);
    }

    if (adjustedStartDate > yahooEndDate) {
        logger.warn(`[Yahoo] Adjusted start date ${adjustedStartDate.toISO()} is after calculated end date ${yahooEndDate.toISO()}. Skipping Yahoo fetch.`);
        return [];
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const queryOptions = {
                period1: adjustedStartDate.toJSDate(),
                period2: yahooEndDate.toJSDate(),
                interval,
                includePrePost: false
            };

            logger.info(`[Yahoo] Attempt ${attempt}: Fetching ${yahooSymbol} (${timeframe}) from ${adjustedStartDate.toISO()} to ${yahooEndDate.toISO()} with interval ${interval}`);

            const data = await yahoo.chart(yahooSymbol, queryOptions);

            if (!data || !data.quotes || data.quotes.length === 0) {
                // This might be a valid case if there's no data in the requested range
                logger.debug(`[Yahoo] No quotes returned from Yahoo Finance for ${yahooSymbol} (${timeframe}) in range.`);
                return [];
            }

            if (type === 'FUT' && data.meta && data.meta.symbol && !data.meta.symbol.endsWith('=F')) {
                logger.warn(`[Yahoo] Yahoo Finance returned data for non-futures symbol: ${data.meta.symbol}. Expected ${yahooSymbol}.`);
                // Depending on strictness, you might throw here or log and continue
                // For now, let's log and process the data if it exists, but be cautious.
            }

            const bars = data.quotes.map(bar => {
                // Yahoo dates are typically UTC timestamps, convert to Luxon UTC then set zone
                const dt = DateTime.fromJSDate(new Date(bar.date), { zone: 'utc' }).setZone(timezone);
                const volume = isNaN(bar.volume) ? 0 : parseInt(bar.volume, 10);
                return {
                    time: dt.toISO(),
                    open: parseFloat(bar.open),
                    high: parseFloat(bar.high),
                    low: parseFloat(bar.low),
                    close: parseFloat(bar.close),
                    volume
                };
            }).filter(bar => {
                // Beyond NaN checks, verify the OHLC values are physically sane.
                // Yahoo's "today, market still open" bar assembles its fields from a
                // live feed non-atomically, and can momentarily return a close below
                // its own reported low (or similar) — catch that rather than storing
                // an impossible candle permanently (Yahoo inserts are ON CONFLICT DO
                // NOTHING, so a bad bar here can never self-heal via a later fetch).
                const isValid =
                    !isNaN(bar.open) &&
                    !isNaN(bar.high) &&
                    !isNaN(bar.low) &&
                    !isNaN(bar.close) &&
                    Number.isInteger(bar.volume) &&
                    bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0 &&
                    bar.high >= bar.low &&
                    bar.high >= bar.open && bar.high >= bar.close &&
                    bar.low <= bar.open && bar.low <= bar.close;
                if (!isValid) {
                    logger.warn(`[Yahoo] Skipping invalid bar for ${yahooSymbol} (${timeframe}): ${JSON.stringify(bar)}`);
                }
                return isValid;
            }).filter(bar => {
                // For intraday timeframes, Yahoo occasionally hands back a synthetic
                // "current live quote" snapshot instead of a real closed candle when a
                // fetch's range reaches close to now — stamped at whatever wall-clock
                // second the response was assembled rather than the interval boundary,
                // with open===high===low===close and zero volume (it's just a price
                // reading, not an aggregated bar). Every real Yahoo intraday bar we've
                // observed lands exactly on the interval boundary (:00 seconds), so
                // that's a reliable, structural way to catch this — more robust than
                // the completion-time trim below, whose cutoff (one bar's duration) is
                // too tight to reliably catch it for 1-minute data. Left uncaught, this
                // becomes a permanent extra "flat" bar on the chart: its off-boundary
                // timestamp never collides with the real bar for that same minute in
                // the DB's uniqueness check, so both end up stored side by side.
                if (['1M', '5M', '15M', '1H'].includes(timeframe)) {
                    const dt = DateTime.fromISO(bar.time, { zone: timezone });
                    if (dt.second !== 0 || dt.millisecond !== 0) {
                        logger.debug(`[Yahoo] Skipping off-boundary snapshot bar for ${yahooSymbol} (${timeframe}) at ${bar.time} (likely a live quote, not a closed candle): ${JSON.stringify(bar)}`);
                        return false;
                    }
                }
                return true;
            });

            // Remove all incomplete bars from the end
            const barDuration = getTimeframeDuration(timeframe);
            if (completionCheckTime && completionCheckTime.isValid) {
                const threshold = completionCheckTime.minus(barDuration);
                while (bars.length > 0) {
                    const lastBar = bars[bars.length - 1];
                    const lastBarStart = DateTime.fromISO(lastBar.time, { zone: timezone });
                    if (lastBarStart > threshold) {
                        logger.debug(`[Source] Removing last Yahoo bar (${timeframe}) with start time ${lastBarStart.toISO()} as it is after threshold ${threshold.toISO()}`);
                        bars.pop();
                    } else {
                        break;
                    }
                }
            }


            logger.info(`[Yahoo] Retrieved ${bars.length} bars (after removing incomplete bars) for ${yahooSymbol} (${timeframe})`);
            broadcastStatus(requestId, `Retrieved ${bars.length} bars from Yahoo Finance for ${yahooSymbol} (${timeframe})`, 'success');
            return bars;
        } catch (err) {
            if (attempt === retries) {
                logger.error(`[Yahoo] Failed after ${retries} attempts for ${yahooSymbol} (${timeframe}): ${err.message}`);
                throw err;
            }
            logger.warn(`[Yahoo] Attempt ${attempt} failed for ${yahooSymbol} (${timeframe}): ${err.message}, retrying...`);
            await delay(2000 * attempt);
        }
    }
}

// Helper function to check if the exchange is open
async function isExchangeOpen(currentTime, exchangeName, exchangeTimezone) {
    try {
        const exchangeTime = DateTime.fromJSDate(currentTime).setZone(exchangeTimezone);
        const dayOfWeek = exchangeTime.weekday; // 1 = Monday, 7 = Sunday
        const hour = exchangeTime.hour;
        const minute = exchangeTime.minute;

        // Calculate the half-hour slot index for the day (0 to 47)
        const halfHourIndex = (hour * 2) + (minute >= 30 ? 1 : 0);

        // Fetch opening hours from the database
        const { rows } = await db.getPool().query(
            'SELECT opening_hours FROM exchanges WHERE name = $1',
            [exchangeName?.toUpperCase()]
        );

        if (rows.length === 0) {
            logger.warn(`[Historical] Exchange ${exchangeName} not found, assuming closed`);
            return false;
        }

        const openingHours = rows[0].opening_hours;
        if (!openingHours || !Array.isArray(openingHours[dayOfWeek - 1]) || openingHours[dayOfWeek - 1].length !== 48) {
            logger.error(`[Historical] Invalid opening_hours format for exchange ${exchangeName}`);
            return false;
        }

        const isOpen = openingHours[dayOfWeek - 1][halfHourIndex];
        // logger.info(`[Historical] Exchange ${exchangeName} at ${exchangeTime.toISO()} (day ${dayOfWeek}, slot ${halfHourIndex}): ${isOpen ? 'open' : 'closed'}`);
        return isOpen;
    } catch (err) {
        logger.error(`[Historical] Error checking exchange open status for ${exchangeName}: ${err.message}`);
        return false; // Default to closed on error
    }
}

// Helper function to get the last trading day
async function getLastTradingDay(currentTime, exchangeName, exchangeTimezone) {
    try {
        const exchangeTime = DateTime.fromJSDate(currentTime).setZone(exchangeTimezone);

        // Fetch opening hours from the database
        const { rows } = await db.getPool().query(
            'SELECT opening_hours FROM exchanges WHERE name = $1',
            [exchangeName?.toUpperCase()]
        );

        if (rows.length === 0) {
            logger.warn(`[Historical] Exchange ${exchangeName} not found, returning current time`);
            return exchangeTime;
        }

        const openingHours = rows[0].opening_hours;
        if (!openingHours || !Array.isArray(openingHours) || openingHours.length !== 7 || !openingHours.every(day => Array.isArray(day) && day.length === 48)) {
            logger.error(`[Historical] Invalid opening_hours format for exchange ${exchangeName}`);
            return exchangeTime;
        }

        const currentDay = exchangeTime.weekday - 1; // 0 = Monday, 6 = Sunday
        const currentHour = exchangeTime.hour;
        const currentMinute = exchangeTime.minute;
        const currentHalfHour = (currentHour * 2) + (currentMinute >= 30 ? 1 : 0);

        // Check if the current slot is open
        if (openingHours[currentDay][currentHalfHour]) {
            return exchangeTime.startOf('minute');
        }

        // Search backward for the last open slot, up to 7 days
        for (let i = 1; i <= 7 * 48; i++) {
            const checkTime = exchangeTime.minus({ minutes: i * 30 });
            const checkDay = checkTime.weekday - 1;
            const checkHour = checkTime.hour;
            const checkMinute = checkTime.minute;
            const checkHalfHour = (checkHour * 2) + (checkMinute >= 30 ? 1 : 0);

            if (openingHours[checkDay][checkHalfHour]) {
                // Found the last open slot
                return checkTime.startOf('minute');
            }
        }

        // If no open slot found in the last 7 days, return the time 7 days ago
        logger.warn(`[Historical] No open trading slot found in the last 7 days for ${exchangeName}. Returning time 7 days ago.`);
        return exchangeTime.minus({ days: 7 });

    } catch (err) {
        logger.error(`[Historical] Error finding last trading day for ${exchangeName}: ${err.message}`);
        return DateTime.fromJSDate(currentTime).setZone(exchangeTimezone); // Default to current time on error
    }
}

async function getExchangeInfo(exchange, broadcastStatus) {
    const upperCaseExchange = exchange?.toUpperCase();
    if (exchangeInfoCache.has(upperCaseExchange)) {
        return exchangeInfoCache.get(upperCaseExchange);
    }
    try {
        const { rows } = await db.getPool().query('SELECT name, timezone, opening_hours FROM exchanges WHERE name = $1', [upperCaseExchange]);
        if (rows.length > 0) {
            const result = { name: rows[0].name, timezone: rows[0].timezone, opening_hours: rows[0].opening_hours };
            exchangeInfoCache.set(upperCaseExchange, result);
            return result;
        }
        const requestId = uuidv4();
        logger.warn(`[populate] Exchange ${exchange} not found in database, using default timezone America/New_York and exchange COMEX`);
        broadcastStatus(requestId, `Exchange ${exchange} not found, defaulting to COMEX`, 'warning');
        return { name: 'COMEX', timezone: 'America/New_York', opening_hours: null };
    } catch (err) {
        logger.error(`[populate] Error fetching info for exchange ${exchange}: ${err.message}`);
        broadcastStatus(uuidv4(), `Error fetching exchange info: ${err.message}`, 'error');
        return { name: 'COMEX', timezone: 'America/New_York', opening_hours: null };
    }
}


/**
 * A new function to trigger a rebuild of all continuous series for a given symbol.
 * @param {string} symbol The symbol to rebuild (e.g., 'ES').
 * @param {string} type The type of the symbol ('FUT' or 'STK').
 */
async function rebuildContinuousSeriesForSymbol(symbol, type) {
    logger.debug(`[rebuildContinuousSeriesForSymbol] Received request to rebuild for ${symbol} (${type})`);
    if (type !== 'FUT') {
        logger.debug(`[rebuildContinuousSeriesForSymbol] Skipping rebuild for non-futures type: ${type}`);
        return;
    }

    // Only needed for the lookup below — each timeframe's actual rebuild now
    // runs in its own worker thread with its own connection (see
    // runContinuousSeriesRebuild), so there's no reason to hold a pooled
    // connection checked out for the whole multi-timeframe rebuild anymore
    // (previously minutes, for a high-volume symbol).
    const client = await db.getPool().connect();
    let futuresSettingId, rollover_months, exchangeInfo;
    try {
        const { rows: fsRows } = await client.query(
            'SELECT id, exchange, rollover_months FROM futures_settings WHERE symbol = $1 AND type = $2',
            [symbol, type]
        );
        if (fsRows.length === 0) {
            throw new Error(`No futures settings found for ${symbol} (${type})`);
        }
        ({ id: futuresSettingId, rollover_months } = fsRows[0]);
        exchangeInfo = await getExchangeInfo(fsRows[0].exchange);
    } finally {
        client.release();
    }

    try {
        // One worker (and one transaction) per timeframe, not one for the
        // whole symbol — for a high-volume symbol this can run for many
        // minutes per timeframe, so treating all 7 as one unit meant a
        // failure on, say, 15M would roll back the 1M and 5M work that had
        // already succeeded.
        for (const timeframe of VALID_TIMEFRAMES) {
            logger.info(`[rebuildContinuousSeriesForSymbol] Rebuilding ${timeframe} for ${symbol}...`);
            await runContinuousSeriesRebuild(futuresSettingId, timeframe, rollover_months, exchangeInfo, null);
        }
        logger.info(`[rebuildContinuousSeriesForSymbol] Successfully rebuilt all timeframes for ${symbol}.`);
    } catch (err) {
        logger.error(`[rebuildContinuousSeriesForSymbol] Error during rebuild for ${symbol}: ${err.message}`);
        throw err; // Re-throw to be handled by the caller
    }
}


/**
 * Returns the merged historical price series for a symbol/timeframe — IBKR
 * data (the continuous series for a null contractMonth, or a specific
 * contract's raw data otherwise) extended with later Yahoo data, per this
 * file's data-provenance rules (see the header comment). Shared by the
 * internal /historical/db route (routes/historical.js) and the external API
 * (routes/external.js) so this merge logic exists in exactly one place.
 *
 * @param {object} params
 * @param {number} params.futuresSettingId
 * @param {string} params.type - 'STK' | 'FUT'
 * @param {string|null} [params.contractMonth] - null/omitted for the continuous FUT series
 * @param {string} params.timeframe
 * @param {string} [params.startDate] - ISO date/time lower bound (inclusive)
 * @param {string} [params.endDate] - ISO date/time upper bound (inclusive)
 * @returns {Promise<Array>} bars sorted ascending by time
 */
async function getMergedHistoricalSeries({ futuresSettingId, type, contractMonth = null, timeframe, startDate, endDate }) {
    let processedBars = [];

    const addDateFilter = (query, params) => {
        let filteredQuery = query;
        if (startDate) {
            params.push(startDate);
            filteredQuery = filteredQuery.replace('ORDER BY time', `AND time >= $${params.length} ORDER BY time`);
        }
        if (endDate) {
            params.push(endDate);
            filteredQuery = filteredQuery.replace('ORDER BY time', `AND time <= $${params.length} ORDER BY time`);
        }
        return filteredQuery;
    };

    if (type === 'FUT' && !contractMonth) {
        const continuousParams = [futuresSettingId, timeframe];
        const continuousQuery = `
            SELECT time, open, high, low, close, volume, source, contract_month, is_rollover
            FROM historical_data
            WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = TRUE
            ORDER BY time ASC;
        `;
        const { rows: continuousDataRows } = await db.getPool().query(addDateFilter(continuousQuery, continuousParams), continuousParams);

        // Also picks up TradingView-sourced bars (see routes/tradingview-webhook.js)
        // — they share the exact same shape as Yahoo's own continuous-style
        // extension rows (contract_month NULL, is_continuous FALSE), and the
        // webhook's upsert already guarantees TradingView wins over Yahoo for
        // any timestamp both would otherwise report (only one row can exist
        // per futures_setting_id+time+timeframe regardless of source — see
        // the unique index), so no extra prioritization is needed here: this
        // query just returns whichever of the two actually won that slot.
        const yahooParams = [futuresSettingId, timeframe];
        const yahooQuery = `
            SELECT time, open, high, low, close, volume, source
            FROM historical_data
            WHERE futures_setting_id = $1 AND timeframe = $2 AND is_continuous = FALSE AND source IN ('Yahoo', 'TradingView')
            ORDER BY time ASC;
        `;
        const { rows: yahooDataRows } = await db.getPool().query(addDateFilter(yahooQuery, yahooParams), yahooParams);

        // Native Date.toISOString() instead of Luxon (fromJSDate+setZone+toISO)
        // — identical output format ("2024-...Z"), measurably cheaper per row
        // at this scale (a real case: ~885k rows for one symbol/timeframe).
        // Not the dominant cost here (that was a missing index — see
        // idx_historical_data_continuous_lookup in database.js), but free.
        const ibkrBars = continuousDataRows.map(row => ({
            time: new Date(row.time).toISOString(),
            open: parseFloat(row.open),
            high: parseFloat(row.high),
            low: parseFloat(row.low),
            close: parseFloat(row.close),
            volume: parseInt(row.volume, 10),
            source: row.source,
            contractMonth: row.contract_month,
            isRollover: row.is_rollover,
        }));
        const yahooBars = yahooDataRows.map(row => ({
            time: new Date(row.time).toISOString(),
            open: parseFloat(row.open),
            high: parseFloat(row.high),
            low: parseFloat(row.low),
            close: parseFloat(row.close),
            volume: parseInt(row.volume, 10),
            source: row.source,
        }));

        if (ibkrBars.length === 0) {
            processedBars = yahooBars;
        } else {
            // Yahoo's own bar count here is small (hundreds, not hundreds of
            // thousands), so per-bar Luxon parsing isn't the perf concern the
            // final sort below was — kept as plain string comparison anyway
            // for consistency, except the '1D'/'1W' case which genuinely
            // needs calendar-day truncation and can't be done as a string
            // compare.
            const lastIbkrTimeStr = ibkrBars[ibkrBars.length - 1].time;
            let yahooExtension;
            if (timeframe === '1D' || timeframe === '1W') {
                const lastIbkrDate = DateTime.fromISO(lastIbkrTimeStr).startOf('day');
                yahooExtension = yahooBars.filter(bar => DateTime.fromISO(bar.time).startOf('day') > lastIbkrDate);
            } else {
                yahooExtension = yahooBars.filter(bar => bar.time > lastIbkrTimeStr);
            }
            processedBars = [...ibkrBars, ...yahooExtension];
        }
    } else {
        const dbParams = [futuresSettingId, contractMonth || null, timeframe];
        const dbQuery = `
            SELECT time, open, high, low, close, volume, source
            FROM historical_data
            WHERE futures_setting_id = $1
            AND (contract_month = $2 OR ($2 IS NULL AND contract_month IS NULL))
            AND timeframe = $3
            AND is_continuous = FALSE
            ORDER BY time ASC;
        `;
        const { rows: rawHistoricalData } = await db.getPool().query(addDateFilter(dbQuery, dbParams), dbParams);

        const ibkrBars = [];
        const yahooBars = [];
        rawHistoricalData.forEach(row => {
            const bar = {
                time: new Date(row.time).toISOString(),
                open: parseFloat(row.open),
                high: parseFloat(row.high),
                low: parseFloat(row.low),
                close: parseFloat(row.close),
                volume: parseInt(row.volume, 10),
                source: row.source,
            };
            if (row.source.toUpperCase() === 'IBKR') {
                ibkrBars.push(bar);
            } else if (row.source.toUpperCase() === 'YAHOO') {
                yahooBars.push(bar);
            }
        });

        if (ibkrBars.length === 0) {
            processedBars = yahooBars;
        } else {
            const lastIbkrTimeStr = ibkrBars[ibkrBars.length - 1].time;
            const yahooExtension = yahooBars.filter(bar => bar.time > lastIbkrTimeStr);
            processedBars = [...ibkrBars, ...yahooExtension];
        }
    }

    // Same fix as the frontend's equivalent sort (TradeView.jsx): `.time` is
    // always a fixed-width ISO 8601 UTC string, which sorts correctly as a
    // plain string — no need to parse each one into a Luxon DateTime just to
    // compare. This exact comparator (Luxon parse on both sides, called on
    // every comparison) was confirmed via timing logs to be the actual
    // ~12-second cost behind a slow chart load for a heavily-backfilled
    // symbol (~885k bars) — the SQL query itself only takes ~150ms.
    processedBars.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    return processedBars;
}

module.exports = {
    populateHistoricalData,
    VALID_TIMEFRAMES,
    getExchangeInfo,
    rebuildContinuousSeriesForSymbol,
    DEFAULT_TIMEFRAME_SETTINGS,
    getEnabledTimeframes,
    getMergedHistoricalSeries,
    getYahooMaxLookbackDays,
    getIbkrDataBound,
    getActiveChunkProgress,
    // Exported only so modules/continuous-series-worker.js can call it with
    // its own connection — not meant to be used directly anywhere else. It
    // has no dependency on this module's other state (db/ibkr/yahoo/caches),
    // only on the client/params passed to it, which is what makes running it
    // in a separate worker thread (with its own DB connection) safe.
    _buildAndStoreContinuousSeries,
};