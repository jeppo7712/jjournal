// POST /trades with a saveKey: a repeat (the first answer lost on the way
// back, Save pressed again) gets the trade already made instead of a copy.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

// A fake database: counts the trades inserted, answers everything else
// with no rows. `slow` holds the INSERT until released.
function fakePool({ failInsert = false } = {}) {
  const state = { inserted: 0, nextId: 100, release: null, slow: false };
  const client = {
    async query(sql) {
      if (/INSERT INTO trades/.test(sql)) {
        if (state.slow) await new Promise(resolve => { state.release = resolve; });
        if (failInsert) throw new Error('insert failed');
        state.inserted += 1;
        return { rows: [{ id: state.nextId++ }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { state, pool: { connect: async () => client } };
}

async function start(pool) {
  // A fresh copy each time: the module keeps one express.Router, and a
  // second factory call would add its routes behind the first one's.
  delete require.cache[require.resolve('../routes/trades.js')];
  const router = require('../routes/trades.js')(pool, { single: () => (req, res, next) => next() }, () => {}, () => 'id');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.accountId = Number(req.headers['x-account-id'] || 1); next(); });
  app.use('/api', router);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const post = (body, account = 1) => fetch(`http://127.0.0.1:${server.address().port}/api/trades`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Account-ID': String(account) }, body: JSON.stringify(body),
  }).then(r => r.json());
  return { server, post };
}

const trade = extra => ({ type: 'STK', symbol: 'TEST', actions: [], ...extra });

test('a repeated save key returns the trade already made', async () => {
  const { state, pool } = fakePool();
  const { server, post } = await start(pool);
  try {
    const first = await post(trade({ saveKey: 'k1' }));
    const again = await post(trade({ saveKey: 'k1' }));
    assert.deepStrictEqual(first, { success: true, id: 100 });
    assert.deepStrictEqual(again, { success: true, id: 100, repeated: true });
    assert.strictEqual(state.inserted, 1);
    // Another form's key, or no key at all, is a new trade.
    assert.strictEqual((await post(trade({ saveKey: 'k2' }))).id, 101);
    assert.strictEqual((await post(trade())).id, 102);
    assert.strictEqual((await post(trade())).id, 103);
    // The same key in another account is not the same save.
    assert.strictEqual((await post(trade({ saveKey: 'k1' }), 2)).id, 104);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a repeat while the first attempt is still saving waits for it', async () => {
  const { state, pool } = fakePool();
  const { server, post } = await start(pool);
  try {
    state.slow = true;
    const first = post(trade({ saveKey: 'k3' }));
    while (!state.release) await new Promise(r => setTimeout(r, 5));
    const again = post(trade({ saveKey: 'k3' }));
    await new Promise(r => setTimeout(r, 50));
    state.slow = false;
    state.release();
    assert.strictEqual((await first).id, 100);
    assert.deepStrictEqual(await again, { success: true, id: 100, repeated: true });
    assert.strictEqual(state.inserted, 1);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a save that failed or was refused leaves the key free for a real retry', async () => {
  const failing = fakePool({ failInsert: true });
  const a = await start(failing.pool);
  try {
    const r = await a.post(trade({ saveKey: 'k4' }));
    assert.ok(r.error);
  } finally { a.server.closeAllConnections(); a.server.close(); }

  const { state, pool } = fakePool();
  const { server, post } = await start(pool);
  try {
    const refused = await post(trade({ saveKey: 'k5', actions: [{ type: 'HOLD' }] }));
    assert.match(refused.error, /type must be BUY or SELL/);
    const retried = await post(trade({ saveKey: 'k5' }));
    assert.deepStrictEqual(retried, { success: true, id: 100 });
    assert.strictEqual(state.inserted, 1);
  } finally { server.closeAllConnections(); server.close(); }
});
