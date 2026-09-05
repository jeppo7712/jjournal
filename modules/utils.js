const { DateTime, Duration } = require('luxon');
const { EventName } = require('@stoqey/ib'); // Need EventName for validateContract
const ibkr = require('./ibkr-conn.js'); // Need ibkr for validateContract
const { logger } = require('./logger.js');


/**
 * A simple promise-based delay.
 * @param {number} ms - The number of milliseconds to delay.
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generates a monotonically increasing request ID for IBKR API calls
 * (contract validation, historical data, executions, etc).
 * Using Math.random() here previously meant concurrent requests could
 * collide on the same ID, causing one contract's response data to be
 * routed into another contract's event handler.
 * @returns {number}
 */
let nextIbReqId = 1;
function generateIbReqId() {
    // Wrap well before IBKR's int32 range to stay safe indefinitely.
    if (nextIbReqId >= 2_000_000_000) nextIbReqId = 1;
    return nextIbReqId++;
}

/**
 * Creates a promise that rejects after a specified timeout.
 * @param {number} ms - The timeout duration in milliseconds.
 * @param {string} message - The error message for the rejection.
 * @returns {Promise<never>}
 */
const timeout = (ms, message) => new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
});

/**
 * OPTIMIZATION: A utility to wrap an async function with retry logic and exponential backoff.
 * @param {Function} fn The async function to execute.
 * @param {object} options Options for retries.
 * @param {number} [options.retries=3] Number of retries.
 * @param {number} [options.delay=1000] Initial delay in ms.
 * @param {string} [options.taskName='Unnamed task'] Name of the task for logging.
 * @param {string} [options.taskId=''] The task ID for logging.
 * @returns {Promise<any>}
 */
async function withRetries(fn, options = {}) {
    const { retries = 3, delay: initialDelay = 1000, taskName = 'Unnamed task', taskId = '' } = options;
    let attempt = 1;
    while (attempt <= retries) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === retries) {
                logger.error(`[utils][withRetries][${taskId}] ${taskName} failed after ${retries} attempts. Error: ${err.message}`);
                throw err;
            }
            const backoffDelay = initialDelay * Math.pow(2, attempt - 1);
            logger.warn(`[utils][withRetries][${taskId}] ${taskName} failed on attempt ${attempt}. Retrying in ${backoffDelay}ms. Error: ${err.message}`);
            await delay(backoffDelay);
            attempt++;
        }
    }
}


/**
 * Takes various date string formats and attempts to standardize them.
 * @param {string} dateStr - The input date string.
 * @returns {string|null} The normalized date string or null if not recognized.
 */
// IBKR's TWS API doesn't always report historical bar times in the traded
// contract's own exchange timezone — it depends on TWS's global time-zone
// display setting (Global Configuration → General), which can be e.g.
// "US/Eastern" regardless of whether the contract trades on CME (Central).
// When IBKR includes that zone as a trailing name on the bar timestamp (e.g.
// "20250110 15:30:00 US/Eastern"), normalizeDate (below) strips it — this
// pulls it out first so the caller can parse the bar's naive date/time in the
// zone IBKR actually used, instead of assuming it matches the contract's
// exchange. Returns null if no zone suffix is present (bar time is in the
// exchange's own timezone, the common case, and the old assumption holds).
function extractIBKRTimezoneSuffix(dateStr) {
    const match = String(dateStr || '').match(/^\d{8}\s+\d{2}:\d{2}:\d{2}\s+([A-Za-z]+\/[A-Za-z_]+)/);
    return match ? match[1] : null;
}

function normalizeDate(dateStr) {
    try {
        const cleanDate = dateStr.replace(/finished[-_].*/, '').trim();
        if (/^\d{8}$/.test(cleanDate)) {
            return cleanDate;
        } else if (/^\d{8}\s+\d{2}:\d{2}:\d{2}$/.test(cleanDate)) {
            return cleanDate;
        } else if (/^\d{8}\s+\d{2}:\d{2}:\d{2}\s+[A-Za-z\/]+/.test(cleanDate)) {
            const [datePart, timePart] = cleanDate.split(/\s+/);
            return `${datePart} ${timePart}`;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
            return cleanDate.replace(/-/g, '');
        } else if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(cleanDate)) {
            return cleanDate.replace(/-/g, '');
        } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(cleanDate)) {
            const [day, month, year] = cleanDate.split('/');
            return `${year}${month}${day}`;
        } else if (/^\d{2}-\d{2}-\d{4}$/.test(cleanDate)) {
            const [day, month, year] = cleanDate.split('-');
            return `${year}${month}${day}`;
        } else if (/^\d{4}\/\d{2}\/\d{2}$/.test(cleanDate)) {
            const [year, month, day] = cleanDate.split('/');
            return `${year}${month}${day}`;
        } else {
            const parsedDate = new Date(cleanDate);
            if (!isNaN(parsedDate)) {
                const year = parsedDate.getFullYear();
                const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
                const day = String(parsedDate.getDate()).padStart(2, '0');
                const hours = String(parsedDate.getHours()).padStart(2, '0');
                const minutes = String(parsedDate.getMinutes()).padStart(2, '0');
                const seconds = String(parsedDate.getSeconds()).padStart(2, '0');
                if (hours === '00' && minutes === '00' && seconds === '00') {
                    return `${year}${month}${day}`;
                }
                return `${year}${month}${day} ${hours}:${minutes}:${seconds}`;
            }
        }
        logger.warn(`[Utils] Unrecognized date format: "${cleanDate}"`);
        return null;
    } catch (err) {
        logger.error(`[Utils] Error normalizing date "${dateStr}": ${err.message}`);
        return null;
    }
}

/**
 * Converts a timeframe string into a Luxon Duration object.
 * @param {string} timeframe - The timeframe string ('15M', '1H', etc.).
 * @returns {Duration} A Luxon Duration object.
 */
function getTimeframeDuration(timeframe) {
    const durations = {
        '1M': { minutes: 1 },
        '5M': { minutes: 5 },
        '15M': { minutes: 15 },
        '1H': { hours: 1 },
        '4H': { hours: 4 },
        '1D': { days: 1 },
        '1W': { weeks: 1 }
    };
    if (!durations[timeframe]) {
        throw new Error(`Unsupported timeframe: ${timeframe}`);
    }
    return Duration.fromObject(durations[timeframe]);
}

/**
 * Parses an IBKR-style duration string (e.g., '1 Y') into a Luxon-compatible object.
 * @param {string} durationStr - The duration string.
 * @returns {{ [unit: string]: number }} An object like { days: 1 }.
 */
function parseDuration(durationStr) {
    const [value, unit] = durationStr.split(' ');
    const valueNum = parseInt(value, 10);
    switch (unit) {
        case 'D': return { days: valueNum };
        case 'W': return { weeks: valueNum };
        case 'M': return { months: valueNum };
        case 'Y': return { years: valueNum };
        default: throw new Error(`Invalid duration unit: ${unit}`);
    }
}

/**
 * Formats a Luxon Duration object into an IBKR-compatible duration string (e.g., '300 S', '1 D', '1 M', '1 Y').
 * IBKR prefers larger units.
 * @param {Duration} duration - The Luxon Duration object.
 * @returns {string} The formatted duration string.
 */
function formatDurationForIBKR(duration) {
    if (duration.as('years') >= 1) {
        const val = `${Math.ceil(duration.as('years'))} Y`;
        return val;
    } else if (duration.as('months') >= 1) {
        const val = `${Math.ceil(duration.as('months'))} M`;
        return val;
    } else if (duration.as('days') >= 1) {
        const val = `${Math.ceil(duration.as('days'))} D`;
        return val;
    } else if (duration.as('seconds') > 0) {
        const val = `${Math.max(Math.ceil(duration.as('seconds')), 1)} S`; // Minimum 1 second
        return val;
    }
    return "1 S"; // Default for zero or negative duration
}

async function validateContract(contract, taskId, cancellationSignal = null, broadcastStatus) {
    return new Promise((resolve, reject) => {
        const ibApi = ibkr.getIbApi();
        if (!ibApi) {
            return reject(new Error("IBKR API is not connected."));
        }

        const ibReqId = generateIbReqId();
        let resolvedOrRejected = false;

        let validationTimeout;

        const cleanupAndAction = (action, value) => {
            if (resolvedOrRejected) return;
            resolvedOrRejected = true;

            clearTimeout(validationTimeout);
            if (cancellationSignal) {
                cancellationSignal.removeEventListener('abort', onAbort);
            }

            // FIX: Safely remove listeners only if the API object still exists.
            const currentApi = ibkr.getIbApi();
            if (currentApi) {
                currentApi.off(EventName.contractDetails, specificContractDetailsHandler);
                currentApi.off(EventName.contractDetailsEnd, specificContractDetailsEndHandler);
                currentApi.off(EventName.error, specificErrorHandler);
            }
            
            action(value);
        };

        const onAbort = () => {
             cleanupAndAction(reject, new Error(`Contract validation for task ${taskId} (ibReqId ${ibReqId}) cancelled.`));
        };

        if (cancellationSignal?.aborted) {
            return reject(new Error(`Contract validation for task ${taskId} (ibReqId ${ibReqId}) already cancelled before starting.`));
        }
       
        cancellationSignal?.addEventListener('abort', onAbort, { once: true });

        // logger.info(`[Historical][validateContract][${taskId}] Validating contract (ibReqId ${ibReqId}): ${JSON.stringify(contract)}`);
        // broadcastStatus(taskId, `Validating contract with TWS (ibReqId ${ibReqId})...`, 'info');
        
        validationTimeout = setTimeout(() => {
            cleanupAndAction(reject, new Error(`Contract validation timed out after 20 seconds for ibReqId ${ibReqId}`));
        }, 20000);

        const specificContractDetailsHandler = (id, contractDetails) => {
            if (id === ibReqId) {
                // logger.info(`[Historical][validateContract][${taskId}] Contract validated (ibReqId ${ibReqId}): ${JSON.stringify(contractDetails.contract)}`);
                cleanupAndAction(resolve, contractDetails.contract);
            }
        };

        const specificContractDetailsEndHandler = (id) => {
            if (id === ibReqId) {
                cleanupAndAction(reject, new Error(`No valid contract details found for ibReqId ${ibReqId}`));
            }
        };

        const specificErrorHandler = (err, code, id) => {
            if (id === ibReqId || id === -1) {
                const fullError = new Error(`Contract validation failed for ibReqId ${ibReqId}: ${err.message} (code ${code})`);
                // Add contract info to the error for better debugging in the catch block
                fullError.contract = contract; 
                // logger.error(`[Historical][validateContract][${taskId}] Contract validation error (ibReqId ${ibReqId}, code ${code}): ${err.message}, contract=${JSON.stringify(contract)}`);
                // broadcastStatus(taskId, `Contract validation failed for ibReqId ${ibReqId}: ${err.message} (code ${code})`, 'error');
                cleanupAndAction(reject, fullError);
            }
        };

        ibApi.on(EventName.contractDetails, specificContractDetailsHandler);
        ibApi.on(EventName.contractDetailsEnd, specificContractDetailsEndHandler);
        ibApi.on(EventName.error, specificErrorHandler);

        ibApi.reqContractDetails(ibReqId, contract);
    });
}


// requiredStartDate can be as far back as MAX_LOOKBACK_DURATION (100 years,
// see historical-data-service.js) when a symbol's history isn't capped — but
// unlike price-bar fetching, there's no provider-side signal that stops this
// search early: it's one validateContract request per candidate month, all
// the way back, regardless of whether the instrument could plausibly have
// existed that far back. No futures contract goes back anywhere near 100
// years, so without a floor this burns hundreds of doomed-to-fail IBKR
// requests (and matching "No security definition" log noise) on every
// contract-chain generation for no benefit.
const CONTRACT_CHAIN_MAX_LOOKBACK_YEARS = 30;

async function generateContractChain(symbol, exchange, requiredStartDate, taskId, broadcastStatus, cancellationSignal, rolloverMonths, currency = 'USD') {
    const searchFloor = DateTime.max(requiredStartDate, DateTime.now().minus({ years: CONTRACT_CHAIN_MAX_LOOKBACK_YEARS }));
    logger.debug(`[populate][${taskId}] Starting contract chain generation for ${symbol} from ${searchFloor.toISODate()} with rollover months: [${rolloverMonths.join(', ')}]`);

    // FIX: Helper for running promises in sequential batches to avoid overwhelming the API
    const runTasksInBatches = async (tasks, batchSize) => {
        let allResults = [];
        for (let i = 0; i < tasks.length; i += batchSize) {
            const batch = tasks.slice(i, i + batchSize);
            logger.debug(`[populate][${taskId}] Executing validation batch ${Math.floor(i / batchSize) + 1}...`);
            const batchResults = await Promise.allSettled(batch.map(task => task()));
            allResults = allResults.concat(batchResults);
        }
        return allResults;
    };

    try {
        const validationTasks = [];
        const now = DateTime.now();
        
        // --- Prepare all validation tasks ---
        // 1. Backward search for historical contracts
        let backwardDate = now.startOf('month');
        while (backwardDate >= searchFloor.startOf('month')) {
            if (rolloverMonths.includes(backwardDate.month)) {
                const contractMonthStr = backwardDate.toFormat('yyyyMM');
                validationTasks.push(() => validateContract({
                    symbol: symbol.toUpperCase(),
                    secType: 'FUT',
                    exchange: exchange.toUpperCase(),
                    lastTradeDateOrContractMonth: contractMonthStr,
                    currency,
                    includeExpired: true
                }, taskId, cancellationSignal, broadcastStatus));
            }
            backwardDate = backwardDate.minus({ months: 1 });
        }

        // 2. Forward search for active/upcoming contracts
        let forwardDate = now.startOf('month');
        const forwardLimit = now.plus({ months: 6 });
        while (forwardDate <= forwardLimit) {
            if (rolloverMonths.includes(forwardDate.month)) {
                const contractMonthStr = forwardDate.toFormat('yyyyMM');
                 validationTasks.push(() => validateContract({
                    symbol: symbol.toUpperCase(),
                    secType: 'FUT',
                    exchange: exchange.toUpperCase(),
                    lastTradeDateOrContractMonth: contractMonthStr,
                    currency,
                }, taskId, cancellationSignal, broadcastStatus));
            }
            forwardDate = forwardDate.plus({ months: 1 });
        }
        
        logger.debug(`[populate][${taskId}] Prepared ${validationTasks.length} contract validation tasks. Executing in sequential batches...`);

        // --- Execute tasks in batches to be safer ---
        const BATCH_SIZE = 4;
        const settledResults = await runTasksInBatches(validationTasks, BATCH_SIZE);
        
        const foundContracts = new Map();
        for (const result of settledResults) {
            if (cancellationSignal?.aborted) break;

            if (result.status === 'fulfilled' && result.value) {
                const contractDetails = result.value;
                if (contractDetails && !foundContracts.has(contractDetails.conId)) {
                    foundContracts.set(contractDetails.conId, contractDetails);
                }
            } else if (result.status === 'rejected') {
                // Log failures but don't stop the entire process
                const error = result.reason;
                const contractMonthStr = error.contract?.lastTradeDateOrContractMonth || "unknown";
                
                const isPastContract = contractMonthStr !== "unknown" && DateTime.fromFormat(contractMonthStr, 'yyyyMM') < now.startOf('month');

                if (error.message.includes("No security definition has been found")) {
                    if (isPastContract) {
                        // logger.info(`[populate][${taskId}] Skipping historical contract ${contractMonthStr}: Not found (as expected for old contracts).`);
                    } else {
                        logger.warn(`[populate][${taskId}] Failed to validate current or future contract ${contractMonthStr}. This could indicate a symbol or TWS data issue.`);
                    }
                } else if (!cancellationSignal?.aborted && !error.message.includes('timed out')) {
                    // Don't log timeout errors as they are verbose and expected for non-existent contracts
                    logger.error(`[populate][${taskId}] Unexpected error validating contract ${contractMonthStr}: ${error.message}`);
                }
            }
        }
        
        if (cancellationSignal?.aborted) {
             throw new Error(`Task ${taskId} cancelled during contract validation.`);
        }

        const sortedContracts = Array.from(foundContracts.values()).sort((a, b) => {
            const monthA = a.lastTradeDateOrContractMonth.substring(0, 6);
            const monthB = b.lastTradeDateOrContractMonth.substring(0, 6);
            return monthA.localeCompare(monthB);
        });

        logger.debug(`[populate][${taskId}] Found ${sortedContracts.length} relevant contracts for ${symbol}.`);
        return sortedContracts.map(c => ({
            ...c,
            contractMonth: c.lastTradeDateOrContractMonth.substring(0, 6)
        }));

    } catch (error) {
        // This catch block is a safety net but the logic above should prevent it from being hit by a single failed validation.
        logger.error(`[populate][${taskId}] A critical error occurred in generateContractChain for ${symbol}: ${error.message}`);
        // Do not re-throw, allow the function to return whatever contracts were found.
        return [];
    }
}


// Export all the utility functions
module.exports = {
    delay,
    timeout,
    withRetries,
    normalizeDate,
    extractIBKRTimezoneSuffix,
    getTimeframeDuration,
    parseDuration,
    formatDurationForIBKR,
    generateContractChain,
    generateIbReqId,
    validateContract
};