// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// The modules log through modules/logger.js, which writes next to USER_PATH.
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'position-groups-'));
const { groupByPosition } = require('../modules/positionGroups.js');

// Made-up fills, shaped like the import's executions.
let n = 0;
const fill = (time, side, quantity, contractMonth) => ({
  execId: `x${++n}`, time, side, quantity, price: 100, commission: 1, contractMonth,
});
const summary = groups => groups.map(g => [
  g.direction, g.result,
  [...g.entryExecutions, ...g.tpExecutions].map(e => `${e.side} ${e.time}`).sort().join(', '),
]);

test('each contract month is a position of its own', () => {
  const groups = groupByPosition([
    // The history starts with the close of a short opened before it.
    fill('20260601 10:00:00', 'BOT', 1, '202606'),
    fill('20260602 10:00:00', 'SLD', 1, '202606'),
    fill('20260602 10:05:00', 'BOT', 1, '202606'),
    // A later contract: flat trades, but off by one if counted with the one before.
    fill('20260915 10:00:00', 'SLD', 1, '202609'),
    fill('20260915 10:05:00', 'BOT', 1, '202609'),
    fill('20260916 10:00:00', 'BOT', 1, '202609'),
    fill('20260916 10:05:00', 'SLD', 1, '202609'),
  ]);
  // Within its own contract that missing fill still can't be told apart...
  assert.deepEqual(summary(groups), [
    ['LONG', 'CLOSED', 'BOT 20260601 10:00:00, SLD 20260602 10:00:00'],
    ['LONG', 'OPEN', 'BOT 20260602 10:05:00'],
    // ...but the next contract's trades are right.
    ['SHORT', 'CLOSED', 'BOT 20260915 10:05:00, SLD 20260915 10:00:00'],
    ['LONG', 'CLOSED', 'BOT 20260916 10:00:00, SLD 20260916 10:05:00'],
  ]);
});

test('positions in two contracts at once stay apart, ordered by first fill', () => {
  const groups = groupByPosition([
    fill('20260610 10:00:00', 'BOT', 1, '202606'),
    fill('20260610 10:01:00', 'SLD', 1, '202609'),
    fill('20260610 10:02:00', 'SLD', 1, '202606'),
    fill('20260610 10:03:00', 'BOT', 1, '202609'),
  ]);
  assert.deepEqual(summary(groups), [
    ['LONG', 'CLOSED', 'BOT 20260610 10:00:00, SLD 20260610 10:02:00'],
    ['SHORT', 'CLOSED', 'BOT 20260610 10:03:00, SLD 20260610 10:01:00'],
  ]);
});

test('a fill that flips the position is split within its contract', () => {
  const groups = groupByPosition([
    fill('20261001 10:00:00', 'BOT', 1, '202612'),
    fill('20261001 10:05:00', 'SLD', 3, '202612'),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => [g.direction, g.result]), [['LONG', 'CLOSED'], ['SHORT', 'OPEN']]);
  assert.equal(groups[0].tpExecutions[0].quantity, 1);
  assert.equal(groups[1].entryExecutions[0].quantity, 2);
  assert.equal(groups[1].entryExecutions[0].execId, `${groups[0].tpExecutions[0].execId}.flip`);
});

test('stock fills (no contract month) are one position', () => {
  const groups = groupByPosition([
    fill('20261001 10:00:00', 'BOT', 10, null),
    fill('20261002 10:00:00', 'SLD', 10, undefined),
  ]);
  assert.deepEqual(summary(groups), [['LONG', 'CLOSED', 'BOT 20261001 10:00:00, SLD 20261002 10:00:00']]);
});
