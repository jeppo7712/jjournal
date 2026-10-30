// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
process.env.USER_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-cache-'));
const { DateTime } = require('luxon');
const { EventName } = require('@stoqey/ib');
const ibkr = require('../modules/ibkr-conn.js').data;
const utils = require('../modules/utils.js');

const FLOOR = DateTime.now().minus({ months: 7 }); // a few quarters back
const MONTHS = [3, 6, 9, 12];

// A fake gateway: answers each lookup through `answer(month)`, which returns
// a conId (found), 'none' (no such contract), 'error' (any other failure,
// handled like a timeout) or 'disconnected'.
function fakeGateway(t, answer) {
  const api = new EventEmitter();
  let lookups = 0;
  api.reqContractDetails = (id, contract) => {
    lookups += 1;
    const month = contract.lastTradeDateOrContractMonth;
    const result = answer(month);
    setImmediate(() => {
      if (result === 'none') api.emit(EventName.error, new Error('No security definition has been found for the request'), 200, id);
      else if (result === 'disconnected') api.emit(EventName.error, new Error('Not connected'), 504, -1);
      else if (result === 'error') api.emit(EventName.error, new Error('Request failed'), 321, id);
      else {
        api.emit(EventName.contractDetails, id, { contract: { conId: result, symbol: contract.symbol, secType: 'FUT', lastTradeDateOrContractMonth: `${month}20` }, contractMonth: month });
        api.emit(EventName.contractDetailsEnd, id);
      }
    });
  };
  t.mock.method(ibkr, 'getIbApi', () => api);
  t.mock.method(ibkr, 'expectSelfReportedErrors', () => {});
  t.mock.method(ibkr, 'releaseSelfReportedErrors', () => {});
  return { lookups: () => lookups };
}

const chain = (symbol) => utils.generateContractChain(symbol, 'CME', FLOOR, 'test', () => {}, null, MONTHS, 'USD');
const conIdOf = (month) => Number(month);

test('a complete search is kept and reused', async (t) => {
  utils._contractChainCache.clear();
  const gw = fakeGateway(t, conIdOf);
  const first = await chain('AAA');
  const asked = gw.lookups();
  assert.ok(first.length > 0 && asked > 0);
  const second = await chain('AAA');
  assert.equal(gw.lookups(), asked, 'no new lookups for the second search');
  assert.deepEqual(second.map(c => c.contractMonth), first.map(c => c.contractMonth));
  second[0].contractMonth = 'changed';
  assert.notEqual((await chain('AAA'))[0].contractMonth, 'changed', 'callers get copies');
});

test('a search with a lost connection is not kept', async (t) => {
  utils._contractChainCache.clear();
  const thisMonth = DateTime.now().toFormat('yyyyMM');
  // Lost while asking for an old month: only past lookups fail.
  let lost = false;
  const gw = fakeGateway(t, (month) => (month < thisMonth && !lost ? ((lost = true), 'disconnected') : conIdOf(month)));
  await chain('BBB');
  assert.equal(utils._contractChainCache.size, 0);
  const asked = gw.lookups();
  await chain('BBB');
  assert.ok(gw.lookups() > asked, 'searched again');
});

test('an unanswered current or later month is not kept', async (t) => {
  utils._contractChainCache.clear();
  const thisMonth = DateTime.now().toFormat('yyyyMM');
  // Later months fail without an answer: the chain may be missing the front contract.
  fakeGateway(t, (month) => (month >= thisMonth ? 'error' : conIdOf(month)));
  await chain('CCC');
  assert.equal(utils._contractChainCache.size, 0);
});

test('an unanswered past month still allows keeping it', async (t) => {
  utils._contractChainCache.clear();
  const thisMonth = DateTime.now().toFormat('yyyyMM');
  fakeGateway(t, (month) => (month < thisMonth ? 'error' : conIdOf(month)));
  await chain('CCD');
  assert.equal(utils._contractChainCache.size, 1);
});

test('later months IBKR says don\'t exist still allow keeping it', async (t) => {
  utils._contractChainCache.clear();
  const thisMonth = DateTime.now().toFormat('yyyyMM');
  fakeGateway(t, (month) => (month > thisMonth ? 'none' : conIdOf(month)));
  await chain('DDD');
  assert.equal(utils._contractChainCache.size, 1);
});

test('an empty result is not kept', async (t) => {
  utils._contractChainCache.clear();
  fakeGateway(t, () => 'none');
  assert.deepEqual(await chain('EEE'), []);
  assert.equal(utils._contractChainCache.size, 0);
});
