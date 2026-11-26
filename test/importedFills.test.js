// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

// src/utils is ES module code (the React app's); Node loads it by syntax.
const load = () => import('../src/utils/importedFills.js');

// Made-up trades.
const trades = [
  { symbol: 'MNQ', actions: [
    { type: 'BUY', quantity: 1, price: 20000.25, date_time: '2026-07-01T14:00:00+00:00', execId: null },
    { type: 'SELL', quantity: 1, price: 20010, date_time: '2026-07-01T14:05:00+00:00', execId: 'x1' },
  ] },
  { symbol: 'ABC.DE', actions: [{ type: 'BUY', quantity: 10, price: 50, date_time: '2026-07-02T08:00:00+00:00' }] },
  { symbol: 'MES', actions: [{ type: 'BUY', quantity: 1, price: 20000.25, date_time: '2026-07-01T14:00:00+00:00' }] },
];
const at = iso => Date.parse(iso);

test('handEnteredActions: the symbol\'s fills without an execution ID', async () => {
  const { handEnteredActions } = await load();
  assert.deepEqual(handEnteredActions(trades, 'mnq').map(a => a.price), [20000.25]);
  assert.deepEqual(handEnteredActions(trades, 'ABC').map(a => a.price), [50]);
  assert.deepEqual(handEnteredActions(null, 'MNQ'), []);
});

test('isHandEntered: same side, quantity and price within 90 seconds', async () => {
  const { handEnteredActions, isHandEntered } = await load();
  const actions = handEnteredActions(trades, 'MNQ');
  const fill = { action: 'BUY', quantity: 1, price: 20000.25, time: at('2026-07-01T14:01:00Z') };
  assert.equal(isHandEntered(actions, fill), true);
  assert.equal(isHandEntered(actions, { ...fill, time: at('2026-07-01T14:01:31Z') }), false);
  assert.equal(isHandEntered(actions, { ...fill, action: 'SELL' }), false);
  assert.equal(isHandEntered(actions, { ...fill, quantity: 2 }), false);
  assert.equal(isHandEntered(actions, { ...fill, price: 20000.5 }), false);
});
