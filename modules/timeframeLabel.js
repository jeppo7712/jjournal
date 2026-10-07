// A timeframe as the user reads it in status messages: minutes as "1m",
// "5m", "15m" ("1M" is one month in TradingView). Internally, in the
// database and the logs, they stay "1M", "5M", "15M". Same rule as
// src/utils/timeframeLabel.js.
const timeframeLabel = (tf) => (typeof tf === 'string' && /^\d+M$/.test(tf) ? `${tf.slice(0, -1)}m` : tf);

module.exports = { timeframeLabel };
