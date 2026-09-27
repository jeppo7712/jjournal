// Journal symbols follow Yahoo's naming: a non-US listing carries a market
// suffix (XEON.DE, ASML.AS, IB01.L) and crypto is quoted as a pair
// (BTC-EUR). IBKR names the same instrument by its bare ticker plus a
// listing exchange (XEON on IBIS/IBIS2) and a currency. This translates one
// into the other, so IBKR price history, Flex imports and TWS imports find
// non-US listings instead of silently matching nothing.
//
// US stocks and futures are not translated: their journal symbol already is
// the IBKR ticker, and the code paths that handle them are left exactly as
// they were.

// IBKR listing-exchange codes per market. A listing can report any of these
// (e.g. a Xetra ETF shows up as IBIS or IBIS2 depending on the line).
const MARKET_VENUES = {
    DE: ['IBIS', 'IBIS2', 'FWB', 'FWB2', 'GETTEX', 'GETTEX2', 'SWB', 'SWB2', 'TGATE'],
    AS: ['AEB'],
    PA: ['SBF'],
    BR: ['ENEXT.BE'],
    L: ['LSE', 'LSEETF', 'LSEIOB1'],
    MI: ['BVME', 'BVME.ETF'],
    SW: ['EBS'],
    MC: ['BM'],
    US: ['NASDAQ', 'NYSE', 'ARCA', 'AMEX', 'BATS', 'NYSENAT', 'IEX', 'PINK'],
};

// Yahoo symbol suffix -> market.
const SUFFIX_MARKET = { DE: 'DE', F: 'DE', AS: 'AS', PA: 'PA', BR: 'BR', L: 'L', MI: 'MI', SW: 'SW', MC: 'MC' };

// A symbol setting's free-text exchange -> market, for symbols without a
// suffix. EURONEXT is deliberately absent: it spans Amsterdam, Paris,
// Brussels and more, so it can't say which listing is meant.
const EXCHANGE_MARKET = {
    XETRA: 'DE', IBIS: 'DE', FWB: 'DE',
    AEB: 'AS', SBF: 'PA',
    LSE: 'L', LSEETF: 'L',
    BVME: 'MI', EBS: 'SW', BM: 'MC',
    NASDAQ: 'US', NYSE: 'US', ARCA: 'US', AMEX: 'US', BATS: 'US',
};

// Yahoo's crypto/FX pair naming (BTC-EUR, ETH-USD). Not an IBKR instrument
// under that name; a class share like BRK-B doesn't match (one letter).
const PAIR_RE = /^[A-Z0-9]+-[A-Z]{3}$/;

/**
 * Resolves how IBKR names a journal symbol.
 *
 * @param {object} setting  the symbol's futures_settings row (or any object
 *   with symbol, type, exchange, currency, ibkr_symbol, ibkr_exchange)
 * @returns {null | { symbol, currency, market, venues, translated }}
 *   null: not an IBKR instrument (skip IBKR entirely).
 *   venues: IBKR listing exchanges this listing may report, or null when
 *     unknown (then nothing is filtered on exchange).
 *   translated: the IBKR ticker/listing differs from the journal's, so
 *     IBKR requests must use the SMART-routed lookup rather than the
 *     journal symbol and exchange as-is.
 */
function resolveIbkrIdentity(setting) {
    const journalSymbol = String(setting.symbol || '').toUpperCase();
    const currency = setting.currency ? String(setting.currency).toUpperCase() : null;
    const overrideSymbol = setting.ibkr_symbol ? String(setting.ibkr_symbol).trim().toUpperCase() : '';
    const overrideExchange = setting.ibkr_exchange ? String(setting.ibkr_exchange).trim().toUpperCase() : '';

    const dot = journalSymbol.lastIndexOf('.');
    const suffixMarket = dot > 0 ? SUFFIX_MARKET[journalSymbol.slice(dot + 1)] : undefined;
    const bareSymbol = suffixMarket ? journalSymbol.slice(0, dot) : journalSymbol;
    const market = suffixMarket || EXCHANGE_MARKET[String(setting.exchange || '').toUpperCase()] || null;

    if (overrideSymbol || overrideExchange) {
        return {
            symbol: overrideSymbol || bareSymbol,
            currency,
            market,
            venues: overrideExchange ? [overrideExchange] : (market ? MARKET_VENUES[market] : null),
            translated: true,
        };
    }
    if (setting.type === 'STK' && PAIR_RE.test(journalSymbol)) return null;

    return {
        symbol: bareSymbol,
        currency,
        market,
        venues: market ? MARKET_VENUES[market] : null,
        translated: setting.type === 'STK' && market !== null && market !== 'US',
    };
}

/**
 * Whether an IBKR report row (Flex trade, or a TWS contract) is this
 * listing. Stocks only; futures keep their own root/contract matching.
 * Fields absent from the row are not held against it.
 */
function isSameStockListing(identity, { symbol, underlyingSymbol, listingExchange, primaryExch, currency }) {
    const rowSymbol = String(symbol || '').toUpperCase();
    const rowUnderlying = String(underlyingSymbol || '').toUpperCase();
    if (rowSymbol !== identity.symbol && rowUnderlying !== identity.symbol) return false;

    const venue = String(listingExchange || primaryExch || '').toUpperCase();
    if (identity.venues && venue && !identity.venues.includes(venue)) return false;

    if (identity.currency && currency && String(currency).toUpperCase() !== identity.currency) return false;
    return true;
}

// Futures month codes, as in a contract's local symbol (MNQZ6 = Dec 2026).
const MONTH_CODES = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };

/**
 * A futures fill's contract month as YYYYMM, the format trades.contract_month
 * and the historical-data code use. Read from the contract code in the local
 * symbol (MGCZ6), because the expiry date isn't always in the contract month:
 * a December gold contract stops trading in late November. The expiry is only
 * the fallback. A one-digit year is resolved to the earliest matching year
 * that isn't more than a year before the fill.
 *
 * @param {object} fields  { localSymbol, symbol, expiry } — whichever the
 *   source has; expiry as YYYYMMDD or YYYYMM
 * @param {string|Date} [fillTime]  when the fill happened (defaults to now)
 * @returns {string|null}
 */
function futuresContractMonth({ localSymbol, symbol, expiry } = {}, fillTime = null) {
    const fillYear = (() => {
        const match = String(fillTime || '').match(/^(\d{4})/);
        return match ? Number(match[1]) : new Date().getUTCFullYear();
    })();
    for (const candidate of [localSymbol, symbol]) {
        const match = String(candidate || '').toUpperCase().replace(/\s+/g, '').match(/([FGHJKMNQUVXZ])(\d{1,2})$/);
        if (!match) continue;
        const month = MONTH_CODES[match[1]];
        let year;
        if (match[2].length === 2) {
            year = 2000 + Number(match[2]);
        } else {
            // Earliest year ending in that digit that isn't more than a
            // year before the fill (a contract can't trade after expiry).
            year = fillYear - (fillYear % 10) - 10 + Number(match[2]);
            while (year < fillYear - 1) year += 10;
        }
        return `${year}${String(month).padStart(2, '0')}`;
    }
    const digits = String(expiry || '').replace(/\D/g, '');
    return digits.length >= 6 ? digits.slice(0, 6) : null;
}

module.exports = { resolveIbkrIdentity, isSameStockListing, futuresContractMonth, MARKET_VENUES };
