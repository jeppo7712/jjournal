// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'ibkr-recency-'));
const { DateTime } = require('luxon');
const { ibkrRecencyNeeded } = require('../modules/historical-data-service.js');

const zone = 'America/Chicago';
const at = iso => DateTime.fromISO(iso, { zone });

test('market closed for the weekend: nothing to fetch once the last bars are stored', () => {
  const now = at('2026-10-31T01:23');           // Saturday night
  const lastTrading = at('2026-10-30T15:53');   // in the last open slot, Friday
  assert.equal(ibkrRecencyNeeded(at('2026-10-30T15:59'), now, lastTrading, '1M'), false);
  assert.equal(ibkrRecencyNeeded(at('2026-10-30T15:00'), now, lastTrading, '1H'), false);
  assert.equal(ibkrRecencyNeeded(at('2026-10-30T00:00'), now, lastTrading, '1D'), false);
  assert.equal(ibkrRecencyNeeded(at('2026-10-30T13:00'), now, lastTrading, '4H'), false);
});

test('market closed, but the last session\'s bars are missing: fetch', () => {
  const now = at('2026-10-31T01:23');
  const lastTrading = at('2026-10-30T15:53');
  assert.equal(ibkrRecencyNeeded(at('2026-10-30T11:00'), now, lastTrading, '1M'), true);
  assert.equal(ibkrRecencyNeeded(at('2026-10-29T00:00'), now, lastTrading, '1D'), true);
});

test('market open: fetch whenever a finished bar may be missing (IBKR is behind)', () => {
  const now = at('2026-11-02T10:00');
  assert.equal(ibkrRecencyNeeded(at('2026-11-02T09:50'), now, now, '1M'), true);
  assert.equal(ibkrRecencyNeeded(at('2026-11-02T09:59'), now, now, '1M'), false);
});

test('no usable completion time: compare with the upper bound, as before', () => {
  const now = at('2026-10-31T01:23');
  assert.equal(ibkrRecencyNeeded(at('2026-10-30T15:59'), now, null, '1M'), true);
  assert.equal(ibkrRecencyNeeded(at('2026-10-30T15:59'), now, DateTime.invalid('x'), '1M'), true);
});

test('an expiring contract: its end bounds the target too', () => {
  const end = at('2026-10-30T16:00');
  assert.equal(ibkrRecencyNeeded(at('2026-10-30T15:59'), end, at('2026-11-02T10:00'), '1M'), true);
  assert.equal(ibkrRecencyNeeded(at('2026-10-30T16:00'), end, at('2026-11-02T10:00'), '1M'), false);
});

test('the last trading moment of a closed market is its close', async (t) => {
  const db = require('../modules/database.js');
  const { getLastTradingDay } = require('../modules/historical-data-service.js');
  // CME: Sunday 17:00 to Friday 16:00 CT, break 16:00-17:00 (as in marketReference.js).
  const slot = (from, to) => Array.from({ length: 48 }, (_, i) => i >= from && i < to);
  const both = (a, b) => a.map((v, i) => v || b[i]);
  const weekday = both(slot(0, 32), slot(34, 48));
  const hours = [weekday, weekday, weekday, weekday, slot(0, 32), slot(0, 0), slot(34, 48)];
  t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows: [{ opening_hours: hours }] }) }));
  const last = async iso => (await getLastTradingDay(new Date(at(iso).toMillis()), 'CME', zone)).toISO({ suppressMilliseconds: true, includeOffset: false });
  assert.equal(await last('2026-10-31T01:23'), '2026-10-30T16:00:00');  // Saturday night: Friday's close
  assert.equal(await last('2026-10-30T16:05'), '2026-10-30T16:00:00');  // right after Friday's close
  assert.equal(await last('2026-10-29T16:40'), '2026-10-29T16:00:00');  // in the daily break
  assert.equal(await last('2026-10-29T10:17'), '2026-10-29T10:17:00');  // open: now
});
