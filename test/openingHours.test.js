// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');

// src/utils is ES module code (the React app's); Node loads it by syntax.
const load = () => import('../src/utils/openingHours.js');

const closedWeek = () => Array(7).fill().map(() => Array(48).fill(false));

test('formatDayHours: closed, 24h, and stretches with their real end time', async () => {
  const { formatDayHours } = await load();
  const day = Array(48).fill(false);
  assert.equal(formatDayHours(day), 'closed');
  assert.equal(formatDayHours(Array(48).fill(true)), '24h');
  for (let s = 17; s < 32; s++) day[s] = true; // 08:30 up to 16:00
  for (let s = 34; s < 48; s++) day[s] = true; // 17:00 to midnight
  assert.equal(formatDayHours(day), '08:30–16:00, 17:00–24:00');
});

test('setRect: a drag from any corner sets exactly the rectangle', async () => {
  const { cellRect, setRect, formatDayHours, describeRect } = await load();
  // Dragged from Fri 15:30 up-left to Mon 08:30.
  const rect = cellRect({ day: 4, slot: 31 }, { day: 0, slot: 17 });
  assert.equal(describeRect(rect), 'Mon–Fri 08:30–16:00');
  const hours = setRect(closedWeek(), rect, true);
  assert.deepEqual(hours.map(formatDayHours), ['08:30–16:00', '08:30–16:00', '08:30–16:00', '08:30–16:00', '08:30–16:00', 'closed', 'closed']);
  // Closing a part again leaves the rest.
  const lunch = setRect(hours, cellRect({ day: 2, slot: 24 }, { day: 2, slot: 25 }), false);
  assert.equal(formatDayHours(lunch[2]), '08:30–12:00, 13:00–16:00');
  assert.equal(formatDayHours(lunch[1]), '08:30–16:00');
});

test('describeRect: one block reads as its half hour', async () => {
  const { cellRect, describeRect } = await load();
  assert.equal(describeRect(cellRect({ day: 6, slot: 47 }, { day: 6, slot: 47 })), 'Sun 23:30–24:00');
});
