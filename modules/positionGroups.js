const { FLIP_SUFFIX } = require('./brokerFills.js');

// ─── POSITION-BASED GROUPING ─────────────────────────────────────────────────
// For fills without bracket order linkage (all Flex fills; TWS fills whose
// orders didn't link up): one trade runs from a fill that opens a position
// until the position is back to 0.
//
// The position is kept per contract month: each futures contract is a
// position of its own. One running total across contracts carried a fill
// missing from the history (the Flex data starting with the close of a
// position opened before it) into every later contract, so every trade
// from then on started and ended on the wrong fill.

// A fill that flips the position (long 1, then sell 2) is split in two:
// the part that closes the position and the part that opens the other
// way, the fee shared by quantity, so each lands in a trade of its own.
// The opening part gets an execution ID of its own (FLIP_SUFFIX, see
// modules/brokerFills.js): a fill
// is in one trade only. Both name the fill they came from (splitOf).
function splitFlips(sorted) {
  const out = [];
  let net = 0;
  for (const exec of sorted) {
    const quantity = Number(exec.quantity);
    const change = exec.side === 'BOT' ? quantity : -quantity;
    const after = net + change;
    if (net !== 0 && after !== 0 && Math.sign(after) !== Math.sign(net)) {
      const closing = Math.abs(net);
      const opening = Math.abs(after);
      const fee = Number(exec.commission) || 0;
      const closingFee = Math.round(fee * (closing / quantity) * 1e6) / 1e6;
      out.push({ ...exec, quantity: closing, commission: closingFee, splitOf: exec.execId });
      out.push({ ...exec, execId: `${exec.execId}${FLIP_SUFFIX}`, quantity: opening, commission: Math.round((fee - closingFee) * 1e6) / 1e6, splitOf: exec.execId });
    } else {
      out.push(exec);
    }
    net = after;
  }
  return out;
}

// One contract's fills, oldest first, into trades.
function groupOneContract(sorted) {
  const groups = [];
  let current = null;
  let netQty = 0;

  for (const exec of splitFlips(sorted)) {
    const isBuy = exec.side === 'BOT';
    const change = isBuy ? Number(exec.quantity) : -Number(exec.quantity);

    if (netQty === 0) {
      current = {
        type: 'position-based',
        parentOrderId: `pos_${exec.execId}`,
        direction: isBuy ? 'LONG' : 'SHORT',
        result: 'OPEN',
        entryOrder: null,
        entryExecutions: [],
        tpOrder: null,
        tpExecutions: [],
        slOrder: null,
        slExecutions: [],
        otherChildren: [],
      };
      groups.push(current);
    }

    netQty += change;

    // Entry = adding to position; exit = reducing/closing
    const isEntry = (current.direction === 'LONG' && isBuy) ||
                    (current.direction === 'SHORT' && !isBuy);

    if (isEntry) {
      current.entryExecutions.push(exec);
    } else {
      // Exit — we can't tell TP vs SL without order data, use tpExecutions slot
      current.tpExecutions.push(exec);
    }

    if (netQty === 0) {
      current.result = 'CLOSED';
      current = null;
    }
  }
  // If we still have an open position (current != null), it stays as result: 'OPEN'
  return groups;
}

// All the fills, any contracts, into trades ordered by their first fill.
function groupByPosition(execs) {
  const byContract = new Map();
  for (const exec of [...execs].sort((a, b) => a.time.localeCompare(b.time))) {
    const key = exec.contractMonth || '';
    if (!byContract.has(key)) byContract.set(key, []);
    byContract.get(key).push(exec);
  }
  const firstTime = g => g.entryExecutions[0].time;
  return [...byContract.values()]
    .flatMap(groupOneContract)
    .sort((a, b) => firstTime(a).localeCompare(firstTime(b)));
}

module.exports = { groupByPosition, splitFlips };
