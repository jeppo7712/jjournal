// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-backfill-limit-'));
const { DateTime } = require('luxon');
const { EventName } = require('@stoqey/ib');
const ibkr = require('../modules/ibkr-conn.js').data;
const { _fetchAndStoreIBKRContractDataWithClient: fetchContract } = require('../modules/historical-data-service.js');

const zone = 'America/Chicago';
const at = iso => DateTime.fromISO(iso, { zone });

// IBKR answering from a fixed set of 1-minute bars: every bar in
// (end - duration, end]. Counts the requests.
function fakeIbkr(t, barTimes) {
  const api = new EventEmitter();
  api.requests = [];
  api.cancelHistoricalData = () => {};
  api.reqHistoricalData = (id, contract, endDateTime, duration) => {
    const end = DateTime.fromFormat(endDateTime, 'yyyyMMdd-HH:mm:ss', { zone: 'utc' });
    const [n, unit] = duration.split(' ');
    const start = end.minus({ [{ D: 'days', W: 'weeks', M: 'months', Y: 'years' }[unit]]: Number(n) });
    api.requests.push(`${start.setZone(zone).toISODate()}..${end.setZone(zone).toISODate()}`);
    setImmediate(() => {
      for (const time of barTimes) {
        if (time > start && time <= end) api.emit(EventName.historicalData, id, time.setZone(zone).toFormat('yyyyMMdd HH:mm:ss'), 1, 1, 1, 1, 1);
      }
      api.emit(EventName.historicalDataEnd, id);
    });
  };
  t.mock.method(ibkr, 'getIbApi', () => api);
  t.mock.method(ibkr, 'isIbkrConnected', () => true);
  return api;
}

// The queries the fetch makes, against one contract's stored bars and limit.
function fakeDb(storedTimes, bound = null) {
  const state = { stored: storedTimes.map(d => d.toMillis()), bound };
  state.query = async (sql, params) => {
    if (/FROM historical_data_bounds/.test(sql) && /^\s*SELECT/.test(sql)) {
      return { rows: state.bound ? [{ earliest_available: new Date(state.bound.earliest), checked_at: new Date(state.bound.checked) }] : [] };
    }
    if (/INSERT INTO historical_data_bounds/.test(sql)) {
      state.bound = { earliest: Date.parse(params[3]), checked: Date.now() };
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM historical_data_bounds/.test(sql)) { state.bound = null; return { rows: [], rowCount: 1 }; }
    if (/SELECT min\(time\) AS oldest/.test(sql)) {
      const times = state.stored;
      return { rows: [{ oldest: times.length ? new Date(Math.min(...times)) : null, latest: times.length ? new Date(Math.max(...times)) : null }] };
    }
    if (/INSERT INTO historical_data /.test(sql)) {
      for (const time of params[2]) { const ms = Date.parse(time); if (!state.stored.includes(ms)) state.stored.push(ms); }
      return { rows: [], rowCount: params[2].length };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return state;
}

// An expired contract (no recency fetch), so only the backfill is asked.
const contract = { symbol: 'ES', secType: 'FUT', conId: 1, lastTradeDateOrContractMonth: '20250919', exchange: 'CME' };
const run = db => fetchContract(db, 1, contract, '1M', zone, null, () => {}, 'test', null, { years: 100 }, false);

test('the stretch between a recorded limit and the oldest bar is asked once, not on every run', async (t) => {
  const oldest = at('2025-01-07T10:27');
  const db = fakeDb([oldest], { earliest: at('2025-01-06T09:19').toMillis(), checked: Date.now() });
  const api = fakeIbkr(t, [oldest]);
  await run(db);
  assert.equal(api.requests.length, 1);
  assert.equal(db.bound.earliest, oldest.toMillis());
  await run(db);
  assert.equal(api.requests.length, 1, 'second run asks nothing');
});

test('a contract\'s first days, shorter than two chunks, are asked once', async (t) => {
  // The contract's window starts 15 months before its month: 2024-06-01.
  const oldest = at('2024-06-03T07:25');
  const db = fakeDb([oldest]);
  const api = fakeIbkr(t, [oldest]);
  await run(db);
  assert.equal(api.requests.length, 1);
  assert.equal(db.bound.earliest, oldest.toMillis());
  await run(db);
  assert.equal(api.requests.length, 1, 'second run asks nothing');
});

test('one empty week in the middle of the history does not end the backfill', async (t) => {
  // Weekly chunks back from 07-01 08:00; 06-10..06-17 is empty.
  const bars = [at('2024-06-04T08:00'), at('2024-06-09T08:00'), at('2024-06-18T08:00'), at('2024-06-25T08:00')];
  const oldest = at('2024-07-01T08:00');
  const db = fakeDb([oldest]);
  fakeIbkr(t, [...bars, oldest]);
  await run(db);
  assert.ok(db.stored.includes(at('2024-06-04T08:00').toMillis()), 'bars before the empty week stored');
  // 06-01..06-03 08:00, the window's last chunk, is empty: the limit.
  assert.equal(db.bound.earliest, at('2024-06-03T08:00').toMillis());
});
