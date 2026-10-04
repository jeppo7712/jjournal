import { DateTime } from 'luxon';

// The Dashboard's unrealised P&L chart: per currency, per day, what the
// positions open at that day's close were worth against their open cost,
// valued at the symbol's daily close (historicalDataMap: symbol → Map of
// ISO date → close).
//
// Same results as the version that used to live in Dashboard.jsx, made
// fast enough to run on a click: that one re-sorted each trade's dates for
// every day it charted and parsed every price date with luxon, which took
// seconds on a journal with a few years of trades. Here each trade's dates
// are sorted once and walked forward along with the days, and dates are
// compared as ISO strings.

const RELEVANT_STATUS = new Set(['OPEN', 'WIN', 'LOSS', 'WASH']);

const lotsState = (openLots) => {
  let openQty = 0;
  let openCost = 0;
  let openFee = 0;
  for (const lot of openLots) {
    openQty += lot.quantity;
    openCost += lot.price * lot.quantity;
    openFee += lot.fee;
  }
  return { openQty, openCost, openFee, avgOpenCost: openQty > 0 ? openCost / openQty : 0 };
};

// The open lots (FIFO) at the end of each day a trade had a fill, and for a
// trade still open that state holds until today. Returns the days in order
// with the state on each.
export function openLotsByDay(trade) {
  const days = [];
  const states = [];
  const openLots = [];
  const actions = (trade.actions || [])
    .map(action => ({ action, time: DateTime.fromISO(action.dateTime) }))
    .sort((a, b) => a.time - b.time);

  let currentDay = null;
  for (const { action, time } of actions) {
    const actionDay = time.startOf('day').toISODate();
    if (currentDay !== actionDay) {
      if (currentDay) {
        days.push(currentDay);
        states.push(lotsState(openLots));
      }
      currentDay = actionDay;
    }

    const opens = (trade.side === 'LONG' && action.type === 'BUY') || (trade.side === 'SHORT' && action.type === 'SELL');
    const closes = (trade.side === 'LONG' && action.type === 'SELL') || (trade.side === 'SHORT' && action.type === 'BUY');
    if (opens) {
      openLots.push({
        quantity: Number(action.quantity || 0),
        price: Number(action.price || 0),
        fee: Number(action.fee || 0),
      });
    } else if (closes) {
      let closeQty = Number(action.quantity || 0);
      while (closeQty > 0 && openLots.length > 0) {
        const lot = openLots[0];
        const qtyToClose = Math.min(lot.quantity, closeQty);
        // Prorate the lot's remaining fee as it's closed (as matchLotsFIFO
        // in TradeContext.js does), so a partial close's share of it isn't
        // counted again on what stays open.
        lot.fee -= lot.fee * (qtyToClose / lot.quantity);
        lot.quantity -= qtyToClose;
        closeQty -= qtyToClose;
        if (lot.quantity <= 0) openLots.shift();
      }
    }
  }

  if (currentDay) {
    days.push(currentDay);
    states.push(lotsState(openLots));
  }

  // A trade still open keeps its last state up to today: the walk in
  // computeUnrealisedSeries holds the last state at or before each day.
  return { days, states };
}

// The last close on or before `dayISO` (dates as ISO strings sort by date).
function lastCloseOnOrBefore(prices, dayISO) {
  let bestDay = null;
  let best = null;
  for (const [day, close] of prices) {
    if (typeof day !== 'string' || day > dayISO) continue;
    if (bestDay === null || day > bestDay) {
      bestDay = day;
      best = close;
    }
  }
  return best;
}

export function computeUnrealisedSeries(trades, historicalDataMap, { startDate = null, endDate = null, formatLabel = d => d.toFormat('dd/MM/yyyy') } = {}) {
  const relevantTrades = trades.filter(t => RELEVANT_STATUS.has(t.status) && (t.type === 'FUT' || t.type === 'STK'));
  if (relevantTrades.length === 0) return { labels: [], seriesByCurrency: {} };

  const today = DateTime.now().startOf('day');
  const todayISO = today.toISODate();

  const items = relevantTrades.map(trade => {
    const { days, states } = openLotsByDay(trade);
    let tickMultiplier = 1;
    if (trade.type !== 'STK') {
      const tickValue = Number(trade.tick_value || trade.tickValue || 0);
      const tickSize = Number(trade.tick_size || trade.tickSize || 0);
      tickMultiplier = tickValue !== 0 && tickSize !== 0 ? tickValue / tickSize : 1;
    }
    return {
      trade,
      days,
      states,
      next: 0, // index of the first day not yet reached
      lots: null,
      lastPrice: null,
      prices: historicalDataMap[trade.symbol],
      tickMultiplier,
      code: String(trade.currency || 'USD').toUpperCase(),
    };
  });

  const firstDates = relevantTrades
    .map(trade => DateTime.fromISO(trade.firstActionDate).startOf('day'))
    .filter(dt => dt.isValid);
  const earliestDateDefault = firstDates.length > 0 ? firstDates.reduce((min, dt) => (dt < min ? dt : min)) : today;

  const earliestDate = startDate ? DateTime.fromISO(startDate).startOf('day') : earliestDateDefault;
  let latestDate = endDate ? DateTime.fromISO(endDate).startOf('day') : today;
  if (earliestDate > latestDate) {
    if (latestDate > today) latestDate = today;
    if (earliestDate > latestDate) return { labels: [], seriesByCurrency: {} };
  }

  const dayCount = Math.ceil(latestDate.diff(earliestDate, 'days').days) + 1;
  const labels = [];
  // Kept per currency: a EUR position summed into the USD figure would give
  // a number denominated in nothing.
  const seriesCurrencies = [...new Set(items.map(item => item.code))];
  const seriesByCurrency = {};
  seriesCurrencies.forEach(code => { seriesByCurrency[code] = []; });

  for (let i = 0; i < dayCount; i++) {
    const currentDate = earliestDate.plus({ days: i });
    const dayISO = currentDate.toISODate();
    const isToday = dayISO === todayISO;
    labels.push(formatLabel(currentDate));
    const dailyByCurrency = {};

    for (const item of items) {
      // Bring the trade's open lots up to this day.
      while (item.next < item.days.length && item.days[item.next] <= dayISO) {
        item.lots = item.states[item.next];
        item.next += 1;
      }
      const lots = item.lots;
      if (!lots || lots.openQty <= 0) continue;

      const { trade, prices } = item;
      let price = null;
      if (trade.status === 'OPEN' && isToday && trade.currentPrice) {
        price = trade.currentPrice;
      } else if (prices) {
        price = prices.get(dayISO) || null;
        // On the chart's first day, fall back to the last close before it.
        if (price === null && i === 0 && prices.size > 0) {
          price = lastCloseOnOrBefore(prices, dayISO);
        }
      }

      // No price today: carry the last one seen.
      if (price === null && item.lastPrice !== null) {
        price = item.lastPrice;
      } else if (price !== null) {
        item.lastPrice = price;
      } else {
        continue;
      }

      let unrealised = 0;
      if (trade.side === 'LONG') {
        unrealised = (price - lots.avgOpenCost) * lots.openQty * item.tickMultiplier - (lots.openFee || 0);
      } else if (trade.side === 'SHORT') {
        unrealised = (lots.avgOpenCost - price) * lots.openQty * item.tickMultiplier - (lots.openFee || 0);
      }
      dailyByCurrency[item.code] = (dailyByCurrency[item.code] || 0) + unrealised;
    }

    // Every currency gets a point for every label, so the series stay
    // aligned to the shared x-axis.
    seriesCurrencies.forEach(code => {
      seriesByCurrency[code].push(dailyByCurrency[code] || 0);
    });
  }

  return { labels, seriesByCurrency };
}
