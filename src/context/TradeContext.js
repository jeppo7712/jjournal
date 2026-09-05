import React, { createContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { DateTime } from 'luxon';
import { debounce } from 'lodash';

// The trade list's hideable columns, in display order. Shared between
// TradeList.jsx (rendering) and Settings.jsx (the per-account visibility
// toggles) so the two never drift out of sync.
export const TRADE_LIST_COLUMNS = [
  { key: 'openDate', label: 'Open Date' },
  { key: 'symbol', label: 'Symbol' },
  { key: 'status', label: 'Status' },
  { key: 'side', label: 'Side' },
  { key: 'quantity', label: 'Qty' },
  { key: 'entry', label: 'Entry' },
  { key: 'exit', label: 'Exit' },
  { key: 'entryTotal', label: 'Entry Total' },
  { key: 'exitTotal', label: 'Exit Total' },
  { key: 'position', label: 'Position' },
  { key: 'holdTime', label: 'Hold Time' },
  { key: 'return', label: 'Return' },
  { key: 'returnPercentage', label: 'Return %' },
];

export function parseActionDate(date) {
  if (date instanceof DateTime && date.isValid) {
    return date;
  }
  if (typeof date === 'string') {
    const dt = DateTime.fromISO(date, { zone: 'utc' }).toLocal();
    if (!dt.isValid) {
      console.warn(`Invalid dateTime: ${date}`);
      return DateTime.fromMillis(0, { zone: 'local' });
    }
    return dt;
  }
  console.warn(`Invalid dateTime type: ${typeof date}, value:`, date);
  return DateTime.fromMillis(0, { zone: 'local' });
}

export function formatDate(date) {
  if (!(date instanceof DateTime) || !date.isValid) return '';
  return date.toFormat('dd/MM/yyyy');
}

export function formatDateTime(date) {
  if (!(date instanceof DateTime) || !date.isValid) return '';
  return date.toFormat('dd/MM/yyyy, HH:mm');
}

export function formatHoldTime(startDate, endDate) {
  if (!(startDate instanceof DateTime) || !(endDate instanceof DateTime) || !startDate.isValid || !endDate.isValid) return '';
  const ms = endDate.diff(startDate, 'milliseconds').milliseconds;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} MIN`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} HR${hours === 1 ? '' : 'S'}`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)} DAY${Math.round(days) === 1 ? '' : 'S'}`;
  const months = days / 30.42;
  if (months < 12) return `${months.toFixed(1)} MTS`;
  const years = months / 12;
  return `${years.toFixed(1)} YRS`;
}

// Shared by every PnL/return calculation in this file (getRealisedPnL,
// updateTradePriceData, computeTradeMeta, computeStats) — previously each
// reimplemented this same STK-vs-FUT if/else independently.
export function getTickMultiplier(trade) {
  if (trade.type === 'STK') return 1;
  const tickValue = Number(trade.tick_value || trade.tickValue || 0);
  const tickSize = Number(trade.tick_size || trade.tickSize || 0);
  return tickValue !== 0 && tickSize !== 0 ? tickValue / tickSize : 1;
}

// FIFO-matches a trade's actions against each other (opening action type
// depends on side: BUY for LONG, SELL for SHORT). Returns the realised PnL
// from closed portions plus whatever lots remain open (used by callers that
// need the open cost basis for unrealised PnL, e.g. updateTradePriceData).
function matchLotsFIFO(trade, tickMultiplier) {
  const openLots = [];
  let realisedPnL = 0;
  const actions = Array.isArray(trade.actions) ? trade.actions : [];
  if (trade.side !== 'LONG' && trade.side !== 'SHORT') return { realisedPnL, openLots };

  const openingType = trade.side === 'LONG' ? 'BUY' : 'SELL';
  const closingType = trade.side === 'LONG' ? 'SELL' : 'BUY';
  const sign = trade.side === 'LONG' ? 1 : -1;

  actions.forEach(action => {
    if (action.type === openingType) {
      openLots.push({
        quantity: Number(action.quantity || 0),
        price: Number(action.price || 0),
        fee: Number(action.fee || 0),
      });
    } else if (action.type === closingType) {
      // Fixed at the fill's own total so the exit-fee split doesn't shrink as
      // this fill eats into successive lots (see bug writeup below).
      const totalCloseQty = Number(action.quantity || 0);
      let closeQty = totalCloseQty;
      while (closeQty > 0 && openLots.length > 0) {
        const lot = openLots[0];
        const qtyToClose = Math.min(lot.quantity, closeQty);
        // Proportion of this lot's entry fee attributable to the quantity being
        // closed right now, based on whatever quantity/fee the lot has left.
        const entryFeeSlice = lot.fee * (qtyToClose / lot.quantity);
        const exitFeeSlice = Number(action.fee || 0) * (qtyToClose / totalCloseQty);
        realisedPnL += (Number(action.price) - lot.price) * sign * qtyToClose * tickMultiplier
          - entryFeeSlice
          - exitFeeSlice;
        // Reduce the lot's remaining fee by the slice just realised, in lockstep
        // with quantity, so a lot closed via multiple separate fills only ever
        // has its entry fee attributed once in total (previously `lot.fee` stayed
        // at its original value while `lot.quantity` shrank, so each subsequent
        // partial close over-attributed fee against a shrinking denominator, and
        // any fee left on a still-open lot double-counted what closes already took).
        lot.fee -= entryFeeSlice;
        lot.quantity -= qtyToClose;
        closeQty -= qtyToClose;
        if (lot.quantity <= 0) openLots.shift();
      }
    }
  });

  return { realisedPnL, openLots };
}

export function getRealisedPnL(trade) {
  if (!trade || !['STK', 'FUT'].includes(trade.type) || !Array.isArray(trade.actions)) return 0;
  const { realisedPnL } = matchLotsFIFO(trade, getTickMultiplier(trade));
  return realisedPnL;
}

export function calculateRisk(trade) {
    // Validate essential trade data and stop loss
    if (!trade || !Array.isArray(trade.actions) || trade.actions.length === 0 || trade.stop_loss === undefined || trade.stop_loss === null) {
        return null;
    }

    const stopLossStr = String(trade.stop_loss).replace(',', '.');
    const stopLoss = parseFloat(stopLossStr);

    if (isNaN(stopLoss) || stopLoss === 0) {
        return null;
    }

    // Determine the entry action type from the first action (e.g., 'BUY' for a LONG trade)
    const entryActionType = trade.actions[0].type;
    let totalQuantity = 0;
    let totalValue = 0;

    // Calculate the total quantity and average price from all entry actions
    trade.actions.forEach(action => {
        if (action.type === entryActionType) {
            const quantity = parseFloat(String(action.quantity).replace(',', '.'));
            const price = parseFloat(String(action.price).replace(',', '.'));

            if (!isNaN(quantity) && quantity > 0 && !isNaN(price)) {
                totalQuantity += quantity;
                totalValue += price * quantity;
            }
        }
    });

    if (totalQuantity <= 0) {
        return null; // No valid entry actions found
    }

    const avgEntryPrice = totalValue / totalQuantity;

    // Calculate the total risk based on the average price and total quantity
    const priceDifference = Math.abs(avgEntryPrice - stopLoss);

    if (trade.type === 'FUT') {
        const tickSizeStr = String(trade.tick_size).replace(',', '.');
        const tickValueStr = String(trade.tick_value).replace(',', '.');
        const tickSize = parseFloat(tickSizeStr);
        const tickValue = parseFloat(tickValueStr);

        if (isNaN(tickSize) || tickSize === 0 || isNaN(tickValue)) {
            return null;
        }
        return (priceDifference / tickSize) * tickValue * totalQuantity;
    } else if (trade.type === 'STK') {
        return priceDifference * totalQuantity;
    }

    return null;
}

function getFuturesSettings(symbol, type, futuresSettings) {
  if (!symbol || !type) {
    const defaultSetting = futuresSettings.find(s => s.symbol === 'DEFAULT' && s.type === type) ||
                          futuresSettings.find(s => s.symbol === 'DEFAULT');
    if (!defaultSetting) {
      console.warn(`No default settings found for type ${type}`);
    }
    return defaultSetting;
  }
  const upperSymbol = symbol.toUpperCase();
  const specificSettings = futuresSettings
    .filter(s => s.symbol !== 'DEFAULT' && s.type === type)
    .sort((a, b) => b.symbol.length - a.symbol.length);
  const matchingSetting = specificSettings.find(s => upperSymbol.startsWith(s.symbol));
  if (matchingSetting) {
    return matchingSetting;
  }
  const defaultSetting = futuresSettings.find(s => s.symbol === 'DEFAULT' && s.type === type) ||
                        futuresSettings.find(s => s.symbol === 'DEFAULT');
  if (!defaultSetting) {
    console.warn(`No settings found for symbol ${symbol} and type ${type}`);
    return defaultSetting;
  }
  return defaultSetting;
}

// Canonical timeframe order, and the same defaults as the backend's
// DEFAULT_TIMEFRAME_SETTINGS (modules/historical-data-service.js) — used
// whenever a symbol's timeframe_settings doesn't explicitly cover a given
// timeframe (e.g. rows saved before it existed).
export const ALL_TIMEFRAMES = ['1W', '1D', '4H', '1H', '15M', '5M', '1M'];
const DEFAULT_TIMEFRAME_ENABLED = { '1M': false, '5M': true, '15M': false, '1H': true, '4H': false, '1D': true, '1W': false };

// Which timeframes a symbol is actually set up to fetch/keep updated, so
// TradeView and the trade-entry reference chart only ever offer timeframes
// that have (or will have) real data — a symbol that's deselected in
// Settings never gets populated, so offering its button just leads to an
// empty/stuck chart.
export function getEnabledTimeframesForSetting(timeframeSettings) {
  return ALL_TIMEFRAMES.filter(tf => {
    const entry = timeframeSettings && timeframeSettings[tf];
    return typeof entry?.enabled === 'boolean' ? entry.enabled : DEFAULT_TIMEFRAME_ENABLED[tf];
  });
}

function calculatePricePrecision(setting) {
  if (!setting || !setting.tick_size) return 2;
  const tickSize = Number(setting.tick_size);
  if (isNaN(tickSize) || tickSize <= 0) return 2;
  const tickSizeStr = tickSize.toString();
  const decimalIndex = tickSizeStr.indexOf('.');
  return decimalIndex === -1 ? 0 : tickSizeStr.length - decimalIndex - 1;
}

async function computeTradeMeta(trade, futuresSettings) {
  const actions = Array.isArray(trade.actions) ? trade.actions : [];
  let buyQty = 0, sellQty = 0, buySum = 0, sellSum = 0, buyFee = 0, sellFee = 0, avgBuy = 0, avgSell = 0;
  let firstActionDate = null;
  let lastActionDate = null;
  let side = null;
  let status = 'OPEN';
  let ret = null;
  let directionBeforeClose = null;

  const tickMultiplier = getTickMultiplier(trade);

  actions.forEach((a, idx) => {
    const actionDate = parseActionDate(a.dateTime);
    if (!actionDate.isValid) {
      console.warn(`Invalid dateTime for action in trade ${trade.id || 'unknown'}`, a);
      return;
    }
    if (!firstActionDate || actionDate < firstActionDate) {
      firstActionDate = actionDate;
    }
    if (!lastActionDate || actionDate > lastActionDate) {
      lastActionDate = actionDate;
    }
    if (idx < actions.length - 1) {
      const nextBuyQty = buyQty + (a.type === 'BUY' ? Number(a.quantity || 0) : 0);
      const nextSellQty = sellQty + (a.type === 'SELL' ? Number(a.quantity || 0) : 0);
      if (nextBuyQty > nextSellQty) directionBeforeClose = 'LONG';
      else if (nextBuyQty < nextSellQty) directionBeforeClose = 'SHORT';
    }
    if (a.type === 'BUY') {
      buyQty += Number(a.quantity || 0);
      buySum += Number(a.price || 0) * Number(a.quantity || 0);
      buyFee += Number(a.fee || 0);
    } else if (a.type === 'SELL') {
      sellQty += Number(a.quantity || 0);
      sellSum += Number(a.price || 0) * Number(a.quantity || 0);
      sellFee += Number(a.fee || 0);
    }
  });

  avgBuy = buySum / (buyQty || 1);
  avgSell = sellSum / (sellQty || 1);

  if (buyQty > sellQty) {
    side = 'LONG';
    status = 'OPEN';
  } else if (buyQty < sellQty) {
    side = 'SHORT';
    status = 'OPEN';
  } else if (buyQty === sellQty && buyQty !== 0) {
    side = directionBeforeClose;
    status = 'CLOSED';
    ret = (sellSum - buySum) * tickMultiplier - buyFee - sellFee;
    if (Math.abs(ret) < 1e-6) {
      status = 'WASH';
    } else if (ret > 0) {
      status = 'WIN';
    } else {
      status = 'LOSS';
    }
  }

  let openDate = '';
  if (firstActionDate) {
    openDate = formatDate(firstActionDate);
  }

  let holdTime = '';
  if (status !== 'OPEN' && firstActionDate && lastActionDate && firstActionDate < lastActionDate) {
    holdTime = formatHoldTime(firstActionDate, lastActionDate);
  }

  let returnPercentage = null;
  if (ret !== null) {
    if (trade.type === 'FUT') {
      const setting = Array.isArray(futuresSettings) ? futuresSettings.find(fs => fs.symbol === trade.symbol && fs.type === trade.type) : null;
      const defaultSetting = Array.isArray(futuresSettings) ? futuresSettings.find(fs => fs.symbol === 'DEFAULT' && fs.type === trade.type) : null;
      const applicableSetting = setting || defaultSetting;

      if (applicableSetting && applicableSetting.initial_margin > 0) {
        let maxContracts = 0;
        let openContracts = 0;
        const tradeDirection = side;

        if (tradeDirection === 'LONG') {
          actions.forEach(a => {
            if (a.type === 'BUY') {
              openContracts += Number(a.quantity || 0);
              if (openContracts > maxContracts) maxContracts = openContracts;
      } else {
              openContracts -= Number(a.quantity || 0);
            }
          });
        } else if (tradeDirection === 'SHORT') {
          actions.forEach(a => {
            if (a.type === 'SELL') {
              openContracts += Number(a.quantity || 0);
              if (openContracts > maxContracts) maxContracts = openContracts;
    } else {
              openContracts -= Number(a.quantity || 0);
            }
          });
        }

        const totalInitialMargin = applicableSetting.initial_margin * maxContracts;
        if (totalInitialMargin > 0) {
          returnPercentage = (ret / totalInitialMargin) * 100;
        }
      }
    }
    // Fallback for FUT without margin or for STK
    if (returnPercentage === null) {
      const entryTotal = side === 'LONG' ? buySum : sellSum;
      if (entryTotal) {
        returnPercentage = ((ret / tickMultiplier) / entryTotal) * 100;
      }
    }
  }

  let rMultiple = null;
  if (trade.stop_loss !== undefined && trade.stop_loss !== null && ret !== null) {
    const entryPrice = side === 'LONG' ? avgBuy : avgSell;
    const quantity = Math.min(buyQty, sellQty);
    const riskPerUnit = side === 'LONG' ? Math.abs(entryPrice - trade.stop_loss) : Math.abs(trade.stop_loss - entryPrice);
    const totalRisk = riskPerUnit * quantity * tickMultiplier;
    if (totalRisk > 0) {
      rMultiple = ret / totalRisk;
    }
  }

  const setting = getFuturesSettings(trade.symbol, trade.type, futuresSettings);
  const pricePrecision = setting ? calculatePricePrecision(setting) : 2;
  
  return {
    side,
    status,
    openDate,
    holdTime,
    return: ret,
    returnPercentage,
    buyQty,
    sellQty,
    buySum,
    sellSum,
    buyFee,
    sellFee,
    avgBuy,
    avgSell,
    firstActionDate,
    lastActionDate,
    rMultiple,
    pricePrecision,
  };
}

// Turns raw /api/trades rows into the same computed shape (position, entry/
// exit, entryTotal/exitTotal, etc.) refreshTrades puts into the `trades`
// context state — factored out so anything needing another account's trades
// processed the same way (e.g. Navigation's cross-account Total Portfolio
// roll-up) can reuse this exactly, rather than re-deriving these numbers ad
// hoc and risking them drifting out of sync with what Dashboard/TradeList
// actually show. Does NOT fetch live price data — currentReturn/currentPrice
// come back null here; see updateTradePriceData for that (separate because
// it's async-per-symbol and the two are composed differently by different
// callers).
async function processRawTradesArray(tradesData, futuresSettings) {
  if (!Array.isArray(tradesData)) return [];
  return Promise.all(tradesData.map(async trade => {
    const actions = Array.isArray(trade.actions) ? trade.actions.map(a => ({ ...a, dateTime: a.date_time || a.dateTime })) : [];
    const meta = await computeTradeMeta({ ...trade, actions }, futuresSettings);

    let openEntryTotal = null;
    if (meta.status === 'OPEN' && (meta.side === 'LONG' || meta.side === 'SHORT')) {
      const tickMultiplier = getTickMultiplier(trade);
      const { openLots } = matchLotsFIFO({ ...trade, side: meta.side, actions }, tickMultiplier);
      openEntryTotal = openLots.reduce((sum, lot) => sum + lot.price * lot.quantity, 0);
    }

    return {
      ...trade, actions, ...meta,
      quantity: meta.status === 'OPEN' ? null : meta.side === 'LONG' ? meta.sellSum / meta.avgSell : meta.buySum / meta.avgBuy,
      position: meta.status === 'OPEN' ? Math.abs(meta.buyQty - meta.sellQty) : null,
      entry: meta.side === 'LONG' ? meta.avgBuy : meta.avgSell,
      exit: meta.status === 'OPEN' ? null : meta.side === 'LONG' ? meta.avgSell : meta.avgBuy,
      entryTotal: meta.status === 'OPEN' ? openEntryTotal : (meta.side === 'LONG' ? meta.buySum : meta.sellSum),
      exitTotal: meta.status === 'OPEN' ? null : meta.side === 'LONG' ? meta.sellSum : meta.buySum,
      stop_loss: trade.stop_loss !== undefined ? trade.stop_loss : trade.stopLoss,
      firstActionDate: meta.firstActionDate.toLocal(),
      lastActionDate: meta.lastActionDate ? meta.lastActionDate.toLocal() : null,
      currentReturn: null,
      currentReturnPercentage: null,
      currentPrice: null,
    };
  }));
}

async function fetchCurrentPrice(symbol, type) {
  try {
    const yahooSymbol = symbol + (type === 'FUT' ? '=F' : '');
    const response = await fetch(`${process.env.REACT_APP_API_URL}/api/yahoo-finance/${encodeURIComponent(yahooSymbol)}`);
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    const currentPrice = data.price;
    if (currentPrice && typeof currentPrice === 'number') {
      return currentPrice;
    } else {
      console.warn(`[TradeContext] Invalid current price for symbol ${yahooSymbol}: ${JSON.stringify(data)}`);
      return null;
    }
  } catch (err) {
    console.error(`[TradeContext] Failed to fetch current price for symbol ${yahooSymbol}:`, err.message);
    return null;
  }
}

function sortItems(items, field, direction) {
  if (!Array.isArray(items)) return [];
  return [...items].sort((a, b) => {
    let aField, bField;
    if (field === 'openDate') {
      aField = a.firstActionDate || a.date;
      bField = b.firstActionDate || b.date;
    } else if (field === 'return') {
      // For open trades, use currentReturn; for closed trades, use return
      aField = a.status === 'OPEN' ? a.currentReturn : a.return;
      bField = b.status === 'OPEN' ? b.currentReturn : b.return;
    } else if (field === 'returnPercentage') {
      // For open trades, use currentReturnPercentage; for closed trades, use returnPercentage
      aField = a.status === 'OPEN' ? a.currentReturnPercentage : a.returnPercentage;
      bField = b.status === 'OPEN' ? b.currentReturnPercentage : b.returnPercentage;
    } else {
      aField = a[field];
      bField = b[field];
    }
    
    // Convert DateTime objects to timestamps for proper comparison
    if (aField instanceof DateTime && aField.isValid) {
      aField = aField.toMillis();
    }
    if (bField instanceof DateTime && bField.isValid) {
      bField = bField.toMillis();
    }
    
    // Convert strings to uppercase for case-insensitive comparison
    if (typeof aField === 'string') aField = aField.toUpperCase();
    if (typeof bField === 'string') bField = bField.toUpperCase();
    
    // Handle null/undefined - put them at the end
    if (aField === undefined || aField === null) return 1;
    if (bField === undefined || bField === null) return -1;
    
    // Perform the comparison
    if (aField < bField) return direction === 'asc' ? -1 : 1;
    if (aField > bField) return direction === 'asc' ? 1 : -1;
    return 0;
  });
}

function computeStats(trades, futuresSettings) {
  let wins = 0,
    losses = 0,
    wash = 0,
    open = 0,
    totalReturn = 0,
    winSum = 0,
    lossSum = 0,
    winCount = 0,
    lossCount = 0;
  let winReturnPctSum = 0,
    lossReturnPctSum = 0;

  trades.forEach(trade => {
    if (!trade.status) return;

    const tickMultiplier = getTickMultiplier(trade);
    const ret = typeof trade.return === 'number' ? trade.return : 0;

    // Calculate return percentage correctly for futures
    let returnPct = null;
    if (trade.type === 'FUT') {
      const setting = futuresSettings.find(fs => fs.symbol === trade.symbol && fs.type === trade.type) ||
                      futuresSettings.find(fs => fs.symbol === 'DEFAULT' && fs.type === trade.type);
      if (setting && setting.initial_margin > 0) {
        // Calculate max contracts from trade actions
        let maxContracts = 0;
        let openContracts = 0;
        const actions = Array.isArray(trade.actions) ? trade.actions : [];
        const tradeDirection = trade.side;
        if (tradeDirection === 'LONG') {
          actions.forEach(a => {
            if (a.type === 'BUY') {
              openContracts += Number(a.quantity || 0);
              if (openContracts > maxContracts) maxContracts = openContracts;
            } else {
              openContracts -= Number(a.quantity || 0);
            }
          });
        } else if (tradeDirection === 'SHORT') {
          actions.forEach(a => {
            if (a.type === 'SELL') {
              openContracts += Number(a.quantity || 0);
              if (openContracts > maxContracts) maxContracts = openContracts;
            } else {
              openContracts -= Number(a.quantity || 0);
            }
          });
        }
        const totalInitialMargin = setting.initial_margin * maxContracts;
        if (totalInitialMargin > 0) {
          returnPct = (ret / totalInitialMargin) * 100;
        }
      }
    }

    // Fallback for stocks or futures without margin data
    if (returnPct === null) {
      const entryTotal = trade.entryTotal || 0;
      returnPct = entryTotal ? ((ret / tickMultiplier) / entryTotal) * 100 : 0;
    }

    if (trade.status === 'WIN') {
      if (ret <= 0) {
        console.warn(`WIN trade with non-positive return: ${ret}`, trade);
      } else {
        wins++;
        winSum += ret;
        winCount++;
        winReturnPctSum += returnPct;
      }
    } else if (trade.status === 'LOSS') {
      if (ret >= 0) {
        console.warn(`LOSS trade with non-negative return: ${ret}`, trade);
      } else {
        losses++;
        lossSum += ret;
        lossCount++;
        lossReturnPctSum += returnPct;
      }
    } else if (trade.status === 'WASH') {
      wash++;
    } else if (trade.status === 'OPEN') {
      open++;
    }

    if (trade.status === 'WIN' || trade.status === 'LOSS') {
      totalReturn += ret;
    }
  });

  const totalTrades = trades.filter(t => t.status).length;

  return {
    wins,
    losses,
    wash,
    open,
    winRate: totalTrades ? Math.round((wins / totalTrades) * 100) : 0,
    avgWin: winCount ? winSum / winCount : 0,
    avgLoss: lossCount ? -lossSum / lossCount : 0,
    avgWinPct: winCount ? winReturnPctSum / winCount : 0,
    avgLossPct: lossCount ? -lossReturnPctSum / lossCount : 0,
    totalReturn,
    totalTrades,
  };
}

function getTimeRange(filter, customStartDate, customEndDate) {
  const now = DateTime.now();
  const startOfDay = now.startOf('day');
  const startOfWeek = startOfDay.minus({ days: startOfDay.weekday - 1 + (startOfDay.weekday === 7 ? -6 : 0) });
  const startOfMonth = now.startOf('month');
  const startOfYear = now.startOf('year');

  const setEndOfDay = dt => dt.endOf('day');
  const setStartOfDay = dt => dt.startOf('day');

  if (filter === 'CUSTOM' && customStartDate && customEndDate) {
    return {
      start: DateTime.fromISO(customStartDate, { zone: 'local' }).startOf('day'),
      end: DateTime.fromISO(customEndDate, { zone: 'local' }).endOf('day')
    };
  }

  switch (filter) {
    case 'TODAY':
      return { start: startOfDay, end: now };
    case 'YESTERDAY': {
      const yesterday = startOfDay.minus({ days: 1 });
      return { start: yesterday, end: setEndOfDay(yesterday) };
    }
    case 'THIS_WK':
      return { start: startOfWeek, end: now };
    case 'LAST_WK': {
      const lastWeekStart = startOfWeek.minus({ days: 7 });
      const lastWeekEnd = startOfWeek.minus({ days: 1 });
      return { start: lastWeekStart, end: setEndOfDay(lastWeekEnd) };
    }
    case 'THIS_MO':
      return { start: startOfMonth, end: now };
    case 'LAST_MO': {
      const lastMonthStart = startOfMonth.minus({ months: 1 });
      const lastMonthEnd = startOfMonth.minus({ days: 1 });
      return { start: lastMonthStart, end: setEndOfDay(lastMonthEnd) };
    }
    case 'LAST_3_MO': {
      const threeMonthsAgo = startOfMonth.minus({ months: 3 });
      const lastMonthEnd = startOfMonth.minus({ days: 1 });
      return { start: threeMonthsAgo, end: setEndOfDay(lastMonthEnd) };
    }
    case 'THIS_YR':
      return { start: startOfYear, end: now };
    case 'LAST_YR': {
      const lastYearStart = startOfYear.minus({ years: 1 });
      const lastYearEnd = startOfYear.minus({ days: 1 });
      return { start: lastYearStart, end: setEndOfDay(lastYearEnd) };
    }
    default:
      return null;
  }
}

export const TradeContext = createContext({
  trades: [],
  dayNotes: [],
  filteredItems: [],
  setTrades: () => { },
  stats: {},
  toggleFilter: () => { },
  refreshTrades: () => { },
  setSort: () => { },
  sortField: '',
  sortDirection: 'asc',
  timeFilter: null,
  setTimeFilter: () => { },
  filter: [],
  getTimeRange: () => { },
  customStartDate: null,
  customEndDate: null,
  setCustomStartDate: () => { },
  setCustomEndDate: () => { },
  accounts: [],
  currentAccountId: null,
  setCurrentAccountId: () => { },
  showTrades: true,
  showDayNotes: true,
  toggleShowTrades: () => { },
  toggleShowDayNotes: () => { },
  futuresSettings: [],
  refreshFuturesSettings: () => { },
  getAllTradeData: () => { },
  symbolFilter: '',
  setSymbolFilter: () => { },
  clearSymbolFilter: () => { },
  restrictToActionsInRange: false,
  setRestrictToActionsInRange: () => { },
  isFetching: false,
  tradesPerPage: 100,
  setTradesPerPage: () => { },
  currentPage: 1,
  setCurrentPage: () => { },
  hiddenColumns: [],
  toggleColumnVisibility: () => { },
});

export const TradeProvider = ({ children }) => {
  const [trades, setTrades] = useState([]);
  const [dayNotes, setDayNotes] = useState([]);
  const [filter, setFilter] = useState([]);
  const [timeFilter, setTimeFilter] = useState(null);
  const [customStartDate, setCustomStartDate] = useState(null);
  const [customEndDate, setCustomEndDate] = useState(null);
  const [sortField, setSortField] = useState('openDate');
  const [sortDirection, setSortDirection] = useState('desc');
  const [accounts, setAccounts] = useState([]);
  const [holdings, setHoldings] = useState([]);
  const [currentAccountId, setCurrentAccountId] = useState(localStorage.getItem('currentAccountId') || null);
  const [showTrades, setShowTrades] = useState(true);
  const [showDayNotes, setShowDayNotes] = useState(true);
  const [futuresSettings, setFuturesSettings] = useState([]);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [restrictToActionsInRange, setRestrictToActionsInRange] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [tradesPerPage, setTradesPerPage] = useState(100);
  const [currentPage, setCurrentPage] = useState(1);
  const [hiddenColumns, setHiddenColumns] = useState([]);

  const priceCacheRef = useRef(new Map());
  const CACHE_DURATION = 5 * 1000;

  // "Latest request wins" guard for refreshTrades: switching accounts (or any
  // rapid re-trigger) can leave an older, slower fetch resolving after a newer
  // one — without this, the stale response's setTrades/setDayNotes would run
  // last and clobber the newer, correct data.
  const refreshSeqRef = useRef(0);

  const toggleShowTrades = useCallback(() => setShowTrades(prev => !prev), []);
  const toggleShowDayNotes = useCallback(() => setShowDayNotes(prev => !prev), []);
  const clearSymbolFilter = useCallback(() => setSymbolFilter(''), []);
  const toggleColumnVisibility = useCallback((columnKey) => {
    setHiddenColumns(prev => prev.includes(columnKey) ? prev.filter(k => k !== columnKey) : [...prev, columnKey]);
  }, []);

  const loadFilterSettings = useCallback(async () => {
    if (!currentAccountId) return;
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/accounts/${currentAccountId}/filters`, {
        headers: { 'X-Account-ID': currentAccountId },
      });
      const data = await res.json();
      setFilter(data.status_filters || []);
      setTimeFilter(data.time_filter || null);
      setCustomStartDate(data.custom_start_date || null);
      setCustomEndDate(data.custom_end_date || null);
      setSymbolFilter(data.symbol_filter || '');
      setShowTrades(data.show_trades !== undefined ? data.show_trades : true);
      setShowDayNotes(data.show_day_notes !== undefined ? data.show_day_notes : true);
      setRestrictToActionsInRange(data.restrict_to_actions_in_range || false);
      // trades_per_page is `null` for "No limit" — a real, intentional value,
      // not a missing one. `|| 100` here was treating null as falsy and
      // silently reverting "No limit" back to 100 on every load (page
      // refresh, account switch). Only fall back to 100 if the key is
      // actually absent from the response.
      setTradesPerPage(data.trades_per_page === undefined ? 100 : data.trades_per_page);
      setHiddenColumns(Array.isArray(data.hidden_columns) ? data.hidden_columns : []);
      setCurrentPage(1);
    } catch (err) {
      console.error('Failed to load filter settings:', err);
    }
  }, [currentAccountId]);

  useEffect(() => {
    loadFilterSettings();
  }, [currentAccountId, loadFilterSettings]);

  const saveFilterSettings = useCallback(
    debounce(async (currentSettings) => {
      if (!currentAccountId) return;
      try {
        await fetch(`${process.env.REACT_APP_API_URL}/api/accounts/${currentAccountId}/filters`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Account-ID': currentAccountId,
          },
          body: JSON.stringify(currentSettings),
        });
      } catch (err) {
        console.error('Failed to save filter settings:', err);
      }
    }, 1000),
    [currentAccountId]
  );

  useEffect(() => {
    saveFilterSettings({
        status_filters: filter,
        time_filter: timeFilter,
        custom_start_date: customStartDate,
        custom_end_date: customEndDate,
        symbol_filter: symbolFilter,
        show_trades: showTrades,
        show_day_notes: showDayNotes,
        restrict_to_actions_in_range: restrictToActionsInRange,
        trades_per_page: tradesPerPage,
        hidden_columns: hiddenColumns,
    });
  }, [filter, timeFilter, customStartDate, customEndDate, symbolFilter, showTrades, showDayNotes, restrictToActionsInRange, tradesPerPage, hiddenColumns, saveFilterSettings]);

  // The save above is debounced (1s) so rapid changes don't fire a request
  // per keystroke/click — but that means a discrete, deliberate change (e.g.
  // picking a new "trades per page" value) can be silently lost if the page
  // reloads or the tab closes within that window, since the pending save
  // never gets to run. Flush it immediately when the page is about to go
  // away so the most recent change is never dropped.
  useEffect(() => {
    const flushPendingSave = () => saveFilterSettings.flush();
    const flushIfHidden = () => {
      if (document.visibilityState === 'hidden') flushPendingSave();
    };
    window.addEventListener('beforeunload', flushPendingSave);
    document.addEventListener('visibilitychange', flushIfHidden);
    return () => {
      window.removeEventListener('beforeunload', flushPendingSave);
      document.removeEventListener('visibilitychange', flushIfHidden);
    };
  }, [saveFilterSettings]);

  const toggleFilter = useCallback((type) => {
    const statusFilters = ['WIN', 'LOSS', 'WASH', 'OPEN'];
    setFilter(prev => {
      const existingFilter = prev.find(f => f.type === type);

      if (statusFilters.includes(type)) {
        const newFilters = prev.filter(f => !statusFilters.includes(f.type));
        if (existingFilter) {
          if (existingFilter.mode === 'include') return [...newFilters, { type, mode: 'exclude' }];
          if (existingFilter.mode === 'exclude') return newFilters;
        }
        return [...newFilters, { type, mode: 'include' }];
      } else {
        if (!existingFilter) return [...prev, { type, mode: 'include' }];
        if (existingFilter.mode === 'include') return prev.map(f => f.type === type ? { ...f, mode: 'exclude' } : f);
        if (existingFilter.mode === 'exclude') return prev.filter(f => f.type !== type);
      }
      return prev;
    });
  }, []);

  const getCachedPrice = useCallback(async (symbol, type) => {
    const cacheKey = `${symbol}_${type}`;
    const cached = priceCacheRef.current.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < CACHE_DURATION) {
      return cached.price;
    }

    const price = await fetchCurrentPrice(symbol, type);
    if (price !== null) {
      priceCacheRef.current.set(cacheKey, { price, timestamp: now });
    }
    return price;
  }, []);

  const updateTradePriceData = useCallback(async (trade, futuresSettings) => {
    if (trade.status !== 'OPEN' || !['STK', 'FUT'].includes(trade.type) || !trade.symbol) return null;

    const currentPrice = await getCachedPrice(trade.symbol, trade.type);
    if (currentPrice === null) return null;

    const tickMultiplier = getTickMultiplier(trade);
    const { openLots } = matchLotsFIFO(trade, tickMultiplier);
    let unrealisedPnL = 0;
    let openCost = 0;
    let openFee = 0;
    let currentReturnPercentage = null;

    if (trade.side === 'LONG' || trade.side === 'SHORT') {
        const openQty = openLots.reduce((sum, lot) => sum + lot.quantity, 0);
        openCost = openLots.reduce((sum, lot) => sum + lot.price * lot.quantity, 0);
        openFee = openLots.reduce((sum, lot) => sum + lot.fee, 0);
        const avgOpenCost = openQty > 0 ? openCost / openQty : 0;
        unrealisedPnL = trade.side === 'LONG'
            ? (currentPrice - avgOpenCost) * openQty * tickMultiplier - openFee
            : (avgOpenCost - currentPrice) * openQty * tickMultiplier - openFee;
    }

    if (trade.type === 'FUT') {
        const setting = futuresSettings.find(fs => fs.symbol === trade.symbol && fs.type === trade.type) || futuresSettings.find(fs => fs.symbol === 'DEFAULT' && fs.type === trade.type);
        const openQty = openLots.reduce((sum, lot) => sum + lot.quantity, 0);
        if (setting && setting.initial_margin > 0) {
            const totalInitialMargin = setting.initial_margin * openQty;
            if (totalInitialMargin > 0) currentReturnPercentage = (unrealisedPnL / totalInitialMargin) * 100;
        }
    }

    if (currentReturnPercentage === null) {
        const entryTotal = openCost + openFee;
        currentReturnPercentage = entryTotal ? ((unrealisedPnL / tickMultiplier) / entryTotal) * 100 : null;
    }

    return { currentReturn: unrealisedPnL, currentReturnPercentage, currentPrice };
  }, [getCachedPrice]);

      const getAllTradeData = useCallback((options = {}) => {
        const { startDate = null, endDate = null, tradeStatuses = null } = options;
        let filteredTrades = trades;
        if (startDate && endDate) {
            const rangeStart = DateTime.fromISO(startDate);
            const rangeEnd = DateTime.fromISO(endDate);
            filteredTrades = filteredTrades.filter(trade => {
                const firstActionDate = parseActionDate(trade.firstActionDate);
                return firstActionDate >= rangeStart && firstActionDate <= rangeEnd;
            });
        }
        if (tradeStatuses) {
            filteredTrades = filteredTrades.filter(trade => tradeStatuses.includes(trade.status));
        }
    let filteredNotes = dayNotes;
    if (startDate && endDate) {
      const rangeStart = DateTime.fromISO(startDate);
      const rangeEnd = DateTime.fromISO(endDate);
      filteredNotes = filteredNotes.filter(note => {
        const noteDate = parseActionDate(note.date);
        return noteDate >= rangeStart && noteDate <= rangeEnd;
      });
    }

    return {
      trades: filteredTrades.map(trade => ({
        id: trade.id,
        market: trade.market,
        symbol: trade.symbol,
        target: trade.target,
        stop_loss: trade.stop_loss,
        tick_size: trade.tick_size,
        tick_value: trade.tick_value,
        created_at: trade.created_at,
        actions: trade.actions.map(action => ({
          type: action.type,
          dateTime: action.dateTime,
          quantity: action.quantity,
          price: action.price,
          fee: action.fee,
        })),
        journal: trade.journal ? {
          tags: trade.journal.tags,
          notes_html: trade.journal.notes_html,
          confidence: trade.journal.confidence,
        } : null,
        attachments: trade.attachments || [],
        meta: {
          side: trade.side,
          status: trade.status,
          openDate: trade.openDate,
          holdTime: trade.holdTime,
          return: trade.return,
          returnPercentage: trade.returnPercentage,
          currentReturn: trade.currentReturn,
          currentReturnPercentage: trade.currentReturnPercentage,
          buyQty: trade.buyQty,
          sellQty: trade.sellQty,
          entry: trade.entry,
          exit: trade.exit,
          entryTotal: trade.entryTotal,
          exitTotal: trade.exitTotal,
          buyFee: trade.buyFee,
          sellFee: trade.sellFee,
        },
      })),
      dayNotes: filteredNotes.map(note => ({
        id: note.id,
        date: note.date,
        mood: note.mood,
        market_condition: note.market_condition,
        market_volume: note.market_volume,
        summary: note.summary,
        notes_html: note.notes_html,
        attachments: note.attachments || [],
      })),
    };
  }, [trades, dayNotes]);


    const loadAttachmentsInBackground = useCallback(async (tradesToUpdate, dayNotesToUpdate) => {
        if (!currentAccountId) return;

        const headers = { 'X-Account-ID': currentAccountId };
        
        const tradePromises = tradesToUpdate
            .filter(t => t.attachments && t.attachments.length > 0)
            .map(t => fetch(`${process.env.REACT_APP_API_URL}/api/trades/${t.id}`, { headers }).then(res => res.json()));

        const dayNotePromises = dayNotesToUpdate
            .filter(n => n.attachments && n.attachments.length > 0)
            .map(n => fetch(`${process.env.REACT_APP_API_URL}/api/daynotes/${n.id}`, { headers }).then(res => res.json()));

        const allPromises = [...tradePromises, ...dayNotePromises];

        if (allPromises.length === 0) {
            return;
        }

        const results = await Promise.allSettled(allPromises);

        const updatedTradesMap = new Map();
        const updatedDayNotesMap = new Map();

        results.forEach(result => {
            if (result.status === 'fulfilled') {
                const item = result.value;
                // Differentiate between a trade and day note based on unique properties
                if (item.symbol && item.actions) { 
                    updatedTradesMap.set(item.id, item.attachments);
                } else if (item.date && item.mood) {
                    updatedDayNotesMap.set(item.id, item.attachments);
                }
            } else {
                console.error('Failed to fetch an item detail for attachments:', result.reason);
            }
        });

        if (updatedTradesMap.size > 0) {
            setTrades(prevTrades =>
                prevTrades.map(trade =>
                    updatedTradesMap.has(trade.id)
                        ? { ...trade, attachments: updatedTradesMap.get(trade.id) }
                        : trade
                )
            );
        }

        if (updatedDayNotesMap.size > 0) {
            setDayNotes(prevNotes =>
                prevNotes.map(note =>
                    updatedDayNotesMap.has(note.id)
                        ? { ...note, attachments: updatedDayNotesMap.get(note.id) }
                        : note
                )
            );
        }

    }, [currentAccountId]);



  // Includes each account's rolled-up cash_balances (see routes/accounts.js)
  // — exposed so anything that changes cash (Capital.jsx's deposit/withdraw/
  // transfer/exchange/holdings, or a trade's auto-settlement) can trigger a
  // re-fetch instead of Navigation's Cash/Total Portfolio silently going
  // stale until a full page reload.
  const refreshAccounts = useCallback(async () => {
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/accounts`, {
        headers: { 'X-Account-ID': currentAccountId || '1' },
      });
      const data = await res.json();
      setAccounts(data);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('Failed to fetch accounts:', err);
      return [];
    }
  }, [currentAccountId]);

  // Every holding for the current account (all statuses) — shared here
  // rather than fetched separately by both Capital.jsx and Navigation.jsx
  // (which used to each pull /api/holdings independently, going stale
  // whenever the other one changed something).
  const refreshHoldings = useCallback(async () => {
    if (!currentAccountId) { setHoldings([]); return []; }
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/holdings`, { headers: { 'X-Account-ID': currentAccountId } });
      const data = res.ok ? await res.json() : [];
      const list = Array.isArray(data) ? data : [];
      setHoldings(list);
      return list;
    } catch (err) {
      console.error('Failed to fetch holdings:', err);
      setHoldings([]);
      return [];
    }
  }, [currentAccountId]);

  const refreshTrades = useCallback(async () => {
    if (!currentAccountId || !futuresSettings) return;
    const requestSeq = ++refreshSeqRef.current;
    setIsFetching(true);
    try {
      const headers = { 'X-Account-ID': currentAccountId };
      const [tradesResponse, dayNotesResponse] = await Promise.all([
        fetch(`${process.env.REACT_APP_API_URL}/api/trades`, { headers }),
        fetch(`${process.env.REACT_APP_API_URL}/api/daynotes`, { headers })
      ]);

      // A newer refreshTrades call has since started — let it win instead of
      // applying this now-stale response.
      if (requestSeq !== refreshSeqRef.current) return;

      const tradesData = await tradesResponse.json();
      const dayNotesData = await dayNotesResponse.json();

      const processedTrades = await processRawTradesArray(tradesData, futuresSettings);

      const finalDayNotes = Array.isArray(dayNotesData) ? dayNotesData.map(note => ({
        ...note,
        date: DateTime.fromISO(note.date, { zone: 'utc' }).toLocal(),
        type: 'dayNote',
        openDate: formatDate(DateTime.fromISO(note.date, { zone: 'utc' }).toLocal()),
        firstActionDate: DateTime.fromISO(note.date, { zone: 'utc' }).toLocal(),
      })) : [];

      if (requestSeq !== refreshSeqRef.current) return;

      // Set initial state with trades and day notes, no price data yet
      setTrades(processedTrades);
      setDayNotes(finalDayNotes);
      setIsFetching(false); // UI is now responsive

      // A saved/edited/deleted trade auto-settles cash server-side (see
      // routes/trades.js), so whenever trades refresh, cash balances may
      // have changed too — re-fetch accounts so Navigation's Cash/Total
      // Portfolio don't go stale until a page reload.
      refreshAccounts();

      loadAttachmentsInBackground(processedTrades, finalDayNotes);
        
      // Fetch price data for open trades in the background
      const openTrades = processedTrades.filter(t => t.status === 'OPEN' && ['STK', 'FUT'].includes(t.type) && t.symbol);
      if (openTrades.length > 0) {
        const priceDataPromises = openTrades.map(trade => updateTradePriceData(trade, futuresSettings));
        Promise.all(priceDataPromises).then(priceDataResults => {
          if (requestSeq !== refreshSeqRef.current) return;
          setTrades(prevTrades => prevTrades.map(trade => {
            const openTradeIndex = openTrades.findIndex(ot => ot.id === trade.id);
            if (openTradeIndex !== -1) {
              const priceData = priceDataResults[openTradeIndex];
              if (priceData) return { ...trade, ...priceData };
            }
            return trade;
          }));
        }).catch(err => {
          console.error('Failed to fetch price data in background:', err);
        });
      }
    } catch (err) {
      console.error('Failed to refresh data from backend:', err);
      if (requestSeq === refreshSeqRef.current) {
        setTrades([]);
        setDayNotes([]);
        setIsFetching(false);
      }
    }
  }, [currentAccountId, futuresSettings, updateTradePriceData, loadAttachmentsInBackground, refreshAccounts]);

  // For a specific OTHER account's trades, fully processed (including live
  // price data) the same way `trades` is for the currently selected account
  // — but returned directly rather than written into `trades` state, since
  // the caller isn't switching accounts. Built for Navigation's Total
  // Portfolio, which rolls up STK market value / FUT unrealized P&L across
  // an account and its descendants (see docs/CAPITAL_TRACKING_DESIGN.md) —
  // reuses the exact same pipeline refreshTrades uses so these numbers can't
  // drift from what Dashboard/TradeList show for that account.
  const fetchProcessedTradesForAccount = useCallback(async (accountId) => {
    if (!accountId || !futuresSettings) return [];
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/trades`, { headers: { 'X-Account-ID': accountId } });
      if (!res.ok) return [];
      const tradesData = await res.json();
      const processedTrades = await processRawTradesArray(tradesData, futuresSettings);

      const openTrades = processedTrades.filter(t => t.status === 'OPEN' && ['STK', 'FUT'].includes(t.type) && t.symbol);
      if (openTrades.length === 0) return processedTrades;

      const priceDataResults = await Promise.all(openTrades.map(trade => updateTradePriceData(trade, futuresSettings)));
      const priceDataById = new Map(openTrades.map((t, i) => [t.id, priceDataResults[i]]));
      return processedTrades.map(t => priceDataById.has(t.id) && priceDataById.get(t.id) ? { ...t, ...priceDataById.get(t.id) } : t);
    } catch (err) {
      console.error(`Failed to fetch processed trades for account ${accountId}:`, err);
      return [];
    }
  }, [futuresSettings, updateTradePriceData]);

  const refreshFuturesSettings = useCallback(async () => {
    try {
      const res = await fetch(`${process.env.REACT_APP_API_URL}/api/futures-settings`);
      const data = await res.json();
      setFuturesSettings(data);
    } catch (err) {
      console.error('Failed to fetch futures settings:', err);
      setFuturesSettings([]);
    }
  }, []);

  useEffect(() => {
    refreshAccounts().then(data => {
      if (!currentAccountId && data.length > 0) {
        const newAccountId = data[0].id;
        setCurrentAccountId(newAccountId);
        localStorage.setItem('currentAccountId', newAccountId);
      }
    });
    refreshFuturesSettings();
  }, [currentAccountId, refreshFuturesSettings, refreshAccounts]);

  useEffect(() => { refreshHoldings(); }, [refreshHoldings]);

  useEffect(() => {
    if (currentAccountId && futuresSettings.length > 0) {
      refreshTrades();
    }
  }, [currentAccountId, futuresSettings, refreshTrades]);

  useEffect(() => {
    if (currentAccountId) {
      localStorage.setItem('currentAccountId', currentAccountId);
    }
  }, [currentAccountId]);

  const setSort = useCallback(field => {
    if (sortField === field) {
      setSortDirection(dir => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  }, [sortField]);

  // --- MEMOIZED CALCULATIONS ---

  const filteredItems = useMemo(() => {
  let combinedItems = [
    ...(showTrades && Array.isArray(trades) ? trades : []),
    ...(showDayNotes && Array.isArray(dayNotes) ? dayNotes : []),
  ];

  if (timeFilter) {
    const range = getTimeRange(timeFilter, customStartDate, customEndDate);
    if (range) {
      combinedItems = combinedItems.filter(item => {
        if (item.type === 'FUT' || item.type === 'STK') {
          const actions = Array.isArray(item.actions) ? item.actions : [];
          const hasActionInRange = actions.some(action => {
            const actionDate = parseActionDate(action.dateTime);
            return actionDate.isValid && actionDate >= range.start && actionDate <= range.end;
          });

          if (restrictToActionsInRange) {
            return hasActionInRange;
          } else {
            const firstActionDate = parseActionDate(item.firstActionDate);
            const lastActionDate = item.status === 'OPEN' ? DateTime.now() : parseActionDate(item.lastActionDate);
            let isActiveInRange = false;
            if (firstActionDate.isValid && lastActionDate.isValid) {
              isActiveInRange = firstActionDate <= range.end && lastActionDate >= range.start;
            }
            return hasActionInRange || isActiveInRange;
          }
        } else if (item.type === 'dayNote') {
          const noteDate = parseActionDate(item.date);
          return noteDate.isValid && noteDate >= range.start && noteDate <= range.end;
        }
        return false;
      });
    }
  }

  if (filter.length > 0) {
    const includeFilters = filter.filter(f => f.mode === 'include').map(f => f.type);
    const excludeFilters = filter.filter(f => f.mode === 'exclude').map(f => f.type);

    combinedItems = combinedItems.filter(item => {
      if (item.type === 'dayNote') return true;
      if (excludeFilters.includes(item.status)) return false;
      if (includeFilters.length > 0) return includeFilters.includes(item.status);
      return true;
    });
  }

  if (symbolFilter) {
    combinedItems = combinedItems.filter(item => {
      if ((item.type === 'FUT' || item.type === 'STK') && item.symbol) {
        return item.symbol.toUpperCase().startsWith(symbolFilter.toUpperCase());
      }
      return item.type === 'dayNote';
    });
  }

      return sortItems(combinedItems, sortField, sortDirection);
  }, [trades, dayNotes, showTrades, showDayNotes, timeFilter, customStartDate, customEndDate, restrictToActionsInRange, filter, symbolFilter, sortField, sortDirection]);

  const stats = useMemo(() => {
    return computeStats(filteredItems.filter(item => item.type === 'FUT' || item.type === 'STK'), futuresSettings);
  }, [filteredItems, futuresSettings]);

  // Memoize the context value to prevent consumers from re-rendering when unrelated state changes
  const contextValue = useMemo(() => ({
        trades,
        dayNotes,
        filteredItems,
        setTrades,
        stats,
        toggleFilter,
        refreshTrades,
        fetchProcessedTradesForAccount,
        setSort,
        sortField,
        sortDirection,
        timeFilter,
        setTimeFilter,
        filter,
        getTimeRange,
        customStartDate,
        customEndDate,
        setCustomStartDate,
        setCustomEndDate,
        accounts,
        setAccounts,
        refreshAccounts,
        holdings,
        refreshHoldings,
        currentAccountId,
        setCurrentAccountId,
        showTrades,
        showDayNotes,
        toggleShowTrades,
        toggleShowDayNotes,
        futuresSettings,
        refreshFuturesSettings,
        getAllTradeData,
        symbolFilter,
        setSymbolFilter,
        clearSymbolFilter,
        restrictToActionsInRange,
        setRestrictToActionsInRange,
        isFetching,
        tradesPerPage,
        setTradesPerPage,
        currentPage,
        setCurrentPage,
        hiddenColumns,
        toggleColumnVisibility,
  }), [
        trades, dayNotes, filteredItems, stats, toggleFilter, refreshTrades, fetchProcessedTradesForAccount, setSort, sortField, sortDirection,
        timeFilter, filter, customStartDate, customEndDate, accounts, refreshAccounts, holdings, refreshHoldings, currentAccountId, showTrades, showDayNotes,
        toggleShowTrades, toggleShowDayNotes, futuresSettings, refreshFuturesSettings, getAllTradeData,
        symbolFilter, restrictToActionsInRange, isFetching, tradesPerPage, currentPage, hiddenColumns, toggleColumnVisibility
  ]);

  return (
    <TradeContext.Provider value={contextValue}>
      {children}
    </TradeContext.Provider>
  );
};