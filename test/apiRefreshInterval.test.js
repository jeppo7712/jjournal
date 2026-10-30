// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'api-refresh-'));
const { apiRefreshIntervalMs } = require('../modules/historical-data-service.js');

const MIN = 60 * 1000;

test('an API client refreshes a series at most every ten minutes, or once per bar', () => {
  assert.equal(apiRefreshIntervalMs('1M'), 10 * MIN);
  assert.equal(apiRefreshIntervalMs('5M'), 10 * MIN);
  assert.equal(apiRefreshIntervalMs('15M'), 15 * MIN);
  assert.equal(apiRefreshIntervalMs('1H'), 60 * MIN);
  assert.equal(apiRefreshIntervalMs('4H'), 240 * MIN);
  assert.equal(apiRefreshIntervalMs('1D'), 24 * 60 * MIN);
});
