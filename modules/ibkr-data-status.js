// Whether IBKR answers historical-data requests, for the HIS light in the
// navigation. The data connection can be up while the gateway sits on every
// request (e.g. after it reconnects to IBKR's servers), which nothing else
// reports; this records how the latest requests actually ended.
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
}

function getStatus() {
  return { ...status };
}

module.exports = { recordSuccess, recordFailure, getStatus };
