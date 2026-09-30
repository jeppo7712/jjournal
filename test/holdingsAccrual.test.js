// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { couponDueDates } = require('../modules/holdingsAccrual.js');

test('coupons follow the maturity-anchored schedule and include the final one', () => {
    assert.deepEqual(
        couponDueDates({ purchaseIso: '2025-09-10', maturityIso: '2027-06-15', months: 6, afterIso: null, todayIso: '2027-06-15' }),
        ['2025-12-15', '2026-06-15', '2026-12-15', '2027-06-15']
    );
});

test('only coupons after the last posted one and not in the future', () => {
    assert.deepEqual(
        couponDueDates({ purchaseIso: '2025-09-10', maturityIso: '2027-06-15', months: 6, afterIso: '2026-06-15', todayIso: '2026-12-20' }),
        ['2026-12-15']
    );
    assert.deepEqual(
        couponDueDates({ purchaseIso: '2025-09-10', maturityIso: '2027-06-15', months: 6, afterIso: '2026-12-15', todayIso: '2027-01-01' }),
        []
    );
});

test('month-end schedules do not drift', () => {
    assert.deepEqual(
        couponDueDates({ purchaseIso: '2025-09-10', maturityIso: '2027-08-31', months: 6, afterIso: null, todayIso: '2030-01-01' }),
        ['2026-02-28', '2026-08-31', '2027-02-28', '2027-08-31']
    );
    assert.deepEqual(
        couponDueDates({ purchaseIso: '2025-01-31', maturityIso: null, months: 1, afterIso: null, todayIso: '2025-05-01' }),
        ['2025-02-28', '2025-03-31', '2025-04-30']
    );
});
