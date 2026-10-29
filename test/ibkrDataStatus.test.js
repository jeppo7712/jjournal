// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// The modules log through modules/logger.js, which writes next to USER_PATH.
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-data-status-'));
const gatewayCommand = require('../modules/ibkr-gateway-command.js');
const dataStatus = require('../modules/ibkr-data-status.js');

const MIN = 60 * 1000;

test('failing connects count as logged out after 10 minutes and back off', () => {
    const t0 = Date.UTC(2026, 9, 11, 12, 21);
    dataStatus.recordConnectFailure('closed the connection before the API handshake', t0);
    assert.equal(dataStatus.isLoggedOut(t0 + 9 * MIN), false);
    // While the gateway may just be restarting: at most every 15 s.
    assert.equal(dataStatus.connectWaitMs(t0 + 5000), 10000);
    assert.equal(dataStatus.connectWaitMs(t0 + 15000), 0);

    dataStatus.recordConnectFailure('closed the connection before the API handshake', t0 + 10 * MIN);
    assert.equal(dataStatus.isLoggedOut(t0 + 10 * MIN), true);
    // Logged out: once a minute.
    assert.equal(dataStatus.connectWaitMs(t0 + 10 * MIN + 15000), 45000);
    assert.equal(dataStatus.connectWaitMs(t0 + 11 * MIN), 0);

    dataStatus.recordConnectSuccess();
    assert.equal(dataStatus.isLoggedOut(t0 + 11 * MIN), false);
    assert.equal(dataStatus.connectWaitMs(t0 + 11 * MIN), 0);
    const s = dataStatus.getStatus();
    assert.equal(s.connectFailingSince, null);
    assert.equal(s.loggedOut, false);
});

test('no RECONNECTDATA or RESTART while connects fail', (t) => {
    const calls = [];
    t.mock.method(gatewayCommand, 'requestDataReconnect', async (reason) => { calls.push(reason); });

    dataStatus.recordConnectFailure('ECONNREFUSED');
    dataStatus.recordFailure('timed out');
    dataStatus.recordFailure('timed out');
    assert.equal(calls.length, 0);

    dataStatus.recordConnectSuccess();
    dataStatus.recordFailure('timed out');
    assert.equal(calls.length, 1);
    dataStatus.recordSuccess();
});

test('a retry of the same failed request is not a second failure', (t) => {
    const calls = [];
    t.mock.method(gatewayCommand, 'requestDataReconnect', async (reason) => { calls.push(reason); });

    // One request IBKR never answers, asked twice: not the gateway.
    dataStatus.recordFailure('timed out', '745200069|1 hour|2 Y|20231127-23:00:00');
    dataStatus.recordFailure('timed out', '745200069|1 hour|2 Y|20231127-23:00:00');
    assert.equal(dataStatus.getStatus().consecutiveFailures, 1);
    assert.equal(calls.length, 0);

    // A different request failing too is.
    dataStatus.recordFailure('timed out', '745200069|1 hour|3 D|20261029-08:51:44');
    assert.equal(dataStatus.getStatus().consecutiveFailures, 2);
    assert.equal(calls.length, 1);

    // After a success the same request counts again.
    dataStatus.recordSuccess();
    dataStatus.recordFailure('timed out', '745200069|1 hour|3 D|20261029-08:51:44');
    assert.equal(dataStatus.getStatus().consecutiveFailures, 1);
    dataStatus.recordSuccess();
});

test('RESTART is held on Sunday between 01:00 and 18:00 US/Eastern', () => {
    const held = (iso) => gatewayCommand.restartHoldReason(new Date(iso)) !== null;
    // Summer time (EDT, UTC-4).
    assert.equal(held('2026-10-11T04:59:00Z'), false); // Sun 00:59 ET
    assert.equal(held('2026-10-11T05:00:00Z'), true); // Sun 01:00 ET
    assert.equal(held('2026-10-11T12:20:00Z'), true); // the daily data stall
    assert.equal(held('2026-10-11T21:59:00Z'), true); // Sun 17:59 ET
    assert.equal(held('2026-10-11T22:00:00Z'), false); // Sun 18:00 ET
    assert.equal(held('2026-10-12T12:20:00Z'), false); // Monday
    assert.equal(held('2026-10-10T12:20:00Z'), false); // Saturday
    // Winter time (EST, UTC-5).
    assert.equal(held('2026-11-08T05:59:00Z'), false); // Sun 00:59 ET
    assert.equal(held('2026-11-08T06:00:00Z'), true); // Sun 01:00 ET
});
