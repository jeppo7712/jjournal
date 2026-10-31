// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

// src/data is ES module code (the React app's); Node loads it by syntax.
const load = () => import('../src/data/marketReference.js');

// Open half-hour slots of one day as "HH:MM-HH:MM" ranges.
function ranges(day) {
  const out = [];
  let start = null;
  [...day, false].forEach((open, i) => {
    if (open && start === null) start = i;
    if (!open && start !== null) {
      const t = s => `${String(Math.floor(s / 2)).padStart(2, '0')}:${s % 2 ? '30' : '00'}`;
      out.push(`${t(start)}-${t(i)}`);
      start = null;
    }
  });
  return out;
}

test('CME Globex hours: Sunday 17:00 to Friday 16:00 Chicago time, break 16:00-17:00', async () => {
  const { findExchangePreset } = await load();
  for (const name of ['CME', 'NYMEX', 'COMEX', 'GLOBEX']) {
    const preset = findExchangePreset(name);
    assert.equal(preset.timezone, 'America/Chicago', name);
    const [mon, , , thu, fri, sat, sun] = preset.opening_hours;
    assert.deepEqual(ranges(mon), ['00:00-16:00', '17:00-24:00'], name);
    assert.deepEqual(ranges(thu), ['00:00-16:00', '17:00-24:00'], name);
    assert.deepEqual(ranges(fri), ['00:00-16:00'], name);
    assert.deepEqual(ranges(sat), [], name);
    assert.deepEqual(ranges(sun), ['17:00-24:00'], name);
  }
  assert.equal(findExchangePreset('CBOT'), null, 'grains trade other hours');
});

test('stock exchange hours', async () => {
  const { findExchangePreset } = await load();
  const mon = name => ranges(findExchangePreset(name).opening_hours[0]);
  assert.deepEqual(mon('NYSE'), ['09:30-16:00']);
  assert.deepEqual(mon('LSE'), ['08:00-16:30']);
  assert.deepEqual(mon('SBF'), ['09:00-17:30']);
  assert.deepEqual(mon('XETRA'), ['09:00-17:30']);
  assert.deepEqual(ranges(findExchangePreset('LSE').opening_hours[5]), []);
  assert.deepEqual(ranges(findExchangePreset('BYBIT').opening_hours[6]), ['00:00-24:00']);
});

test('matchesExchangePreset compares timezone and every slot', async () => {
  const { findExchangePreset, matchesExchangePreset } = await load();
  const preset = findExchangePreset('CME');
  const stored = { timezone: 'America/Chicago', opening_hours: preset.opening_hours.map(d => [...d]) };
  assert.equal(matchesExchangePreset(stored, preset), true);
  stored.opening_hours[4][33] = true; // Friday 16:30-17:00 open
  assert.equal(matchesExchangePreset(stored, preset), false);
  assert.equal(matchesExchangePreset({ ...stored, opening_hours: preset.opening_hours, timezone: 'America/New_York' }, preset), false);
  assert.equal(matchesExchangePreset({ timezone: 'America/Chicago', opening_hours: null }, preset), false);
});
