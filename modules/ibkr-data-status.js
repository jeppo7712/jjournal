// Whether IBKR answers historical-data requests, for the HIS light in the
// navigation. The data connection can be up while the gateway sits on every
// request (e.g. after it reconnects to IBKR's servers), which nothing else
// reports; this records how the latest requests actually ended.
const gatewayCommand = require('./ibkr-gateway-command.js');

const status = {
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  consecutiveFailures: 0,
};

function recordSuccess() {
  status.lastSuccessAt = new Date().toISOString();
  status.consecutiveFailures = 0;
}

function recordFailure(message) {
  status.lastFailureAt = new Date().toISOString();
  status.lastError = String(message || 'Unknown error').slice(0, 300);
  status.consecutiveFailures += 1;
  // Two in a row is past a one-off; ask the gateway to reconnect its data
  // connections, and restart it if that doesn't help (only does anything
  // when a command address is configured; see ibkr-gateway-command.js).
  if (status.consecutiveFailures >= 2) {
    gatewayCommand.requestDataReconnect(`${status.consecutiveFailures} failed requests in a row`).catch(() => {});
  }
}

function getStatus() {
  return { ...status, lastReconnect: gatewayCommand.getLastReconnect(), lastRestart: gatewayCommand.getLastRestart() };
}

module.exports = { recordSuccess, recordFailure, getStatus };
