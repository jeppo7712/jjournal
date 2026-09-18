// Money display, in the value's own currency.
//
// Every money value in this app belongs to exactly one currency and is never
// converted: a trade's currency comes from its symbol's settings (see
// resolveTradeCurrency in modules/tradeCalculations.js), a cash row's and a
// holding's are stored on the row. Display has to follow suit — a EUR trade
// rendered with a hardcoded '$' is wrong even before any aggregation is
// involved.
//
// Deliberately NOT Intl.NumberFormat: the existing display style is
// `$1234.56` with no thousands separators, and negatives are conveyed by
// colour with Math.abs() at the call site rather than a minus sign. Intl
// would render `$1,234.56` and `-$1,234.56`, silently changing every number
// already on screen. This reproduces the current format exactly so a USD-only
// account looks identical to before, and only the currency mark changes when
// a value genuinely isn't USD.

const CURRENCY_SYMBOLS = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CHF: 'CHF ',
  AED: 'AED ',
  CAD: 'C$',
  AUD: 'A$',
  HKD: 'HK$',
  SEK: 'SEK ',
  NOK: 'NOK ',
  DKK: 'DKK ',
  SGD: 'S$',
};

// The mark that prefixes an amount. An unknown/unlisted code falls back to
// the code itself plus a space ("PLN 1234.56") rather than guessing a glyph —
// unambiguous, and never silently mislabels one currency as another.
export function currencyMark(currency) {
  if (!currency) return CURRENCY_SYMBOLS.USD;
  const code = String(currency).toUpperCase();
  return CURRENCY_SYMBOLS[code] || `${code} `;
}

// formatMoney(39.8, 'EUR') -> "€39.80"
// formatMoney(39.8)        -> "$39.80"   (USD default, matches previous behaviour)
//
// Does not apply a sign: call sites pass Math.abs() and colour the value,
// which is the convention already used throughout the trade views.
export function formatMoney(amount, currency = 'USD', decimals = 2) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '-';
  return `${currencyMark(currency)}${n.toFixed(decimals)}`;
}

// For the "amount then code" style used where several currencies are listed
// together and the code needs to read clearly (Capital's balance cards):
// formatMoneyWithCode(8082.84, 'USD') -> "8082.84 USD"
export function formatMoneyWithCode(amount, currency = 'USD', decimals = 2) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '-';
  return `${n.toFixed(decimals)} ${String(currency || 'USD').toUpperCase()}`;
}
