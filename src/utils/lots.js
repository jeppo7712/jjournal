// A trade's fills replayed FIFO, in time order: a fill against the open
// position closes its lots (oldest first), and whatever is left of it opens
// a position the other way. So a trade entered with a flip (long 1, then
// sell 2: short 1) keeps its P&L and open position right — every lot
// carries its own sign instead of all following the trade's side.
//
// Returns the realised P&L of the closed parts (with proportional entry
// and exit fees), the lots still open, the open position's sign (+1 long,
// -1 short, 0 flat), and the position after each fill (timeline: open
// quantity, open cost, entry fee still carried, sign, realised so far,
// fill price) — for valuing a position on a past day, and dating the P&L
// a partial close locked in.
//
// The server's cash ledger matches lots the same way
// (computeFuturesRealizedPnLPerAction in modules/tradeCalculations.js).

const timeOf = (action) => {
  const t = +new Date(action.dateTime || action.date_time);
  return Number.isFinite(t) ? t : 0;
};

export function replayLots(actions, tickMultiplier = 1) {
  const sorted = (Array.isArray(actions) ? actions : [])
    .map((action, index) => ({ action, index }))
    .sort((a, b) => timeOf(a.action) - timeOf(b.action) || a.index - b.index)
    .map(({ action }) => action);

  const openLots = [];
  const timeline = [];
  let realisedPnL = 0;

  for (const action of sorted) {
    const sign = action.type === 'BUY' ? 1 : action.type === 'SELL' ? -1 : 0;
    if (sign === 0) continue;
    const quantity = Number(action.quantity || 0);
    const price = Number(action.price || 0);
    const fee = Number(action.fee || 0);
    let remaining = quantity;

    // Against the position: close lots. The exit fee is split by the fill's
    // own quantity, so it doesn't shrink as the fill eats into lots.
    while (remaining > 0 && openLots.length > 0 && openLots[0].sign !== sign) {
      const lot = openLots[0];
      const qtyToClose = Math.min(lot.quantity, remaining);
      const entryFeeSlice = lot.fee * (qtyToClose / lot.quantity);
      const exitFeeSlice = quantity ? fee * (qtyToClose / quantity) : 0;
      realisedPnL += (price - lot.price) * lot.sign * qtyToClose * tickMultiplier - entryFeeSlice - exitFeeSlice;
      // The lot's fee shrinks with its quantity, so a lot closed by several
      // fills has its entry fee counted once in total.
      lot.fee -= entryFeeSlice;
      lot.quantity -= qtyToClose;
      remaining -= qtyToClose;
      if (lot.quantity <= 1e-12) openLots.shift();
    }
    // With the position, or what's left after closing it: opens.
    if (remaining > 1e-12) {
      openLots.push({ quantity: remaining, price, fee: quantity ? fee * (remaining / quantity) : 0, sign });
    }

    timeline.push({
      dateTime: action.dateTime,
      price,
      openQty: openLots.reduce((sum, lot) => sum + lot.quantity, 0),
      openCost: openLots.reduce((sum, lot) => sum + lot.price * lot.quantity, 0),
      openFee: openLots.reduce((sum, lot) => sum + lot.fee, 0),
      sign: openLots.length > 0 ? openLots[0].sign : 0,
      realisedPnL,
    });
  }

  return { realisedPnL, openLots, timeline, sign: openLots.length > 0 ? openLots[0].sign : 0 };
}

// The largest position held at any point (contracts or shares, unsigned):
// what a futures trade's margin is counted on.
export function maxPosition(actions) {
  let net = 0;
  let max = 0;
  for (const action of Array.isArray(actions) ? actions : []) {
    net += (action.type === 'BUY' ? 1 : action.type === 'SELL' ? -1 : 0) * Number(action.quantity || 0);
    max = Math.max(max, Math.abs(net));
  }
  return max;
}

// How much the open position was opened with: the fills (or, at a flip,
// the part of the fill) on its side since the position was last flat or
// flipped. For "2 still open of 3" — after long 1, sell 2 it's 1 of 1,
// not 1 of the 2 sold.
export function openedInPosition(actions) {
  let net = 0;
  let opened = 0;
  for (const action of Array.isArray(actions) ? actions : []) {
    const sign = action.type === 'BUY' ? 1 : action.type === 'SELL' ? -1 : 0;
    const after = net + sign * Number(action.quantity || 0);
    if (Math.abs(after) < 1e-12) opened = 0;
    else if (Math.sign(after) !== Math.sign(net)) opened = Math.abs(after); // opened from flat, or flipped
    else if (Math.abs(after) > Math.abs(net)) opened += Math.abs(after) - Math.abs(net);
    net = Math.abs(after) < 1e-12 ? 0 : after;
  }
  return opened;
}
