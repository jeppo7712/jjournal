const { DateTime } = require('luxon');

// Server-side port of the trade PnL/meta calculations the frontend computes
// client-side (see getTickMultiplier/computeTradeMeta/refreshTrades in
// src/context/TradeContext.js). Used by the external API (routes/external.js)
// so an external consumer gets ready-to-use side/status/PnL/return% fields
// instead of having to reimplement FIFO-adjacent trade accounting itself.
//
// NOTE: this is a deliberate duplication, not a shared import — TradeContext.js
// is a React ES module (JSX, browser-only APIs) and can't be required from
// this CommonJS backend without a build step. If the calculation rules ever
// change, both places need updating together.

function getTickMultiplier(trade) {
    if (trade.type === 'STK') return 1;
    const tickValue = Number(trade.tick_value ?? 0);
    const tickSize = Number(trade.tick_size ?? 0);
    return tickValue !== 0 && tickSize !== 0 ? tickValue / tickSize : 1;
}

function parseActionDate(dateTimeValue) {
    if (!dateTimeValue) return null;
    // pg returns `timestamptz` columns as native JS Date objects, not ISO
    // strings — String(dateObj) gives a locale-formatted string ("Mon May 12
    // 2025 13:00:00 GMT+0400 (...)") that DateTime.fromISO can't parse, which
    // silently failed date parsing for every action on every trade (this
    // function only runs server-side, on raw DB rows, before any JSON
    // serialization would have converted the Date to an ISO string for us).
    // That made every trade's buy/sell quantities stay 0 and status get
    // stuck on its 'OPEN' default, regardless of actual position size.
    const dt = dateTimeValue instanceof Date
        ? DateTime.fromJSDate(dateTimeValue, { zone: 'utc' })
        : DateTime.fromISO(String(dateTimeValue), { zone: 'utc' });
    return dt.isValid ? dt : null;
}

function calculatePricePrecision(setting) {
    if (!setting || !setting.tick_size) return 2;
    const tickSize = Number(setting.tick_size);
    if (isNaN(tickSize) || tickSize <= 0) return 2;
    const tickSizeStr = tickSize.toString();
    const decimalIndex = tickSizeStr.indexOf('.');
    return decimalIndex === -1 ? 0 : tickSizeStr.length - decimalIndex - 1;
}

function getFuturesSetting(symbol, type, futuresSettings) {
    const settings = Array.isArray(futuresSettings) ? futuresSettings : [];
    if (!symbol || !type) {
        return settings.find(s => s.symbol === 'DEFAULT' && s.type === type) || settings.find(s => s.symbol === 'DEFAULT') || null;
    }
    const upperSymbol = symbol.toUpperCase();
    const specificSettings = settings
        .filter(s => s.symbol !== 'DEFAULT' && s.type === type)
        .sort((a, b) => b.symbol.length - a.symbol.length);
    const matchingSetting = specificSettings.find(s => upperSymbol.startsWith(s.symbol));
    if (matchingSetting) return matchingSetting;
    return settings.find(s => s.symbol === 'DEFAULT' && s.type === type) || settings.find(s => s.symbol === 'DEFAULT') || null;
}

/**
 * Computes side, status, realised PnL, return %, R-multiple, average/entry/
 * exit prices, position size, and hold time for a trade — the same derived
 * fields the app's UI shows, given the trade's raw `actions` array.
 * @param {object} trade - { type, symbol, stop_loss, tick_size, tick_value, actions: [{type, dateTime|date_time, quantity, price, fee}] }
 * @param {Array} futuresSettings - rows from futures_settings, for margin/tick lookups
 */
function computeTradeDerived(trade, futuresSettings) {
    const actions = Array.isArray(trade.actions) ? trade.actions : [];
    let buyQty = 0, sellQty = 0, buySum = 0, sellSum = 0, buyFee = 0, sellFee = 0;
    let firstActionDate = null, lastActionDate = null;
    let side = null, status = 'OPEN', ret = null, directionBeforeClose = null;

    const tickMultiplier = getTickMultiplier(trade);

    actions.forEach((a, idx) => {
        const actionDate = parseActionDate(a.dateTime || a.date_time);
        if (!actionDate) return;
        if (!firstActionDate || actionDate < firstActionDate) firstActionDate = actionDate;
        if (!lastActionDate || actionDate > lastActionDate) lastActionDate = actionDate;
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

    const avgBuy = buySum / (buyQty || 1);
    const avgSell = sellSum / (sellQty || 1);

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
        if (Math.abs(ret) < 1e-6) status = 'WASH';
        else if (ret > 0) status = 'WIN';
        else status = 'LOSS';
    }

    const holdTimeMinutes = (status !== 'OPEN' && firstActionDate && lastActionDate && firstActionDate < lastActionDate)
        ? Math.round(lastActionDate.diff(firstActionDate, 'minutes').minutes)
        : null;

    let returnPercentage = null;
    if (ret !== null) {
        if (trade.type === 'FUT') {
            const setting = getFuturesSetting(trade.symbol, trade.type, futuresSettings);
            if (setting && setting.initial_margin > 0) {
                let maxContracts = 0, openContracts = 0;
                if (side === 'LONG') {
                    actions.forEach(a => {
                        if (a.type === 'BUY') { openContracts += Number(a.quantity || 0); if (openContracts > maxContracts) maxContracts = openContracts; }
                        else { openContracts -= Number(a.quantity || 0); }
                    });
                } else if (side === 'SHORT') {
                    actions.forEach(a => {
                        if (a.type === 'SELL') { openContracts += Number(a.quantity || 0); if (openContracts > maxContracts) maxContracts = openContracts; }
                        else { openContracts -= Number(a.quantity || 0); }
                    });
                }
                const totalInitialMargin = setting.initial_margin * maxContracts;
                if (totalInitialMargin > 0) returnPercentage = (ret / totalInitialMargin) * 100;
            }
        }
        if (returnPercentage === null) {
            const entryTotal = side === 'LONG' ? buySum : sellSum;
            if (entryTotal) returnPercentage = ((ret / tickMultiplier) / entryTotal) * 100;
        }
    }

    let rMultiple = null;
    if (trade.stop_loss !== undefined && trade.stop_loss !== null && ret !== null) {
        const entryPrice = side === 'LONG' ? avgBuy : avgSell;
        const quantity = Math.min(buyQty, sellQty);
        const riskPerUnit = Math.abs(entryPrice - trade.stop_loss);
        const totalRisk = riskPerUnit * quantity * tickMultiplier;
        if (totalRisk > 0) rMultiple = ret / totalRisk;
    }

    const setting = getFuturesSetting(trade.symbol, trade.type, futuresSettings);
    const pricePrecision = setting ? calculatePricePrecision(setting) : 2;

    return {
        side,
        status,
        return: ret,
        return_percentage: returnPercentage,
        r_multiple: rMultiple,
        buy_quantity: buyQty,
        sell_quantity: sellQty,
        buy_fee: buyFee,
        sell_fee: sellFee,
        avg_buy_price: buyQty ? avgBuy : null,
        avg_sell_price: sellQty ? avgSell : null,
        quantity: status === 'OPEN' ? null : (side === 'LONG' ? sellSum / avgSell : buySum / avgBuy),
        position: status === 'OPEN' ? Math.abs(buyQty - sellQty) : null,
        entry_price: side === 'LONG' ? avgBuy : avgSell,
        exit_price: status === 'OPEN' ? null : (side === 'LONG' ? avgSell : avgBuy),
        entry_total: side === 'LONG' ? buySum : sellSum,
        exit_total: status === 'OPEN' ? null : (side === 'LONG' ? sellSum : buySum),
        hold_time_minutes: holdTimeMinutes,
        price_precision: pricePrecision,
        first_action_at: firstActionDate ? firstActionDate.toISO() : null,
        last_action_at: lastActionDate ? lastActionDate.toISO() : null,
    };
}

/**
 * FIFO-matches a FUTURES trade's actions to compute the realised PnL
 * attributable to EACH CLOSING action individually (not just the final
 * total) — needed so a closing fill can settle its own realised PnL to
 * cash as it happens (see routes/trades.js's settleTradeActionsToCash),
 * rather than only being knowable once the whole position is closed.
 *
 * Deliberately price-difference only, no fee attribution — unlike
 * matchLotsFIFO in TradeContext.js (which folds proportional entry/exit
 * fees into its running realisedPnL total). Fees here are already
 * correctly settled to cash the moment each action is charged one,
 * regardless of when its PnL gets realised (a broker charges commission
 * per fill, not per eventual close) — adding fee-slicing on top of that
 * would double-count it. This only needs to answer "how much of the
 * price move did this specific close realise."
 *
 * @param {string} side - 'LONG' or 'SHORT'
 * @param {Array} actions - chronologically sorted {type, quantity, price}
 * @param {number} tickMultiplier - see getTickMultiplier
 * @returns {Map<number, number>} action array index -> realised PnL for
 *   that action (only closing actions have entries; opening actions
 *   realise nothing yet).
 */
function computeFuturesRealizedPnLPerAction(side, actions, tickMultiplier) {
    const realizedByIndex = new Map();
    if (side !== 'LONG' && side !== 'SHORT') return realizedByIndex;

    const openLots = []; // { quantity, price }
    const openingType = side === 'LONG' ? 'BUY' : 'SELL';
    const closingType = side === 'LONG' ? 'SELL' : 'BUY';
    const sign = side === 'LONG' ? 1 : -1;

    actions.forEach((action, idx) => {
        if (action.type === openingType) {
            openLots.push({ quantity: Number(action.quantity || 0), price: Number(action.price || 0) });
        } else if (action.type === closingType) {
            let realizedForThisAction = 0;
            let closeQty = Number(action.quantity || 0);
            while (closeQty > 0 && openLots.length > 0) {
                const lot = openLots[0];
                const qtyToClose = Math.min(lot.quantity, closeQty);
                realizedForThisAction += (Number(action.price) - lot.price) * sign * qtyToClose * tickMultiplier;
                lot.quantity -= qtyToClose;
                closeQty -= qtyToClose;
                if (lot.quantity <= 0) openLots.shift();
            }
            realizedByIndex.set(idx, realizedForThisAction);
        }
    });

    return realizedByIndex;
}

module.exports = { computeTradeDerived, getTickMultiplier, computeFuturesRealizedPnLPerAction, parseActionDate };
