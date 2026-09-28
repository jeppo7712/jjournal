const { IBApi, EventName } = require('@stoqey/ib');
const path = require('path');
const fs = require('fs').promises;
const { logger } = require('./logger.js');

// Two independent TWS/IB Gateway connections:
//
// - "account" (config.ibkrAddresses): the user's own TWS, logged into the
//   account whose trades get imported. Executions, completed and open
//   orders come from here, so which IBKR account it's logged into matters.
// - "data" (config.ibkrDataAddresses): historical bars and contract lookups.
//   Any login with market data will do, e.g. a headless IB Gateway on a
//   paper login, so charts don't depend on the user's TWS being open. When
//   no data address is set it uses the account addresses, as before.
//
// Each keeps its own socket, reference count and lock. They connect with
// different client IDs so both can share one TWS when no separate data
// address is set.
const ACCOUNT_CLIENT_ID = 0;
const DATA_CLIENT_ID = 11;
const DEFAULT_ADDRESSES = [{ host: '127.0.0.1', port: 7497 }];

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
        return { ibkrAddresses: DEFAULT_ADDRESSES };
    }
}

const usable = (addresses) => (Array.isArray(addresses) ? addresses.filter(a => a && a.host && a.port) : []);

function createConnection({ name, clientId, resolveAddresses }) {
  const tag = `[IBKR:${name}]`;
  let ibApi = null;
  let connectionCount = 0;
  let connectionLock = null;
  let disconnectionLock = null;
  let managedAccounts = [];
  const commissionMap = new Map();
  // Requests whose caller handles "No security definition" (code 200) itself
  // and reports it with context — contract lookups (validateContract), where
  // the futures contract-chain scan asks about many months that don't exist.
  // The persistent error handler only logs those at debug level instead of
  // flooding the log and status feed with one "Connection Error" per month.
  const selfReportedRequestIds = new Set();
  const expectSelfReportedErrors = (reqId) => selfReportedRequestIds.add(reqId);
  const releaseSelfReportedErrors = (reqId) => selfReportedRequestIds.delete(reqId);

  function getIbApi() {
    return ibApi;
  }

  function isIbkrConnected() {
    return !!ibApi;
  }

  /**
   * The IBKR account IDs the connected session manages. TWS sends them
   * right after connecting; if they haven't arrived yet this asks and waits
   * briefly. Empty when not connected or TWS didn't answer.
   */
  async function getManagedAccounts(waitMs = 3000) {
    if (!ibApi) return [];
    if (managedAccounts.length > 0) return managedAccounts;
    const api = ibApi;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { api.off(EventName.managedAccounts, onAccounts); resolve(); }, waitMs);
      function onAccounts() { clearTimeout(timer); api.off(EventName.managedAccounts, onAccounts); resolve(); }
      api.on(EventName.managedAccounts, onAccounts);
      try { api.reqManagedAccts(); } catch (e) { /* resolved by the timer */ }
    });
    return managedAccounts;
  }

  /**
   * Initializes the connection. Manages a connection counter and uses a
   * lock to prevent concurrent initializations.
   * @param {string} requestId - A unique ID for logging and status broadcasting.
   * @param {function} broadcastStatus - Function to send WebSocket status updates.
   */
  async function initializeIBKR(requestId, broadcastStatus) {
    if (ibApi) {
      connectionCount++;
      logger.info(`${tag} initializeIBKR: Reusing existing connection. Count: ${connectionCount}`);
      broadcastStatus(requestId, 'IBKR instance exists, reusing connection.', 'info');
      return;
    }

    if (connectionLock) {
      logger.info(`${tag} initializeIBKR: Connection process locked. Waiting...`);
      broadcastStatus(requestId, 'IBKR connection process active, awaiting completion.', 'info');
      try {
        await connectionLock;
        if (ibApi) {
          connectionCount++;
          logger.info(`${tag} initializeIBKR: Waited for lock. Connection successful. Count: ${connectionCount}`);
        } else {
          logger.info(`${tag} initializeIBKR: Waited for lock. Connection failed. Not incrementing count.`);
          throw new Error("Previously locked IBKR connection attempt failed.");
        }
        return;
      } catch (error) {
        logger.error(`${tag} initializeIBKR: Error while waiting for connection lock: ${error.message}`);
        throw error;
      }
    }

    connectionLock = (async () => {
      logger.info(`${tag} initializeIBKR: Attempting new connection (lock acquired).`);
      broadcastStatus(requestId, `Attempting new IBKR connection.`, 'info');

      const addresses = resolveAddresses(await loadConfig());
      let lastError = null;

      for (let i = 0; i < addresses.length; i++) {
        const { host, port } = addresses[i];

        broadcastStatus(requestId, `Connecting to Interactive Brokers API at ${host}:${port}`, 'info');
        logger.info(`${tag} Attempting connection to ${host}:${port}`);

        const currentAttemptIbApi = new IBApi({ host, port });
        managedAccounts = [];
        currentAttemptIbApi.on(EventName.managedAccounts, (list) => {
          managedAccounts = String(list || '').split(',').map(s => s.trim()).filter(Boolean);
        });

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
              logger.info(`✅ ${tag} Connected to Interactive Brokers API at ${host}:${port}`);
              ibApi = currentAttemptIbApi;
              connectionCount = 1;

              // Setup commission report listener
              ibApi.on(EventName.commissionReport, (commissionReport) => {
                logger.info(`${tag} Commission report received:`, commissionReport);
                if (commissionReport.execId) {
                  logger.info(`${tag} Storing commission for execId: ${commissionReport.execId}, commission: ${commissionReport.commission}`);
                  commissionMap.set(commissionReport.execId, commissionReport.commission);
                }
              });

              // Setup persistent error handler
              ibApi.on(EventName.error, (err, code, localRequestId) => {
                if (code === 200 && selfReportedRequestIds.has(localRequestId)) {
                  logger.debug(`${tag} No security definition for ReqId ${localRequestId} (reported by the lookup itself).`);
                  return;
                }
                const errSourceId = localRequestId || requestId || `ibkr-${name}`;
                logger.error(`${tag} [Persistent Error Handler] Error: ${err.message} (Code: ${code}, ReqId: ${localRequestId})`);
                broadcastStatus(errSourceId, `IBKR Connection Error: ${err.message} (Code: ${code})`, 'error');

                if (code === 502 || code === 504 || code === 509 || code === 1100 || code === 2104 || code === 2106 || code === 2158) {
                  logger.error(`${tag} [Persistent Error Handler] Critical error ${code} received. Disconnecting and nullifying ibApi.`);
                  if (ibApi) {
                    try { ibApi.disconnect(); } catch (e) { /* ignore */ }
                    ibApi = null;
                    connectionCount = 0;
                    managedAccounts = [];
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
              logger.error(`${tag} ${errorMsg}`);
              rejectPromise(new Error(errorMsg));
            });
            currentAttemptIbApi.connect(clientId);
          });
          return;
        } catch (err) {
          lastError = err;
          if (currentAttemptIbApi) {
            try { currentAttemptIbApi.disconnect(); } catch (e) { /* ignore */ }
          }
          if (i < addresses.length - 1) {
            broadcastStatus(requestId, `Connection to ${host}:${port} failed. Trying next address...`, 'info');
            logger.info(`${tag} Connection to ${host}:${port} failed. Trying next address...`);
          }
        }
      }
      logger.error(`${tag} initializeIBKR: All connection attempts failed.`);
      broadcastStatus(requestId, 'All IBKR connection attempts failed.', 'error');
      ibApi = null;
      throw lastError || new Error('All IBKR connection attempts failed and no specific error was caught.');
    })();

    try {
      await connectionLock;
    } finally {
      connectionLock = null;
    }
  }

  /**
   * Decrements the connection counter and disconnects if it reaches zero.
   */
  async function disconnectIBKR() {
    if (disconnectionLock) {
      await disconnectionLock;
      return;
    }

    connectionCount--;
    logger.info(`${tag} disconnectIBKR: Decremented count to ${connectionCount}.`);

    if (connectionCount <= 0 && ibApi) {
      let releaseLock;
      disconnectionLock = new Promise((resolve) => { releaseLock = resolve; });

      try {
        ibApi.disconnect();
        logger.info(`✅ ${tag} Disconnected from Interactive Brokers API`);
      } catch (err) {
        logger.error(`❌ ${tag} Error disconnecting from IBKR:`, err.message);
      } finally {
        ibApi = null;
        connectionCount = 0;
        managedAccounts = [];
        disconnectionLock = null;
        releaseLock();
      }
    } else if (connectionCount < 0) {
      connectionCount = 0;
    }
  }

  return {
    initializeIBKR,
    disconnectIBKR,
    getIbApi,
    isIbkrConnected,
    getManagedAccounts,
    expectSelfReportedErrors,
    releaseSelfReportedErrors,
    commissionMap, // Exporting map for use in execution routes
  };
}

const accountAddresses = (config) => {
  const list = usable(config.ibkrAddresses);
  return list.length > 0 ? list : DEFAULT_ADDRESSES;
};

const account = createConnection({
  name: 'account',
  clientId: ACCOUNT_CLIENT_ID,
  resolveAddresses: accountAddresses,
});

const data = createConnection({
  name: 'data',
  clientId: DATA_CLIENT_ID,
  resolveAddresses: (config) => {
    const list = usable(config.ibkrDataAddresses);
    return list.length > 0 ? list : accountAddresses(config);
  },
});

// The account connection is the module's default export shape (what
// routes/ibkr.js has always used); the data connection hangs off `.data`.
module.exports = { ...account, account, data };
