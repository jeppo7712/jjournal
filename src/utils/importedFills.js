// Which of a broker's fills the IBKR import window counts as handled though
// their execution ID isn't in the journal — the same rules as the fills
// badge (pendingFills in modules/brokerFills.js): a fill entered by hand
// (no execution ID; same side, quantity and price, within
// HAND_ENTERED_SECONDS), or one dismissed from the badge.

export const HAND_ENTERED_SECONDS = 90;

// The journal's fills of `symbol` entered by hand, from the account's trades.
// A stock's symbol may carry its exchange (ABC.DE for ABC).
export function handEnteredActions(trades, symbol) {
  const root = String(symbol || '').toUpperCase();
  return (Array.isArray(trades) ? trades : [])
    .filter(t => {
      const s = String(t.symbol || '').toUpperCase();
      return s === root || s.startsWith(`${root}.`);
    })
    .flatMap(t => (t.actions || []).filter(a => !a.execId && !a.exec_id));
}

// Whether a fill ({ action: 'BUY'|'SELL', quantity, price, time in ms }) was
// entered by hand as one of `actions`.
export function isHandEntered(actions, fill) {
  return actions.some(a => a.type === fill.action
    && Number(a.quantity) === Number(fill.quantity)
    && Math.abs(Number(a.price) - Number(fill.price)) < 0.000001
    && Math.abs(Date.parse(a.date_time || a.dateTime) - fill.time) <= HAND_ENTERED_SECONDS * 1000);
}
