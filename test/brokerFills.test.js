// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// The modules log through modules/logger.js, which writes next to USER_PATH.
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-fills-'));
const { parseFills, flexTime } = require('../modules/brokerFills.js');

// Made-up accounts and values, shaped like IBKR's Flex XML attributes.
const tradeConfirm = (over) => ({
  currency: 'USD', symbol: 'MESZ6', listingExchange: 'CME', execID: 'tc-1',
  dateTime: '20261014;101530', tradeDate: '20261014', buySell: 'BUY', quantity: '2', price: '6000.25', commission: '-1.24', ...over,
});

test('Flex times are US/Eastern', () => {
  assert.equal(flexTime('20261014;101530'), '2026-10-14T14:15:30.000Z'); // EDT
  assert.equal(flexTime('20261210;101530'), '2026-12-10T15:15:30.000Z'); // EST
  assert.equal(flexTime('2026101'), null);
});

test('a Trade Confirmation row without asset type: a known futures root makes it a future', () => {
  const [fill] = parseFills([{ accountId: 'DU1000002', TradeConfirms: { TradeConfirm: tradeConfirm() } }], new Set(['MES']));
  assert.deepEqual(fill, {
    execId: 'tc-1', brokerAccountId: 'DU1000002', type: 'FUT', symbol: 'MES', rawSymbol: 'MESZ6', contractMonth: '202612',
    side: 'BUY', quantity: 2, price: 6000.25, commission: 1.24, commissionCurrency: null, currency: 'USD', exchange: 'CME', dateTime: '2026-10-14T14:15:30.000Z',
  });
  // Unknown root: taken as a stock symbol as it stands.
  const [stock] = parseFills([{ accountId: 'DU1000002', TradeConfirms: { TradeConfirm: tradeConfirm({ symbol: 'ABCZ6' }) } }], new Set(['MES']));
  assert.equal(stock.type, 'STK');
  assert.equal(stock.symbol, 'ABCZ6');
});

test('Activity rows: one per execution, other asset types and summaries left out', () => {
  const statement = {
    accountId: 'U1000001',
    Trades: { Trade: [
      { assetCategory: 'STK', symbol: 'ABC', underlyingSymbol: 'ABC', ibExecID: 'af-1', levelOfDetail: 'EXECUTION', dateTime: '20261009;101500',
        buySell: 'SELL', quantity: '-10', tradePrice: '12.5', ibCommission: '-1', currency: 'EUR', listingExchange: 'AEB' },
      { assetCategory: 'CASH', symbol: 'EUR.USD', ibExecID: 'af-2', levelOfDetail: 'EXECUTION', dateTime: '20261009;101600', buySell: 'BUY', quantity: '100', tradePrice: '1.1' },
      { assetCategory: 'STK', symbol: 'ABC', ibExecID: '', levelOfDetail: 'ORDER', dateTime: '20261009;101500', buySell: 'SELL', quantity: '-10', tradePrice: '12.5' },
    ] },
    // The same fill in today's Trade Confirmation too.
    TradeConfirms: { TradeConfirm: tradeConfirm({ execID: 'af-1', symbol: 'ABC', assetCategory: 'STK' }) },
  };
  const fills = parseFills([statement]);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].side, 'SELL');
  assert.equal(fills[0].quantity, 10);
  assert.equal(fills[0].contractMonth, null);
});

test('a query without the commission field gives an unknown fee, not a zero one', () => {
  const row = tradeConfirm();
  delete row.commission;
  const [fill] = parseFills([{ accountId: 'DU1000002', TradeConfirms: { TradeConfirm: row } }], new Set(['MES']));
  assert.equal(fill.commission, null);
  const [free] = parseFills([{ accountId: 'DU1000002', TradeConfirms: { TradeConfirm: tradeConfirm({ commission: '0' }) } }], new Set(['MES']));
  assert.equal(free.commission, 0);
});
