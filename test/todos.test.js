const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const {
    parseInput, applyWrite, parseListQuery, filterItems, createTodoService, TodoError,
} = require('../modules/todos.js');
const todoRoutes = require('../routes/todos.js');

// Invented values only (this repository is public).
const ACCOUNTS = [
    { id: 3, name: 'Broker Main', is_virtual: false, archived: false },
    { id: 4, name: 'Paper', is_virtual: true, archived: false },
    { id: 5, name: 'Old', is_virtual: false, archived: true },
];
const TRADES = [{ id: 12, symbol: 'ABC' }];

// A stand-in for createTodoStore(): the same methods over a Map.
function memoryStore(clock) {
    const rows = new Map();
    let nextId = 1;
    const decorate = (row) => ({
        ...row,
        account_name: ACCOUNTS.find(a => a.id === row.account_id)?.name ?? null,
        trade_symbol: TRADES.find(t => t.id === row.trade_id)?.symbol ?? null,
    });
    const keyTaken = (key, exceptId) => key && [...rows.values()].some(r => r.key === key && r.id !== exceptId);
    const duplicate = () => Object.assign(new Error('duplicate key'), { code: '23505' });
    const store = {
        get: async (id) => (rows.has(id) ? decorate(rows.get(id)) : null),
        getByKey: async (key) => {
            const row = [...rows.values()].find(r => r.key === key);
            return row ? decorate(row) : null;
        },
        lock: (id) => store.get(id),
        lockByKey: (key) => store.getByKey(key),
        insert: async (item) => {
            if (keyTaken(item.key)) throw duplicate();
            const id = nextId++;
            const at = clock().toISOString();
            rows.set(id, { ...item, id, created_at: at, updated_at: at });
            return store.get(id);
        },
        update: async (id, item) => {
            if (keyTaken(item.key, id)) throw duplicate();
            rows.set(id, { ...rows.get(id), ...item, id, updated_at: clock().toISOString() });
            return store.get(id);
        },
        remove: async (id) => {
            const row = rows.get(id);
            if (!row) return null;
            rows.delete(id);
            return { id, key: row.key };
        },
        markSeen: async (ids = null) => {
            let n = 0;
            for (const row of rows.values()) {
                if (row.status === 'fired' && !row.seen_at && (!ids || ids.includes(row.id))) { row.seen_at = clock().toISOString(); n++; }
            }
            return n;
        },
        account: async (id) => ACCOUNTS.find(a => a.id === id) || null,
        trade: async (id) => TRADES.find(t => t.id === id) || null,
        all: async () => [...rows.values()].map(decorate),
        transaction: (fn) => fn(store),
    };
    return store;
}

function setup() {
    let now = new Date('2026-03-02T09:00:00Z');
    const clock = () => now;
    const changes = [];
    const service = createTodoService(memoryStore(clock), { onChange: (c) => changes.push(c), now: clock });
    return { service, changes, advance: (minutes) => { now = new Date(now.getTime() + minutes * 60000); } };
}

const alertBody = (extra = {}) => ({
    kind: 'trigger',
    title: 'ABC weekly close under the line',
    then: 'review the position',
    trigger: { symbol: 'abc', type: 'STK', condition: 'close_1w', direction: 'below', level: 42.5 },
    ...extra,
});
const orderBody = (extra = {}) => ({
    kind: 'order',
    title: 'Buy ETFA.DE on the dip',
    account_id: 3,
    order: { symbol: 'ETFA.DE', side: 'BUY', quantity: 10, order_type: 'LMT', limit_price: 95.5, tif: 'GTD', good_till: '2026-03-20' },
    ...extra,
});

async function rejects400(promise, pattern) {
    await assert.rejects(promise, (err) => {
        assert.ok(err instanceof TodoError, err.message);
        assert.strictEqual(err.status, 400);
        assert.match(err.message, pattern);
        return true;
    });
}

// --- Validation ---

test('validation per kind answers 400 naming the field', async () => {
    const { service } = setup();
    await rejects400(service.create(alertBody({ trigger: { symbol: 'ABC', type: 'STK', condition: 'touch', direction: 'above' } }), 'agent'), /trigger\.level is required/);
    await rejects400(service.create(orderBody({ account_id: null }), 'agent'), /account_id is required for kind order/);
    await rejects400(service.create(alertBody({ trigger: { symbol: 'ABC', type: 'STK', condition: 'close_1m', direction: 'above', level: 40 } }), 'agent'), /close_1m is for futures only/);
    await rejects400(service.create({ kind: 'trigger', title: 'no details' }, 'agent'), /trigger is required for kind trigger/);
    await rejects400(service.create({ kind: 'todo', title: 'x', trigger: alertBody().trigger }, 'agent'), /trigger only goes with kind trigger/);
    await rejects400(service.create({ kind: 'note', title: 'x' }, 'agent'), /kind must be one of/);
    await rejects400(service.create({ kind: 'todo' }, 'agent'), /title is required/);
    await rejects400(service.create({ kind: 'todo', title: 'x'.repeat(301) }, 'agent'), /title is longer than 300/);
    await rejects400(service.create({ kind: 'todo', title: 'x', due_at: '2030-01-01T09:00:00' }, 'agent'), /due_at must be a time with its zone/);
    await rejects400(service.create(alertBody({ trigger: { ...alertBody().trigger, symbol: 'A BC' } }), 'agent'), /trigger\.symbol must not contain spaces/);
    await rejects400(service.create(alertBody({ trigger: { ...alertBody().trigger, contract_month: '202606' } }), 'agent'), /contract_month is for futures only/);
});

test('orders: the prices, TIF and bracket the type needs', async () => {
    const { service } = setup();
    const order = (o) => orderBody({ order: { ...orderBody().order, ...o } });
    await rejects400(service.create(order({ tif: 'GTD', good_till: null }), 'app'), /good_till is required for tif GTD/);
    await rejects400(service.create(order({ tif: 'GTC' }), 'app'), /good_till only goes with tif GTD/);
    await rejects400(service.create(order({ limit_price: null }), 'app'), /order\.limit_price is required/);
    await rejects400(service.create(order({ stop_price: 90 }), 'app'), /stop_price doesn't go with order_type LMT/);
    const stopLimit = await service.create(order({ order_type: 'STP LMT', stop_price: 96 }), 'app');
    assert.deepStrictEqual([stopLimit.order.stop_price, stopLimit.order.limit_price], [96, 95.5]);
    await rejects400(service.create(order({ order_type: 'MOC', limit_price: null, tif: 'DAY', good_till: null, quantity: 0 }), 'app'), /order\.quantity must be a positive number/);
    await rejects400(service.create(order({ stop_loss: 96 }), 'app'), /stop_loss must be below the entry price for a BUY/);
    await rejects400(service.create(order({ side: 'SELL', profit_target: 99 }), 'app'), /profit_target must be below the entry price for a SELL/);
    const paper = await service.create(orderBody({ account_id: 4 }), 'app');
    assert.strictEqual(paper.account_name, 'Paper', 'a paper account takes orders too');
    await rejects400(service.create(orderBody({ account_id: 5 }), 'app'), /archived/);
    await rejects400(service.create(orderBody({ account_id: 99 }), 'app'), /account_id 99 doesn't exist/);
    await rejects400(service.create({ kind: 'todo', title: 'x', trade_id: 99 }, 'app'), /trade_id 99 doesn't exist/);

    const saved = await service.create(order({ order_type: 'moc', limit_price: null, tif: 'day', good_till: null, stop_loss: null }), 'app');
    assert.deepStrictEqual(
        { type: saved.order.type, order_type: saved.order.order_type, tif: saved.order.tif, limit_price: saved.order.limit_price },
        { type: 'STK', order_type: 'MOC', tif: 'DAY', limit_price: null }
    );
    assert.strictEqual(saved.account_name, 'Broker Main');
});

test('an archived account is only refused when set; an order whose account was deleted can be closed', async () => {
    let now = new Date('2026-03-02T09:00:00Z');
    const store = memoryStore(() => now);
    const service = createTodoService(store, { now: () => now });
    const paper = ACCOUNTS.find(a => a.id === 4);
    const order = await service.create(orderBody({ account_id: 4 }), 'app');
    const todo = await service.create({ kind: 'todo', title: 'call', account_id: 4 }, 'app');
    paper.archived = true;
    try {
        // The app's form sends the account it has along with every save.
        const edited = await service.update(todo.id, { kind: 'todo', title: 'call back', account_id: 4 }, 'app');
        assert.strictEqual(edited.title, 'call back');
        await rejects400(service.update(todo.id, { account_id: 5 }, 'app'), /archived/);
    } finally {
        paper.archived = false;
    }

    // ON DELETE SET NULL after the account is deleted.
    await store.update(order.id, { ...(await store.get(order.id)), account_id: null });
    const filled = await service.update(order.id, { status: 'done', closed_note: 'filled' }, 'app');
    assert.strictEqual(filled.status, 'done');
    await rejects400(service.update(order.id, { account_id: null }, 'app'), /account_id is required for kind order/);
    await rejects400(service.update(todo.id, { kind: 'order', order: orderBody().order, account_id: null }, 'app'), /account_id is required/);
});

test('a price alert\'s reminder is not its definition; a todo\'s due_at is', async () => {
    const { service, advance } = setup();
    const alert = await service.create(alertBody({ due_at: '2026-03-03T09:00:00Z' }), 'agent');
    advance(10);
    const fired = await service.update(alert.id, { status: 'fired', fired_note: 'closed at 41' }, 'agent');
    advance(10);
    const snoozed = await service.update(alert.id, { due_at: '2026-03-04T09:00:00Z' }, 'app');
    assert.strictEqual(snoozed.status, 'fired', 'a snoozed reminder keeps the alert fired');
    assert.strictEqual(snoozed.fired_at, fired.fired_at);
    assert.strictEqual(snoozed.fired_note, 'closed at 41');
    assert.strictEqual(snoozed.armed_at, alert.armed_at, 'still watching since it was armed');
    assert.strictEqual(snoozed.reminded_at, null, 'the moved reminder is due again');

    const todo = await service.create({ kind: 'todo', title: 'call', due_at: '2026-03-03T09:00:00Z', status: 'expired' }, 'agent');
    advance(10);
    const moved = await service.update(todo.id, { due_at: '2026-03-05T09:00:00Z' }, 'app');
    assert.strictEqual(moved.status, 'open', 'a lapsed todo moved to a new time is open again');
});

test('impossible days are a 400, not rolled on to the next month', async () => {
    const { service } = setup();
    await rejects400(service.create({ kind: 'todo', title: 'x', due_at: '2026-02-30T10:00:00Z' }, 'app'), /due_at must be a time/);
    await rejects400(service.create(alertBody({ expires_at: '2026-04-31T00:00:00+02:00' }), 'agent'), /expires_at must be a time/);
    const leap = await service.create({ kind: 'todo', title: 'x', due_at: '2028-02-29T10:00:00Z' }, 'app');
    assert.strictEqual(leap.due_at, '2028-02-29T10:00:00.000Z');
});

test('parseInput keeps only the fields sent, and ignores read-only ones', () => {
    const patch = parseInput({ status: 'fired', id: 7, created_at: 'x', account_name: 'y', created_by: 'user' });
    assert.deepStrictEqual(patch, { status: 'fired' });
    assert.deepStrictEqual(parseInput({ notes: null, due_at: '2026-03-02T10:00:00+01:00' }), { notes: null, due_at: '2026-03-02T09:00:00.000Z' });
});

test('created_by comes from the route, never from the body', async () => {
    const { service } = setup();
    const byAgent = await service.create({ kind: 'todo', title: 'from the agent', created_by: 'user' }, 'agent');
    const byUser = await service.create({ kind: 'todo', title: 'from the app' }, 'app');
    assert.strictEqual(byAgent.created_by, 'agent');
    assert.strictEqual(byAgent.source, null);
    assert.strictEqual(byUser.created_by, 'user');
    assert.strictEqual(byUser.source, 'app');
    const edited = await service.update(byUser.id, { title: 'edited by the agent' }, 'agent');
    assert.strictEqual(edited.created_by, 'user');
});

// --- PUT by key ---

test('PUT by key creates, then updates, and answers 409 on a dismissed item unless reopen', async () => {
    const { service, advance } = setup();
    const first = await service.upsertByKey('abc-1w-below-42.5', alertBody({ source: 'daily-report' }), 'agent');
    assert.strictEqual(first.created, true);
    assert.strictEqual(first.saved.key, 'abc-1w-below-42.5');
    assert.strictEqual(first.saved.trigger.symbol, 'ABC');

    advance(5);
    const second = await service.upsertByKey('abc-1w-below-42.5', { then: 'cut it in half' }, 'agent');
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.saved.id, first.saved.id);
    assert.strictEqual(second.saved.then, 'cut it in half');
    assert.strictEqual(second.saved.title, first.saved.title, 'fields not sent stay');
    assert.strictEqual(second.saved.armed_at, first.saved.armed_at, 'a new "then" does not re-arm');

    await service.update(first.saved.id, { status: 'dismissed' }, 'app');
    await assert.rejects(service.upsertByKey('abc-1w-below-42.5', { then: 'again' }, 'agent'), (err) => {
        assert.strictEqual(err.status, 409);
        assert.strictEqual(err.message, 'closed by the user');
        assert.strictEqual(err.extra.todo.status, 'dismissed');
        assert.strictEqual(err.extra.todo.then, 'cut it in half', 'nothing changed');
        return true;
    });

    advance(5);
    const reopened = await service.upsertByKey('abc-1w-below-42.5', { then: 'again', reopen: true }, 'agent');
    assert.strictEqual(reopened.saved.status, 'open');
    assert.strictEqual(reopened.saved.then, 'again');
    assert.strictEqual(reopened.saved.closed_at, null);
    assert.strictEqual(reopened.saved.armed_at, '2026-03-02T09:10:00.000Z');
});

test('POST with a key already in use is a 409; a bad key is a 400', async () => {
    const { service } = setup();
    await service.create({ kind: 'todo', title: 'one', key: 'k-1' }, 'agent');
    await assert.rejects(service.create({ kind: 'todo', title: 'two', key: 'k-1' }, 'agent'), (err) => err.status === 409);
    await rejects400(service.upsertByKey('has space', { kind: 'todo', title: 'x' }, 'agent'), /key may only contain/);
});

// --- Bookkeeping ---

test('fired_at, closed_at and armed_at follow the status', async () => {
    const { service, advance } = setup();
    const created = await service.create(alertBody(), 'agent');
    assert.strictEqual(created.status, 'open');
    assert.strictEqual(created.armed_at, '2026-03-02T09:00:00.000Z');

    advance(60);
    const fired = await service.update(created.id, { status: 'fired', fired_note: 'week close 41.80 on 2026-03-06' }, 'agent');
    assert.strictEqual(fired.fired_at, '2026-03-02T10:00:00.000Z');
    assert.strictEqual(fired.closed_at, null);
    assert.strictEqual(fired.armed_at, created.armed_at);

    const given = await service.create(alertBody({ status: 'fired', fired_at: '2026-03-06T21:00:00Z' }), 'agent');
    assert.strictEqual(given.fired_at, '2026-03-06T21:00:00.000Z');
    const stray = await service.create(alertBody({ fired_at: '2026-03-06T21:00:00Z', fired_note: 'x' }), 'agent');
    assert.deepStrictEqual([stray.status, stray.fired_at, stray.fired_note], ['open', null, null], 'an open item has no fired details');

    advance(60);
    const done = await service.update(created.id, { status: 'done', closed_note: 'trimmed' }, 'app');
    assert.strictEqual(done.closed_at, '2026-03-02T11:00:00.000Z');
    assert.strictEqual(done.fired_at, fired.fired_at, 'when it fired stays on record');

    advance(60);
    const edited = await service.update(created.id, { notes: 'later note' }, 'app');
    assert.strictEqual(edited.closed_at, done.closed_at, 'still closed: the close time stays');

    const dismissed = await service.update(created.id, { status: 'dismissed' }, 'app');
    assert.strictEqual(dismissed.closed_at, '2026-03-02T12:00:00.000Z');

    advance(60);
    const reopened = await service.update(created.id, { status: 'open' }, 'app');
    assert.deepStrictEqual(
        [reopened.fired_at, reopened.fired_note, reopened.closed_at, reopened.closed_note],
        [null, null, null, null]
    );
    assert.strictEqual(reopened.armed_at, '2026-03-02T13:00:00.000Z');
});

test('a changed trigger re-arms it; a fired one goes back to open', async () => {
    const { service, advance } = setup();
    const created = await service.create(alertBody(), 'agent');
    advance(10);
    const renamed = await service.update(created.id, { title: 'new title', trigger: { ...alertBody().trigger, void_above: 50 } }, 'agent');
    assert.strictEqual(renamed.armed_at, created.armed_at, 'title and void levels are not the definition');

    advance(10);
    await service.update(created.id, { status: 'fired' }, 'agent');
    advance(10);
    const moved = await service.update(created.id, { trigger: { ...alertBody().trigger, level: 41 } }, 'agent');
    assert.strictEqual(moved.status, 'open');
    assert.strictEqual(moved.fired_at, null);
    assert.strictEqual(moved.armed_at, '2026-03-02T09:30:00.000Z');

    // With an explicit status, that status wins.
    await service.update(created.id, { status: 'fired' }, 'agent');
    const kept = await service.update(created.id, { status: 'fired', trigger: { ...alertBody().trigger, level: 40 } }, 'agent');
    assert.strictEqual(kept.status, 'fired');

    // Done is the user's decision: a new level doesn't reopen it.
    await service.update(created.id, { status: 'done' }, 'app');
    const stillDone = await service.update(created.id, { trigger: { ...alertBody().trigger, level: 39 } }, 'agent');
    assert.strictEqual(stillDone.status, 'done');
});

test('due_at: alert defaults on, a snooze re-arms and clears reminded_at', async () => {
    const { service, advance } = setup();
    const undated = await service.create({ kind: 'todo', title: 'someday' }, 'app');
    assert.strictEqual(undated.alert, false);

    const dated = await service.create({ kind: 'todo', title: 'call the broker', due_at: '2026-03-05T13:00:00Z' }, 'app');
    assert.strictEqual(dated.alert, true);
    const quiet = await service.create({ kind: 'todo', title: 'quiet', due_at: '2026-03-05T13:00:00Z', alert: false }, 'app');
    assert.strictEqual(quiet.alert, false);
    const later = await service.update(quiet.id, { due_at: '2026-03-06T13:00:00Z' }, 'app');
    assert.strictEqual(later.alert, false, 'moving the time keeps the choice');

    advance(30);
    const reminded = await service.update(dated.id, { reminded_at: '2026-03-05T13:00:04Z' }, 'agent');
    assert.strictEqual(reminded.reminded_at, '2026-03-05T13:00:04.000Z');
    assert.strictEqual(reminded.status, 'open');
    assert.strictEqual(reminded.armed_at, dated.armed_at);

    advance(30);
    const snoozed = await service.update(dated.id, { due_at: '2026-03-05T14:00:00Z' }, 'app');
    assert.strictEqual(snoozed.reminded_at, null);
    assert.strictEqual(snoozed.armed_at, '2026-03-02T10:00:00.000Z');

    const cleared = await service.update(dated.id, { due_at: null }, 'app');
    assert.strictEqual(cleared.alert, false);
});

test('changing the kind drops the old kind\'s details', async () => {
    const { service } = setup();
    const alert = await service.create(alertBody(), 'agent');
    const todo = await service.update(alert.id, { kind: 'todo' }, 'app');
    assert.strictEqual(todo.trigger, null);
    await rejects400(service.update(alert.id, { kind: 'order' }, 'app'), /order is required for kind order/);
});

test('markSeen marks fired items once', async () => {
    const { service, changes } = setup();
    const a = await service.create(alertBody(), 'agent');
    await service.update(a.id, { status: 'fired' }, 'agent');
    assert.strictEqual(await service.markSeen(), 1);
    assert.strictEqual(await service.markSeen(), 0);
    assert.ok((await service.get(a.id)).seen_at);
    // Fired again: unseen again.
    await service.update(a.id, { status: 'open' }, 'agent');
    const refired = await service.update(a.id, { status: 'fired' }, 'agent');
    assert.strictEqual(refired.seen_at, null);
    assert.strictEqual(changes.filter(c => c.change === 'seen').length, 1);
    // Only the ones on screen.
    const b = await service.create(alertBody({ status: 'fired' }), 'agent');
    assert.strictEqual(await service.markSeen('app', [a.id]), 1, 'a fired again above');
    assert.strictEqual((await service.get(b.id)).seen_at, null, 'b was not on screen');
    assert.strictEqual(await service.markSeen('app', [b.id]), 1);
    // Fired again without going through open (a new fired_at): unseen again;
    // the same fired_at sent back, or an edit, leaves it seen.
    const sameAgain = await service.update(b.id, { status: 'fired', fired_at: (await service.get(b.id)).fired_at }, 'agent');
    assert.ok(sameAgain.seen_at);
    assert.ok((await service.update(b.id, { title: 'Renamed' }, 'app')).seen_at);
    const firedAgain = await service.update(b.id, { status: 'fired', fired_at: '2030-01-02T15:00:00Z' }, 'agent');
    assert.strictEqual(firedAgain.seen_at, null);
    await rejects400(service.markSeen('app', ['x']), /ids must be a list/);
});

// --- Listing ---

test('list filters and sort order', async () => {
    const { service, advance } = setup();
    const someday = await service.create({ kind: 'todo', title: 'someday' }, 'app');
    advance(1);
    const late = await service.create({ kind: 'todo', title: 'late', due_at: '2026-03-20T09:00:00Z' }, 'agent');
    advance(1);
    const soon = await service.create({ kind: 'todo', title: 'soon', due_at: '2026-03-03T09:00:00Z', trade_id: 12 }, 'app');
    advance(1);
    const order = await service.create(orderBody({ due_at: '2026-03-10T16:00:00Z' }), 'app');
    advance(1);
    const alert = await service.create(alertBody(), 'agent');
    await service.update(alert.id, { status: 'fired' }, 'agent');
    advance(1);
    const closed = await service.create({ kind: 'todo', title: 'closed', status: 'done' }, 'app');

    const ids = (r) => r.items.map(i => i.id);
    assert.deepStrictEqual(ids(await service.list({})), [alert.id, soon.id, order.id, late.id, someday.id, closed.id]);
    assert.deepStrictEqual(ids(await service.list({ status: 'open,fired' })), [alert.id, soon.id, order.id, late.id, someday.id]);
    assert.deepStrictEqual(ids(await service.list({ kind: 'order' })), [order.id]);
    assert.deepStrictEqual(ids(await service.list({ account_id: '3' })), [order.id]);
    assert.deepStrictEqual(ids(await service.list({ trade_id: '12' })), [soon.id]);
    assert.deepStrictEqual(ids(await service.list({ created_by: 'agent' })), [alert.id, late.id]);
    assert.deepStrictEqual(ids(await service.list({ from: '2026-03-03', to: '2026-03-10' })), [soon.id, order.id], 'to includes its whole day');
    assert.deepStrictEqual(ids(await service.list({ to: '2026-03-10T12:00:00Z' })), [soon.id]);
    assert.deepStrictEqual(ids(await service.list({ updated_since: '2026-03-02T09:04:00Z' })), [alert.id, closed.id]);
    assert.deepStrictEqual(ids(await service.list({ closed_since: '2026-03-02T09:06:00Z' })), [alert.id, soon.id, order.id, late.id, someday.id]);

    advance(1);
    const later = await service.create({ kind: 'todo', title: 'closed later', status: 'dismissed' }, 'app');
    assert.deepStrictEqual(ids(await service.list({ closed_before: '2026-03-02T09:07:00Z' })), [later.id, closed.id], 'only closed ones, newest first');
    assert.deepStrictEqual(ids(await service.list({ closed_before: '2026-03-02T09:06:00Z' })), [closed.id]);
    await service.remove(later.id, 'app');

    const page = await service.list({ limit: '2', offset: '1' });
    assert.strictEqual(page.total, 6);
    assert.deepStrictEqual(ids(page), [soon.id, order.id]);

    const soonItem = (await service.list({ trade_id: '12' })).items[0];
    assert.strictEqual(soonItem.trade_symbol, 'ABC');
});

test('list query: bad values are 400', () => {
    assert.throws(() => parseListQuery({ status: 'open,closed' }), /status must be one of/);
    assert.throws(() => parseListQuery({ kind: 'note' }), /kind must be one of/);
    assert.throws(() => parseListQuery({ account_id: 'x' }), /account_id must be a whole number/);
    assert.throws(() => parseListQuery({ from: 'yesterday' }), /from must be a time with its zone/);
    assert.deepStrictEqual(filterItems([], parseListQuery({})), { total: 0, limit: 200, offset: 0, items: [] });
});

test('applyWrite on a new item without a kind is a 400', () => {
    assert.throws(() => applyWrite(null, { title: 'x' }, { origin: 'app' }), /kind is required/);
});

// --- Routes and the event to the agent ---

async function withServer(fn) {
    const sent = [];
    const broadcasts = [];
    let now = new Date('2026-03-02T09:00:00Z');
    const clock = () => now;
    const notify = todoRoutes.changeNotifier({
        broadcast: (m) => broadcasts.push(m),
        loadConfig: async () => ({ agentEventsUrl: 'http://listener.invalid/event', agentEventsToken: 't' }),
        send: async (config, event, data) => { sent.push({ event, data }); },
    });
    const service = createTodoService(memoryStore(clock), { onChange: notify, now: clock });
    const app = express();
    app.use(express.json());
    app.use('/api/external/v1', todoRoutes.externalRouter(service));
    app.use('/api', todoRoutes.appRouter(service));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };
    // The event is sent after the reply; let it go out.
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));
    try {
        await fn({ call, sent, broadcasts, settle });
    } finally {
        server.close();
    }
}

test('the event goes out for an app change, not for an external-API change', async () => {
    await withServer(async ({ call, sent, broadcasts, settle }) => {
        const ext = await call('PUT', '/api/external/v1/todos/key/test-1', { kind: 'todo', title: 'test item', due_at: '2030-01-01T09:00:00Z' });
        assert.strictEqual(ext.status, 201);
        assert.strictEqual(ext.body.created_by, 'agent');
        const again = await call('PUT', '/api/external/v1/todos/key/test-1', { title: 'test item 2' });
        assert.strictEqual(again.status, 200);
        await call('PATCH', `/api/external/v1/todos/${ext.body.id}`, { reminded_at: '2030-01-01T09:00:02Z' });
        await settle();
        assert.strictEqual(sent.length, 0, 'the agent never hears its own writes');
        assert.strictEqual(broadcasts.length, 3, 'the open apps still refresh');

        const created = await call('POST', '/api/todos', { kind: 'todo', title: 'mine' });
        assert.strictEqual(created.status, 201);
        assert.strictEqual(created.body.created_by, 'user');
        await call('PATCH', `/api/todos/${ext.body.id}`, { status: 'done' });
        const deleted = await call('DELETE', `/api/todos/${ext.body.id}`);
        assert.deepStrictEqual(deleted.body, { success: true });
        await call('POST', '/api/todos/seen');
        await settle();
        assert.deepStrictEqual(sent, [
            { event: 'todo', data: { id: created.body.id, key: null, change: 'created' } },
            { event: 'todo', data: { id: ext.body.id, key: 'test-1', change: 'updated' } },
            { event: 'todo', data: { id: ext.body.id, key: 'test-1', change: 'deleted' } },
        ]);
        assert.deepStrictEqual(broadcasts.at(-1), { type: 'todosChanged', id: ext.body.id, change: 'deleted' }, 'nothing was seen: no message');
    });
});

test('routes: errors, 404s and the list shape', async () => {
    await withServer(async ({ call }) => {
        const bad = await call('POST', '/api/external/v1/todos', { kind: 'trigger', title: 'x', trigger: { symbol: 'MES', type: 'FUT', condition: 'touch', direction: 'above' } });
        assert.deepStrictEqual(bad, { status: 400, body: { error: 'trigger.level is required' } });
        assert.strictEqual((await call('GET', '/api/external/v1/todos/999')).status, 404);
        assert.strictEqual((await call('GET', '/api/external/v1/todos/abc')).status, 400);
        assert.strictEqual((await call('GET', '/api/external/v1/todos/key/nope')).status, 404);
        assert.strictEqual((await call('DELETE', '/api/external/v1/todos/999')).status, 404);

        await call('PUT', '/api/external/v1/todos/key/k1', { kind: 'todo', title: 'one' });
        const dismissed = await call('PATCH', '/api/todos/1', { status: 'dismissed' });
        assert.strictEqual(dismissed.body.status, 'dismissed');
        const conflict = await call('PUT', '/api/external/v1/todos/key/k1', { title: 'two' });
        assert.strictEqual(conflict.status, 409);
        assert.strictEqual(conflict.body.error, 'closed by the user');
        assert.strictEqual(conflict.body.todo.title, 'one');

        const list = await call('GET', '/api/external/v1/todos?status=dismissed');
        assert.deepStrictEqual({ total: list.body.total, limit: list.body.limit, offset: list.body.offset }, { total: 1, limit: 200, offset: 0 });
        assert.strictEqual(list.body.todos[0].key, 'k1');
        assert.strictEqual((await call('GET', '/api/external/v1/todos?status=nope')).status, 400);
    });
});
