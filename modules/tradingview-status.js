const { logger } = require('./logger.js');

// When the TradingView webhook last delivered a bar, for the status light in
// the navigation. Kept in memory and updated by routes/tradingview-webhook.js;
// on startup it's seeded from the newest TradingView bar in the database, so
// a restart doesn't make a working feed look dead until the next alert.
let lastBar = null; // { receivedAt, symbol, timeframe, time }

function recordBar({ symbol, timeframe, time }) {
  lastBar = { receivedAt: new Date().toISOString(), symbol, timeframe, time };
}

function getLastBar() {
  return lastBar;
}

async function seedFromDatabase(pool) {
  try {
    // One index lookup per symbol and timeframe (historical_data_source_idx)
    // instead of a max() over the whole table.
    const { rows } = await pool.query(`
      SELECT f.symbol, x.timeframe, x.last
      FROM futures_settings f
      CROSS JOIN LATERAL (
        SELECT tf AS timeframe,
               (SELECT max(time) FROM historical_data h
                 WHERE h.futures_setting_id = f.id AND h.timeframe = tf AND h.source = 'TradingView') AS last
        FROM unnest(ARRAY['1M','5M','15M','1H','4H','1D','1W']) AS tf
      ) x
      WHERE x.last IS NOT NULL
      ORDER BY x.last DESC
      LIMIT 1`);
    if (rows.length > 0 && !lastBar) {
      const { symbol, timeframe, last } = rows[0];
      const time = new Date(last).toISOString();
      lastBar = { receivedAt: time, symbol, timeframe, time };
    }
  } catch (err) {
    logger.warn(`[TradingView status] Could not read the last TradingView bar: ${err.message}`);
  }
}

module.exports = { recordBar, getLastBar, seedFromDatabase };
