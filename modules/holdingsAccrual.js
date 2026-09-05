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

// Posts every coupon due (<=today) that hasn't been posted yet for one
// holding, resuming from whichever the last posted one was (or purchase_date
// if none yet). Catches up on multiple missed periods in one pass (e.g. the
// server was down for a while) rather than only ever posting the single
// most-recent one.
async function postDueCoupons(client, holding, today) {
  const months = monthsPerCouponPeriod(holding.coupon_frequency);
  if (!months || !(Number(holding.coupon_rate) > 0)) return 0;

  const { rows } = await client.query(
    `SELECT MAX(date_time) AS last_date FROM cash_transactions WHERE linked_holding_id = $1 AND type = 'INTEREST'`,
    [holding.id]
  );
  let cursor = rows[0].last_date
    ? DateTime.fromJSDate(new Date(rows[0].last_date)).startOf('day')
    : DateTime.fromJSDate(new Date(holding.purchase_date)).startOf('day');
  const maturity = holding.maturity_date
    ? DateTime.fromJSDate(new Date(holding.maturity_date)).startOf('day')
    : null;

  const paymentsPerYear = 12 / months;
  const couponAmount = Number(holding.face_value) * (Number(holding.coupon_rate) / 100) / paymentsPerYear;

  let posted = 0;
  while (true) {
    const dueDate = cursor.plus({ months });
    if (dueDate > today) break;
    if (maturity && dueDate > maturity) break; // face value + final coupon handled together at maturity below
    await client.query(
      `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, linked_holding_id, note)
       VALUES ($1, $2, 'INTEREST', $3, $4, $5, $6)`,
      [holding.account_id, dueDate.toJSDate(), couponAmount, holding.currency, holding.id, `Coupon payment: ${holding.name}`]
    );
    posted++;
    cursor = dueDate;
  }
  return posted;
}

// Auto-redeems any ACTIVE holding whose maturity_date has passed, crediting
// face_value and marking it MATURED — the discount-instrument payoff for a
// T-bill, and principal repayment (alongside whatever final coupon
// postDueCoupons already posted) for a bond.
async function processMaturedHoldings(client, broadcastStatus, uuidv4, today) {
  const { rows } = await client.query(
    `SELECT * FROM holdings WHERE status = 'ACTIVE' AND maturity_date IS NOT NULL AND maturity_date <= $1`,
    [today.toISODate()]
  );
  for (const holding of rows) {
    await client.query(`UPDATE holdings SET status = 'MATURED', updated_at = NOW() WHERE id = $1`, [holding.id]);
    await client.query(
      `INSERT INTO cash_transactions (account_id, date_time, type, amount, currency, linked_holding_id, note)
       VALUES ($1, $2, 'OTHER', $3, $4, $5, $6)`,
      [holding.account_id, holding.maturity_date, Math.abs(Number(holding.face_value)), holding.currency, holding.id, `Matured: ${holding.name} (auto-redeemed at face value)`]
    );
    if (broadcastStatus) {
      broadcastStatus(uuidv4(), `Holding matured: ${holding.name} — ${holding.face_value} ${holding.currency} credited`, 'success');
    }
  }
  return rows.length;
}

async function processHoldingsAccrual(pool, broadcastStatus, uuidv4) {
  const today = DateTime.now().startOf('day');
  const client = await pool.connect();
  let couponsPosted = 0;
  let maturedCount = 0;
  try {
    await client.query('BEGIN');

    const { rows: coupons } = await client.query(
      `SELECT * FROM holdings
       WHERE status = 'ACTIVE' AND type = 'BOND' AND coupon_rate IS NOT NULL AND coupon_frequency IS NOT NULL AND coupon_rate > 0`
    );
    for (const holding of coupons) {
      const posted = await postDueCoupons(client, holding, today);
      if (posted > 0 && broadcastStatus) {
        broadcastStatus(uuidv4(), `${posted} coupon payment(s) posted for ${holding.name}`, 'success');
      }
      couponsPosted += posted;
    }

    maturedCount = await processMaturedHoldings(client, broadcastStatus, uuidv4, today);

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

module.exports = { processHoldingsAccrual };
