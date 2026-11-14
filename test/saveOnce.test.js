// modules/saveOnce.js: a POST with an X-Save-Key is booked once.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { saveOnce } = require('../modules/saveOnce.js');

async function start({ fail = false, slow = null } = {}) {
  const booked = [];
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.accountId = Number(req.get('X-Account-ID') || 1); next(); });
  app.post('/api/deposit', saveOnce(), async (req, res) => {
    if (req.body.amount <= 0) return res.status(400).json({ error: 'positive amount' });
    if (slow) await slow;
    if (fail) return res.status(500).json({ error: 'db down' });
    booked.push(req.body.amount);
    res.json({ id: booked.length });
  });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const post = (body, key, account = 1) => fetch(`http://127.0.0.1:${server.address().port}/api/deposit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Account-ID': String(account), ...(key ? { 'X-Save-Key': key } : {}) },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() }));
  const stop = () => { server.closeAllConnections(); server.close(); };
  return { booked, post, stop };
}

test('a repeat with the same values gets the first answer, booked once', async () => {
  const { booked, post, stop } = await start();
  try {
    assert.deepStrictEqual(await post({ amount: 100 }, 'a'), { status: 200, body: { id: 1 } });
    assert.deepStrictEqual(await post({ amount: 100 }, 'a'), { status: 200, body: { id: 1 } });
    assert.deepStrictEqual(booked, [100]);
    // Other keys, other accounts and no key at all are their own saves.
    assert.strictEqual((await post({ amount: 100 }, 'b')).body.id, 2);
    assert.strictEqual((await post({ amount: 100 }, 'a', 2)).body.id, 3);
    assert.strictEqual((await post({ amount: 100 })).body.id, 4);
    assert.strictEqual((await post({ amount: 100 })).body.id, 5);
  } finally { stop(); }
});

test('a repeat with other values is refused, not booked', async () => {
  const { booked, post, stop } = await start();
  try {
    await post({ amount: 100 }, 'c');
    const again = await post({ amount: 120 }, 'c');
    assert.strictEqual(again.status, 409);
    assert.match(again.body.error, /already saved once/);
    assert.deepStrictEqual(booked, [100]);
  } finally { stop(); }
});

test('a repeat while the first is still running waits for its answer', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const { booked, post, stop } = await start({ slow });
  try {
    const first = post({ amount: 50 }, 'd');
    await new Promise(r => setTimeout(r, 50));
    const again = post({ amount: 50 }, 'd');
    await new Promise(r => setTimeout(r, 50));
    release();
    assert.deepStrictEqual((await first).body, { id: 1 });
    assert.deepStrictEqual((await again).body, { id: 1 });
    assert.deepStrictEqual(booked, [50]);
  } finally { stop(); }
});

test('a refused or failed save frees the key for a real retry', async () => {
  const { booked, post, stop } = await start();
  try {
    assert.strictEqual((await post({ amount: -1 }, 'e')).status, 400);
    assert.deepStrictEqual(await post({ amount: 10 }, 'e'), { status: 200, body: { id: 1 } });
    assert.deepStrictEqual(booked, [10]);
  } finally { stop(); }
  const failing = await start({ fail: true });
  try {
    assert.strictEqual((await failing.post({ amount: 10 }, 'f')).status, 500);
    assert.strictEqual((await failing.post({ amount: 10 }, 'f')).status, 500); // tried again, not replayed
  } finally { failing.stop(); }
});
