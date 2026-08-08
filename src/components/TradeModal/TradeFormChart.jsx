import React, { useState, useEffect, useRef, useCallback } from 'react';
import { DateTime } from 'luxon';
import { createChart } from 'lightweight-charts';
import { Oval } from 'react-loader-spinner';
import styles from './TradeModal.module.css';
import { resolveDisplayZone } from '../../utils/timezonePreference';
import { getWebSocketUrl } from '../../utils/getWebSocketUrl';

const TIMEFRAMES = ['1W', '1D', '4H', '1H', '15M', '5M', '1M'];

function getBarDurationInSeconds(timeframe) {
  switch (timeframe) {
    case '1W': return 7 * 24 * 60 * 60;
    case '1D': return 24 * 60 * 60;
    case '4H': return 4 * 60 * 60;
    case '1H': return 60 * 60;
    case '15M': return 15 * 60;
    case '5M': return 5 * 60;
    case '1M': return 60;
    default: return 60 * 60;
  }
}
// Same padding TradeView uses for its initial (pre-full-history) fetch — 60
// bars either side of the trade's actions is enough context to be useful
// without pulling in a whole symbol's history just to look at a few days.
const BARS_PADDING = 60;
// The background "give me room to scroll out" fetch is deliberately kept
// bounded here, unlike TradeView's literal unbounded full-history fetch —
// for a 1-minute symbol with millions of rows, parsing+sorting that payload
// on the main thread is exactly what froze the tab (confirmed: it isn't the
// DB or backend being slow, it's the browser choking on the JSON once it
// finally arrives). 1000 bars either side is generous context without ever
// risking an unbounded payload.
const BARS_PADDING_FULL = 1000;

// Read-only reference chart shown while creating/editing a trade — helps
// picking a Stop Loss / Target by seeing the price action around the actual
// fills, before they're saved. Deliberately simpler than TradeView's chart
// (no back-adjustment, no rollover markers), but shares TradeView's exact
// data-loading strategy: a fast padded initial fetch, one background fetch
// for full history, and WebSocket-driven refreshes after that — not a
// separately-invented, weaker approximation of it.
export default function TradeFormChart({ symbol, type, actions, exchangeTimezone, displayTimezone, pricePrecision = 2, enabledTimeframes, onClose }) {
  // Only the timeframes the symbol is actually set up to fetch — a
  // deselected timeframe never gets populated, so offering its button just
  // led to a chart stuck empty with no explanation. Falls back to the full
  // list if the caller didn't resolve one (or somehow every timeframe came
  // back disabled), rather than rendering no buttons at all.
  const availableTimeframes = enabledTimeframes && enabledTimeframes.length > 0 ? enabledTimeframes : TIMEFRAMES;
  // 1-minute is what actually matters for setting a precise Stop-Loss/Target
  // from real fills — defaulting to 1H (TradeView's general-purpose default)
  // just meant an extra click every single time. Falls back to the finest
  // enabled timeframe if 1-minute itself isn't available — TIMEFRAMES is
  // ordered coarsest-to-finest ('1W' first, '1M' last), so the fallback has
  // to take the *last* available entry, not the first (which used to default
  // all the way out to '1W', the least useful timeframe for this).
  const [timeframe, setTimeframe] = useState(() => (availableTimeframes.includes('1M') ? '1M' : availableTimeframes[availableTimeframes.length - 1]));
  // Timezone is a single, shared preference for the whole modal — TradeModal
  // owns the picker and the state; this just reads it as a prop rather than
  // keeping its own separate copy (which meant switching it up top didn't
  // affect the chart, and showed a second, redundant picker).
  const [loading, setLoading] = useState(true);
  const [awaitingData, setAwaitingData] = useState(false);
  const [error, setError] = useState(null);
  const [bars, setBars] = useState([]);
  // Whether the initial padded fetch, and then the background full-history
  // fetch, have each completed once for the current symbol/type/timeframe —
  // mirrors TradeView's `initialDataLoaded`/`fullHistoryLoaded` state machine.
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);
  const [fullHistoryLoaded, setFullHistoryLoaded] = useState(false);

  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const candlestickSeriesRef = useRef(null);
  const hasAutoFitRef = useRef(false);
  // 'initial' (narrow, padded window — fast) vs 'full' (whole available
  // history — slower, arrives after, gives room to scroll out). Read by the
  // render effect to decide whether to auto-center (initial) or preserve
  // whatever the user's currently looking at (full).
  const loadPhaseRef = useRef('initial');
  const wsRef = useRef(null);
  const onMessageRef = useRef(null);
  // Aborts any in-flight fetch belonging to a previous symbol/type/timeframe
  // whenever those change — without this, a still-in-flight background fetch
  // from the timeframe the user just switched away from lands later and its
  // (possibly huge) payload still gets parsed and applied on top of the new
  // timeframe's data.
  const requestControllerRef = useRef(null);

  const zone = resolveDisplayZone(displayTimezone, exchangeTimezone);

  // Bounds the fetch to a padded window around the draft actions instead of
  // requesting the symbol's entire history — without this, a fine-grained
  // timeframe like 1M means pulling hundreds of thousands of bars spanning
  // years just to look at a few days, which is both slow (large query +
  // payload) and pointless (nothing to auto-center on since the fetch was
  // never scoped to the trade in the first place). Only the min/max
  // timestamps are used as effect dependencies below, not the actions array
  // itself, so editing a price/quantity doesn't retrigger a refetch — only
  // an actual date/time change does.
  const validActionTimes = (actions || [])
    .filter(a => a.dateTime && a.dateTime.isValid)
    .map(a => a.dateTime.toSeconds());
  const minActionTime = validActionTimes.length > 0 ? Math.min(...validActionTimes) : null;
  const maxActionTime = validActionTimes.length > 0 ? Math.max(...validActionTimes) : null;

  // Two-phase load, same strategy as TradeView: a fast initial fetch scoped
  // tightly to a padded window around the trade's actions (so something
  // useful appears in roughly the time one small query takes, even on
  // 1-minute data), then a wider (but still bounded — see BARS_PADDING_FULL)
  // background fetch that arrives after and merges in — giving room to
  // scroll out further without ever blocking on the initial, fast render.
  const fetchChartDataLogic = useCallback(async (isInitialLoad) => {
    if (!symbol) return;

    if (isInitialLoad) {
      setLoading(true);
      setError(null);
      setAwaitingData(false);
    }

    const paddingBars = isInitialLoad ? BARS_PADDING : BARS_PADDING_FULL;
    const paddingSecs = paddingBars * getBarDurationInSeconds(timeframe);
    // Anchor on the actions if we have them; otherwise a window around now is
    // a far more sensible default than the symbol's entire history.
    const centerMin = minActionTime ?? DateTime.now().toSeconds();
    const centerMax = maxActionTime ?? DateTime.now().toSeconds();
    const startDate = DateTime.fromSeconds(centerMin - paddingSecs).toISO();
    const endDate = DateTime.fromSeconds(centerMax + paddingSecs).toISO();
    const url = `${process.env.REACT_APP_API_URL}/api/historical/db?symbol=${encodeURIComponent(symbol)}&type=${encodeURIComponent(type)}&timeframe=${timeframe}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;

    const controller = requestControllerRef.current;
    try {
      const res = await fetch(url, { headers: { 'x-account-id': '1' }, signal: controller?.signal });
      const responseData = await res.json();

      if (!res.ok && res.status !== 202) {
        throw new Error(responseData?.error || responseData?.message || `HTTP error! status: ${res.status}`);
      }

      if (responseData && typeof responseData === 'object' && !Array.isArray(responseData) && responseData.message) {
        // Backend has no data yet and has queued a population task — a real
        // signal from the server, not a guess. The WebSocket connection
        // below is what tells us when that task actually finishes.
        setAwaitingData(true);
        setLoading(true);
        setBars([]);
        return;
      }

      if (!Array.isArray(responseData)) {
        setError(`Chart data is not yet available for ${timeframe}.`);
        setLoading(false);
        setAwaitingData(false);
        return;
      }

      loadPhaseRef.current = isInitialLoad ? 'initial' : 'full';
      setAwaitingData(false);
      setError(null);
      setBars(responseData);

      if (isInitialLoad) {
        setLoading(false);
        setInitialDataLoaded(true);
      } else {
        setFullHistoryLoaded(true);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Intentionally cancelled because symbol/type/timeframe moved on —
        // not a real failure, and definitely not something to surface.
        return;
      }
      if (isInitialLoad) {
        setError(`Failed to load chart: ${err.message}`);
        setLoading(false);
        setAwaitingData(false);
      }
      // A failed background/refresh fetch isn't fatal — whatever's already
      // on screen stays up; the next WebSocket signal will try again.
    }
  }, [symbol, type, timeframe, minActionTime, maxActionTime]);

  // Reset and kick off the initial (padded) fetch whenever the symbol, type,
  // or timeframe changes. Aborts whatever was still in flight for the
  // previous combination first, so a late-arriving stale response never gets
  // parsed and applied on top of the new one (see requestControllerRef).
  useEffect(() => {
    if (!symbol) return;
    hasAutoFitRef.current = false;
    loadPhaseRef.current = 'initial';
    setBars([]);
    setInitialDataLoaded(false);
    setFullHistoryLoaded(false);
    if (requestControllerRef.current) requestControllerRef.current.abort();
    requestControllerRef.current = new AbortController();
    fetchChartDataLogic(true);
    return () => {
      if (requestControllerRef.current) requestControllerRef.current.abort();
    };
  }, [symbol, type, timeframe, fetchChartDataLogic]);

  // Once the initial padded fetch has shown something, load the full
  // available history once in the background — same as TradeView.
  useEffect(() => {
    if (initialDataLoaded && !fullHistoryLoaded) {
      fetchChartDataLogic(false);
    }
  }, [initialDataLoaded, fullHistoryLoaded, fetchChartDataLogic]);

  // enabledTimeframes can change after mount (futuresSettings loads async, or
  // the symbol field changes before the trade is saved) — if the currently
  // selected timeframe is no longer among the available ones, fall back
  // instead of staying on a timeframe that was just disabled.
  useEffect(() => {
    if (availableTimeframes.length === 0 || availableTimeframes.includes(timeframe)) return;
    setTimeframe(availableTimeframes.includes('1M') ? '1M' : availableTimeframes[availableTimeframes.length - 1]);
  }, [availableTimeframes, timeframe]);

  // --- WEBSOCKET IMPLEMENTATION (ported from TradeView) ---
  // The real "new data has arrived" signal: the backend broadcasts
  // `historicalDataUpdate` the moment it finishes writing new bars for a
  // specific symbol+timeframe. Reacting to that directly is what TradeView
  // already does correctly — this replaces the earlier polling/heuristic
  // approach that kept guessing wrong.
  useEffect(() => {
    onMessageRef.current = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (
          data.type === 'historicalDataUpdate' &&
          symbol &&
          data.symbol.toUpperCase() === symbol.toUpperCase() &&
          data.timeframe === timeframe
        ) {
          fetchChartDataLogic(!initialDataLoaded);
        }
      } catch (err) {
        console.error('[TradeFormChart] Error parsing WebSocket message:', err);
      }
    };
  }, [symbol, timeframe, fetchChartDataLogic, initialDataLoaded]);

  useEffect(() => {
    if (!symbol) return;
    const ws = new WebSocket(getWebSocketUrl('/ws'));
    wsRef.current = ws;
    ws.onopen = () => {};
    ws.onmessage = (event) => { if (onMessageRef.current) { onMessageRef.current(event); } };
    ws.onclose = () => {};
    ws.onerror = (err) => { console.error('[TradeFormChart] WebSocket error:', err); };
    return () => {
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;
        if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
          try { wsRef.current.close(); } catch (e) { console.warn('[TradeFormChart] Error during explicit WebSocket close:', e); }
        }
        wsRef.current = null;
      }
    };
  }, [symbol]);
  // --- END: WEBSOCKET IMPLEMENTATION ---

  // Create the chart once, on mount.
  useEffect(() => {
    if (!chartContainerRef.current || chartRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight,
      layout: { background: { color: '#232733' }, textColor: '#e0e2e6' },
      grid: { vertLines: { color: '#353943' }, horzLines: { color: '#353943' }, horzLinesVisible: false, vertLinesVisible: false },
      timeScale: {
        timeVisible: true,
        tickMarkFormatter: (timestamp) => {
          const dt = DateTime.fromSeconds(timestamp, { zone });
          return timeframe === '1D' || timeframe === '1W' ? dt.toFormat("d LLL ''yy") : dt.toFormat('HH:mm');
        },
      },
      rightPriceScale: { borderColor: '#353943' },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    chart.applyOptions({
      localization: {
        timeFormatter: (timestamp) => {
          const dt = DateTime.fromSeconds(timestamp, { zone });
          return dt.toFormat("d LLL ''yy HH:mm");
        },
      },
    });
    const series = chart.addCandlestickSeries({
      upColor: '#22C55E',
      downColor: '#EF4444',
      borderVisible: true,
      wickUpColor: '#22C55E',
      wickDownColor: '#EF4444',
      borderUpColor: '#22C55E',
      borderDownColor: '#EF4444',
    });
    chartRef.current = chart;
    candlestickSeriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      candlestickSeriesRef.current = null;
    };
  }, []);

  // Push data + markers whenever bars, the zone, or the draft actions change.
  useEffect(() => {
    const series = candlestickSeriesRef.current;
    if (!series) return;
    if (bars.length === 0) {
      // Without this, switching timeframes (which clears `bars` while the
      // new timeframe loads) left the previous timeframe's candles visibly
      // on screen the whole time — the loading spinner overlay was showing,
      // but the stale chart underneath it never actually cleared.
      series.setData([]);
      if (typeof series.setMarkers === 'function') series.setMarkers([]);
      return;
    }

    const chartData = bars
      .map(bar => {
        const point = {
          time: Math.floor(DateTime.fromISO(bar.time, { zone: 'utc' }).toSeconds()),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        };
        // Hollow/outlined styling for non-IBKR (Yahoo) bars — same as
        // TradeView, so IBKR vs Yahoo data is visually distinguishable here
        // too instead of looking identical.
        if (bar.source !== 'IBKR') {
          const color = bar.close >= bar.open ? '#22C55E' : '#EF4444';
          point.color = 'transparent';
          point.borderColor = color;
          point.wickColor = color;
        }
        return point;
      })
      .sort((a, b) => a.time - b.time);

    // The wider phase-2 (full-history) load arriving after the initial one
    // shouldn't yank the view back to auto-fit again — preserve whatever the
    // user's currently looking at. Only the very first successful load for
    // this timeframe should auto-center.
    const isBackgroundEnrichment = loadPhaseRef.current === 'full' && hasAutoFitRef.current;
    const preservedRange = isBackgroundEnrichment && chartRef.current
      ? chartRef.current.timeScale().getVisibleRange()
      : null;

    series.setData(chartData);

    if (typeof series.setMarkers === 'function') {
      const markers = (actions || [])
        .filter(a => a.dateTime && a.dateTime.isValid && a.price !== '' && a.price != null && !isNaN(parseFloat(a.price)))
        .map(a => {
          const actionTime = Math.floor(a.dateTime.setZone(zone).toUnixInteger());
          const barIndex = chartData.findIndex(bar => bar.time > actionTime);
          let barTime;
          if (chartData.length === 0) return null;
          if (barIndex === 0) barTime = chartData[0].time;
          else if (barIndex === -1) barTime = chartData[chartData.length - 1].time;
          else barTime = chartData[barIndex - 1].time;
          return {
            time: barTime,
            position: a.type === 'BUY' ? 'belowBar' : 'aboveBar',
            color: a.type === 'BUY' ? '#FFFC33' : '#33FFFC',
            shape: a.type === 'BUY' ? 'arrowUp' : 'arrowDown',
            text: `${a.type} ${a.quantity || ''} @ ${parseFloat(a.price).toFixed(pricePrecision)}`,
            size: 1,
            textColor: '#e0e2e6',
            textBackgroundColor: a.type === 'BUY' ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.7)',
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.time - b.time);
      series.setMarkers(markers);

      if (preservedRange) {
        // Background enrichment (phase 2) — restore exactly what the user
        // was looking at rather than re-fitting.
        chartRef.current.timeScale().setVisibleRange(preservedRange);
      } else if (chartData.length > 0 && chartRef.current) {
        // Reaching this branch already means there was nothing valid to
        // restore (preservedRange is only ever populated when this WAS a
        // background-enrichment pass and the chart could actually report its
        // current view) — so this covers both the genuine first load for
        // this timeframe AND the rare case where the chart couldn't report a
        // view to preserve. Either way, re-fitting is correct; silently doing
        // nothing here is what left a stale/wrong zoom level on screen after
        // a timeframe switch.
        //
        // Center on markers when we have them (bar-snapped, most precise);
        // but a brand-new trade with no price entered yet has NO markers at
        // all (they require a valid price to render) — without this
        // fallback, the chart got data but its view was never set at all,
        // which rendered as a permanently blank chart with no error and no
        // loading indicator, no matter how long you waited.
        const centerTimes = markers.length > 0
          ? markers.map(m => m.time)
          : (minActionTime != null && maxActionTime != null)
            ? [minActionTime, maxActionTime]
            : [chartData[chartData.length - 1].time];
        hasAutoFitRef.current = true;
        // Bar spacing from the data actually returned, same as TradeView —
        // not a theoretical duration for the timeframe, which can disagree
        // with reality (market closures, gaps, etc.) and made this zoom too
        // tight right after switching timeframes.
        const barSpacing = chartData.length > 1 ? chartData[1].time - chartData[0].time : getBarDurationInSeconds(timeframe);
        const MINIMUM_BARS_TO_SHOW = 40;
        const minCenterTime = Math.min(...centerTimes);
        const maxCenterTime = Math.max(...centerTimes);
        const centerTimeSpan = maxCenterTime - minCenterTime;
        const minVisibleTimeSpan = (MINIMUM_BARS_TO_SHOW - 1) * barSpacing;
        const baseVisibleSpan = Math.max(centerTimeSpan, minVisibleTimeSpan);
        const PADDING_BARS = 5;
        const totalPadding = PADDING_BARS * 2 * barSpacing;
        const finalVisibleSpan = baseVisibleSpan + totalPadding;
        const padding = (finalVisibleSpan - centerTimeSpan) / 2;
        const from = minCenterTime - padding;
        const to = maxCenterTime + padding;
        chartRef.current.timeScale().setVisibleRange({ from, to });
      }
    }
  }, [bars, actions, zone, timeframe, pricePrecision]);

  // Inline panel — sits alongside the form (see TradeModal.jsx, which widens
  // its modal and splits into a left column for the form / right column for
  // this) rather than covering it, so both are visible at once and setting
  // Stop-Loss/Target doesn't mean bouncing back and forth between two views.
  return (
    <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #3a3f4d', paddingLeft: 20, marginLeft: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span className={styles.title} style={{ fontSize: '1rem' }}>{symbol} — reference chart</span>
        <button className={styles.closeBtn} onClick={onClose} title="Hide chart">×</button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {availableTimeframes.map(tf => (
          <button
            key={tf}
            onClick={() => setTimeframe(tf)}
            style={{
              background: timeframe === tf ? '#3B82F6' : 'rgb(112, 113, 115)',
              color: '#f0f2f6',
              border: 'none',
              borderRadius: '12px',
              padding: '6px 12px',
              fontSize: '0.9em',
              cursor: 'pointer',
              opacity: timeframe === tf ? 1 : 0.7,
            }}
          >
            {tf}
          </button>
        ))}
      </div>
      <div style={{ position: 'relative', flex: 1, minHeight: 300 }}>
        <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />
        {loading && (
          // zIndex is required here — lightweight-charts renders via <canvas>,
          // which browsers often promote to its own compositor layer; without
          // an explicit z-index this overlay (position:absolute, z-index:auto)
          // can end up painted *underneath* the chart's canvas despite coming
          // later in the DOM, making it invisible even though it's genuinely
          // present and correctly styled otherwise. TradeView's equivalent
          // overlay (chartMessageOverlay) sets the same z-index: 10 for
          // exactly this reason — dropped when this component was built from
          // scratch instead of sharing that CSS.
          <div style={{ position: 'absolute', inset: 0, zIndex: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: '#232733' }}>
            <Oval height="40" width="40" color="#3B82F6" ariaLabel="loading-indicator" secondaryColor="#ccc" strokeWidth={4} strokeWidthSecondary={4} />
            <p style={{ color: '#e0e2e6', fontSize: '0.9em', textAlign: 'center', padding: '0 20px' }}>
              {awaitingData ? `Fetching ${symbol} (${timeframe}) data for the first time — this can take a bit…` : `Loading ${timeframe} chart…`}
            </p>
          </div>
        )}
        {error && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#232733' }}>
            <p style={{ color: '#EF4444' }}>{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
