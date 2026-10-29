// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'merged-series-'));
const db = require('../modules/database.js');
const { getMergedHistoricalSeries } = require('../modules/historical-data-service.js');

const row = (time, source, close) => ({ time: new Date(time), open: close, high: close, low: close, close, volume: 1, source });

async function merged(t, timeframe, rows) {
  t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows }) }));
  return (await getMergedHistoricalSeries({ futuresSettingId: 1, type: 'STK', timeframe })).map(b => `${b.time} ${b.source}`);
}

test('daily stock bars: Yahoo adds no second candle for IBKR\'s last day', async (t) => {
  // IBKR stamps a European day at local midnight, Yahoo at the open.
  const out = await merged(t, '1D', [
    row('2026-10-26T23:00:00Z', 'IBKR', 15.65), // 27 October
    row('2026-10-27T08:00:00Z', 'Yahoo', 15.65),
    row('2026-10-27T23:00:00Z', 'IBKR', 15.66), // 28 October
    row('2026-10-28T08:00:00Z', 'Yahoo', 15.66),
    row('2026-10-29T08:00:00Z', 'Yahoo', 15.67), // 29 October: only Yahoo has it
  ]);
  assert.deepEqual(out, [
    '2026-10-26T23:00:00.000Z IBKR',
    '2026-10-27T23:00:00.000Z IBKR',
    '2026-10-29T08:00:00.000Z Yahoo',
  ]);
});

test('intraday stock bars: Yahoo extends right after IBKR\'s last bar', async (t) => {
  const out = await merged(t, '5M', [
    row('2026-10-28T15:25:00Z', 'IBKR', 1),
    row('2026-10-28T15:25:00Z', 'Yahoo', 1),
    row('2026-10-28T15:30:00Z', 'Yahoo', 1),
  ]);
  assert.deepEqual(out, ['2026-10-28T15:25:00.000Z IBKR', '2026-10-28T15:30:00.000Z Yahoo']);
});
