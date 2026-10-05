// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCashType, parseCashItems, matchItems, flexDate, parseCashReport, compareBalances } = require('../modules/brokerCash.js');
const { checkFlexQuery } = require('../modules/flexCheck.js');

// Rows shaped like IBKR's Flex XML attributes (made-up account and values).
const cashRow = (over) => ({
  accountId: 'U1000001', currency: 'USD', symbol: '', description: '', dateTime: '20260910',
  amount: '0', type: 'Other Fees', transactionID: '', actionID: '', exDate: '', levelOfDetail: 'DETAIL', ...over,
});
const statement = (rows, over = {}) => ({
  accountId: 'U1000001', fromDate: '20251010', toDate: '20261009',
  CashTransactions: { CashTransaction: rows }, ...over,
});

test('classifies IBKR cash types, deposits and withdrawals by sign', () => {
  assert.equal(classifyCashType('Deposits/Withdrawals', 500), 'DEPOSIT');
  assert.equal(classifyCashType('Deposits/Withdrawals', -500), 'WITHDRAWAL');
  assert.equal(classifyCashType('Dividends', 3), 'DIVIDEND');
  assert.equal(classifyCashType('Payment In Lieu Of Dividends', -3), 'PAYMENT_IN_LIEU');
  assert.equal(classifyCashType('Withholding Tax', -1), 'WITHHOLDING_TAX');
  assert.equal(classifyCashType('Broker Interest Received', 2), 'INTEREST');
  assert.equal(classifyCashType('Other Fees', -10), 'FEE');
  assert.equal(classifyCashType('Price Adjustments', 1), 'OTHER');
});

test('reads dates in yyyyMMdd with or without a time, rejects other orders', () => {
  assert.equal(flexDate('20260918'), '2026-09-18');
  assert.equal(flexDate('20260303;172558'), '2026-03-03');
  assert.equal(flexDate('2026-09-18, 17:25:58'), '2026-09-18');
  assert.equal(flexDate('09/18/2026'), null);
});

test('parses detail rows and skips summary rows without a transaction ID', () => {
  const items = parseCashItems([statement([
    cashRow({ type: 'Dividends', symbol: 'abc', amount: '12.5', transactionID: '11', actionID: '900', exDate: '20260901', dateTime: '20260915' }),
    cashRow({ type: 'Withholding Tax', symbol: 'ABC', amount: '-1.88', transactionID: '12', actionID: '900', dateTime: '20260915' }),
    cashRow({ type: 'Other Fees', amount: '-10', levelOfDetail: 'SUMMARY' }),
  ])]);
  assert.equal(items.length, 2);
  assert.deepEqual(
    { ...items[0], description: undefined },
    { brokerAccountId: 'U1000001', externalId: '11', brokerType: 'Dividends', kind: 'DIVIDEND', date: '2026-09-15', currency: 'USD',
      amount: 12.5, symbol: 'ABC', description: undefined, actionId: '900', exDate: '2026-09-01' }
  );
  assert.equal(items[1].kind, 'WITHHOLDING_TAX');
});

const item = (id, kind, date, amount, over = {}) => ({ id, kind, date, amount, currency: 'EUR', symbol: null, actionId: null, ...over });
const row = (id, type, date, amount, over = {}) => ({ id, type, date, amount, currency: 'EUR', ...over });

test('deposits: one-to-one, several broker rows against one entry, one against several', () => {
  const items = [
    item(1, 'DEPOSIT', '2026-09-18', 50000), item(2, 'DEPOSIT', '2026-09-18', 50000), // entered as one 100000
    item(3, 'DEPOSIT', '2026-09-21', 110000), item(4, 'DEPOSIT', '2026-09-21', 100000), // entered one by one
    item(5, 'DEPOSIT', '2026-09-23', 240000), // entered as two
    item(6, 'DEPOSIT', '2026-09-24', 83000), // not entered at all
  ];
  const rows = [
    row(10, 'DEPOSIT', '2026-09-18', 100000),
    row(11, 'DEPOSIT', '2026-09-21', 100000), row(12, 'DEPOSIT', '2026-09-21', 110000),
    row(13, 'DEPOSIT', '2026-09-23', 140000), row(14, 'DEPOSIT', '2026-09-23', 100000),
  ];
  const matches = matchItems(items, rows);
  const find = id => matches.find(m => m.itemIds.includes(id));
  assert.deepEqual(find(1), { itemIds: [1, 2], rowIds: [10], dividendId: null });
  assert.deepEqual(find(3).rowIds, [12]);
  assert.deepEqual(find(4).rowIds, [11]);
  assert.deepEqual(find(5).rowIds.sort(), [13, 14]);
  assert.equal(find(6), undefined);
});

test('never matches across currency, sign or more than three days apart', () => {
  const matches = matchItems(
    [item(1, 'DEPOSIT', '2026-09-18', 500), item(2, 'WITHDRAWAL', '2026-09-18', -500), item(3, 'DEPOSIT', '2026-09-10', 700)],
    [row(10, 'DEPOSIT', '2026-09-18', 500, { currency: 'USD' }), row(11, 'DEPOSIT', '2026-09-18', 500, { id: 11 }), row(12, 'DEPOSIT', '2026-09-14', 700)]
  );
  assert.deepEqual(matches, [{ itemIds: [1], rowIds: [11], dividendId: null }]);
});

test('a fee matches a hand-entered fee of the same amount, nearest date first', () => {
  const matches = matchItems(
    [item(1, 'FEE', '2026-10-02', -10, { currency: 'USD' })],
    [row(10, 'OTHER', '2026-09-30', -10, { currency: 'USD' }), row(11, 'FEE', '2026-10-02', -10, { currency: 'USD' }), row(12, 'DEPOSIT', '2026-10-02', -10, { currency: 'USD' })]
  );
  assert.deepEqual(matches, [{ itemIds: [1], rowIds: [11], dividendId: null }]);
});

test('a hand-entered dividend covers the broker dividend and its tax', () => {
  const items = [
    item(1, 'DIVIDEND', '2026-09-15', 12.5, { currency: 'USD', symbol: 'ABC', actionId: '900' }),
    item(2, 'WITHHOLDING_TAX', '2026-09-15', -1.88, { currency: 'USD', symbol: 'ABC', actionId: '900' }),
    item(3, 'DIVIDEND', '2026-09-15', 4, { currency: 'EUR', symbol: 'XYZ', actionId: '901' }),
  ];
  const dividends = [
    { id: 70, symbol: 'ABC', currency: 'USD', payDate: '2026-09-16', gross: 12.5 },
    { id: 71, symbol: 'XYZ.DE', currency: 'EUR', payDate: '2026-09-15', gross: 4.01 },
  ];
  assert.deepEqual(matchItems(items, [], dividends), [{ itemIds: [1, 2], rowIds: [], dividendId: 70 }]);
});

// --- Flex query check ---

const statusOf = (checks, label) => checks.find(c => c.label === label)?.status;

test('query check: a complete Activity query passes', () => {
  const trade = Object.fromEntries(['accountId', 'assetCategory', 'symbol', 'underlyingSymbol', 'currency', 'listingExchange', 'expiry',
    'dateTime', 'buySell', 'quantity', 'tradePrice', 'ibCommission', 'ibExecID', 'ibOrderID'].map(f => [f, 'x']));
  trade.dateTime = '20260910;101500';
  trade.levelOfDetail = 'EXECUTION';
  const checks = checkFlexQuery({
    type: 'AF',
    statements: [statement([cashRow({ transactionID: '1', amount: '-10' })], {
      Trades: { Trade: [trade] }, CashReport: { CashReportCurrency: { accountId: 'U1000001', currency: 'USD', endingCash: '1', toDate: '20261009' } },
      OpenDividendAccruals: '',
    })],
  }, 'activity', { kind: 'real', accounts: [{ name: 'Main', broker_account_id: 'U1000001' }] });
  assert.deepEqual(checks.filter(c => c.status !== 'ok').map(c => c.label), ['Open Dividend Accruals']);
  assert.equal(statusOf(checks, 'Open Dividend Accruals'), 'info');
});

test('query check: a missing extra field is a warning, a missing essential one a failure', () => {
  const trade = { symbol: 'X', dateTime: '20260910', buySell: 'BUY', quantity: '1', tradePrice: '1', ibCommission: '0', ibExecID: '1' };
  const warn = checkFlexQuery({ type: 'AF', statements: [statement([], { Trades: { Trade: trade } })] }, 'activity', { kind: 'real' });
  assert.equal(statusOf(warn, 'Trades'), 'warn');
  const { ibExecID, ...noExec } = trade;
  const fail = checkFlexQuery({ type: 'AF', statements: [statement([], { Trades: { Trade: noExec } })] }, 'activity', { kind: 'real' });
  assert.equal(statusOf(fail, 'Trades'), 'missing');
});

test('query check: says what is missing and how to fix it', () => {
  const checks = checkFlexQuery({
    type: 'AF',
    statements: [statement([cashRow({ transactionID: '1', amount: '-10', levelOfDetail: 'SUMMARY' })], { fromDate: '20260901', toDate: '20261009' })],
  }, 'activity', { kind: 'real', accounts: [] });
  assert.equal(statusOf(checks, 'Trades'), 'missing');
  assert.equal(statusOf(checks, 'Cash Report'), 'warn');
  assert.equal(statusOf(checks, 'Cash Transactions'), 'missing'); // summary, not detail
  assert.equal(statusOf(checks, 'Period'), 'warn');
  assert.equal(statusOf(checks, 'Account U1000001'), 'warn'); // not linked to a journal account
  assert.ok(checks.every(c => c.status === 'ok' || c.status === 'info' || c.fix));
});

test('query check: wrong query type, paper account in the real set, alias instead of ID', () => {
  assert.equal(checkFlexQuery({ type: 'TCF', statements: [] }, 'activity', { kind: 'real' })[0].label, 'Query type');
  const paper = checkFlexQuery({ type: 'AF', statements: [statement([], { accountId: 'DU1000002' })] }, 'activity', { kind: 'real' });
  assert.equal(statusOf(paper, 'Account DU1000002'), 'missing');
  const alias = checkFlexQuery({ type: 'AF', statements: [statement([], { accountId: 'My main account' })] }, 'activity', { kind: 'real' });
  assert.equal(statusOf(alias, 'Account "My main account"'), 'missing');
  const quiet = checkFlexQuery({ type: 'AF', statements: [statement([]), statement([], { accountId: 'U1000001F', CashTransactions: '', CashReport: { CashReportCurrency: { accountId: 'U1000001F', currency: 'BASE_SUMMARY', endingCash: '0' } } })] }, 'activity', { kind: 'real' });
  assert.equal(statusOf(quiet, 'Account U1000001F'), 'info'); // no activity: nothing to link
  const paperSet = checkFlexQuery({ type: 'AF', statements: [statement([], { accountId: 'DU1000002' })] }, 'activity', { kind: 'paper' });
  assert.equal(statusOf(paperSet, 'Cash Transactions'), undefined); // paper accounts don't track cash
  const dates = checkFlexQuery({ type: 'AF', statements: [statement([cashRow({ transactionID: '1', dateTime: '09/18/2026' })])] }, 'activity', { kind: 'real' });
  assert.equal(statusOf(dates, 'Date format'), 'missing');
});

test('cash report: one row per held currency, the base-currency summary left out', () => {
  const rows = parseCashReport([{ accountId: 'U1000001', toDate: '20261002', CashReport: { CashReportCurrency: [
    { accountId: 'U1000001', currency: 'BASE_SUMMARY', endingCash: '20559.8', toDate: '20261002' },
    { accountId: 'U1000001', currency: 'EUR', endingCash: '17575.228', toDate: '20261002' },
    { accountId: 'U1000001', currency: 'USD', endingCash: '784.18164', toDate: '20261002' },
  ] } }]);
  assert.deepEqual(rows, [
    { brokerAccountId: 'U1000001', currency: 'EUR', asOf: '2026-10-02', endingCash: 17575.228 },
    { brokerAccountId: 'U1000001', currency: 'USD', asOf: '2026-10-02', endingCash: 784.18164 },
  ]);
});

test('cash report: an account holding only its base currency reports just the summary', () => {
  const rows = parseCashReport([{
    accountId: 'U1000002', toDate: '20261002',
    CashTransactions: { CashTransaction: [{ currency: 'USD', fxRateToBase: '1', amount: '-10' }] },
    CashReport: { CashReportCurrency: { accountId: 'U1000002', currency: 'BASE_SUMMARY', endingCash: '7002.84', toDate: '20261002' } },
  }]);
  assert.deepEqual(rows, [{ brokerAccountId: 'U1000002', currency: 'USD', asOf: '2026-10-02', endingCash: 7002.84 }]);
  // Without a way to tell the base currency, nothing is guessed.
  assert.deepEqual(parseCashReport([{ accountId: 'U1000002', CashReport: { CashReportCurrency: { currency: 'BASE_SUMMARY', endingCash: '1', toDate: '20261002' } } }]), []);
});

test('balance check: rounding is in line, items waiting in the inbox explain their part', () => {
  const [eur, usd, gbp] = compareBalances(
    [{ currency: 'EUR', asOf: '2026-10-02', endingCash: 17575.228 }, { currency: 'USD', asOf: '2026-10-02', endingCash: 784.18164 },
     { currency: 'GBP', asOf: '2026-10-02', endingCash: 90 }],
    { EUR: 17575.2444, USD: 782.6116, GBP: 100 },
    { GBP: -10 }
  );
  assert.equal(eur.inLine, true);
  assert.equal(usd.inLine, false);
  assert.equal(usd.unexplained, 1.57);
  assert.equal(gbp.inLine, true); // a waiting -10 fee is the whole difference
  assert.equal(gbp.waiting, -10);
});
