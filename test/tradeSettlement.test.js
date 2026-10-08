// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { fillDay } = require('../modules/tradeSettlement.js');

test('a fill belongs to the day where its market trades, not the UTC day', () => {
    // 20:30 in New York is already the next day in UTC.
    assert.equal(fillDay('2026-04-01T00:30:00Z', 'America/New_York'), '2026-03-31');
    assert.equal(fillDay('2026-03-31T22:30:00Z', 'Europe/Berlin'), '2026-04-01');
    // No exchange timezone known, or an unknown one: New York.
    assert.equal(fillDay('2026-04-01T00:30:00Z', null), '2026-03-31');
    assert.equal(fillDay('2026-04-01T00:30:00Z', 'Not/AZone'), '2026-03-31');
});

test('Chicago futures take the trade date of their session, which opens at 17:00 the evening before', () => {
    // Tuesday 18:30 Chicago (23:30 UTC, daylight time) is Wednesday's session.
    assert.equal(fillDay('2026-03-31T23:30:00Z', 'America/Chicago', 'FUT'), '2026-04-01');
    // Before 17:00 it's still the same day.
    assert.equal(fillDay('2026-03-31T20:30:00Z', 'America/Chicago', 'FUT'), '2026-03-31');
    // Sunday evening opens Monday.
    assert.equal(fillDay('2026-04-05T23:00:00Z', 'America/Chicago', 'FUT'), '2026-04-06');
    // A stock in Chicago, or a future elsewhere, keeps its calendar day.
    assert.equal(fillDay('2026-03-31T23:30:00Z', 'America/Chicago', 'STK'), '2026-03-31');
    assert.equal(fillDay('2026-03-31T21:30:00Z', 'Europe/Berlin', 'FUT'), '2026-03-31');
});
