// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { DateTime, Duration } = require('luxon');

// The modules log through modules/logger.js, which writes next to USER_PATH.
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-duration-'));
const { formatDurationForIBKR } = require('../modules/utils.js');

test('IBKR durations: over 12 months is asked in years', () => {
  // A calendar year an hour short (it crosses the switch to summer time).
  const start = DateTime.fromISO('2009-11-05T08:00:00', { zone: 'America/New_York' });
  const end = DateTime.fromISO('2010-11-05T08:00:00', { zone: 'America/New_York' });
  assert.equal(formatDurationForIBKR(end.diff(start)), '1 Y');
  assert.equal(formatDurationForIBKR(Duration.fromObject({ days: 340 })), '12 M');
  assert.equal(formatDurationForIBKR(Duration.fromObject({ days: 3 })), '3 D');
});
