const db = require('./database.js');
const { getFuturesSetting } = require('./tradeCalculations.js');
const { futuresContractMonth } = require('./ibkrSymbols.js');

// The last price this journal has stored itself for a symbol: the close of
// its newest bar in historical_data (IBKR, Yahoo or TradingView, whichever
// is freshest). It stands in for a live quote when Yahoo can't give one.
//
// A futures symbol also stores bars of each later contract month, priced
// differently (the April contract trades above the December one). Only the
// front-month series counts: the continuous one, or bars without a contract
// month (Yahoo's =F, TradingView's 1!).
//
// A futures trade can carry its contract in the symbol (MNQZ6). Its
// setting is the root's (MNQ), found the way the rest of the app finds it,
// and that contract month's own bars are preferred when stored; without
// them the front month stands in.
//
// The table is large, so the newest bar is looked up per timeframe (and,
// outside the continuous series, per source) where an index gives it at once.
const TIMEFRAMES = ['1M', '5M', '15M', '1H', '4H', '1D', '1W'];
const SOURCES = ['IBKR', 'Yahoo', 'TradingView'];

async function newestContractBar(settingId, contractMonth) {
    const { rows } = await db.getPool().query(
        `SELECT b.close, b.time, b.source, b.timeframe
         FROM unnest($2::text[]) AS tf(timeframe)
         CROSS JOIN unnest($3::text[]) AS src(source)
         CROSS JOIN LATERAL (
             SELECT h.close, h.time, h.source, h.timeframe FROM historical_data h
             WHERE h.futures_setting_id = $1 AND h.timeframe = tf.timeframe AND h.source = src.source
               AND NOT h.is_continuous AND COALESCE(h.contract_month, '') = $4
             ORDER BY h.time DESC LIMIT 1
         ) b
         ORDER BY b.time DESC LIMIT 1`,
        [settingId, TIMEFRAMES, SOURCES, contractMonth]
    );
    return rows[0] || null;
}

async function newestFrontMonthBar(settingId) {
    const { rows } = await db.getPool().query(
        `SELECT b.close, b.time, b.source, b.timeframe
         FROM unnest($2::text[]) AS tf(timeframe)
         CROSS JOIN LATERAL (
             (SELECT h.close, h.time, h.source, h.timeframe FROM historical_data h
              WHERE h.futures_setting_id = $1 AND h.timeframe = tf.timeframe AND h.is_continuous
              ORDER BY h.time DESC LIMIT 1)
             UNION ALL
             (SELECT n.close, n.time, n.source, n.timeframe FROM unnest($3::text[]) AS src(source)
              CROSS JOIN LATERAL (
                  SELECT h.close, h.time, h.source, h.timeframe FROM historical_data h
                  WHERE h.futures_setting_id = $1 AND h.timeframe = tf.timeframe AND h.source = src.source
                    AND NOT h.is_continuous AND COALESCE(h.contract_month, '') = ''
                  ORDER BY h.time DESC LIMIT 1
              ) n)
         ) b
         ORDER BY b.time DESC LIMIT 1`,
        [settingId, TIMEFRAMES, SOURCES]
    );
    return rows[0] || null;
}

// The symbol's own setting: an exact match, or for a future the root its
// symbol starts with (never DEFAULT, which has no bars of its own).
async function resolveSetting(symbol, type) {
    const { rows } = await db.getPool().query('SELECT id, symbol, type FROM futures_settings WHERE type = $1', [type]);
    const upper = String(symbol || '').toUpperCase();
    const exact = rows.find(r => r.symbol.toUpperCase() === upper);
    if (exact) return exact;
    if (type !== 'FUT') return null;
    const root = getFuturesSetting(upper, type, rows);
    return root && root.symbol !== 'DEFAULT' ? root : null;
}

// Returns { price, time, source, timeframe } or null when nothing is stored.
async function latestStoredPrice(symbol, type) {
    const setting = await resolveSetting(symbol, type);
    if (!setting) return null;
    const upper = String(symbol || '').toUpperCase();
    const contractMonth = type === 'FUT' && upper !== setting.symbol.toUpperCase()
        ? futuresContractMonth({ symbol: upper })
        : null;
    const bar = (contractMonth && await newestContractBar(setting.id, contractMonth)) || await newestFrontMonthBar(setting.id);
    if (!bar) return null;
    const price = parseFloat(bar.close);
    if (!Number.isFinite(price)) return null;
    return { price, time: new Date(bar.time).toISOString(), source: bar.source, timeframe: bar.timeframe };
}

module.exports = { latestStoredPrice };
