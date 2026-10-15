// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

// src/utils is ES module code (the React app's); Node loads it by syntax.
const load = () => import('../src/utils/lots.js');
const fill = (type, dateTime, quantity, price, fee = 0) => ({ type, dateTime, quantity, price, fee });
const round = v => Math.round(v * 1e6) / 1e6;

test('plain long: partial closes realise FIFO, fees counted once', async () => {
  const { replayLots } = await load();
  const r = replayLots([
    fill('BUY', '2026-10-01T14:00:00Z', 2, 100, 2),
    fill('SELL', '2026-10-02T14:00:00Z', 1, 110, 1),
    fill('SELL', '2026-10-03T14:00:00Z', 1, 90, 1),
  ], 2);
  // (110-100)*2 - 1 - 1 + (90-100)*2 - 1 - 1
  assert.equal(round(r.realisedPnL), -4);
  assert.equal(r.openLots.length, 0);
  assert.equal(r.sign, 0);
});

test('a flip: what is left of the fill opens the other way', async () => {
  const { replayLots } = await load();
  const actions = [
    fill('BUY', '2026-10-01T14:00:00Z', 1, 100, 1),
    fill('SELL', '2026-10-02T14:00:00Z', 2, 110, 1), // closes the long, opens 1 short
  ];
  const open = replayLots(actions, 2);
  assert.equal(open.sign, -1);
  assert.deepEqual(open.openLots, [{ quantity: 1, price: 110, fee: 0.5, sign: -1 }]);
  assert.equal(round(open.realisedPnL), 20 - 1 - 0.5);
  assert.deepEqual(open.timeline.map(s => s.sign), [1, -1]);

  const closed = replayLots([...actions, fill('BUY', '2026-10-03T14:00:00Z', 1, 105, 1)], 2);
  // Same as the trade's total: (220 - 205) * 2 - 3 fees.
  assert.equal(round(closed.realisedPnL), 27);
  assert.equal(closed.sign, 0);
});

test('fills are taken in time order', async () => {
  const { replayLots } = await load();
  const r = replayLots([
    fill('SELL', '2026-10-02T14:00:00Z', 1, 110),
    fill('BUY', '2026-10-01T14:00:00Z', 1, 100),
  ], 1);
  assert.equal(r.realisedPnL, 10);
});

test('largest position held, across a flip', async () => {
  const { maxPosition } = await load();
  assert.equal(maxPosition([fill('BUY', null, 1, 0), fill('SELL', null, 4, 0), fill('BUY', null, 3, 0)]), 3);
  assert.equal(maxPosition([fill('SELL', null, 2, 0), fill('SELL', null, 1, 0), fill('BUY', null, 3, 0)]), 3);
});

test('quantity the open position was opened with, from its latest flip', async () => {
  const { openedInPosition } = await load();
  assert.equal(openedInPosition([fill('BUY', null, 2, 0), fill('SELL', null, 1, 0), fill('BUY', null, 1, 0)]), 3);
  assert.equal(openedInPosition([fill('BUY', null, 1, 0), fill('SELL', null, 2, 0)]), 1);
  assert.equal(openedInPosition([fill('BUY', null, 1, 0), fill('SELL', null, 3, 0), fill('BUY', null, 1, 0)]), 2);
});
