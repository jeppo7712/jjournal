// The Stats calendar as one continuous run of weeks (Monday to Sunday), the
// way a phone's calendar scrolls, instead of one month at a time. Days are
// 'yyyy-MM-dd' keys throughout: plain calendar dates, so no time zone can
// move them (the trades are already bucketed into days in the chosen zone).

import { formatNumber } from './numberFormat.js';
import { currencyMark, markAmount } from './formatMoney.js';

const DAY_MS = 864e5;
const toUtc = key => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
const fromUtc = ms => new Date(ms).toISOString().slice(0, 10);

export const addDays = (key, n) => fromUtc(toUtc(key) + n * DAY_MS);
export const weekdayIndex = key => (new Date(toUtc(key)).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
export const mondayOf = key => addDays(key, -weekdayIndex(key));
export const monthKey = key => key.slice(0, 7);
export const firstOfMonth = key => `${key.slice(0, 7)}-01`;

// 'yyyy-MM' n months later (or earlier, n < 0).
export function addMonths(month, n) {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

const lastOfMonth = month => addDays(`${addMonths(month, 1)}-01`, -1);

// Every week shown: from the month of the earliest day with trades (at least
// `monthsBack` before today's month) to the end of the month after today's,
// so there is a little room to scroll past today, as in a phone's calendar.
export function calendarWeeks(dayKeys, todayKey, monthsBack = 12) {
  let first = `${addMonths(monthKey(todayKey), -monthsBack)}-01`;
  for (const key of dayKeys) if (key < first) first = firstOfMonth(key);
  const last = lastOfMonth(addMonths(monthKey(todayKey), 1));
  const weeks = [];
  for (let monday = mondayOf(first); monday <= last; monday = addDays(monday, 7)) weeks.push(monday);
  return weeks;
}

export const weekDays = monday => Array.from({ length: 7 }, (_, i) => addDays(monday, i));

// The month a week belongs to for the title and month jumps: the month of its
// Thursday, which holds at least four of its days.
export const weekMonth = monday => monthKey(addDays(monday, 3));

// A week's totals from the per-day data. `daily[key]`: { totalByCurrency,
// trades } (closed trades and partial sales of open ones on that day);
// `closed[key]`: the trades closed that day, which give the wins, losses and
// fees.
export function weekSummary(monday, daily, closed) {
  const totalByCurrency = {};
  const feesByCurrency = {};
  const traded = new Set();
  let wins = 0;
  let losses = 0;
  for (const key of weekDays(monday)) {
    const day = daily[key];
    if (day) {
      for (const [code, amount] of Object.entries(day.totalByCurrency)) totalByCurrency[code] = (totalByCurrency[code] || 0) + amount;
      day.trades.forEach(t => traded.add(t));
    }
    for (const trade of closed[key] || []) {
      if (trade.status === 'WIN') wins += 1;
      if (trade.status === 'LOSS') losses += 1;
      const code = String(trade.currency || 'USD').toUpperCase();
      feesByCurrency[code] = (feesByCurrency[code] || 0) + (trade.buyFee || 0) + (trade.sellFee || 0);
    }
  }
  return { totalByCurrency, feesByCurrency, wins, losses, count: traded.size };
}

// A short amount for a phone-sized day cell: whole units, thousands as "k".
// compactMoney(191.77) -> "$192", compactMoney(-1234, 'EUR') -> "-€1.2k",
// compactMoney(25300) -> "$25k".
export function compactMoney(amount, currency = 'USD') {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  let text;
  if (abs >= 9999.5) text = `${formatNumber(Math.round(n / 1000), 0)}k`;
  else if (abs >= 999.5) text = `${formatNumber(Math.round(n / 100) / 10, 1)}k`;
  else text = formatNumber(Math.round(n), 0);
  return markAmount(currencyMark(currency), text);
}
