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

module.exports = { resolveIbkrIdentity, isSameStockListing, MARKET_VENUES };
