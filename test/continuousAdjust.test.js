// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'continuous-adjust-'));
const { adjustContinuousBars } = require('../modules/historical-data-service.js');

const bar = (time, close) => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 1 });
// September contract until the roll, December from it; the gap is 295.25.
const bars = [bar('2026-09-14T22:58:00.000Z', 29164.75), bar('2026-09-14T22:59:00.000Z', 29163), bar('2026-09-14T23:00:00.000Z', 29458.25)];
const rolls = [{ time: '2026-09-14T23:00:00.000Z', from: '202609', to: '202612', gap: 295.25, ratio: 29458.25 / 29163 }];

test('none: bars as stored', () => {
  assert.deepEqual(adjustContinuousBars(bars, rolls, 'none'), bars);
});

test('back: bars before a roll move by its gap, the latest contract stays', () => {
  const out = adjustContinuousBars(bars, rolls, 'back');
  assert.deepEqual(out.map(b => b.close), [29460, 29458.25, 29458.25]);
  assert.equal(out[0].high, 29461);
  assert.equal(out[2], bars[2]);
});

test('ratio: bars before a roll scale by its ratio', () => {
  const out = adjustContinuousBars(bars, rolls, 'ratio');
  assert.equal(out[1].close, 29458.25);
  assert.ok(Math.abs(out[0].close / out[1].close - 29164.75 / 29163) < 1e-9);
});

test('back: two rolls add up for the oldest bars', () => {
  const two = [{ ...rolls[0], time: '2026-06-14T23:00:00.000Z', gap: 100 }, rolls[0]];
  assert.deepEqual(adjustContinuousBars([bar('2026-06-01T00:00:00.000Z', 1000)], two, 'back').map(b => b.close), [1395.25]);
});
