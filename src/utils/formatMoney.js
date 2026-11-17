// Money display, in the value's own currency.
//
// Every money value in this app belongs to exactly one currency and is never
// converted: a trade's currency comes from its symbol's settings (see
// resolveTradeCurrency in modules/tradeCalculations.js), a cash row's and a
// holding's are stored on the row. Display has to follow suit — a EUR trade
// rendered with a hardcoded '$' is wrong even before any aggregation is
// involved.
//
// Sign rule for the whole app: a negative amount or percentage carries a
// minus ("-$12.50", "-1.25%") on top of its red colour; a positive one has
// no plus (its green says it). One minus character, the plain hyphen-minus.
//
// Deliberately NOT Intl.NumberFormat: the grouping and decimal mark follow
// the user's number format setting (numberFormat.js), not the browser's
// locale.

import { formatNumber } from './numberFormat.js';

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

// An amount behind its currency mark, with a minus in front of the mark:
// "-$1,234.50", not "$-1,234.50". `text` is an already formatted number.
export function markAmount(mark, text) {
  const value = String(text);
  return value.startsWith('-') ? `-${mark}${value.slice(1)}` : `${mark}${value}`;
}

// formatMoney(12.5, 'EUR') -> "€12.50" (grouping per the number format setting)
// formatMoney(12.5)        -> "$12.50"   (USD default, matches previous behaviour)
// formatMoney(-12.5)       -> "-$12.50"  (pass the signed value, never Math.abs)
export function formatMoney(amount, currency = 'USD', decimals = 2) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '-';
  return markAmount(currencyMark(currency), formatNumber(n, decimals));
}

// For the "amount then code" style used where several currencies are listed
// together and the code needs to read clearly (Capital's balance cards):
// formatMoneyWithCode(5500.00, 'USD') -> "5500.00 USD"
export function formatMoneyWithCode(amount, currency = 'USD', decimals = 2) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '-';
  return `${formatNumber(n, decimals)} ${String(currency || 'USD').toUpperCase()}`;
}
