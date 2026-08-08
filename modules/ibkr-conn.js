const { IBApi, EventName } = require('@stoqey/ib');
const path = require('path');
const fs = require('fs').promises;
const { logger } = require('./logger.js');

// Module-specific state variables
let ibApi = null;
let connectionCount = 0;
let connectionLock = null;
let disconnectionLock = null;
const commissionMap = new Map();

// We need a way to get the config, so we create a helper for it.
// This avoids circular dependencies with server.js.
const USER_PATH_LOCAL = process.env.USER_PATH || "./";
const CONFIG_FILE = path.join(USER_PATH_LOCAL, 'config.json');

async function loadConfig() {
    try {
        await fs.access(CONFIG_FILE);
        const configData = await fs.readFile(CONFIG_FILE, 'utf-8');
        return JSON.parse(configData);
    } catch {
        // Return a default structure if config doesn't exist yet
        return { ibkrAddresses: [{ host: '127.0.0.1', port: 7497 }] };
    }
}

/**
 * Returns the current IB API instance if connected.
 * @returns {IBApi|null} The IBApi instance or null.
 */
function getIbApi() {
    return ibApi;
}

/**
 * Checks if the IBKR API is currently connected.
 * @returns {boolean}
 */
function isIbkrConnected() {
    return !!ibApi;
}

/**
 * Initializes a connection to the Interactive Brokers API.
 * Manages a connection counter and uses a lock to prevent concurrent initializations.
 * @param {string} requestId - A unique ID for logging and status broadcasting.
 * @param {function} broadcastStatus - Function to send WebSocket status updates.
 */
async function initializeIBKR(requestId, broadcastStatus) {
  if (ibApi) {
    connectionCount++;
    logger.info(`[IBKR] initializeIBKR: Reusing existing connection. Count: ${connectionCount}`);
    broadcastStatus(requestId, 'IBKR instance exists, reusing connection.', 'info');
    return;
  }

  if (connectionLock) {
    logger.info(`[IBKR] initializeIBKR: Connection process locked. Waiting...`);
    broadcastStatus(requestId, 'IBKR connection process active, awaiting completion.', 'info');
    try {
      await connectionLock;
      if (ibApi) {
        connectionCount++;
        logger.info(`[IBKR] initializeIBKR: Waited for lock. Connection successful. Count: ${connectionCount}`);
      } else {
        logger.info(`[IBKR] initializeIBKR: Waited for lock. Connection failed. Not incrementing count.`);
        throw new Error("Previously locked IBKR connection attempt failed.");
      }
      return;
    } catch (error) {
      logger.error(`[IBKR] initializeIBKR: Error while waiting for connection lock: ${error.message}`);
      throw error;
    }
  }

  connectionLock = (async () => {
    logger.info(`[IBKR] initializeIBKR: Attempting new connection (lock acquired).`);
    broadcastStatus(requestId, `Attempting new IBKR connection.`, 'info');

    const config = await loadConfig();
    const addresses = config.ibkrAddresses || [{ host: '127.0.0.1', port: 7497 }];
    let lastError = null;

    for (let i = 0; i < addresses.length; i++) {
      const { host, port } = addresses[i];
      if (!host || !port) {
        logger.info(`[IBKR] Skipping invalid address: host=${host}, port=${port}`);
        continue;
      }

      broadcastStatus(requestId, `Connecting to Interactive Brokers API at ${host}:${port}`, 'info');
      logger.info(`[IBKR] Attempting connection to ${host}:${port}`);

      const currentAttemptIbApi = new IBApi({ host, port });

      try {
        await new Promise((resolvePromise, rejectPromise) => {
          const connectionTimeout = setTimeout(() => {
            currentAttemptIbApi.removeAllListeners(EventName.connected);
            currentAttemptIbApi.removeAllListeners(EventName.error);
            rejectPromise(new Error(`Connection attempt to ${host}:${port} timed out after 15 seconds.`));
          }, 15000);

          currentAttemptIbApi.once(EventName.connected, () => {
            clearTimeout(connectionTimeout);
            broadcastStatus(requestId, `Connected to Interactive Brokers API at ${host}:${port}`, 'success');
            logger.info(`✅ Connected to Interactive Brokers API at ${host}:${port}`);
            ibApi = currentAttemptIbApi;
            connectionCount = 1;

            // Setup commission report listener
            ibApi.on(EventName.commissionReport, (commissionReport) => {
              logger.info(`[IBKR] Commission report received:`, commissionReport);
              if (commissionReport.execId) {
                logger.info(`[IBKR] Storing commission for execId: ${commissionReport.execId}, commission: ${commissionReport.commission}`);
                commissionMap.set(commissionReport.execId, commissionReport.commission);
              }
            });

            // Setup persistent error handler
            ibApi.on(EventName.error, (err, code, localRequestId) => {
              const errSourceId = localRequestId || requestId || uuidv4();
              logger.error(`[IBKR Persistent Error Handler] Error: ${err.message} (Code: ${code}, ReqId: ${localRequestId})`);
              broadcastStatus(errSourceId, `IBKR Connection Error: ${err.message} (Code: ${code})`, 'error');

              if (code === 502 || code === 504 || code === 509 || code === 1100 || code === 2104 || code === 2106 || code === 2158) {
                logger.error(`[IBKR Persistent Error Handler] Critical error ${code} received. Disconnecting and nullifying ibApi.`);
                if (ibApi) {
                  try { ibApi.disconnect(); } catch (e) { /* ignore */ }
                  ibApi = null;
                  connectionCount = 0;
                  commissionMap.clear();
                }
              }
            });
            resolvePromise();
          });

          currentAttemptIbApi.once(EventName.error, (err, code) => {
            clearTimeout(connectionTimeout);
            const errorMsg = `Failed to connect to TWS at ${host}:${port}: ${err.message} (Code: ${code})`;
            broadcastStatus(requestId, errorMsg, 'error');
            logger.error(`[IBKR] ${errorMsg}`);
            rejectPromise(new Error(errorMsg));
          });
          currentAttemptIbApi.connect();
        });
        return;
      } catch (err) {
        lastError = err;
        if (currentAttemptIbApi) {
          try { currentAttemptIbApi.disconnect(); } catch (e) { /* ignore */ }
        }
        if (i < addresses.length - 1) {
          broadcastStatus(requestId, `Connection to ${host}:${port} failed. Trying next address...`, 'info');
          logger.info(`[IBKR] Connection to ${host}:${port} failed. Trying next address...`);
        }
      }
    }
    logger.error(`[IBKR] initializeIBKR: All connection attempts failed.`);
    broadcastStatus(requestId, 'All IBKR connection attempts failed.', 'error');
    ibApi = null;
    throw lastError || new Error('All IBKR connection attempts failed and no specific error was caught.');
  })();

  try {
    await connectionLock;
  } catch (error) {
    throw error;
  } finally {
    connectionLock = null;
  }
}


/**
 * Decrements the connection counter and disconnects from the API if the counter reaches zero.
 */
async function disconnectIBKR() {
    if (disconnectionLock) {
        await disconnectionLock;
        return;
    }

    connectionCount--;
    logger.info(`[IBKR] disconnectIBKR: Decremented count to ${connectionCount}.`);

    if (connectionCount <= 0 && ibApi) {
        let releaseLock;
        disconnectionLock = new Promise((resolve) => { releaseLock = resolve; });
        
        try {
            ibApi.disconnect();
            logger.info('✅ Disconnected from Interactive Brokers API');
        } catch (err) {
            logger.error('❌ Error disconnecting from IBKR:', err.message);
        } finally {
            ibApi = null;
            connectionCount = 0;
            disconnectionLock = null;
            releaseLock();
        }
    } else if (connectionCount < 0) {
        connectionCount = 0;
    }
}

module.exports = {
    initializeIBKR,
    disconnectIBKR,
    getIbApi,
    isIbkrConnected,
    commissionMap, // Exporting map for use in execution routes
};
