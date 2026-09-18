// Per-currency aggregation.
//
// Money from different currencies must never be added together — this app
// performs no FX conversion, so a figure blending USD and EUR is not
// "approximate", it's meaningless. Every aggregate that sums across trades
// therefore produces a { CODE: amount } map rather than a scalar.
//
// Designed so a single-currency account is indistinguishable from before:
// one entry in, one value out, formatted exactly as the old inline style.
// The segmentation only becomes visible once a second currency genuinely
// exists in the data.

import { formatMoney } from './formatMoney';

const DEFAULT_CURRENCY = 'USD';

function normalise(currency) {
  return String(currency || DEFAULT_CURRENCY).toUpperCase();
}

// sumByCurrency(trades, t => t.return) -> { USD: 1234.5, EUR: 88.2 }
// Entries that produce a non-finite amount are skipped rather than poisoning
// the bucket with NaN.
export function sumByCurrency(items, getAmount, getCurrency = item => item.currency) {
  const totals = {};
  (Array.isArray(items) ? items : []).forEach(item => {
    const amount = Number(getAmount(item));
    if (!Number.isFinite(amount)) return;
    const code = normalise(getCurrency(item));
    totals[code] = (totals[code] || 0) + amount;
  });
  return totals;
}

// Combines several per-currency maps into one, adding same-currency entries
// and keeping different currencies apart — e.g. cash + holdings + open
// positions into a single net-worth-per-currency view.
export function mergeTotals(...totalsMaps) {
  const merged = {};
  totalsMaps.forEach(totals => {
    Object.entries(totals || {}).forEach(([currency, amount]) => {
      const value = Number(amount);
      if (!Number.isFinite(value)) return;
      const code = normalise(currency);
      merged[code] = (merged[code] || 0) + value;
    });
  });
  return merged;
}

// Stable display order: USD first when present, then alphabetical.
//
// Deliberately NOT ordered by magnitude, tempting as that is. These figures
// update live (unrealised P&L, market value), and a magnitude sort would let
// the lead currency swap places mid-session as prices move — a sidebar
// number jumping between "$…" and "€…" reads as a glitch. A fixed order is
// predictable and always scannable in the same spot.
export function toTotalsList(totals) {
  return Object.entries(totals || {})
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => {
      if (a.currency === b.currency) return 0;
      if (a.currency === DEFAULT_CURRENCY) return -1;
      if (b.currency === DEFAULT_CURRENCY) return 1;
      return a.currency.localeCompare(b.currency);
    });
}

// The currency a single-value display should lead with — the first in the
// stable order above, so it matches what's rendered first.
export function dominantCurrency(totals) {
  const list = toTotalsList(totals);
  return list.length > 0 ? list[0].currency : DEFAULT_CURRENCY;
}

export function currencyCount(totals) {
  return Object.keys(totals || {}).length;
}

// "$1234.56" for one currency (identical to the previous inline style),
// "$1234.56 · €88.20" once there are several. An empty map renders as zero
// in USD, matching what an empty sum displayed before.
//
// `abs` applies Math.abs to each value, for the call sites that convey sign
// through colour rather than a minus sign.
export function formatTotals(totals, { decimals = 2, abs = false } = {}) {
  const list = toTotalsList(totals);
  if (list.length === 0) return formatMoney(0, DEFAULT_CURRENCY, decimals);
  return list
    .map(({ currency, amount }) => formatMoney(abs ? Math.abs(amount) : amount, currency, decimals))
    .join(' · ');
}
