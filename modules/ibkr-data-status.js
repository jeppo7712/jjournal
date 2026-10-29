// Whether IBKR answers historical-data requests, for the HIS light in the
// navigation. The data connection can be up while the gateway sits on every
// request (e.g. after it reconnects to IBKR's servers), which nothing else
// reports; this records how the latest requests actually ended.
//
// It also records whether the data connection can be opened at all. IB
// Gateway only opens its API port once it is logged in, so when every
// connect has failed for LOGGED_OUT_AFTER_MS the gateway is reported as
// logged out (e.g. after an auto-restart IBKR answered with "Session
// expired"). Nothing the journal can send fixes that, so it then stops
// asking the gateway to reconnect or restart and tries to connect only
// once a minute, until a connect works again.
const gatewayCommand = require('./ibkr-gateway-command.js');
const { logger } = require('./logger.js');

const LOGGED_OUT_AFTER_MS = 10 * 60 * 1000;
// Least time between two connect attempts while connects keep failing:
// the first while the gateway may just be restarting, the second once it
// counts as logged out.
const CONNECT_RETRY_MS = 15 * 1000;
const LOGGED_OUT_RETRY_MS = 60 * 1000;

const status = {
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  consecutiveFailures: 0,
};
// The request that failed last (see recordFailure).
let lastFailedRequest = null;

const connect = {
  failingSince: null, // ms; first failed connect since the last one that worked
  lastAttemptAt: null, // ms
  lastError: null,
  loggedOutReported: false,
};

function recordSuccess() {
  status.lastSuccessAt = new Date().toISOString();
  status.consecutiveFailures = 0;
  lastFailedRequest = null;
}

/**
 * @param {string} message
 * @param {string} [requestKey] Identifies the request (contract, range, bar
 *   size): a retry of the request that failed last isn't counted again. One
 *   request IBKR never answers (ETFC before its listing timed out on both
 *   attempts) said nothing about the gateway, yet counted as two failures
 *   in a row and had it reconnected and restarted about 13 times a day.
 */
function recordFailure(message, requestKey = null) {
  status.lastFailureAt = new Date().toISOString();
  status.lastError = String(message || 'Unknown error').slice(0, 300);
  if (requestKey !== null && requestKey === lastFailedRequest) return;
  lastFailedRequest = requestKey;
  status.consecutiveFailures += 1;
  // Two in a row is past a one-off; ask the gateway to reconnect its data
  // connections, and restart it if that doesn't help (only does anything
  // when a command address is configured; see ibkr-gateway-command.js).
  // Not while connects fail: a gateway that doesn't accept API connections
  // can't be helped that way.
  if (status.consecutiveFailures >= 2 && connect.failingSince === null) {
    gatewayCommand.requestDataReconnect(`${status.consecutiveFailures} failed requests in a row`).catch(() => {});
  }
}

function isLoggedOut(now = Date.now()) {
  return connect.failingSince !== null && now - connect.failingSince >= LOGGED_OUT_AFTER_MS;
}

/** A connect to the data address failed (refused, closed, timed out). */
function recordConnectFailure(message, now = Date.now()) {
  if (connect.failingSince === null) connect.failingSince = now;
  connect.lastAttemptAt = now;
  connect.lastError = String(message || 'Unknown error').slice(0, 300);
  if (isLoggedOut(now) && !connect.loggedOutReported) {
    connect.loggedOutReported = true;
    logger.error(`[IBKR data] No API connection since ${new Date(connect.failingSince).toISOString()}: IB Gateway is probably logged out (e.g. its weekly session expired) and needs a fresh login, e.g. a restart of its container. Trying again once a minute. Last error: ${connect.lastError}`);
  }
}

/** A connect to the data address worked: the gateway is logged in. */
function recordConnectSuccess() {
  if (connect.loggedOutReported) logger.info('[IBKR data] Connected again; IB Gateway is logged in.');
  connect.failingSince = null;
  connect.lastAttemptAt = null;
  connect.lastError = null;
  connect.loggedOutReported = false;
}

/**
 * While connects keep failing, how long the next one should wait so the
 * gateway isn't asked every few seconds: 0 when it may try now.
 */
function connectWaitMs(now = Date.now()) {
  if (connect.failingSince === null) return 0;
  const interval = isLoggedOut(now) ? LOGGED_OUT_RETRY_MS : CONNECT_RETRY_MS;
  return Math.max(0, connect.lastAttemptAt + interval - now);
}

function getStatus() {
  return {
    ...status,
    lastReconnect: gatewayCommand.getLastReconnect(),
    lastRestart: gatewayCommand.getLastRestart(),
    restartHeld: gatewayCommand.getRestartHeld(),
    connectFailingSince: connect.failingSince === null ? null : new Date(connect.failingSince).toISOString(),
    connectError: connect.lastError,
    loggedOut: isLoggedOut(),
  };
}

module.exports = { recordSuccess, recordFailure, recordConnectFailure, recordConnectSuccess, connectWaitMs, isLoggedOut, getStatus };
