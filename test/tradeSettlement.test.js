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
