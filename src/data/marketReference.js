// Built-in reference data used to auto-fill the Settings forms for
// exchanges and futures symbols. None of this is fetched live — there's no
// reliable free API for exchange trading-hour calendars or futures contract
// specs (tick size/value, standard rollover cycle), so this ships as a
// small, curated static table instead, covering exchanges/contracts common
// enough to be worth building in. It's applied automatically when a
// recognized name is typed (see Settings.jsx), and everything it fills
// stays a normal editable field afterward — this is a starting point, not
// a lock.
//
// The exchange grids below are the exchanges' published regular hours, in
// each exchange's own timezone (they used to be copied from a stored
// configuration that had the CME group's hours in New York time under a
// Chicago timezone, one hour late). Holidays and early closes aren't in a
// weekly grid. Settings shows when a stored exchange differs from these and
// offers to use them (see Settings.jsx).

// --- Opening-hours grid builder -------------------------------------------

// "HH:MM" (24h) -> half-hour slot index (0-47). "24:00" -> 48, so a range
// can close out a day (exclusive end).
function timeToSlot(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 2 + (m >= 30 ? 1 : 0);
}

function dayFromRanges(ranges) {
  const day = Array(48).fill(false);
  ranges.forEach(([start, end]) => {
    for (let i = timeToSlot(start); i < timeToSlot(end); i++) day[i] = true;
  });
  return day;
}

const CLOSED_DAY = Array(48).fill(false);

// `week` is keyed Mon..Sun; each value is either an array of [start,end]
// ranges for that day, or 'closed'. Missing days default to closed.
function buildWeeklyGrid(week) {
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  return order.map(day => (week[day] && week[day] !== 'closed' ? dayFromRanges(week[day]) : CLOSED_DAY));
}

// Standard Mon-Fri single-session grid (e.g. regular-hours equity exchanges).
function weekdaySessionGrid(start, end) {
  return buildWeeklyGrid({
    mon: [[start, end]], tue: [[start, end]], wed: [[start, end]],
    thu: [[start, end]], fri: [[start, end]],
  });
}

// --- Exchanges --------------------------------------------------------------
// Keyed by canonical name; `aliases` lets several real-world exchange names
// that share one underlying trading schedule resolve to the same preset
// (e.g. this app's own config already has NYMEX/COMEX/GLOBEX/CME as four
// separate `exchanges` rows with the identical CME Group Globex schedule —
// they trade nearly around the clock on the same electronic platform with
// the same daily maintenance halt, just listing different product groups).
export const EXCHANGE_PRESETS = {
  CME: {
    // CME Globex: equity index, metals (COMEX) and energy (NYMEX) futures.
    // Not CBOT: its grain futures trade different hours.
    aliases: ['CME', 'NYMEX', 'COMEX', 'GLOBEX', 'CME GLOBEX'],
    timezone: 'America/Chicago',
    // Sunday 17:00 to Friday 16:00 CT, with a daily break 16:00-17:00 CT.
    opening_hours: buildWeeklyGrid({
      mon: [['00:00', '16:00'], ['17:00', '24:00']],
      tue: [['00:00', '16:00'], ['17:00', '24:00']],
      wed: [['00:00', '16:00'], ['17:00', '24:00']],
      thu: [['00:00', '16:00'], ['17:00', '24:00']],
      fri: [['00:00', '16:00']],
      sat: 'closed',
      sun: [['17:00', '24:00']],
    }),
  },
  NYSE: {
    aliases: ['NYSE', 'ARCA', 'NYSE ARCA'],
    timezone: 'America/New_York',
    opening_hours: weekdaySessionGrid('09:30', '16:00'),
  },
  NASDAQ: {
    aliases: ['NASDAQ'],
    timezone: 'America/New_York',
    // With pre- and after-market (4:00-20:00 ET): the journal's IBKR bars
    // include extended hours.
    opening_hours: weekdaySessionGrid('04:00', '20:00'),
  },
  EURONEXT: {
    aliases: ['EURONEXT', 'AEB', 'EURONEXT AMSTERDAM'],
    timezone: 'Europe/Amsterdam',
    opening_hours: weekdaySessionGrid('09:00', '17:30'),
  },
  XETRA: {
    aliases: ['XETRA', 'IBIS'],
    timezone: 'Europe/Berlin',
    opening_hours: weekdaySessionGrid('09:00', '17:30'),
  },
  SBF: {
    aliases: ['SBF', 'EURONEXT PARIS'],
    timezone: 'Europe/Paris',
    opening_hours: weekdaySessionGrid('09:00', '17:30'),
  },
  LSE: {
    aliases: ['LSE', 'LSEETF', 'LONDON'],
    timezone: 'Europe/London',
    opening_hours: weekdaySessionGrid('08:00', '16:30'),
  },
  CRYPTO: {
    // Crypto exchanges trade around the clock.
    aliases: ['BYBIT', 'BINANCE', 'COINBASE', 'KRAKEN', 'BITSTAMP', 'PAXOS'],
    timezone: 'UTC',
    opening_hours: buildWeeklyGrid({
      mon: [['00:00', '24:00']], tue: [['00:00', '24:00']], wed: [['00:00', '24:00']],
      thu: [['00:00', '24:00']], fri: [['00:00', '24:00']], sat: [['00:00', '24:00']],
      sun: [['00:00', '24:00']],
    }),
  },
};

// Flat alias -> preset key lookup, built once.
const EXCHANGE_ALIAS_MAP = Object.entries(EXCHANGE_PRESETS).reduce((map, [key, preset]) => {
  preset.aliases.forEach(alias => { map[alias.toUpperCase()] = key; });
  return map;
}, {});

// Whether an exchange's stored timezone and hours are this preset's.
export function matchesExchangePreset(exchange, preset) {
  if (!exchange || !preset) return false;
  if (exchange.timezone !== preset.timezone) return false;
  const hours = exchange.opening_hours;
  return Array.isArray(hours) && hours.length === 7
    && hours.every((day, d) => Array.isArray(day) && day.length === 48 && day.every((open, i) => !!open === preset.opening_hours[d][i]));
}

export function findExchangePreset(name) {
  if (!name) return null;
  const key = EXCHANGE_ALIAS_MAP[name.trim().toUpperCase()];
  return key ? EXCHANGE_PRESETS[key] : null;
}

// --- Futures contracts --------------------------------------------------
// tickSize/tickValue/rolloverMonths are the parts that are genuinely fixed,
// publicly documented CME Group contract specs — not user- or
// broker-specific, so they're safe to trust directly. `typicalMargin` is
// explicitly NOT that: exchange/broker margins move over time and vary by
// broker, so it's only ever offered as an editable starting estimate, never
// silently trusted (see how it's applied in Settings.jsx). `fee` (your own
// commission) isn't looked up at all — there's no way to know that from a
// symbol.
//
// Scope deliberately kept to contracts whose specs are simple, round
// numbers well established from public CME Group documentation. Contracts
// that price in fractional ticks (e.g. Treasury futures in 32nds/64ths) are
// left out for now rather than risk a subtly wrong tick value silently
// corrupting PnL math — ask if you want those added, they just need a more
// careful pass.
export const FUTURES_CONTRACT_PRESETS = {
  // --- Equity index (CME/CBOT) ---
  ES: { name: 'E-mini S&P 500', tickSize: 0.25, tickValue: 12.5, exchange: 'CME', rolloverMonths: [3, 6, 9, 12], typicalMargin: 13200 },
  MES: { name: 'Micro E-mini S&P 500', tickSize: 0.25, tickValue: 1.25, exchange: 'CME', rolloverMonths: [3, 6, 9, 12], typicalMargin: 1320 },
  NQ: { name: 'E-mini Nasdaq-100', tickSize: 0.25, tickValue: 5, exchange: 'CME', rolloverMonths: [3, 6, 9, 12], typicalMargin: 24000 },
  MNQ: { name: 'Micro E-mini Nasdaq-100', tickSize: 0.25, tickValue: 0.5, exchange: 'CME', rolloverMonths: [3, 6, 9, 12], typicalMargin: 2400 },
  YM: { name: 'E-mini Dow', tickSize: 1, tickValue: 5, exchange: 'CME', rolloverMonths: [3, 6, 9, 12], typicalMargin: 10000 },
  MYM: { name: 'Micro E-mini Dow', tickSize: 1, tickValue: 0.5, exchange: 'CME', rolloverMonths: [3, 6, 9, 12], typicalMargin: 1000 },
  RTY: { name: 'E-mini Russell 2000', tickSize: 0.1, tickValue: 5, exchange: 'CME', rolloverMonths: [3, 6, 9, 12], typicalMargin: 7500 },
  M2K: { name: 'Micro E-mini Russell 2000', tickSize: 0.1, tickValue: 0.5, exchange: 'CME', rolloverMonths: [3, 6, 9, 12], typicalMargin: 750 },

  // --- Metals (COMEX) ---
  GC: { name: 'Gold', tickSize: 0.1, tickValue: 10, exchange: 'COMEX', rolloverMonths: [2, 4, 6, 8, 12], typicalMargin: 21828 },
  MGC: { name: 'Micro Gold', tickSize: 0.1, tickValue: 1, exchange: 'COMEX', rolloverMonths: [2, 4, 6, 8, 12], typicalMargin: 5575 },
  SI: { name: 'Silver', tickSize: 0.005, tickValue: 25, exchange: 'COMEX', rolloverMonths: [3, 5, 7, 9, 12], typicalMargin: 25683 },
  SIL: { name: 'Micro Silver', tickSize: 0.005, tickValue: 5, exchange: 'COMEX', rolloverMonths: [3, 5, 7, 9, 12], typicalMargin: 5137 },
  HG: { name: 'Copper', tickSize: 0.0005, tickValue: 12.5, exchange: 'COMEX', rolloverMonths: [3, 5, 7, 9, 12], typicalMargin: 10416 },
  MHG: { name: 'Micro Copper', tickSize: 0.0005, tickValue: 1.25, exchange: 'COMEX', rolloverMonths: [3, 5, 7, 9, 12], typicalMargin: 1042 },
  PL: { name: 'Platinum', tickSize: 0.1, tickValue: 5, exchange: 'NYMEX', rolloverMonths: [1, 4, 7, 10], typicalMargin: 7344 },

  // --- Energy (NYMEX) ---
  CL: { name: 'Crude Oil', tickSize: 0.01, tickValue: 10, exchange: 'NYMEX', rolloverMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], typicalMargin: 16250 },
  MCL: { name: 'Micro Crude Oil', tickSize: 0.01, tickValue: 1, exchange: 'NYMEX', rolloverMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], typicalMargin: 3136 },
  NG: { name: 'Natural Gas', tickSize: 0.001, tickValue: 10, exchange: 'NYMEX', rolloverMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], typicalMargin: 8500 },
};

export function findFuturesPreset(symbol) {
  if (!symbol) return null;
  return FUTURES_CONTRACT_PRESETS[symbol.trim().toUpperCase()] || null;
}
