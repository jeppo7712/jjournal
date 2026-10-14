// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { DateTime, Duration } = require('luxon');

// The modules log through modules/logger.js, which writes next to USER_PATH.
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-duration-'));
const { formatDurationForIBKR, withRetries } = require('../modules/utils.js');

test('IBKR durations: over 12 months is asked in years', () => {
  // A calendar year an hour short (it crosses the switch to summer time).
  const start = DateTime.fromISO('2009-11-05T08:00:00', { zone: 'America/New_York' });
  const end = DateTime.fromISO('2010-11-05T08:00:00', { zone: 'America/New_York' });
  assert.equal(formatDurationForIBKR(end.diff(start)), '1 Y');
  assert.equal(formatDurationForIBKR(Duration.fromObject({ days: 340 })), '12 M');
  assert.equal(formatDurationForIBKR(Duration.fromObject({ days: 3 })), '3 D');
});

test('a cancelled task is not retried', async () => {
  const controller = new AbortController();
  let calls = 0;
  const fn = async () => { calls += 1; controller.abort(); throw new Error('cancelled'); };
  await assert.rejects(withRetries(fn, { retries: 3, delay: 1, cancellationSignal: controller.signal }), /cancelled/);
  assert.equal(calls, 1);
  // Without a cancel, a failure is tried again.
  let tries = 0;
  await assert.rejects(withRetries(async () => { tries += 1; throw new Error('IBKR timeout'); }, { retries: 2, delay: 1 }));
  assert.equal(tries, 2);
});
