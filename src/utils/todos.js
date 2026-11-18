// The Todo page's sorting into sections, the menu badge's count, and the
// words for an alert or an order. Plain functions over the items as the API
// returns them (modules/todos.js), so they can be tested without a browser.
//
// Every item sits in exactly one section:
//   needs     fired, or open and past its due_at (any kind)
//   today     open and due later today
//   alerts    other open price alerts
//   orders    other working orders, grouped by account
//   upcoming  todos due after today, grouped by day
//   someday   todos without a date
//   closed    done, dismissed or expired
// "Today" is the day in `zone` (the user's display zone; see todoZone).

import { DateTime } from 'luxon';
import { formatNumber } from './numberFormat.js';

export const CLOSED_STATUSES = ['done', 'dismissed', 'expired'];

// The zone the Todo page shows times in: the user's display-zone choice
// (utils/timezonePreference.js). "Exchange" means nothing for a reminder
// to call someone, so it falls back to this browser's zone, as "local" does.
export function todoZone(displayTimezone) {
  return !displayTimezone || displayTimezone === 'exchange' || displayTimezone === 'local' ? 'local' : displayTimezone;
}

const at = (iso, zone) => DateTime.fromISO(iso, { zone });

// Option A: the page follows the account picker. An item with no account
// belongs to every account; one with an account shows under that account
// and the accounts above it (accountIds: the current account and its
// sub-accounts, as strings or numbers).
export function inScope(item, accountIds) {
  if (item.account_id === null || item.account_id === undefined) return true;
  return accountIds.some(id => String(id) === String(item.account_id));
}

export function sectionOf(item, now, zone) {
  if (CLOSED_STATUSES.includes(item.status)) return 'closed';
  if (item.status === 'fired') return 'needs';
  if (item.due_at) {
    const due = at(item.due_at, zone);
    const nowZ = DateTime.fromJSDate(now, { zone });
    if (due <= nowZ) return 'needs';
    if (due.hasSame(nowZ, 'day')) return 'today';
  }
  if (item.kind === 'trigger') return 'alerts';
  if (item.kind === 'order') return 'orders';
  return item.due_at ? 'upcoming' : 'someday';
}

const ms = (iso) => (iso ? Date.parse(iso) : null);
const byDue = (a, b) => (ms(a.due_at) ?? Infinity) - (ms(b.due_at) ?? Infinity) || ms(a.created_at) - ms(b.created_at);

// { needs, today, upcoming: [{ day, items }], alerts, orders: [{ accountId,
// accountName, items }], someday, closed } — each list in a useful order.
export function groupTodos(items, now, zone) {
  const out = { needs: [], today: [], upcoming: [], alerts: [], orders: [], someday: [], closed: [] };
  const upcoming = new Map();
  const orders = new Map();
  for (const item of items) {
    const section = sectionOf(item, now, zone);
    if (section === 'upcoming') {
      const day = at(item.due_at, zone).toISODate();
      if (!upcoming.has(day)) upcoming.set(day, []);
      upcoming.get(day).push(item);
    } else if (section === 'orders') {
      const key = String(item.account_id ?? '');
      if (!orders.has(key)) orders.set(key, { accountId: item.account_id, accountName: item.account_name || 'No account', items: [] });
      orders.get(key).items.push(item);
    } else {
      out[section].push(item);
    }
  }
  // Fired first (newest first), then overdue (oldest first).
  out.needs.sort((a, b) => (
    (b.status === 'fired') - (a.status === 'fired')
    || (a.status === 'fired' ? ms(b.fired_at) - ms(a.fired_at) : byDue(a, b))
  ));
  out.today.sort(byDue);
  out.alerts.sort((a, b) => (a.trigger?.symbol || '').localeCompare(b.trigger?.symbol || '') || ms(a.created_at) - ms(b.created_at));
  out.someday.sort((a, b) => ms(b.created_at) - ms(a.created_at));
  out.closed.sort((a, b) => ms(b.closed_at) - ms(a.closed_at));
  out.upcoming = [...upcoming.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([day, list]) => ({ day, items: list.sort(byDue) }));
  out.orders = [...orders.values()].sort((a, b) => a.accountName.localeCompare(b.accountName));
  for (const group of out.orders) {
    group.items.sort((a, b) => (a.order?.symbol || '').localeCompare(b.order?.symbol || '') || ms(a.created_at) - ms(b.created_at));
  }
  return out;
}

// The menu badge: fired items the user hasn't seen, plus open items due
// today or overdue.
export function badgeCount(items, now, zone) {
  const nowZ = DateTime.fromJSDate(now, { zone });
  const endOfToday = nowZ.endOf('day');
  return items.reduce((n, item) => {
    if (item.status === 'fired') return n + (item.seen_at ? 0 : 1);
    if (item.status === 'open' && item.due_at && at(item.due_at, zone) <= endOfToday) return n + 1;
    return n;
  }, 0);
}

// Open but past its expiry: the agent will lapse it; shown greyed till then.
export const isLapsing = (item, now) => item.status === 'open' && !!item.expires_at && ms(item.expires_at) <= now.getTime();

// --- Words ---

const CONDITION_WORDS = {
  touch: 'trades',
  close_1m: '1-minute close',
  close_1d: 'daily close',
  close_1w: 'weekly close',
};
export const CONDITION_LABELS = [
  { value: 'touch', label: 'Touch' },
  { value: 'close_1m', label: '1-minute close (futures)' },
  { value: 'close_1d', label: 'Daily close' },
  { value: 'close_1w', label: 'Weekly close' },
];

// Up to 8 decimals, trailing zeros dropped, but at least 2 ("42.50").
export function price(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  const text = formatNumber(n, 8, true);
  const decimals = (String(n).split('.')[1] || '').length;
  return decimals >= 2 ? text : formatNumber(n, 2);
}

// The same in plain digits ("42.50", never "42,50" or "1.234,50"), for text
// that's saved (a title made from an alert or order): the agent reads it
// too, and the display format is only this app's.
export function plainPrice(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  const decimals = (String(n).split('.')[1] || '').length;
  return decimals >= 2 ? String(n) : n.toFixed(2);
}

const instrument = (spec) => `${spec.symbol}${spec.contract_month ? ` ${spec.contract_month}` : ''}`;

// "ABC: weekly close below 42.50", "MES 202606: trades above 5000.00".
// fmt: price (the display format) or plainPrice (for saved text).
export function describeTrigger(trigger, fmt = price) {
  if (!trigger) return '';
  const voids = [
    trigger.void_above && `void above ${fmt(trigger.void_above)}`,
    trigger.void_below && `void below ${fmt(trigger.void_below)}`,
  ].filter(Boolean);
  return `${instrument(trigger)}: ${CONDITION_WORDS[trigger.condition] || trigger.condition} ${trigger.direction} ${fmt(trigger.level)}`
    + (voids.length ? ` (${voids.join(', ')})` : '');
}

// "BUY 10 ETFA.DE LMT 95.50", "SELL 2 MES 202606 STP LMT 4990.00 / 4985.00"
export function describeOrder(order, fmt = price) {
  if (!order) return '';
  const prices = order.order_type === 'STP LMT'
    ? `${fmt(order.stop_price)} / ${fmt(order.limit_price)}`
    : fmt(order.limit_price ?? order.stop_price);
  const quantity = fmt === price ? formatNumber(Number(order.quantity), 8, true) : String(Number(order.quantity));
  return [order.side, quantity, instrument(order), order.order_type, prices]
    .filter(Boolean).join(' ') + (order.currency ? ` ${order.currency}` : '');
}

// "GTD 20 Mar 2026", "DAY", "GTC"; plus a bracket's stop and target.
export function describeOrderTerms(order) {
  if (!order) return '';
  const tif = order.tif === 'GTD' && order.good_till
    ? `GTD ${DateTime.fromISO(order.good_till).toFormat('d LLL yyyy')}`
    : order.tif;
  const bracket = [
    order.stop_loss && `stop ${price(order.stop_loss)}`,
    order.profit_target && `target ${price(order.profit_target)}`,
  ].filter(Boolean);
  return [tif, ...bracket].join(' · ');
}

// The words the page uses for a status, per kind.
export function statusLabel(item) {
  if (item.kind === 'order') {
    return { open: 'Working', fired: 'Reminder due', done: 'Filled', dismissed: 'Cancelled', expired: 'Expired' }[item.status];
  }
  if (item.kind === 'trigger') {
    return { open: 'Armed', fired: 'Fired', done: 'Done', dismissed: 'Dismissed', expired: 'Expired' }[item.status];
  }
  return { open: 'Open', fired: 'Due', done: 'Done', dismissed: 'Dismissed', expired: 'Expired' }[item.status];
}

// "14:00" today, "Thu 14:00" within a week, "Thu 5 Mar 14:00" otherwise
// (with the year when it isn't this year's).
export function whenText(iso, now, zone) {
  if (!iso) return '';
  const t = at(iso, zone);
  const nowZ = DateTime.fromJSDate(now, { zone });
  if (t.hasSame(nowZ, 'day')) return t.toFormat('HH:mm');
  if (Math.abs(t.diff(nowZ, 'days').days) < 6) return t.toFormat('ccc HH:mm');
  return t.toFormat(t.hasSame(nowZ, 'year') ? 'ccc d LLL HH:mm' : 'ccc d LLL yyyy HH:mm');
}

// "Today", "Tomorrow", "Thu 5 Mar" (+ year when not this year's) for a day key.
export function dayHeading(dayKey, now, zone) {
  const nowZ = DateTime.fromJSDate(now, { zone }).startOf('day');
  const day = DateTime.fromISO(dayKey, { zone });
  const diff = Math.round(day.diff(nowZ, 'days').days);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return day.toFormat(day.hasSame(nowZ, 'year') ? 'cccc d LLLL' : 'cccc d LLLL yyyy');
}

// --- Times in the form ---

// A date ('2026-03-05') and time ('14:00') in `zone` → an ISO time in UTC.
export function toUtcIso(dateValue, timeValue, zone) {
  if (!dateValue) return null;
  const t = DateTime.fromISO(`${dateValue}T${timeValue || '09:00'}`, { zone });
  return t.isValid ? t.toUTC().toISO() : null;
}

// An ISO time → { date, time } in `zone`, for the form's inputs.
export function fromUtcIso(iso, zone) {
  if (!iso) return { date: '', time: '' };
  const t = at(iso, zone);
  return { date: t.toISODate(), time: t.toFormat('HH:mm') };
}

// The snooze choices for an item: an hour from now, tomorrow at its own
// time of day (or 09:00 when it has none).
export function snoozeTimes(item, now, zone) {
  const nowZ = DateTime.fromJSDate(now, { zone });
  const due = item.due_at ? at(item.due_at, zone) : null;
  const tomorrow = nowZ.plus({ days: 1 }).set({
    hour: due ? due.hour : 9, minute: due ? due.minute : 0, second: 0, millisecond: 0,
  });
  return {
    hour: nowZ.plus({ hours: 1 }).set({ second: 0, millisecond: 0 }).toUTC().toISO(),
    tomorrow: tomorrow.toUTC().toISO(),
  };
}

// --- The Todo calendar ---

// The day an item sits on in the Todo calendar ('yyyy-MM-dd' in `zone`), or
// null: a fired item on the day it fired, an order on its good-till date
// (else its reminder), anything else on its due_at.
export function calendarDayOf(item, zone) {
  if (item.status === 'fired' && item.fired_at) return at(item.fired_at, zone).toISODate();
  if (item.kind === 'order' && item.order?.good_till) return item.order.good_till;
  return item.due_at ? at(item.due_at, zone).toISODate() : null;
}

// { 'yyyy-MM-dd': [items] }, each day's items by time.
export function itemsByDay(items, zone) {
  const days = {};
  for (const item of items) {
    const day = calendarDayOf(item, zone);
    if (day) (days[day] = days[day] || []).push(item);
  }
  for (const list of Object.values(days)) list.sort(byDue);
  return days;
}

// The weeks the Todo calendar runs through (Mondays, 'yyyy-MM-dd'): from the
// month before today's (or the earliest item's month) to the end of the
// month after today's (or the latest item's month), so a far-off order's
// good-till date can be scrolled to.
export function todoCalendarWeeks(dayKeys, todayKey) {
  const monthStart = key => DateTime.fromISO(`${key.slice(0, 7)}-01`);
  const today = monthStart(todayKey);
  let first = today.minus({ months: 1 });
  let last = today.plus({ months: 1 });
  for (const key of dayKeys) {
    const m = monthStart(key);
    if (m < first) first = m;
    if (m > last) last = m;
  }
  const end = last.endOf('month').toISODate();
  const weeks = [];
  for (let monday = first.minus({ days: first.weekday - 1 }); monday.toISODate() <= end; monday = monday.plus({ weeks: 1 })) {
    weeks.push(monday.toISODate());
  }
  return weeks;
}

// What the Dashboard's Today card counts, over the items in scope:
// overdue and due today (open), fired ones not seen yet, working orders and
// armed price alerts.
export function todaySummary(items, now, zone) {
  const out = { overdue: 0, dueToday: 0, fired: 0, orders: 0, alerts: 0, top: [] };
  for (const item of items) {
    if (item.status === 'fired') {
      if (!item.seen_at) { out.fired += 1; out.top.push(item); }
      continue;
    }
    if (item.status !== 'open') continue;
    if (item.kind === 'order') out.orders += 1;
    if (item.kind === 'trigger') out.alerts += 1;
    const section = sectionOf(item, now, zone);
    if (section === 'needs') { out.overdue += 1; out.top.push(item); }
    else if (section === 'today') { out.dueToday += 1; out.top.push(item); }
  }
  out.top.sort((a, b) => (b.status === 'fired') - (a.status === 'fired') || byDue(a, b));
  return out;
}
