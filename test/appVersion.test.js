// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/utils/appVersion.js');

test('nextQuoteIndex: any quote first, then never the same one twice', async () => {
  const { nextQuoteIndex, QUOTES } = await load();
  const n = QUOTES.length;
  assert.equal(nextQuoteIndex(-1, () => 0), 0);
  assert.equal(nextQuoteIndex(-1, () => 0.9999), n - 1);
  for (let cur = 0; cur < n; cur += 1) {
    for (const r of [0, 0.5, 0.9999]) {
      const next = nextQuoteIndex(cur, () => r);
      assert.notEqual(next, cur);
      assert.ok(next >= 0 && next < n);
    }
  }
});

test('builtLabel: day/month/year and time, empty when unknown', async () => {
  const { builtLabel } = await load();
  assert.match(builtLabel('2026-11-16T10:20:00.000Z'), /^\d\d\/11\/2026, \d\d:\d\d$/);
  assert.equal(builtLabel(''), '');
  assert.equal(builtLabel('not a date'), '');
});
