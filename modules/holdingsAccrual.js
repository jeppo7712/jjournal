const { DateTime } = require('luxon');
const { logger } = require('./logger.js');

// Automates the two things a T-bill/bond eventually needs done to it,
// instead of leaving them purely manual (see docs/CAPITAL_TRACKING_DESIGN.md):
//
// 1. BOND coupon payments — periodic interest, posted to the cash ledger as
//    they come due (type INTEREST), based on coupon_rate/coupon_frequency.
// 2. Maturity — ANY holding type (TBILL, BOND, OTHER) auto-redeems at face
//    value once maturity_date passes, marking it MATURED. This is the
//    zero-coupon-discount-instrument case too (a T-bill has no coupon_rate
//    set at all — it just accretes silently to face_value and pays out
//    once, here).
//
// Both are read from cash_transactions/holdings state each run rather than
// tracked in a separate "last processed" column — same "derive it, don't
// separately maintain it" philosophy as account cash balances (SUM of
// transactions, not a stored running total that could drift).
//
// Deliberately narrow: this only ever posts the exact scheduled amount on
// the exact scheduled date, for a holding still ACTIVE — an early sale, a
// partial redemption, or any other custom amount/date stays a manual action
// via POST /holdings/:id/redeem, unaffected by this.

function monthsPerCouponPeriod(frequency) {
  switch (frequency) {
    case 'ANNUAL': return 12;
    case 'SEMI_ANNUAL': return 6;
    case 'QUARTERLY': return 3;
    default: return null;
  }
}

// Coupon dates of a bond that fall after `afterIso` and on or before
// `todayIso` (all YYYY-MM-DD, compared as UTC calendar dates), oldest first.
//
// With a maturity date the schedule is anchored to it, the way a real bond
// pays: coupons fall on the maturity date and every period before it, and
// the last one is paid ON the maturity date itself. Without one, it counts
// forward from the purchase date. Each date is computed from the anchor
// (never from the previous date), so a month-end schedule doesn't drift
// (Jan 31 -> Feb 28 -> Mar 28 ...).
function couponDueDates({ purchaseIso, maturityIso, months, afterIso, todayIso }) {
  const purchase = DateTime.fromISO(purchaseIso, { zone: 'utc' });
  const after = DateTime.fromISO(afterIso || purchaseIso, { zone: 'utc' });
  const today = DateTime.fromISO(todayIso, { zone: 'utc' });
  const dates = [];
  if (maturityIso) {
    const maturity = DateTime.fromISO(maturityIso, { zone: 'utc' });
    for (let k = 0; ; k++) {
      const date = maturity.minus({ months: months * k });
      if (date <= purchase || date <= after) break;
      if (date <= today) dates.push(date.toISODate());
    }
    dates.reverse();
  } else {
    for (let k = 1; ; k++) {
      const date = purchase.plus({ months: months * k });
      if (date > today) break;
      if (date > after) dates.push(date.toISODate());
    }
  }
  return dates;
}

// Posts every coupon due (<=today) that hasn't been posted yet for one
// holding, resuming after whichever the last posted one was (or the
// purchase date if none yet). Catches up on multiple missed periods in one
// pass (e.g. the server was down for a while) rather than only ever posting
// the single most-recent one. Includes the final coupon on the maturity
// date, which processMaturedHoldings (face value only) relies on.
async function postDueCoupons(client, holding, todayIso) {
  const months = monthsPerCouponPeriod(holding.coupon_frequency);
  if (!months || !(Number(holding.coupon_rate) > 0)) return 0;

  const { rows } = await client.query(
    `SELECT to_char(MAX(date_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last_date
     FROM cash_transactions WHERE linked_holding_id = $1 AND type = 'INTEREST'`,
    [holding.id]
  );

  const paymentsPerYear = 12 / months;
  const couponAmount = Number(holding.face_value) * (Number(holding.coupon_rate) / 100) / paymentsPerYear;

  const dueDates = couponDueDates({
    purchaseIso: holding.purchase_iso,
    maturityIso: holding.maturity_iso,
    months,
    afterIso: rows[0].last_date,
    todayIso,
  });
  for (const dueIso of dueDates) {
    // Booked at midnight UTC of the due date, like dividends and date-only
    // manual cash entries — built from the plain date string so no JS Date
    // time-zone conversion can move it to the previous day.
    await client.query(
      `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, linked_holding_id, note)
       VALUES ($1, $2, 'INTEREST', $3, $4, $5, $6)`,
      [holding.account_id, `${dueIso}T00:00:00Z`, couponAmount, holding.currency, holding.id, `Coupon payment: ${holding.name}`]
    );
  }
  return dueDates.length;
}

// Auto-redeems any ACTIVE holding whose maturity_date has passed, crediting
// face_value and marking it MATURED — the discount-instrument payoff for a
// T-bill, and principal repayment for a bond (its final coupon was already
// posted by postDueCoupons, which runs first in the same transaction).
async function processMaturedHoldings(client, broadcastStatus, uuidv4, todayIso) {
  const { rows } = await client.query(
    `SELECT *, to_char(maturity_date, 'YYYY-MM-DD') AS maturity_iso
     FROM holdings WHERE status = 'ACTIVE' AND maturity_date IS NOT NULL AND maturity_date <= $1`,
    [todayIso]
  );
  for (const holding of rows) {
    await client.query(`UPDATE holdings SET status = 'MATURED', updated_at = NOW() WHERE id = $1`, [holding.id]);
    await client.query(
      `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, linked_holding_id, note)
       VALUES ($1, $2, 'OTHER', $3, $4, $5, $6)`,
      [holding.account_id, `${holding.maturity_iso}T00:00:00Z`, Math.abs(Number(holding.face_value)), holding.currency, holding.id, `Matured: ${holding.name} (auto-redeemed at face value)`]
    );
    if (broadcastStatus) {
      broadcastStatus(uuidv4(), `Holding matured: ${holding.name} — ${holding.face_value} ${holding.currency} credited`, 'success');
    }
  }
  return rows.length;
}

async function processHoldingsAccrual(pool, broadcastStatus, uuidv4) {
  const todayIso = DateTime.utc().toISODate();
  const client = await pool.connect();
  let couponsPosted = 0;
  let maturedCount = 0;
  try {
    await client.query('BEGIN');
    // The 6-hourly cron and the manual "process accrual" button can overlap;
    // without this, both could read the same last coupon date and post the
    // same coupon twice. Released automatically at COMMIT/ROLLBACK.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('jjournal_holdings_accrual'))`);

    const { rows: coupons } = await client.query(
      `SELECT *, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_iso, to_char(maturity_date, 'YYYY-MM-DD') AS maturity_iso
       FROM holdings
       WHERE status = 'ACTIVE' AND type = 'BOND' AND coupon_rate IS NOT NULL AND coupon_frequency IS NOT NULL AND coupon_rate > 0`
    );
    for (const holding of coupons) {
      const posted = await postDueCoupons(client, holding, todayIso);
      if (posted > 0 && broadcastStatus) {
        broadcastStatus(uuidv4(), `${posted} coupon payment(s) posted for ${holding.name}`, 'success');
      }
      couponsPosted += posted;
    }

    maturedCount = await processMaturedHoldings(client, broadcastStatus, uuidv4, todayIso);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`[HoldingsAccrual] Failed: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
  return { couponsPosted, maturedCount };
}

module.exports = { processHoldingsAccrual, couponDueDates };
