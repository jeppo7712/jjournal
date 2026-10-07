// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { timeframeLabel: serverLabel } = require('../modules/timeframeLabel.js');

// src/utils is ES module code (the React app's); Node loads it by syntax.
const load = () => import('../src/utils/timeframeLabel.js');

test('timeframeLabel: minutes read 1m/5m/15m, the rest stays', async () => {
  const { timeframeLabel } = await load();
  for (const label of [timeframeLabel, serverLabel]) {
    assert.deepEqual(['1M', '5M', '15M', '1H', '4H', '1D', '1W'].map(label), ['1m', '5m', '15m', '1H', '4H', '1D', '1W']);
    assert.equal(label(undefined), undefined);
  }
});
