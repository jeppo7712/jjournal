// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/utils/todos.js');

// Invented values only. "Now" is Thursday 2026-03-05 10:00 in New York (15:00 UTC).
const NOW = new Date('2026-03-05T15:00:00Z');
const ZONE = 'America/New_York';
let nextId = 1;
const item = (fields) => ({
  id: nextId++, kind: 'todo', status: 'open', account_id: null, due_at: null,
  created_at: '2026-03-01T00:00:00Z', ...fields,
});

test('todoZone: "exchange" and "local" are the browser zone', async () => {
  const t = await load();
  assert.equal(t.todoZone('exchange'), 'local');
  assert.equal(t.todoZone('local'), 'local');
  assert.equal(t.todoZone(undefined), 'local');
  assert.equal(t.todoZone('Europe/London'), 'Europe/London');
});

test('each item lands in one section', async () => {
  const t = await load();
  const s = (fields) => t.sectionOf(item(fields), NOW, ZONE);
  assert.equal(s({ status: 'fired', kind: 'trigger' }), 'needs');
  assert.equal(s({ due_at: '2026-03-05T14:00:00Z' }), 'needs', 'overdue todo');
  assert.equal(s({ kind: 'order', due_at: '2026-03-05T14:00:00Z' }), 'needs', 'an order whose reminder is overdue');
  assert.equal(s({ due_at: '2026-03-06T04:00:00Z' }), 'today', '23:00 in New York is still today');
  assert.equal(s({ due_at: '2026-03-06T05:30:00Z' }), 'upcoming', '00:30 in New York is tomorrow');
  assert.equal(s({ kind: 'trigger', due_at: '2026-03-05T20:00:00Z' }), 'today', 'an alert with a reminder today');
  assert.equal(s({ kind: 'trigger', due_at: '2026-03-10T20:00:00Z' }), 'alerts');
  assert.equal(s({ kind: 'trigger' }), 'alerts');
  assert.equal(s({ kind: 'order' }), 'orders');
  assert.equal(s({ kind: 'order', due_at: '2026-03-20T16:00:00Z' }), 'orders');
  assert.equal(s({}), 'someday');
  assert.equal(s({ status: 'done', due_at: '2026-03-05T14:00:00Z' }), 'closed');
  assert.equal(s({ status: 'expired', kind: 'trigger' }), 'closed');
});

test('groupTodos: order within sections, days and accounts', async () => {
  const t = await load();
  const firedOld = item({ kind: 'trigger', status: 'fired', fired_at: '2026-03-04T00:00:00Z' });
  const firedNew = item({ kind: 'trigger', status: 'fired', fired_at: '2026-03-05T00:00:00Z' });
  const overdue = item({ due_at: '2026-03-05T12:00:00Z' });
  const later = item({ due_at: '2026-03-07T12:00:00Z' });
  const sooner = item({ due_at: '2026-03-06T12:00:00Z' });
  const sameDay = item({ due_at: '2026-03-06T09:00:00Z' });
  const orderB = item({ kind: 'order', account_id: 3, account_name: 'Broker Main', order: { symbol: 'XYZ' } });
  const orderA = item({ kind: 'order', account_id: 3, account_name: 'Broker Main', order: { symbol: 'ABC' } });
  const orderOther = item({ kind: 'order', account_id: 2, account_name: 'Another', order: { symbol: 'ABC' } });
  const g = t.groupTodos([later, overdue, firedOld, sooner, orderB, firedNew, orderA, orderOther, sameDay], NOW, ZONE);
  assert.deepEqual(g.needs.map(i => i.id), [firedNew.id, firedOld.id, overdue.id]);
  assert.deepEqual(g.upcoming.map(d => d.day), ['2026-03-06', '2026-03-07']);
  assert.deepEqual(g.upcoming[0].items.map(i => i.id), [sameDay.id, sooner.id]);
  assert.deepEqual(g.orders.map(o => o.accountName), ['Another', 'Broker Main']);
  assert.deepEqual(g.orders[1].items.map(i => i.id), [orderA.id, orderB.id]);
});

test('inScope: the account, its sub-accounts, and items with no account', async () => {
  const t = await load();
  assert.equal(t.inScope(item({ account_id: null }), ['3']), true);
  assert.equal(t.inScope(item({ account_id: 3 }), ['3', '7']), true);
  assert.equal(t.inScope(item({ account_id: 7 }), [3, 7]), true);
  assert.equal(t.inScope(item({ account_id: 9 }), ['3', '7']), false);
});

test('badgeCount: unseen fired items plus open items due today or overdue', async () => {
  const t = await load();
  const items = [
    item({ kind: 'trigger', status: 'fired', seen_at: null }),
    item({ kind: 'trigger', status: 'fired', seen_at: '2026-03-05T14:00:00Z' }),
    item({ due_at: '2026-03-04T12:00:00Z' }),
    item({ due_at: '2026-03-06T04:00:00Z' }),
    item({ due_at: '2026-03-06T05:30:00Z' }),
    item({ status: 'done', due_at: '2026-03-04T12:00:00Z' }),
    item({}),
  ];
  assert.equal(t.badgeCount(items, NOW, ZONE), 3);
});

test('words for alerts and orders', async () => {
  const t = await load();
  assert.equal(t.describeTrigger({ symbol: 'ABC', condition: 'close_1w', direction: 'below', level: 42.5 }), 'ABC: weekly close below 42.50');
  assert.equal(
    t.describeTrigger({ symbol: 'MES', contract_month: '202606', condition: 'touch', direction: 'above', level: 5000, void_below: 4900.25 }),
    'MES 202606: trades above 5000.00 (void below 4900.25)'
  );
  assert.equal(t.describeOrder({ side: 'BUY', quantity: 10, symbol: 'ETFA.DE', order_type: 'LMT', limit_price: 95.5 }), 'BUY 10 ETFA.DE LMT 95.50');
  assert.equal(t.describeOrder({ side: 'SELL', quantity: 2, symbol: 'MES', order_type: 'STP LMT', stop_price: 4990, limit_price: 4985 }), 'SELL 2 MES STP LMT 4990.00 / 4985.00');
  assert.equal(t.describeOrder({ side: 'SELL', quantity: 5, symbol: 'ABC', order_type: 'MOC', currency: 'EUR' }), 'SELL 5 ABC MOC EUR');
  assert.equal(t.describeOrderTerms({ tif: 'GTD', good_till: '2026-03-20', stop_loss: 90, profit_target: 101.125 }), 'GTD 20 Mar 2026 · stop 90.00 · target 101.125');
  assert.equal(t.describeOrder({ side: 'BUY', quantity: 1500, symbol: 'ABC', order_type: 'LMT', limit_price: 1234.5 }, t.plainPrice), 'BUY 1500 ABC LMT 1234.50');
  assert.equal(t.describeTrigger({ symbol: 'XYZ', condition: 'touch', direction: 'below', level: 12.25 }, t.plainPrice), 'XYZ: trades below 12.25');
  assert.equal(t.statusLabel({ kind: 'order', status: 'dismissed' }), 'Cancelled');
  assert.equal(t.statusLabel({ kind: 'trigger', status: 'open' }), 'Armed');
});

test('form times round-trip through the zone; snooze choices', async () => {
  const t = await load();
  assert.equal(t.toUtcIso('2026-03-05', '14:00', ZONE), '2026-03-05T19:00:00.000Z');
  assert.equal(t.toUtcIso('2026-03-05', '', ZONE), '2026-03-05T14:00:00.000Z', 'no time: 09:00');
  assert.equal(t.toUtcIso('', '14:00', ZONE), null);
  assert.deepEqual(t.fromUtcIso('2026-03-05T19:00:00Z', ZONE), { date: '2026-03-05', time: '14:00' });
  const snooze = t.snoozeTimes(item({ due_at: '2026-03-05T19:00:00Z' }), NOW, ZONE);
  assert.equal(snooze.hour, '2026-03-05T16:00:00.000Z');
  assert.equal(snooze.tomorrow, '2026-03-06T19:00:00.000Z');
  assert.equal(t.snoozeTimes(item({}), NOW, ZONE).tomorrow, '2026-03-06T14:00:00.000Z');
  assert.equal(t.whenText('2026-03-05T19:00:00Z', NOW, ZONE), '14:00');
  assert.equal(t.dayHeading('2026-03-06', NOW, ZONE), 'Tomorrow');
});
