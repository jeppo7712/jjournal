// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/utils/calendarWeeks.js');

test('days and months as plain keys', async () => {
  const c = await load();
  assert.equal(c.addDays('2026-02-27', 3), '2026-03-02');
  assert.equal(c.weekdayIndex('2026-11-16'), 0); // a Monday
  assert.equal(c.weekdayIndex('2026-11-22'), 6); // a Sunday
  assert.equal(c.mondayOf('2026-11-01'), '2026-10-26');
  assert.equal(c.addMonths('2026-11', 2), '2027-01');
  assert.equal(c.addMonths('2026-01', -1), '2025-12');
  assert.equal(c.weekMonth('2026-10-26'), '2026-10'); // Thursday 29 Oct
  assert.equal(c.weekMonth('2026-09-28'), '2026-10'); // Thursday 1 Oct
});

test('weeks run from the earliest trading month to the end of next month', async () => {
  const c = await load();
  const weeks = c.calendarWeeks(['2025-03-14', '2026-06-02'], '2026-11-18', 12);
  assert.equal(weeks[0], '2025-02-24');          // Monday on or before 1 Mar 2025
  assert.equal(weeks[weeks.length - 1], '2026-12-28'); // the week holding 31 Dec
  assert.ok(weeks.every((w, i) => i === 0 || c.addDays(weeks[i - 1], 7) === w));
  // Without old trades: twelve months back.
  assert.equal(c.calendarWeeks([], '2026-11-18', 12)[0], c.mondayOf('2025-11-01'));
});

test('a week sums its days, counts each trade once, wins and losses from closes', async () => {
  const c = await load();
  const a = { status: 'WIN', currency: 'USD', buyFee: 1, sellFee: 1 };
  const b = { status: 'LOSS', currency: 'EUR', buyFee: 0.5, sellFee: 0.5 };
  const open = { status: 'OPEN', currency: 'USD' };
  const daily = {
    '2026-11-16': { totalByCurrency: { USD: 100 }, trades: [a, open] },
    '2026-11-18': { totalByCurrency: { EUR: -40, USD: 20 }, trades: [b, open] },
    '2026-11-23': { totalByCurrency: { USD: 999 }, trades: [a] }, // next week
  };
  const closed = { '2026-11-16': [a], '2026-11-18': [b] };
  assert.deepEqual(c.weekSummary('2026-11-16', daily, closed), {
    totalByCurrency: { USD: 120, EUR: -40 }, feesByCurrency: { USD: 2, EUR: 1 }, wins: 1, losses: 1, count: 3,
  });
  assert.equal(c.weekSummary('2026-11-02', daily, closed).count, 0);
});

test('compact amounts for phone cells', async () => {
  const c = await load();
  assert.equal(c.compactMoney(191.77), '$192');
  assert.equal(c.compactMoney(-156.4), '-$156');
  assert.equal(c.compactMoney(-1234, 'EUR'), '-€1.2k');
  assert.equal(c.compactMoney(25300), '$25k');
  assert.equal(c.compactMoney(0.4), '$0');
});
