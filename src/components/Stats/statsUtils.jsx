import { DateTime } from 'luxon';
import { currencyMark } from '../../utils/formatMoney';
import { matchLotsFIFO, getTickMultiplier } from '../../context/TradeContext';

// The Stats page scopes itself to exactly one currency before calling into
// here (see activeCurrency in Stats.jsx) — these ratios and distributions
// are only meaningful within one currency, so every array reaching these
// functions is single-currency by construction. That means the mark can be
// read off the set itself rather than threaded through ~28 signatures.
// Falls back to USD for an empty set, where there's nothing to label anyway.
const markFor = (trades) => currencyMark((Array.isArray(trades) && trades[0] && trades[0].currency) || 'USD');

const toDT = (value) => {
  if (!value) return null;
  if (DateTime.isDateTime(value)) return value;
  if (value instanceof Date) return DateTime.fromJSDate(value);
  return DateTime.fromISO(String(value));
};

const tradeFees = (t) => (t.buyFee || 0) + (t.sellFee || 0);

// Long-term positions are mostly OPEN trades, and the trade-outcome stats
// (win rate, profit factor, streaks...) rightly ignore them. But money
// still moves while a trade is open: selling part of a position locks in
// P&L even though the trade stays OPEN. These are those partial closes,
// one event per closing fill, dated when it happened.
export const computePartialRealizations = (trades) => {
  const events = [];
  trades.forEach(t => {
    if (t.status !== 'OPEN') return;
    const { timeline } = matchLotsFIFO(t, getTickMultiplier(t));
    let previous = 0;
    timeline.forEach(step => {
      const amount = step.realisedPnL - previous;
      previous = step.realisedPnL;
      const date = toDT(step.dateTime);
      if (Math.abs(amount) > 1e-9 && date && date.isValid) {
        events.push({ date, amount, symbol: t.symbol });
      }
    });
  });
  return events;
};

// Every realised P&L event: a closed trade's return on its closing date,
// plus the partial closes of still-open trades above. What date-bucketed
// P&L (days, months) is built from.
const realizationEvents = (trades) => {
  const events = trades
    .filter(t => t.status !== 'OPEN')
    .map(t => ({ date: toDT(t.lastActionDate), amount: t.return || 0, symbol: t.symbol }))
    .filter(e => e.date && e.date.isValid);
  return events.concat(computePartialRealizations(trades));
};


// General Performance Stats
export const computeGeneralStats = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  const totalTrades = closedTrades.length;
  const winTrades = closedTrades.filter(t => t.status === 'WIN').length;
  const lossTrades = closedTrades.filter(t => t.status === 'LOSS').length;
  // Win rate excludes WASH trades from the denominator — a wash is neither a
  // win nor a loss, so it shouldn't dilute the rate (5 wins + 5 washes is a
  // 100% win rate among decided trades, not 50%).
  const decidedTrades = winTrades + lossTrades;
  const winRate = decidedTrades > 0 ? (winTrades / decidedTrades * 100).toFixed(2) : 'N/A';
  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.return || 0), 0);
  const avgPnl = totalTrades > 0 ? (totalPnl / totalTrades).toFixed(2) : 'N/A';
  const profitFactor = computeProfitFactor(closedTrades);
  // All fees paid, open trades included — see computeFeeAnalysis.
  const totalFees = trades.reduce((sum, t) => sum + tradeFees(t), 0).toFixed(2);
  const partialPnl = computePartialRealizations(trades).reduce((sum, e) => sum + e.amount, 0);

  return [
    { label: 'Total Trades', value: totalTrades },
    { label: 'Wins', value: winTrades },
    { label: 'Losses', value: lossTrades },
    { label: 'Win Rate', value: `${winRate}%` },
    { label: 'Profit Factor', value: profitFactor },
    { label: 'Total P&L', value: `${markFor(trades)}${totalPnl.toFixed(2)}` },
    { label: 'Avg P&L per Trade', value: `${markFor(trades)}${avgPnl}` },
    { label: 'Total Fees', value: `${markFor(trades)}${totalFees}` },
    ...(Math.abs(partialPnl) > 1e-9
      ? [{ label: 'P&L from Partial Sells', value: `${markFor(trades)}${partialPnl.toFixed(2)}` }]
      : []),
  ];
};

// Risk Metrics
export const computeRiskMetrics = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  const { maxDrawdown } = computeDrawdowns(closedTrades);
  const sharpeRatio = computeSharpeRatio(closedTrades);
  const sortinoRatio = computeSortinoRatio(closedTrades);

  return [
    { label: 'Max Drawdown', value: `${markFor(trades)}${maxDrawdown.toFixed(2)}` },
    { label: 'Sharpe Ratio', value: sharpeRatio },
    { label: 'Sortino Ratio', value: sortinoRatio },
  ];
};

// Trade Analysis
export const computeTradeAnalysis = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  const avgHoldTime = computeAvgHoldTime(closedTrades);
  const tradesPerDay = computeTradesPerDay(closedTrades);
  const { bestTrade, worstTrade } = computeBestWorstTrades(closedTrades);
  const { winStreak, lossStreak } = computeStreaks(closedTrades);

  return [
    { label: 'Avg Holding Time', value: avgHoldTime },
    { label: 'Avg Trades per Day', value: tradesPerDay },
    { label: 'Best Trade', value: `${markFor(trades)}${bestTrade.toFixed(2)}` },
    { label: 'Worst Trade', value: `${markFor(trades)}${worstTrade.toFixed(2)}` },
    { label: 'Win Streak', value: winStreak },
    { label: 'Loss Streak', value: lossStreak },
  ];
};

// Symbol-Specific Stats
export const computeSymbolStats = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  const grouped = groupBySymbol(closedTrades);
  const allBySymbol = groupBySymbol(trades);
  return Object.keys(grouped).map(symbol => {
    const symbolTrades = grouped[symbol];
    const totalPnl = symbolTrades.reduce((sum, t) => sum + (t.return || 0), 0);
    // Excludes WASH trades from the denominator — see computeGeneralStats.
    const symbolWins = symbolTrades.filter(t => t.status === 'WIN').length;
    const symbolDecided = symbolWins + symbolTrades.filter(t => t.status === 'LOSS').length;
    const winRate = symbolDecided > 0 ? (symbolWins / symbolDecided * 100).toFixed(2) : 'N/A';
    const totalFees = allBySymbol[symbol].reduce((sum, t) => sum + tradeFees(t), 0).toFixed(2);

    return {
      symbol,
      stats: [
        { label: 'Total P&L', value: `${markFor(trades)}${totalPnl.toFixed(2)}` },
        { label: 'Win Rate', value: `${winRate}%` },
        { label: 'Total Fees', value: `${markFor(trades)}${totalFees}` },
      ],
    };
  });
};

// Fee Analysis
// Open trades count too: a fee is paid when the fill happens, not when the
// position closes, so an account holding only open positions has still
// paid real fees. (Fees as % of P&L below stays closed-only — it compares
// against realized P&L.)
export const computeFeeAnalysis = (trades) => {
  const totalFees = trades.reduce((sum, t) => sum + (t.buyFee || 0) + (t.sellFee || 0), 0);
  const avgFeesPerTrade = trades.length > 0 ? (totalFees / trades.length).toFixed(2) : 'N/A';
  const feesPerMonth = computeFeesPerMonth(trades);
  const feesPerSymbol = computeFeesPerSymbol(trades);

  return {
    totalFees: totalFees.toFixed(2),
    avgFeesPerTrade,
    feesPerMonth,
    feesPerSymbol,
  };
};

// Helper Functions
const computeProfitFactor = (trades) => {
  const winSum = trades.reduce((sum, t) => (t.status === 'WIN' ? sum + (t.return || 0) : sum), 0);
  const lossSum = trades.reduce((sum, t) => (t.status === 'LOSS' ? sum + Math.abs(t.return || 0) : sum), 0);
  return lossSum !== 0 ? (winSum / lossSum).toFixed(2) : winSum > 0 ? 'Infinity' : 'N/A';
};

const computeDrawdowns = (trades) => {
  const sortedTrades = trades.sort((a, b) => new Date(a.lastActionDate) - new Date(b.lastActionDate));
  let cumulativePnl = 0;
  let peak = 0;
  let maxDrawdown = 0;
  sortedTrades.forEach(t => {
    cumulativePnl += t.return || 0;
    peak = Math.max(peak, cumulativePnl);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulativePnl);
  });
  return { maxDrawdown };
};

const computeSharpeRatio = (trades) => {
  if (trades.length < 2) return 'N/A';
  const returns = trades.map(t => t.return || 0);
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const stdDev = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1));
  return stdDev !== 0 ? (avgReturn / stdDev).toFixed(2) : 'N/A';
};

const computeSortinoRatio = (trades) => {
  if (trades.length < 2) return 'N/A';
  const returns = trades.map(t => t.return || 0);
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const downsideReturns = returns.filter(r => r < 0);
  const downsideDev = downsideReturns.length > 0 ? Math.sqrt(downsideReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / trades.length) : 0;
  return downsideDev !== 0 ? (avgReturn / downsideDev).toFixed(2) : 'N/A';
};

const computeAvgHoldTime = (trades) => {
  const totalHoldTime = trades.reduce((sum, t) => {
    if (t.firstActionDate && t.lastActionDate) {
      const first = DateTime.fromISO(t.firstActionDate);
      const last = DateTime.fromISO(t.lastActionDate);
      return sum + (last - first) / (1000 * 3600);
    }
    return sum;
  }, 0);
  return trades.length > 0 ? `${(totalHoldTime / trades.length).toFixed(2)} hours` : 'N/A';
};

const computeTradesPerDay = (trades) => {
  const tradingDays = new Set(trades.map(t => DateTime.fromISO(t.lastActionDate).toISODate()));
  return tradingDays.size > 0 ? (trades.length / tradingDays.size).toFixed(2) : 'N/A';
};

const computeBestWorstTrades = (trades) => {
  const returns = trades.map(t => t.return || 0);
  return {
    bestTrade: trades.length > 0 ? Math.max(...returns) : 0,
    worstTrade: trades.length > 0 ? Math.min(...returns) : 0,
  };
};

// Longest consecutive run of WINs / LOSSes. A WASH (or any other non-WIN/LOSS
// closed status) doesn't break a streak — it's skipped rather than resetting
// the count, since a wash is neither a win nor a loss.
const computeStreakExtremes = (trades) => {
  let maxWinStreak = 0, maxLossStreak = 0, currentWin = 0, currentLoss = 0;
  trades.forEach(t => {
    if (t.status === 'WIN') {
      currentWin++;
      currentLoss = 0;
      maxWinStreak = Math.max(maxWinStreak, currentWin);
    } else if (t.status === 'LOSS') {
      currentLoss++;
      currentWin = 0;
      maxLossStreak = Math.max(maxLossStreak, currentLoss);
    }
  });
  return { maxWinStreak, maxLossStreak };
};

const computeStreaks = (trades) => {
  const { maxWinStreak, maxLossStreak } = computeStreakExtremes(trades);
  return { winStreak: maxWinStreak, lossStreak: maxLossStreak };
};

const groupBySymbol = (trades) => {
  return trades.reduce((acc, trade) => {
    const symbol = trade.symbol;
    if (!acc[symbol]) acc[symbol] = [];
    acc[symbol].push(trade);
    return acc;
  }, {});
};

// By each fill's own date: a position built up over months paid its fees
// in those months, not all in the month of its latest fill.
const computeFeesPerMonth = (trades) => {
  const feesByMonth = {};
  trades.forEach(t => {
    (Array.isArray(t.actions) ? t.actions : []).forEach(a => {
      const fee = Number(a.fee || 0);
      const date = toDT(a.dateTime);
      if (!fee || !date || !date.isValid) return;
      const month = date.toFormat('yyyy-MM');
      feesByMonth[month] = (feesByMonth[month] || 0) + fee;
    });
  });
  return feesByMonth;
};

const computeFeesPerSymbol = (trades) => {
  const feesBySymbol = {};
  trades.forEach(t => {
    const symbol = t.symbol;
    const fees = (t.buyFee || 0) + (t.sellFee || 0);
    feesBySymbol[symbol] = (feesBySymbol[symbol] || 0) + fees;
  });
  return feesBySymbol;
};


export const computeOpenTradeStats = (trades) => {
  const openTrades = trades.filter(t => t.status === 'OPEN');
  const totalOpenTrades = openTrades.length;
  const totalOpenPnl = openTrades.reduce((sum, t) => sum + (t.currentReturn || 0), 0);
  const avgOpenPnl = totalOpenTrades > 0 ? (totalOpenPnl / totalOpenTrades).toFixed(2) : 'N/A';

  return [
    { label: 'Total Open Trades', value: totalOpenTrades },
    { label: 'Total Open P&L', value: `${markFor(trades)}${totalOpenPnl.toFixed(2)}` },
    { label: 'Avg Open P&L per Trade', value: `${markFor(trades)}${avgOpenPnl}` },
  ];
};

export const computeOpenSymbolStats = (trades) => {
  const openTrades = trades.filter(t => t.status === 'OPEN');
  const grouped = groupBySymbol(openTrades);
  return Object.keys(grouped).map(symbol => {
    const symbolTrades = grouped[symbol];
    const totalOpenPnl = symbolTrades.reduce((sum, t) => sum + (t.currentReturn || 0), 0);
    const avgOpenPnl = symbolTrades.length > 0 ? (totalOpenPnl / symbolTrades.length).toFixed(2) : 'N/A';

    return {
      symbol,
      stats: [
        { label: 'Total Open P&L', value: `${markFor(trades)}${totalOpenPnl.toFixed(2)}` },
        { label: 'Avg Open P&L per Trade', value: `${markFor(trades)}${avgOpenPnl}` },
      ],
    };
  });
};

// Every symbol, ranked by what it has made overall: realised P&L (closed
// trades and partial sells) plus the unrealised P&L of what's still held.
// Closed-trades-only would rank a long-held winner that was never sold at 0.
export const computeBestPerformingAssets = (trades) => {
  const bySymbol = {};
  const row = (symbol) => (bySymbol[symbol] = bySymbol[symbol] || { symbol, realizedPnl: 0, unrealizedPnl: 0 });
  realizationEvents(trades).forEach(e => { row(e.symbol).realizedPnl += e.amount; });
  trades.forEach(t => {
    if (t.status === 'OPEN') row(t.symbol).unrealizedPnl += t.currentReturn || 0;
  });
  return Object.values(bySymbol)
    .map(r => ({ ...r, totalPnl: r.realizedPnl + r.unrealizedPnl }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
};

// Open positions per symbol, valued at the current price. Market value is
// only meaningful for stocks/ETFs (a futures position's notional isn't
// money you hold), so futures show their unrealised P&L but carry no value
// or allocation share. `pricesPending` while live prices are still loading.
export const computeHoldings = (trades) => {
  const openTrades = trades.filter(t => t.status === 'OPEN' && t.symbol);
  const realizedBySymbol = {};
  realizationEvents(trades).forEach(e => {
    realizedBySymbol[e.symbol] = (realizedBySymbol[e.symbol] || 0) + e.amount;
  });
  const feesBySymbol = {};
  trades.forEach(t => { feesBySymbol[t.symbol] = (feesBySymbol[t.symbol] || 0) + tradeFees(t); });

  const bySymbol = {};
  let pricesPending = false;
  openTrades.forEach(t => {
    const r = bySymbol[t.symbol] = bySymbol[t.symbol] || {
      symbol: t.symbol, type: t.type, quantity: 0, costBasis: 0, openCost: 0,
      marketValue: t.type === 'STK' ? 0 : null, unrealizedPnl: 0, currentPrice: null, priced: true,
    };
    const multiplier = getTickMultiplier(t);
    const signedQty = (t.side === 'SHORT' ? -1 : 1) * Number(t.position || 0);
    r.quantity += signedQty;
    const sideSign = t.side === 'SHORT' ? -1 : 1;
    r.openCost += Number(t.entryTotal || 0) * sideSign;
    r.costBasis += Number(t.entryTotal || 0) * multiplier * sideSign;
    if (t.currentPrice === null || t.currentPrice === undefined) {
      r.priced = false;
      pricesPending = true;
      return;
    }
    r.currentPrice = t.currentPrice;
    r.unrealizedPnl += t.currentReturn || 0;
    if (r.marketValue !== null) r.marketValue += signedQty * t.currentPrice * multiplier;
  });

  const rows = Object.values(bySymbol).map(r => ({
    ...r,
    avgCost: r.quantity ? r.openCost / r.quantity : null,
    unrealizedPct: r.type === 'STK' && r.costBasis ? (r.unrealizedPnl / Math.abs(r.costBasis)) * 100 : null,
    realizedPnl: realizedBySymbol[r.symbol] || 0,
    fees: feesBySymbol[r.symbol] || 0,
  }));
  const totalMarketValue = rows.reduce((sum, r) => sum + (r.marketValue || 0), 0);
  rows.forEach(r => {
    r.allocationPct = r.marketValue !== null && totalMarketValue ? (r.marketValue / totalMarketValue) * 100 : null;
  });
  rows.sort((a, b) => (b.marketValue ?? -Infinity) - (a.marketValue ?? -Infinity));

  const stockCost = rows.filter(r => r.type === 'STK').reduce((sum, r) => sum + r.costBasis, 0);
  const unrealizedPnl = rows.reduce((sum, r) => sum + r.unrealizedPnl, 0);
  const realizedPnl = realizationEvents(trades).reduce((sum, e) => sum + e.amount, 0);
  return {
    rows,
    pricesPending,
    totals: {
      marketValue: totalMarketValue,
      costBasis: stockCost,
      unrealizedPnl,
      unrealizedPct: stockCost ? (rows.filter(r => r.type === 'STK').reduce((sum, r) => sum + r.unrealizedPnl, 0) / Math.abs(stockCost)) * 100 : null,
      realizedPnl,
      totalPnl: realizedPnl + unrealizedPnl,
      fees: trades.reduce((sum, t) => sum + tradeFees(t), 0),
    },
  };
};

// Compute Distribution of Trade Returns
export const computeReturnDistribution = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN' && t.returnPercentage !== undefined);
  if (!closedTrades.length) return { labels: [], data: [] };

  const buckets = Array(20).fill(0); // 20 buckets from -50% to +50%
  const bucketSize = 5; // 5% per bucket
  const labels = Array.from({ length: 20 }, (_, i) => {
    const start = -50 + i * bucketSize;
    return `${start}% to ${start + bucketSize}%`;
  });

  closedTrades.forEach(t => {
    const returnPercent = Math.max(-50, Math.min(50, t.returnPercentage)); // Clamp to [-50, 50]
    // At exactly +50% this would compute index 20, one past the last bucket
    // (19, "45% to 50%") — clamp the index too, not just the input value.
    const bucketIndex = Math.min(buckets.length - 1, Math.floor((returnPercent + 50) / bucketSize));
    buckets[bucketIndex]++;
  });

  return { labels, data: buckets };
};

// Compute Win Rate Over Time
export const computeWinRateSeries = (trades) => {
  const closedTrades = trades.filter(t => t.status === 'WIN' || t.status === 'LOSS').sort((a, b) => DateTime.fromISO(a.lastActionDate) - DateTime.fromISO(b.lastActionDate));
  if (closedTrades.length < 20) return { labels: [], data: [] };

  const windowSize = 20;
  const labels = [];
  const data = [];

  for (let i = windowSize - 1; i < closedTrades.length; i++) {
    const window = closedTrades.slice(i - windowSize + 1, i + 1);
    const wins = window.filter(t => t.status === 'WIN').length;
    const winRate = (wins / windowSize) * 100;
    const date = DateTime.fromISO(closedTrades[i].lastActionDate).toFormat('dd/MM/yyyy');
    labels.push(date);
    data.push(winRate);
  }

  return { labels, data };
};

// Compute Heatmap of Trading Activity
export const computeTradingActivityHeatmap = (trades, zone = 'local') => {
  const heatmap = Array(7).fill().map(() => Array(24).fill(0)); // 7 days x 24 hours
  trades.forEach(t => {
    if (t.firstActionDate) {
      const date = t.firstActionDate.setZone(zone);
      const day = date.weekday % 7; // 0 = Sunday, 6 = Saturday
      const hour = date.hour;
      heatmap[day][hour]++;
    }
  });

  const maxValue = Math.max(...heatmap.flat());
  return { heatmap, maxValue };
};

// Allocation of open stock/ETF positions by current market value (quantity
// x current price). Used to be sized by |unrealised P&L|, which made a
// position at break-even invisible and a small losing one look large.
export const computeOpenPositionsPie = (trades) => {
  const rows = computeHoldings(trades).rows.filter(r => r.marketValue !== null && r.marketValue > 0);
  return { labels: rows.map(r => r.symbol), data: rows.map(r => r.marketValue) };
};

// Compute Top Winning and Losing Trades
export const computeTopTrades = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN' && t.return !== undefined).sort((a, b) => b.return - a.return);
  const topWins = closedTrades.slice(0, 5).map(t => ({
    symbol: t.symbol,
    return: t.return,
    date: DateTime.fromISO(t.lastActionDate).toFormat('dd/MM/yyyy'),
  }));
  const topLosses = closedTrades.slice(-5).reverse().map(t => ({
    symbol: t.symbol,
    return: t.return,
    date: DateTime.fromISO(t.lastActionDate).toFormat('dd/MM/yyyy'),
  }));
  return { topWins, topLosses };
};

// Compute Fees as Percentage of P&L
export const computeFeesPnlSeries = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN' && t.lastActionDate && DateTime.fromISO(t.lastActionDate).isValid);
  if (!closedTrades.length) return { labels: [], data: [] };

  const monthlyData = closedTrades.reduce((acc, t) => {
    const month = DateTime.fromISO(t.lastActionDate).toFormat('yyyy-MM');
    const fees = Number(t.buyFee || 0) + Number(t.sellFee || 0);
    const pnl = Number(t.return || 0);
    if (!acc[month]) acc[month] = { fees: 0, pnl: 0 };
    acc[month].fees += fees;
    acc[month].pnl += Math.abs(pnl);
    return acc;
  }, {});

  const labels = Object.keys(monthlyData).sort();
  const data = labels.map(month => (
    monthlyData[month].pnl > 0 ? (monthlyData[month].fees / monthlyData[month].pnl) * 100 : 0
  ));

  return { labels, data };
};

// Compute Scatter Plot of Return vs. Hold Time
export const computeReturnVsHoldTime = (trades) => {
  const closedTrades = trades.filter(
    t => t.status !== 'OPEN' &&
         t.returnPercentage != null &&
         t.firstActionDate &&
         t.lastActionDate &&
         DateTime.fromISO(t.firstActionDate).isValid &&
         DateTime.fromISO(t.lastActionDate).isValid
  );
  if (!closedTrades.length) return { data: [] };

  const data = closedTrades.map(t => {
    const holdTime = (DateTime.fromISO(t.lastActionDate) - DateTime.fromISO(t.firstActionDate)) / (1000 * 3600); // Hours
    return {
      x: isNaN(holdTime) ? 0 : holdTime,
      y: isNaN(Number(t.returnPercentage)) ? 0 : Number(t.returnPercentage),
    };
  }).filter(d => d.x >= 0); // Exclude negative hold times

  return { data };
};

// Cumulative P&L per day over the last 3 years (at most): realised P&L so
// far plus the unrealised P&L of whatever was open at that day's close,
// valued at the symbol's daily close (historicalDataMap). Realised-only
// used to leave an account of long-held positions flat at 0 until something
// was sold. Each trade's position is replayed fill by fill (matchLotsFIFO's
// timeline), so a trade held over several days is valued on each of them
// and a partial sell realises P&L on the day it happened. Without a close
// for a day, the last known close — or the last fill price — is used.
export const computePortfolioValueSeries = (trades, historicalDataMap) => {
  if (!trades.length) return { labels: [], series: [], realizedSeries: [] };

  const today = DateTime.now().startOf('day');
  const maxDays = 3 * 365;
  const firstDate = trades
    .map(t => toDT(t.firstActionDate))
    .filter(dt => dt && dt.isValid)
    .reduce((min, dt) => (dt < min ? dt : min), today)
    .startOf('day');
  const startDate = firstDate > today.minus({ days: maxDays }) ? firstDate : today.minus({ days: maxDays });
  const days = Math.ceil(today.diff(startDate, 'days').days) + 1;

  const replays = trades.map(t => {
    const multiplier = getTickMultiplier(t);
    const steps = matchLotsFIFO(t, multiplier).timeline
      .map(step => ({ ...step, at: toDT(step.dateTime) }))
      .filter(step => step.at && step.at.isValid);
    return { trade: t, multiplier, sign: t.side === 'SHORT' ? -1 : 1, steps, next: 0 };
  });
  // Trades whose side can't be replayed (no fills) still count their
  // return on the closing date, as before.
  const unreplayable = trades.filter((t, i) => replays[i].steps.length === 0 && t.status !== 'OPEN');

  const lastClose = {};
  const labels = [];
  const series = [];
  const realizedSeries = [];

  for (let i = 0; i < days; i++) {
    const date = startDate.plus({ days: i });
    const dateISO = date.toISODate();
    const dayEnd = date.endOf('day');
    let realized = 0;
    let unrealized = 0;

    replays.forEach(r => {
      while (r.next < r.steps.length && r.steps[r.next].at <= dayEnd) r.next++;
      if (r.next === 0) return;
      const state = r.steps[r.next - 1];
      realized += state.realisedPnL;
      if (state.openQty <= 1e-9) return;

      const symbol = r.trade.symbol;
      const closes = historicalDataMap && historicalDataMap[symbol];
      const close = closes && closes.get ? closes.get(dateISO) : undefined;
      if (typeof close === 'number' && !isNaN(close)) lastClose[symbol] = close;
      const price = lastClose[symbol] ?? state.price;
      unrealized += r.sign * (price * state.openQty - state.openCost) * r.multiplier - state.openFee;
    });
    unreplayable.forEach(t => {
      const closedAt = toDT(t.lastActionDate);
      if (closedAt && closedAt <= dayEnd) realized += t.return || 0;
    });

    labels.push(date.toFormat('dd/MM/yyyy'));
    realizedSeries.push(realized);
    series.push(realized + unrealized);
  }

  return { labels, series, realizedSeries };
};

export const computeReturnPercentageSeries = (trades, historicalDataMap) => {
  if (!trades.length) return [];

  const allActions = trades.flatMap(trade => {
    if (!Array.isArray(trade.actions)) return []; // Guard against undefined/null actions

    let tradeTickMultiplier = 1;
    if (trade.type === 'STK') {
      tradeTickMultiplier = 1;
    } else if (trade.type === 'FUT') {
      const tickValue = Number(trade.tick_value || trade.tickValue || 0);
      const tickSize = Number(trade.tick_size || trade.tickSize || 0);
      if (tickSize !== 0 && !isNaN(tickValue) && !isNaN(tickSize)) {
        tradeTickMultiplier = tickValue / tickSize;
      } else {
        tradeTickMultiplier = 1;
      }
    }

    return trade.actions.map(action => ({
      ...action,
      symbol: trade.symbol,
      typeAction: action.type, 
      tradeType: trade.type,   
      tickMultiplier: tradeTickMultiplier,
      dateTime: DateTime.fromISO(action.dateTime), 
    }));
  })
  .filter(action => action.dateTime && action.dateTime.isValid) 
  .sort((a, b) => a.dateTime - b.dateTime);

  if (!allActions.length) return [];

  const today = DateTime.now().startOf('day');
  const maxDays = 3*365;
  const firstActionDate = allActions[0].dateTime.startOf('day');
  const startDate = firstActionDate > today.minus({ days: maxDays }) ? firstActionDate : today.minus({ days: maxDays });
  
  const numDays = Math.ceil(today.diff(startDate, 'days').days) + 1;
  if (numDays <= 0) return [];

  const series = [];
  
  let cash = 0;
  let totalDeposits = 0;
  const openPositions = {}; 
  const lastKnownPrices = {}; 
  
  let currentActionIndex = 0;

  for (let i = 0; i < numDays; i++) {
    const currentDate = startDate.plus({ days: i });
    const currentDateISO = currentDate.toISODate();

    while (currentActionIndex < allActions.length && allActions[currentActionIndex].dateTime <= currentDate.endOf('day')) {
      const action = allActions[currentActionIndex];
      const price = Number(action.price);
      const quantity = Number(action.quantity);
      const fee = Number(action.fee || 0);
      const tickMultiplier = action.tickMultiplier || 1;

      if (isNaN(price) || isNaN(quantity) || isNaN(fee)) {
        console.warn('Skipping action with invalid price, quantity, or fee:', action);
        currentActionIndex++;
        continue;
      }
      
      const grossAmount = price * quantity * tickMultiplier;

      if (action.typeAction === 'BUY') {
        const totalCostWithFee = grossAmount + fee;
        if (cash < totalCostWithFee) {
          const deposit = totalCostWithFee - cash;
          totalDeposits += deposit;
          cash += deposit;
        }
        cash -= totalCostWithFee;
        
        if (openPositions[action.symbol]) {
          openPositions[action.symbol].quantity += quantity;
          openPositions[action.symbol].cost += grossAmount; // Asset cost basis
        } else {
          openPositions[action.symbol] = { quantity: quantity, cost: grossAmount, tickMultiplier: tickMultiplier };
        }
        lastKnownPrices[action.symbol] = price;
      } else if (action.typeAction === 'SELL') {
        const proceedsAfterFee = grossAmount - fee;
        cash += proceedsAfterFee;

        if (openPositions[action.symbol] && openPositions[action.symbol].quantity > 0.000001) {
          const avgCostPerUnit = openPositions[action.symbol].cost / openPositions[action.symbol].quantity;
          const costOfSoldUnits = avgCostPerUnit * quantity;

          if (isFinite(costOfSoldUnits)) {
             openPositions[action.symbol].cost -= costOfSoldUnits;
          }
          
          openPositions[action.symbol].quantity -= quantity;

          if (openPositions[action.symbol].quantity <= 0.000001 || openPositions[action.symbol].cost < 0) {
            delete openPositions[action.symbol];
          }
        }
        lastKnownPrices[action.symbol] = price;
      }
      currentActionIndex++;
    }

    let marketValue = 0;
    Object.keys(openPositions).forEach(symbol => {
      const position = openPositions[symbol];
      if (position.quantity > 0.000001) {
        const historicalData = historicalDataMap[symbol];
        let currentPrice;
        if (historicalData && historicalData.has(currentDateISO)) {
          currentPrice = historicalData.get(currentDateISO);
          if (typeof currentPrice === 'number' && !isNaN(currentPrice)) {
            lastKnownPrices[symbol] = currentPrice;
          } else {
            currentPrice = lastKnownPrices[symbol] || 0; 
          }
        } else {
          currentPrice = lastKnownPrices[symbol] || 0;
        }
        marketValue += position.quantity * currentPrice * position.tickMultiplier;
      }
    });

    const portfolioValue = cash + marketValue;
    const returnPercentage = totalDeposits > 0.000001 ? ((portfolioValue - totalDeposits) / totalDeposits) * 100 : 0;
    
    series.push({ date: currentDate.toFormat('dd/MM/yyyy'), returnPercentage: isNaN(returnPercentage) ? 0 : returnPercentage });
  }

  return series;
};

// Professional Trading Metrics

// Compute Expectancy (Average Win magnitude * Win Rate - Average Loss magnitude * Loss Rate)
export const computeExpectancy = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  if (closedTrades.length === 0) return 'N/A';
  
  const winTrades = closedTrades.filter(t => t.status === 'WIN');
  const lossTrades = closedTrades.filter(t => t.status === 'LOSS');
  
  const avgWin = winTrades.length > 0 ? winTrades.reduce((sum, t) => sum + (t.return || 0), 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? Math.abs(lossTrades.reduce((sum, t) => sum + (t.return || 0), 0) / lossTrades.length) : 0;
  const winRate = closedTrades.length > 0 ? winTrades.length / closedTrades.length : 0;
  const lossRate = closedTrades.length > 0 ? lossTrades.length / closedTrades.length : 0;
  
  const expectancy = (avgWin * winRate) - (avgLoss * lossRate);
  return expectancy.toFixed(2);
};

// Compute Risk/Reward Ratio (Avg Win / Avg Loss)
export const computeRiskRewardRatio = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  if (closedTrades.length === 0) return 'N/A';
  
  const winTrades = closedTrades.filter(t => t.status === 'WIN');
  const lossTrades = closedTrades.filter(t => t.status === 'LOSS');
  
  const avgWin = winTrades.length > 0 ? winTrades.reduce((sum, t) => sum + (t.return || 0), 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? Math.abs(lossTrades.reduce((sum, t) => sum + (t.return || 0), 0) / lossTrades.length) : 0;
  
  return avgLoss !== 0 ? (avgWin / avgLoss).toFixed(2) : avgWin > 0 ? 'Infinity' : 'N/A';
};

// Compute Recovery Factor (Total P&L / Max Drawdown)
export const computeRecoveryFactor = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  if (closedTrades.length === 0) return 'N/A';
  
  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.return || 0), 0);
  const { maxDrawdown } = computeDrawdowns(closedTrades);
  
  return maxDrawdown !== 0 ? (totalPnl / maxDrawdown).toFixed(2) : 'N/A';
};

// Compute best and worst days
export const computeBestWorstDays = (trades) => {
  const events = realizationEvents(trades);
  if (events.length === 0) return { bestDay: 'N/A', worstDay: 'N/A', bestAmount: '0.00', worstAmount: '0.00' };

  const dailyPnL = {};
  events.forEach(e => {
    const date = e.date.toISODate();
    dailyPnL[date] = (dailyPnL[date] || 0) + e.amount;
  });
  
  const days = Object.entries(dailyPnL);
  const bestDay = days.reduce((max, [date, pnl]) => pnl > max.pnl ? { date, pnl } : max, { date: null, pnl: -Infinity });
  const worstDay = days.reduce((min, [date, pnl]) => pnl < min.pnl ? { date, pnl } : min, { date: null, pnl: Infinity });
  
  return {
    bestDay: bestDay.date ? DateTime.fromISO(bestDay.date).toFormat('dd/MM/yyyy') : 'N/A',
    worstDay: worstDay.date ? DateTime.fromISO(worstDay.date).toFormat('dd/MM/yyyy') : 'N/A',
    bestAmount: bestDay.pnl.toFixed(2),
    worstAmount: worstDay.pnl.toFixed(2),
  };
};

// Compute monthly P&L summary
// P&L includes partial sells of still-open trades (in the month they were
// sold); the win/loss/trade counts stay about closed trades only.
export const computeMonthlyPnLSummary = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  const partials = computePartialRealizations(trades);
  if (closedTrades.length === 0 && partials.length === 0) return [];

  const monthlyData = {};
  const bucket = (month) => (monthlyData[month] = monthlyData[month] || { pnl: 0, wins: 0, losses: 0, trades: 0 });
  closedTrades.forEach(t => {
    const date = toDT(t.lastActionDate);
    if (!date || !date.isValid) return;
    const m = bucket(date.toFormat('yyyy-MM'));
    m.pnl += t.return || 0;
    m.trades += 1;
    if (t.status === 'WIN') m.wins += 1;
    if (t.status === 'LOSS') m.losses += 1;
  });
  partials.forEach(e => { bucket(e.date.toFormat('yyyy-MM')).pnl += e.amount; });

  return Object.entries(monthlyData).sort(([a], [b]) => a.localeCompare(b)).map(([month, data]) => ({
    month,
    pnl: data.pnl.toFixed(2),
    wins: data.wins,
    losses: data.losses,
    trades: data.trades,
    winRate: data.wins + data.losses > 0 ? ((data.wins / (data.wins + data.losses)) * 100).toFixed(1) : '—',
  }));
};

// Compute daily P&L distribution stats
export const computeDailyPnLStats = (trades) => {
  const events = realizationEvents(trades);
  if (events.length === 0) return { avgDailyPnL: 'N/A', bestDailyPnL: 'N/A', worstDailyPnL: 'N/A' };

  const dailyPnL = {};
  events.forEach(e => {
    const date = e.date.toISODate();
    dailyPnL[date] = (dailyPnL[date] || 0) + e.amount;
  });
  
  const pnlValues = Object.values(dailyPnL);
  const avgDailyPnL = pnlValues.length > 0 ? (pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length).toFixed(2) : '0.00';
  const bestDailyPnL = pnlValues.length > 0 ? Math.max(...pnlValues).toFixed(2) : '0.00';
  const worstDailyPnL = pnlValues.length > 0 ? Math.min(...pnlValues).toFixed(2) : '0.00';
  
  return { avgDailyPnL, bestDailyPnL, worstDailyPnL };
};

// Compute average consecutive wins/losses
export const computeConsecutiveStats = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  if (closedTrades.length === 0) return { avgConsecutiveWins: 'N/A', avgConsecutiveLosses: 'N/A' };
  
  let currentWinStreak = 0, currentLossStreak = 0;
  let totalWinStreaks = 0, countWinStreaks = 0;
  let totalLossStreaks = 0, countLossStreaks = 0;
  
  closedTrades.forEach(t => {
    if (t.status === 'WIN') {
      currentWinStreak++;
      if (currentLossStreak > 0) {
        totalLossStreaks += currentLossStreak;
        countLossStreaks++;
        currentLossStreak = 0;
      }
    } else if (t.status === 'LOSS') {
      currentLossStreak++;
      if (currentWinStreak > 0) {
        totalWinStreaks += currentWinStreak;
        countWinStreaks++;
        currentWinStreak = 0;
      }
    }
  });
  
  if (currentWinStreak > 0) {
    totalWinStreaks += currentWinStreak;
    countWinStreaks++;
  }
  if (currentLossStreak > 0) {
    totalLossStreaks += currentLossStreak;
    countLossStreaks++;
  }
  
  const avgConsecutiveWins = countWinStreaks > 0 ? (totalWinStreaks / countWinStreaks).toFixed(2) : '0.00';
  const avgConsecutiveLosses = countLossStreaks > 0 ? (totalLossStreaks / countLossStreaks).toFixed(2) : '0.00';
  
  return { avgConsecutiveWins, avgConsecutiveLosses };
};

// Compute average trades per week
export const computeAvgTradesPerWeek = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  if (closedTrades.length === 0) return '0.00';
  
  const weeks = new Set(closedTrades.map(t => {
    const date = DateTime.fromISO(t.lastActionDate);
    // 'WW' is the ISO week number, which belongs to the ISO week-year ('kkkk'),
    // not the calendar year ('yyyy') — using 'yyyy' mislabels early-January
    // trades that fall in the previous year's ISO week 52/53.
    return date.toFormat('kkkk-WW');
  }));
  
  return weeks.size > 0 ? (closedTrades.length / weeks.size).toFixed(2) : '0.00';
};

// Compute average trades per month
export const computeAvgTradesPerMonth = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  if (closedTrades.length === 0) return '0.00';
  
  const months = new Set(closedTrades.map(t => DateTime.fromISO(t.lastActionDate).toFormat('yyyy-MM')));
  return months.size > 0 ? (closedTrades.length / months.size).toFixed(2) : '0.00';
};

// Compute win/loss by hour of day
export const computeHourlyStats = (trades, zone = 'local') => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  const hourlyData = Array(24).fill(null).map(() => ({ wins: 0, losses: 0, pnl: 0 }));

  closedTrades.forEach(t => {
    if (!t.firstActionDate) return;
    const hour = t.firstActionDate.setZone(zone).hour;
    if (hour >= 0 && hour < 24) {
      // WASH trades count toward pnl (should be ~0) but aren't a win or a
      // loss — don't let them inflate the loss bucket.
      if (t.status === 'WIN') hourlyData[hour].wins++;
      else if (t.status === 'LOSS') hourlyData[hour].losses++;
      hourlyData[hour].pnl += (t.return || 0);
    }
  });
  
  return hourlyData.map((data, hour) => ({
    hour: `${hour}:00`,
    wins: data.wins,
    losses: data.losses,
    total: data.wins + data.losses,
    winRate: data.wins + data.losses > 0 ? ((data.wins / (data.wins + data.losses)) * 100).toFixed(1) : 0,
    pnl: data.pnl.toFixed(2),
  }));
};

// Compute largest winning streak
export const computeLargestStreaks = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  if (closedTrades.length === 0) return { largestWinStreak: 0, largestLossStreak: 0 };

  const { maxWinStreak, maxLossStreak } = computeStreakExtremes(closedTrades);
  return { largestWinStreak: maxWinStreak, largestLossStreak: maxLossStreak };
};

// Compute average win/loss size
export const computeAvgWinLoss = (trades) => {
  const closedTrades = trades.filter(t => t.status !== 'OPEN');
  if (closedTrades.length === 0) return { avgWin: '0.00', avgLoss: '0.00' };
  
  const winTrades = closedTrades.filter(t => t.status === 'WIN');
  const lossTrades = closedTrades.filter(t => t.status === 'LOSS');
  
  const avgWin = winTrades.length > 0 ? (winTrades.reduce((sum, t) => sum + (t.return || 0), 0) / winTrades.length).toFixed(2) : '0.00';
  const avgLoss = lossTrades.length > 0 ? (lossTrades.reduce((sum, t) => sum + (t.return || 0), 0) / lossTrades.length).toFixed(2) : '0.00';
  
  return { avgWin, avgLoss };
};