const db = require('./database.js');

// The last price this journal has stored itself for a symbol: the close of
// its newest bar in historical_data (IBKR, Yahoo or TradingView, whichever
// is freshest). It stands in for a live quote when Yahoo can't give one.
//
// A futures symbol also stores bars of each later contract month, priced
// differently (the April contract trades above the December one). Only the
// front-month series counts: the continuous one, or bars without a contract
// month (Yahoo's =F, TradingView's 1!).
//
// The table is large, so the newest bar is looked up per timeframe (and,
// outside the continuous series, per source) where an index gives it at once.
const TIMEFRAMES = ['1M', '5M', '15M', '1H', '4H', '1D', '1W'];
const SOURCES = ['IBKR', 'Yahoo', 'TradingView'];

// Returns { price, time, source, timeframe } or null when nothing is stored.
async function latestStoredPrice(symbol, type) {
    const { rows } = await db.getPool().query(
        `WITH fs AS (SELECT id FROM futures_settings WHERE symbol = $1 AND type = $2)
         SELECT b.close, b.time, b.source, b.timeframe
         FROM fs CROSS JOIN unnest($3::text[]) AS tf(timeframe)
         CROSS JOIN LATERAL (
             (SELECT h.close, h.time, h.source, h.timeframe FROM historical_data h
              WHERE h.futures_setting_id = fs.id AND h.timeframe = tf.timeframe AND h.is_continuous
              ORDER BY h.time DESC LIMIT 1)
             UNION ALL
             (SELECT n.close, n.time, n.source, n.timeframe FROM unnest($4::text[]) AS src(source)
              CROSS JOIN LATERAL (
                  SELECT h.close, h.time, h.source, h.timeframe FROM historical_data h
                  WHERE h.futures_setting_id = fs.id AND h.timeframe = tf.timeframe AND h.source = src.source
                    AND NOT h.is_continuous AND COALESCE(h.contract_month, '') = ''
                  ORDER BY h.time DESC LIMIT 1
              ) n)
         ) b
         ORDER BY b.time DESC LIMIT 1`,
        [symbol, type, TIMEFRAMES, SOURCES]
    );
    if (rows.length === 0) return null;
    const { close, time, source, timeframe } = rows[0];
    const price = parseFloat(close);
    if (!Number.isFinite(price)) return null;
    return { price, time: new Date(time).toISOString(), source, timeframe };
}

module.exports = { latestStoredPrice };
