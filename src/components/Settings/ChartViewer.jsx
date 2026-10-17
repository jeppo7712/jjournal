import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { DateTime } from 'luxon';
import { createChart } from 'lightweight-charts';
import styles from './ChartViewer.module.css';
import { loadStoredDisplayTimezone, storeDisplayTimezone, resolveDisplayZone, TimezonePicker } from '../../utils/timezonePreference';
import { formatNumber } from '../../utils/numberFormat';
import { timeframeLabel } from '../../utils/timeframeLabel';

// Settings → Charts: any symbol's stored price history, without a trade —
// for looking up old bars (1-minute data going back further than most
// charting sites keep). Read-only: it asks for what's in the database
// (noRefresh), so browsing old data never queues fetches or interrupts the
// background tasks. Loads a window around the chosen moment and more as the
// chart is scrolled to either edge, from the same endpoint the trade view
// uses (GET /api/historical/db).

const TIMEFRAMES = ['1M', '5M', '15M', '1H', '4H', '1D', '1W'];
const BAR_SECONDS = { '1M': 60, '5M': 300, '15M': 900, '1H': 3600, '4H': 14400, '1D': 86400, '1W': 604800 };
// Bars per load either side; a window is sized in time, with room for
// nights and weekends without bars.
const WINDOW_BARS = 1500;
const WINDOW_SLACK = 2.2;
// Kept in memory at most; scrolling far away drops the far side.
const MAX_BARS = 40000;
// How close to an edge (in bars) before the next window loads.
const EDGE_BARS = 40;

const toSeconds = iso => Math.floor(Date.parse(iso) / 1000);

// The earliest and latest bar of a timeframe over every source the summary
// lists (IBKR continuous or per contract, Yahoo, stock IBKR).
function rangeOf(summaryTf, contract) {
  if (!summaryTf) return null;
  const spans = [];
  if (contract) {
    if (summaryTf.ibkrContracts?.[contract]) spans.push(summaryTf.ibkrContracts[contract]);
  } else {
    for (const key of ['ibkrContinuous', 'yahoo', 'ibkr']) if (summaryTf[key]) spans.push(summaryTf[key]);
  }
  const valid = spans.filter(s => s.earliest && s.latest);
  if (valid.length === 0) return null;
  return {
    earliest: valid.map(s => s.earliest).sort()[0],
    latest: valid.map(s => s.latest).sort().slice(-1)[0],
  };
}

export default function ChartViewer({ futuresSettings = [], apiBaseUrl }) {
  const symbols = useMemo(() => (futuresSettings || [])
    .filter(s => s.symbol !== 'DEFAULT')
    .map(s => ({ key: `${s.symbol}|${s.type}`, symbol: s.symbol, type: s.type, precision: precisionOf(s.tick_size) }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol)), [futuresSettings]);

  const [symbolKey, setSymbolKey] = useState(() => {
    try { return localStorage.getItem('jjournal_chart_viewer_symbol') || ''; } catch { return ''; }
  });
  const selected = symbols.find(s => s.key === symbolKey) || symbols[0] || null;
  const [summary, setSummary] = useState(null);
  const [timeframe, setTimeframe] = useState('1M');
  const [contract, setContract] = useState('');
  const [goTo, setGoTo] = useState('');
  const [displayTimezone, setDisplayTimezone] = useState(() => loadStoredDisplayTimezone());
  const [bars, setBars] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hover, setHover] = useState(null);

  const zone = resolveDisplayZone(displayTimezone, summary?.exchangeTimezone || 'America/New_York');
  const summaryTf = summary?.timeframes?.[timeframe];
  const range = rangeOf(summaryTf, contract);
  const availableTimeframes = TIMEFRAMES.filter(tf => rangeOf(summary?.timeframes?.[tf], '') || Object.keys(summary?.timeframes?.[tf]?.ibkrContracts || {}).length > 0);
  const contracts = Object.keys(summaryTf?.ibkrContracts || {}).sort();

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeRef = useRef(null);
  const barsRef = useRef([]);
  const loadingRef = useRef(false);
  const requestSeqRef = useRef(0);
  const pendingViewRef = useRef(null); // { center } or { shiftBy } for the next render
  const edgesRef = useRef({ earliest: false, latest: false }); // nothing more that way

  useEffect(() => { barsRef.current = bars; }, [bars]);

  // The symbol's summary: which timeframes have data, from when to when,
  // and for a future its contracts.
  useEffect(() => {
    if (!selected) return;
    try { localStorage.setItem('jjournal_chart_viewer_symbol', selected.key); } catch { /* not kept */ }
    let cancelled = false;
    setSummary(null);
    setBars([]);
    setError(null);
    fetch(`${apiBaseUrl}/api/historical/summary?symbol=${encodeURIComponent(selected.symbol)}&type=${encodeURIComponent(selected.type)}`)
      .then(res => res.json())
      .then(data => { if (!cancelled) setSummary(data && data.timeframes ? data : null); })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [selected?.key, apiBaseUrl]);

  // A timeframe or contract without data for this symbol falls back.
  useEffect(() => {
    if (!summary) return;
    if (!availableTimeframes.includes(timeframe) && availableTimeframes.length > 0) {
      // The finest one stored (TIMEFRAMES runs finest first).
      setTimeframe(availableTimeframes[0]);
    }
    if (contract && !contracts.includes(contract)) setContract('');
  }, [summary, timeframe, contract]);

  const fetchBars = useCallback(async (startIso, endIso) => {
    const params = new URLSearchParams({
      symbol: selected.symbol, type: selected.type, timeframe, noRefresh: 'true', startDate: startIso, endDate: endIso,
    });
    if (contract) params.set('contractMonth', contract);
    const res = await fetch(`${apiBaseUrl}/api/historical/db?${params}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }, [selected?.symbol, selected?.type, timeframe, contract, apiBaseUrl]);

  const spanSeconds = BAR_SECONDS[timeframe] * WINDOW_BARS * WINDOW_SLACK;

  // A fresh window: around the chosen moment, or the latest bars.
  const loadAround = useCallback(async (centerIso) => {
    if (!selected || !range) return;
    const seq = ++requestSeqRef.current;
    const latest = toSeconds(range.latest);
    const center = centerIso ? toSeconds(centerIso) : latest;
    const start = new Date((centerIso ? center - spanSeconds : latest - 2 * spanSeconds) * 1000).toISOString();
    const end = new Date((centerIso ? center + spanSeconds : latest + BAR_SECONDS[timeframe]) * 1000).toISOString();
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchBars(start, end);
      if (seq !== requestSeqRef.current) return;
      edgesRef.current = { earliest: data.length === 0 || data[0].time <= range.earliest, latest: data.length === 0 || data[data.length - 1].time >= range.latest };
      pendingViewRef.current = { center: centerIso ? center : null };
      setBars(data);
    } catch (err) {
      if (seq === requestSeqRef.current) setError(err.message);
    } finally {
      if (seq === requestSeqRef.current) { loadingRef.current = false; setLoading(false); }
    }
  }, [selected, range?.earliest, range?.latest, fetchBars, spanSeconds, timeframe]);

  // More bars at one edge, kept in view where the user is.
  const loadMore = useCallback(async (direction) => {
    const current = barsRef.current;
    if (loadingRef.current || current.length === 0 || edgesRef.current[direction === 'older' ? 'earliest' : 'latest']) return;
    const seq = requestSeqRef.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const edge = toSeconds(direction === 'older' ? current[0].time : current[current.length - 1].time);
      const step = BAR_SECONDS[timeframe];
      const [start, end] = direction === 'older'
        ? [edge - 2 * spanSeconds, edge - step]
        : [edge + step, edge + 2 * spanSeconds];
      const data = await fetchBars(new Date(start * 1000).toISOString(), new Date(end * 1000).toISOString());
      if (seq !== requestSeqRef.current) return;
      const known = new Set(current.map(b => b.time));
      const added = data.filter(b => !known.has(b.time));
      if (added.length === 0) {
        edgesRef.current[direction === 'older' ? 'earliest' : 'latest'] = true;
        return;
      }
      let merged = direction === 'older' ? [...added, ...current] : [...current, ...added];
      let dropped = 0;
      if (merged.length > MAX_BARS) {
        dropped = merged.length - MAX_BARS;
        if (direction === 'older') { merged = merged.slice(0, MAX_BARS); edgesRef.current.latest = false; }
        else { merged = merged.slice(dropped); edgesRef.current.earliest = false; }
      }
      pendingViewRef.current = { shiftBy: direction === 'older' ? added.length : -dropped };
      setBars(merged);
    } catch (err) {
      setError(err.message);
    } finally {
      if (seq === requestSeqRef.current) { loadingRef.current = false; setLoading(false); }
    }
  }, [fetchBars, spanSeconds, timeframe]);

  // A new symbol, timeframe or contract: the latest bars (or the moment
  // chosen in "Go to").
  useEffect(() => {
    if (!selected || !range) return;
    loadAround(goTo ? DateTime.fromISO(goTo, { zone }).toUTC().toISO() : null);
  }, [selected?.key, timeframe, contract, range?.earliest, range?.latest]);

  // The chart, once.
  useEffect(() => {
    if (!chartContainerRef.current || chartRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      layout: { background: { color: '#13161F' }, textColor: '#8B93A3' },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      timeScale: { timeVisible: true, rightOffset: 5 },
      rightPriceScale: { borderColor: '#141822' },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: '#22C55E', downColor: '#EF4444', borderVisible: true,
      wickUpColor: '#22C55E', wickDownColor: '#EF4444', borderUpColor: '#22C55E', borderDownColor: '#EF4444',
    });
    const volume = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume', color: 'rgba(139, 147, 163, 0.35)' });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; volumeRef.current = null; };
  }, []);

  // Times in the chosen zone, prices in the symbol's precision.
  useEffect(() => {
    if (!chartRef.current) return;
    const daily = timeframe === '1D' || timeframe === '1W';
    chartRef.current.applyOptions({
      timeScale: { tickMarkFormatter: ts => DateTime.fromSeconds(ts, { zone }).toFormat(daily ? "d LLL ''yy" : 'HH:mm') },
      localization: {
        timeFormatter: ts => DateTime.fromSeconds(ts, { zone }).toFormat(daily ? 'ccc d LLL yyyy' : "ccc d LLL yyyy, HH:mm"),
        priceFormatter: price => formatNumber(price, selected?.precision ?? 2),
      },
    });
  }, [zone, timeframe, selected?.precision]);

  // Bars to the chart, then the view: centred on "Go to", shifted after
  // loading more at an edge, or the latest bars.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    const points = bars.map(bar => {
      const point = { time: toSeconds(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close };
      if (bar.source !== 'IBKR') {
        const color = bar.close >= bar.open ? '#22C55E' : '#EF4444';
        Object.assign(point, { color: 'transparent', borderColor: color, wickColor: color });
      }
      return point;
    });
    const view = pendingViewRef.current;
    pendingViewRef.current = null;
    const before = view && view.shiftBy !== undefined ? chart.timeScale().getVisibleLogicalRange() : null;
    series.setData(points);
    volumeRef.current.setData(bars.map(bar => ({ time: toSeconds(bar.time), value: bar.volume || 0 })));
    if (typeof series.setMarkers === 'function') {
      series.setMarkers(contract ? [] : bars.filter(b => b.isRollover && b.contractMonth).map(b => ({
        time: toSeconds(b.time), position: 'aboveBar', color: '#A78BFA', shape: 'arrowDown', text: `Roll → ${b.contractMonth}`,
      })));
    }
    if (points.length === 0) return;
    if (before) {
      chart.timeScale().setVisibleLogicalRange({ from: before.from + view.shiftBy, to: before.to + view.shiftBy });
    } else if (view && view.center) {
      const index = Math.max(0, points.findIndex(p => p.time >= view.center));
      chart.timeScale().setVisibleLogicalRange({ from: index - 90, to: index + 90 });
    } else if (view) {
      chart.timeScale().setVisibleLogicalRange({ from: points.length - 180, to: points.length + 5 });
    }
  }, [bars, contract]);

  // Near an edge: load more that way.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onRange = (logical) => {
      if (!logical || barsRef.current.length === 0) return;
      if (logical.from < EDGE_BARS) loadMore('older');
      else if (logical.to > barsRef.current.length - EDGE_BARS) loadMore('newer');
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
  }, [loadMore]);

  // The bar under the crosshair, for the readout.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onMove = (param) => {
      if (!param || param.time === undefined) { setHover(null); return; }
      const bar = barsRef.current.find(b => toSeconds(b.time) === param.time);
      setHover(bar || null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
  }, []);

  // The candle under the pointer (the last one loaded can be off screen).
  const shown = hover;
  const fmt = v => formatNumber(v, selected?.precision ?? 2);
  const goToSubmit = (e) => {
    e.preventDefault();
    if (!goTo) { loadAround(null); return; }
    const dt = DateTime.fromISO(goTo, { zone });
    if (!dt.isValid) { setError('Enter a date and time to go to.'); return; }
    loadAround(dt.toUTC().toISO());
  };

  if (symbols.length === 0) return <p className={styles.empty}>Add a symbol under Symbols first.</p>;

  return (
    <div className={styles.viewer}>
      <div className={styles.controls}>
        <label className={styles.field}>
          <span>Symbol</span>
          <select value={selected?.key || ''} onChange={e => { setSymbolKey(e.target.value); setContract(''); }}>
            {symbols.map(s => <option key={s.key} value={s.key}>{s.symbol} {s.type === 'FUT' ? '(future)' : '(stock)'}</option>)}
          </select>
        </label>
        {selected?.type === 'FUT' && (
          <label className={styles.field}>
            <span>Contract</span>
            <select value={contract} onChange={e => setContract(e.target.value)} title="Continuous: the contracts joined at each roll, prices as traded">
              <option value="">Continuous</option>
              {contracts.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}
        <div className={styles.timeframes} role="radiogroup" aria-label="Timeframe">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              type="button"
              role="radio"
              aria-checked={timeframe === tf}
              className={`${styles.tf} ${timeframe === tf ? styles.tfActive : ''}`}
              disabled={!availableTimeframes.includes(tf)}
              onClick={() => setTimeframe(tf)}
              title={availableTimeframes.includes(tf) ? timeframeLabel(tf) : `No ${timeframeLabel(tf)} data stored`}
            >
              {tf}
            </button>
          ))}
        </div>
        <form className={styles.goTo} onSubmit={goToSubmit}>
          <label className={styles.field}>
            <span>Go to</span>
            <input type="datetime-local" value={goTo} onChange={e => setGoTo(e.target.value)} min={range ? DateTime.fromISO(range.earliest).setZone(zone).toFormat("yyyy-LL-dd'T'HH:mm") : undefined} />
          </label>
          <button type="submit" className={styles.button}>Go</button>
          <button type="button" className={styles.button} onClick={() => { setGoTo(''); loadAround(null); }}>Latest</button>
        </form>
        <div className={styles.zone}>
          <TimezonePicker value={displayTimezone} onChange={v => { setDisplayTimezone(v); storeDisplayTimezone(v); }} />
        </div>
      </div>

      <div className={styles.readout} aria-live="polite">
        {shown ? (
          <>
            <strong>{DateTime.fromISO(shown.time).setZone(zone).toFormat(timeframe === '1D' || timeframe === '1W' ? 'ccc d LLL yyyy' : 'ccc d LLL yyyy, HH:mm')}</strong>
            <span>O {fmt(shown.open)}</span><span>H {fmt(shown.high)}</span><span>L {fmt(shown.low)}</span><span>C {fmt(shown.close)}</span>
            <span>Vol {formatNumber(shown.volume || 0, 0)}</span>
            {shown.contractMonth && <span className={styles.muted}>{shown.contractMonth}</span>}
            <span className={styles.muted}>{shown.source}</span>
          </>
        ) : <span className={styles.muted}>{!summary ? 'Loading…' : bars.length ? 'Point at a candle to read its prices.' : 'No bars here.'}</span>}
        {range && (
          <span className={styles.rangeNote}>
            {timeframeLabel(timeframe)} stored {DateTime.fromISO(range.earliest).setZone(zone).toFormat('d LLL yyyy')} – {DateTime.fromISO(range.latest).setZone(zone).toFormat('d LLL yyyy')}
          </span>
        )}
      </div>

      <div className={styles.chartWrap}>
        <div ref={chartContainerRef} className={styles.chart} />
        {loading && <div className={styles.loading}>Loading…</div>}
        {!loading && summary && !range && <div className={styles.loading}>No {timeframeLabel(timeframe)} data stored for {selected?.symbol}{contract ? ` ${contract}` : ''}.</div>}
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <p className={styles.hint}>
        Scroll or drag the chart to either edge to load more. Outlined candles are Yahoo or TradingView bars, filled ones IBKR's.
        {selected?.type === 'FUT' && !contract && ' The continuous series joins the contracts at each roll (purple markers), prices as traded.'}
      </p>
    </div>
  );
}

function precisionOf(tickSize) {
  const text = String(Number(tickSize) || 0.01);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}
