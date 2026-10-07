// How a timeframe reads in the interface. Internally minutes are "1M",
// "5M", "15M" (stored that way in the database and the API); shown as
// "1m", "5m", "15m", since in TradingView "1M" is one month.
export const timeframeLabel = (tf) => (typeof tf === 'string' && /^\d+M$/.test(tf) ? `${tf.slice(0, -1)}m` : tf);
