// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    computeTradeDerived,
    computeFuturesRealizedPnLPerAction,
    getFuturesSetting,
    resolveTradeCurrency,
} = require('../modules/tradeCalculations.js');

const action = (type, dateTime, quantity, price, fee = 0) => ({ type, dateTime, quantity, price, fee });

const futuresSettings = [
    { symbol: 'DEFAULT', type: 'FUT', tick_size: 0.25, tick_value: 5, initial_margin: 1000, currency: 'USD' },
    { symbol: 'MNQ', type: 'FUT', tick_size: 0.25, tick_value: 0.5, initial_margin: 2000, currency: 'USD' },
    { symbol: 'XEON.DE', type: 'STK', tick_size: 0.01, tick_value: 0.01, currency: 'EUR' },
];

test('closed long stock trade: P&L, status, quantity and return %', () => {
    const d = computeTradeDerived({
        type: 'STK', symbol: 'AAPL', stop_loss: 95,
        actions: [
            action('BUY', '2026-01-05T15:00:00Z', 10, 100, 1),
            action('SELL', '2026-01-06T15:00:00Z', 10, 110, 1),
        ],
    }, futuresSettings);
    assert.equal(d.side, 'LONG');
    assert.equal(d.status, 'WIN');
    assert.equal(d.return, 98); // (1100 - 1000) - 2 in fees
    assert.equal(d.quantity, 10);
    assert.equal(d.hold_time_minutes, 24 * 60);
    assert.ok(Math.abs(d.return_percentage - 9.8) < 1e-9);
    assert.ok(Math.abs(d.r_multiple - 98 / 50) < 1e-9); // risk = (100 - 95) * 10
});

test('closed short futures trade uses the tick multiplier', () => {
    const d = computeTradeDerived({
        type: 'FUT', symbol: 'MNQZ5', tick_size: 0.25, tick_value: 0.5,
        actions: [
            action('SELL', '2026-01-05T15:00:00Z', 2, 20000),
            action('BUY', '2026-01-05T16:00:00Z', 2, 19990),
        ],
    }, futuresSettings);
    assert.equal(d.side, 'SHORT');
    assert.equal(d.status, 'WIN');
    assert.equal(d.return, 40); // 10 points * 2 contracts * $2/point
});

test('futures return % uses the root symbol margin for a contract-suffixed symbol', () => {
    // MNQZ5 must resolve to the MNQ row (margin 2000), not DEFAULT (1000) —
    // the frontend (TradeContext.js) resolves it the same way.
    const d = computeTradeDerived({
        type: 'FUT', symbol: 'MNQZ5', tick_size: 0.25, tick_value: 0.5,
        actions: [
            action('BUY', '2026-01-05T15:00:00Z', 1, 20000),
            action('SELL', '2026-01-05T16:00:00Z', 1, 20100),
        ],
    }, futuresSettings);
    assert.equal(d.return, 200);
    assert.equal(d.return_percentage, 10); // 200 / (2000 * 1 contract)
});

test('open trade reports position and no P&L', () => {
    const d = computeTradeDerived({
        type: 'STK', symbol: 'AAPL',
        actions: [
            action('BUY', '2026-01-05T15:00:00Z', 10, 100),
            action('SELL', '2026-01-06T15:00:00Z', 4, 105),
        ],
    }, futuresSettings);
    assert.equal(d.status, 'OPEN');
    assert.equal(d.position, 6);
    assert.equal(d.return, null);
    assert.equal(d.quantity, null);
});

test('closed trade at a zero price does not give a NaN quantity', () => {
    const d = computeTradeDerived({
        type: 'STK', symbol: 'X',
        actions: [
            action('BUY', '2026-01-05T15:00:00Z', 5, 0),
            action('SELL', '2026-01-06T15:00:00Z', 5, 0),
        ],
    }, futuresSettings);
    assert.equal(d.status, 'WASH');
    assert.equal(d.quantity, 5);
});

test('FIFO realised P&L per closing fill', () => {
    const realized = computeFuturesRealizedPnLPerAction('LONG', [
        action('BUY', null, 1, 100),
        action('BUY', null, 1, 110),
        action('SELL', null, 1, 120), // closes the 100 lot
        action('SELL', null, 1, 105), // closes the 110 lot
    ], 2);
    assert.equal(realized.get(2), 40);
    assert.equal(realized.get(3), -10);
    assert.equal(realized.has(0), false);
});

test('symbol settings resolution', () => {
    assert.equal(getFuturesSetting('MNQZ5', 'FUT', futuresSettings).symbol, 'MNQ');
    assert.equal(getFuturesSetting('ESZ5', 'FUT', futuresSettings).symbol, 'DEFAULT');
    assert.equal(resolveTradeCurrency('XEON.DE', 'STK', futuresSettings), 'EUR');
    assert.equal(resolveTradeCurrency('ESZ5', 'FUT', futuresSettings), null); // never from DEFAULT
});

test('settlement: one cash entry per fill, on its own date', () => {
  const { settlementEntries } = require('../modules/tradeCalculations.js');
  // A stock bought one day and sold a few days later: the purchase's cash
  // stays on the purchase day.
  const stock = settlementEntries('STK', [
    { type: 'SELL', quantity: 10, price: 99.9, fee: 1.78, dateTime: '2026-10-05T08:16:25Z' },
    { type: 'BUY', quantity: 10, price: 104, fee: 1.78, dateTime: '2026-09-24T13:41:22Z' },
  ]);
  assert.deepEqual(stock.map(e => [e.dateTime.slice(0, 10), Math.round(e.amount * 100) / 100]), [
    ['2026-09-24', -1041.78],
    ['2026-10-05', 997.22],
  ]);
  // A future: fees always, the realised P&L on the closing fill, never the
  // contract value; a fill without a fee leaves no entry.
  const future = settlementEntries('FUT', [
    { type: 'BUY', quantity: 1, price: 20000, fee: 0, dateTime: '2026-10-01T14:00:00Z' },
    { type: 'SELL', quantity: 1, price: 20010, fee: 1.24, dateTime: '2026-10-01T15:00:00Z' },
  ], 0.25, 0.5);
  assert.deepEqual(future.map(e => Math.round(e.amount * 100) / 100), [18.76]);
  const { settlementNote } = require('../modules/tradeCalculations.js');
  assert.equal(settlementNote('MNQ', future[0]), 'MNQ sell 1 @ 20010 · P&L +20.00 · fee 1.24');
  assert.equal(settlementNote('GDX.L', stock[0]), 'GDX.L buy 10 @ 104 · fee 1.78');
});
