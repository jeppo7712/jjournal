// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

// src/utils is ES module code (the React app's); Node loads it by syntax.
const load = () => import('../src/utils/unrealisedSeries.js');

const day = (offset) => DateTime.now().startOf('day').plus({ days: offset });
const iso = (offset) => day(offset).toISODate();
const at = (offset) => day(offset).set({ hour: 15 }).toISO();

test('open long position: valued at each day\'s close, last close carried, fees subtracted', async () => {
  const { computeUnrealisedSeries } = await load();
  const trades = [{
    symbol: 'AAPL', type: 'STK', side: 'LONG', status: 'OPEN', currency: 'USD',
    firstActionDate: at(-3),
    actions: [{ type: 'BUY', dateTime: at(-3), quantity: 10, price: 100, fee: 1 }],
  }];
  const closes = { AAPL: new Map([[iso(-3), 101], [iso(-2), 103], [iso(0), 99]]) };
  const { labels, seriesByCurrency } = computeUnrealisedSeries(trades, closes);
  assert.equal(labels.length, 4);
  // -3: 101 → +10 - 1 fee; -2: 103 → +29; -1: no close, carries 103; 0: 99 → -11
  assert.deepEqual(seriesByCurrency.USD.map(v => Math.round(v * 100) / 100), [9, 29, 29, -11]);
});

test('a closed trade only counts while it was open; currencies stay apart', async () => {
  const { computeUnrealisedSeries } = await load();
  const trades = [
    {
      symbol: 'MNQ', type: 'FUT', side: 'SHORT', status: 'WIN', currency: 'USD', tick_size: 0.25, tick_value: 0.5,
      firstActionDate: at(-4),
      actions: [
        { type: 'SELL', dateTime: at(-4), quantity: 2, price: 20000, fee: 0 },
        { type: 'BUY', dateTime: at(-2), quantity: 2, price: 19900, fee: 0 },
      ],
    },
    {
      symbol: 'SAP.DE', type: 'STK', side: 'LONG', status: 'OPEN', currency: 'EUR',
      firstActionDate: at(-1),
      actions: [{ type: 'BUY', dateTime: at(-1), quantity: 5, price: 200, fee: 0 }],
    },
  ];
  const closes = {
    MNQ: new Map([[iso(-4), 19990], [iso(-3), 19950], [iso(-2), 19900]]),
    'SAP.DE': new Map([[iso(-1), 202], [iso(0), 204]]),
  };
  const { seriesByCurrency } = computeUnrealisedSeries(trades, closes);
  // Short 2 MNQ ($2 a point): -4: +10 pts → $40; -3: +50 pts → $200; closed from -2 on.
  assert.deepEqual(seriesByCurrency.USD, [40, 200, 0, 0, 0]);
  assert.deepEqual(seriesByCurrency.EUR, [0, 0, 0, 10, 20]);
});

test('date range: the first day falls back to the last close before it', async () => {
  const { computeUnrealisedSeries } = await load();
  const trades = [{
    symbol: 'AAPL', type: 'STK', side: 'LONG', status: 'OPEN', currency: 'USD',
    firstActionDate: at(-10),
    actions: [{ type: 'BUY', dateTime: at(-10), quantity: 1, price: 100, fee: 0 }],
  }];
  const closes = { AAPL: new Map([[iso(-10), 100], [iso(-6), 120], [iso(-3), 130]]) };
  const { labels, seriesByCurrency } = computeUnrealisedSeries(trades, closes, { startDate: iso(-5), endDate: iso(-3) });
  assert.equal(labels.length, 3);
  assert.deepEqual(seriesByCurrency.USD, [20, 20, 30]);
});
