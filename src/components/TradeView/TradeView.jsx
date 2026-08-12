import React, { useRef, useLayoutEffect, useState, useEffect, useContext, useCallback, useMemo } from 'react';
import { TradeContext, calculateRisk, getEnabledTimeframesForSetting } from '../../context/TradeContext';
import { DateTime } from 'luxon';
import { sanitizeNotesHtml } from '../../utils/sanitizeHtml';
import { getWebSocketUrl } from '../../utils/getWebSocketUrl';
import { loadStoredDisplayTimezone, storeDisplayTimezone, resolveDisplayZone, TimezonePicker } from '../../utils/timezonePreference';
import styles from './TradeView.module.css';
import { ChartIcon } from './TradeViewIcons';
import { createChart, LineType } from 'lightweight-charts';
import { getRealisedPnL } from '../../context/TradeContext';
import { debounce } from 'lodash';
import { Oval } from 'react-loader-spinner';

// Remembers the last chart timeframe picked per symbol (scoped by type too,
// since a symbol string could in principle mean different things for STK vs
// FUT), so reopening a trade doesn't always reset back to the type default.
const CHART_TIMEFRAME_STORAGE_KEY = 'jjournal_chart_timeframe_by_symbol';

function loadStoredTimeframes() {
  try {
    return JSON.parse(localStorage.getItem(CHART_TIMEFRAME_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function getStoredTimeframe(type, symbol) {
  if (!symbol) return null;
  return loadStoredTimeframes()[`${type}:${symbol}`] || null;
}

function storeTimeframe(type, symbol, timeframe) {
  if (!symbol) return;
  try {
    const all = loadStoredTimeframes();
    all[`${type}:${symbol}`] = timeframe;
    localStorage.setItem(CHART_TIMEFRAME_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage full/unavailable — not worth surfacing an error for a UI preference.
  }
}

function createSimpleGuardedFetch() {
  const activeRequests = new Map();
  
  return async (url, options = {}) => {
    const requestKey = `${url}-${JSON.stringify(options)}`;
    
    // If request is already in progress, wait for it
    if (activeRequests.has(requestKey)) {
      return activeRequests.get(requestKey);
    }
    
    // Make the request and store the promise
    const requestPromise = fetch(url, options).then(async response => {
      const data = await response.json();
      return { response, data };
    }).finally(() => {
      // Remove from active requests when done
      activeRequests.delete(requestKey);
    });
    
    activeRequests.set(requestKey, requestPromise);
    return requestPromise;
  };
}

function getBarDurationInSeconds(timeframe) {
  switch (timeframe) {
    case '1W': return 7 * 24 * 60 * 60;
    case '1D': return 24 * 60 * 60;
    case '4H': return 4 * 60 * 60;
    case '1H': return 60 * 60;
    case '15M': return 15 * 60;
    case '5M': return 5 * 60;
    case '1M': return 60;
    default: return 24 * 60 * 60; // Default to 1 day
  }
}

function BubbleButton({ children, onClick, color = '#3B82F6', disabled, circle = false, ...rest }) {
  return (
    <button
      className={`${styles.saveBtn} ${circle ? styles.circleBtn : ''}`}
      style={{
        background: color,
        borderRadius: circle ? '50%' : 18,
        padding: circle ? '8px' : '10px 24px',
        minWidth: circle ? '40px' : 90,
        height: circle ? '40px' : 'auto',
        width: circle ? '40px' : 'auto',
        display: circle ? 'flex' : 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onClick={onClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
}

function formatTimelineDate(dateTime, pricePrecision = 2) {
  if (!(dateTime instanceof DateTime) || !dateTime.isValid) {
    console.warn(`Invalid dateTime: ${dateTime}`);
    return '';
  }
  const pad = n => n.toString().padStart(2, '0');
  const day = pad(dateTime.day);
  const month = pad(dateTime.month);
  const year = dateTime.year.toString().slice(-2);
  const monthName = dateTime.toFormat('MMM');
  const time = dateTime.toFormat('HH:mm');
  return (
    <span>{day} {monthName} {year}<br />at {time}</span>
  );
}

function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

function snapToPrevBarTime(timeframe) {
  switch (timeframe) {
    case '1D':
      return 60 * 60 * 24;
    case '4H':
      return 60 * 60 * 4;
    case '1H':
      return 60 * 60;
    case '15M':
      return 60 * 15;
    case '5M':
      return 60 * 5;
    case '1M':
      return 60;
    default:
      return 0;
  }
}

function snapToBarTime(timeframe) {
  switch (timeframe) {
    case '1W':
      return 60 * 60 * 24 * 4;
    default:
      return 0;
  }
}

function getBackAdjustmentInfo(bars) {
  if (!bars || bars.length < 2) return { adjustedBars: bars, adjustmentMap: new Map() };

  const adjustedBars = [];
  const adjustmentMap = new Map();
  let currentAdjustment = 0;

  // Iterate backwards from the most recent bar to the oldest
  for (let i = bars.length - 1; i >= 0; i--) {
    const currentBar = bars[i];
    const prevBar = i > 0 ? bars[i - 1] : null;

    // The adjustment for the current bar's time is the cumulative value
    // calculated from all rollovers that occurred *after* this bar.
    adjustmentMap.set(currentBar.time, currentAdjustment);

    // 1. First, apply the cumulative adjustment from previous (later in time) rollovers
    //    to the current bar's prices.
    adjustedBars.unshift({
      ...currentBar,
      open: currentBar.open + currentAdjustment,
      high: currentBar.high + currentAdjustment,
      low: currentBar.low + currentAdjustment,
      close: currentBar.close + currentAdjustment,
    });

    // 2. THEN, if the current bar represents a rollover event, calculate the price gap
    //    and add it to the cumulative adjustment. This new adjustment value will be
    //    applied to all bars that come before this one.
    if (currentBar.isRollover && prevBar) {
      const gap = currentBar.open - prevBar.close;
      currentAdjustment += gap;
    }
  }

  return { adjustedBars, adjustmentMap };
}


export default function TradeView({ trade, onClose, onEdit }) {
  const { futuresSettings } = useContext(TradeContext);
  const defaultTimeframe = trade?.type === 'FUT' ? '1H' : '1D';
  const [displayTimezone, setDisplayTimezoneState] = useState(loadStoredDisplayTimezone);
  const setDisplayTimezone = useCallback((value) => {
    setDisplayTimezoneState(value);
    storeDisplayTimezone(value);
  }, []);
  const [modalHeight, setModalHeight] = useState(undefined);
  // Matches TradeView.module.css's own `@media (max-width: 700px)` — tracked
  // in JS too because the modal below sizes itself via inline style (width/
  // maxWidth/maxHeight), and an inline style always wins over a CSS class's
  // media query on the same element. Without this, the modal (and its close
  // button) stayed desktop-sized no matter what the stylesheet said — same
  // bug already found and fixed in TradeModal.jsx.
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 700px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  const [selectedAttachment, setSelectedAttachment] = useState(null);
  const [showChart, setShowChart] = useState(false);
  const [error, setError] = useState(null);
  const [hasHistoricalDataConfig, setHasHistoricalDataConfig] = useState(false);
  const [timeframe, setTimeframe] = useState(
    () => getStoredTimeframe(trade?.type, trade?.symbol) || defaultTimeframe
  );
  const lastTimeframeSymbolRef = useRef(trade?.symbol);

  // Covers the (currently theoretical, but cheap to handle) case where the
  // same TradeView instance gets reused for a different trade rather than
  // remounted — without this, the initial lazy useState above would only run
  // once and a symbol switch would keep showing the previous symbol's timeframe.
  useEffect(() => {
    if (trade?.symbol !== lastTimeframeSymbolRef.current) {
      lastTimeframeSymbolRef.current = trade?.symbol;
      setTimeframe(getStoredTimeframe(trade?.type, trade?.symbol) || defaultTimeframe);
    }
  }, [trade?.symbol, trade?.type, defaultTimeframe]);

  const selectTimeframe = useCallback((tf) => {
    setTimeframe(tf);
    storeTimeframe(trade?.type, trade?.symbol, tf);
  }, [trade?.type, trade?.symbol]);
  const [showAvgStopLines, setShowAvgStopLines] = useState(true);
  const [showBackAdjustedLines, setShowBackAdjustedLines] = useState(false);
  // The "Continuous" (back-adjust) toggle is only relevant once a rollover
  // boundary is actually present in the fetched series — single-contract IBKR
  // data (or Yahoo-only data) has nothing to back-adjust, so showing it then
  // would be a button that visibly does nothing when clicked.
  const [hasRolloverToAdjust, setHasRolloverToAdjust] = useState(false);
  const [awaitingData, setAwaitingData] = useState(false); // New state to track pending data
  const guardedFetchRef = useRef(createSimpleGuardedFetch());
  const isInitializedRef = useRef(false);
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);
  const [fullHistoryLoaded, setFullHistoryLoaded] = useState(false);

  const pricePrecision = trade?.pricePrecision || 2;

  const risk = useMemo(() => calculateRisk(trade), [trade]);
  const [chartLoading, setChartLoading] = useState(false);
  const [hasChartDataBars, setHasChartDataBars] = useState(false);

  const hasSymbolSetting = useMemo(() => {
    if (!trade?.symbol || !trade?.type || !Array.isArray(futuresSettings)) return false;
    const upperSymbol = trade.symbol.toUpperCase();
    const specificSettings = futuresSettings
      .filter(s => s.symbol !== 'DEFAULT' && s.type === trade.type)
      .sort((a, b) => b.symbol.length - a.symbol.length);
    const matchingSetting = specificSettings.find(s => upperSymbol.startsWith(s.symbol));
    return matchingSetting || futuresSettings.some(s => s.symbol === 'DEFAULT' && s.type === trade.type) || futuresSettings.some(s => s.symbol === 'DEFAULT');
  }, [trade?.symbol, trade?.type, futuresSettings]);

  const chartDataRef = useRef([]);
  const lastFetchTimeRef = useRef({});
  const modalRef = useRef(null);
  const contentWrapperRef = useRef(null);
  const chartContainerRef = useRef(null);
  const chartRef = useRef(null);
  const candlestickSeriesRef = useRef(null);
  const avgPriceSeriesRef = useRef(null);
  const avgExitPriceSeriesRef = useRef(null);
  const stopLossLineRef = useRef(null);
  const stopLossLineSeriesRef = useRef(null);
  const adjustmentMapRef = useRef(new Map());
  const wsRef = useRef(null);
  const onMessageRef = useRef(); // To hold the websocket message handler
  // Whether we've auto-centered the view at least once for the current
  // chart generation (symbol/timeframe). Only the very first successful load
  // auto-centers on the trade — every update after that (background load,
  // incremental edge-triggered loads, back-adjustment toggle, etc.)
  // preserves whatever the user is currently looking at, captured fresh
  // immediately before setData rather than from an earlier snapshot (an old
  // snapshot taken before an async fetch starts is stale by the time that
  // fetch resolves if the user kept panning in the meantime).
  const hasAutoFittedRef = useRef(false);
  // Incremental "load more on scroll" state — the background fetch only
  // loads a generous but bounded window around the trade (see
  // BARS_PADDING_BACKGROUND), not the symbol's entire history; these track
  // whether we're mid-fetch (avoid duplicate/overlapping extend requests)
  // and whether we've already confirmed there's nothing further in a given
  // direction (avoid re-requesting an edge that's already known to be empty
  // on every subsequent scroll tick).
  const isFetchingMoreRef = useRef(false);
  const noMoreOlderDataRef = useRef(false);
  const noMoreNewerDataRef = useRef(false);
  // Tracks how far back/forward a fetch has already been REQUESTED, as
  // opposed to chartDataRef's own oldest/newest bar. fetchMoreHistory used to
  // derive its next window purely from the oldest/newest bar actually
  // returned — fine on a normal weekday, but a chunk landing mostly on a
  // closed weekend can come back with just one bar sitting right at the
  // window's edge, barely moving that boundary. The next window then gets
  // computed as nearly identical to the one that just ran, re-fetching the
  // same near-empty slice forever instead of ever reaching the denser data
  // (and eventually much older history) just beyond it. Requested boundaries
  // always advance by a full chunk regardless of how sparse the response
  // was, so using these instead guarantees real progress every time.
  const oldestRequestedTimeRef = useRef(null);
  const newestRequestedTimeRef = useRef(null);
  // A single chunk coming back empty isn't reliable proof there's nothing
  // further — a multi-day holiday closure (or a chunk that happens to land
  // almost entirely on one) can span more than one chunk-width on its own.
  // Only give up after a few consecutive empty chunks in the same
  // direction, not the first one.
  const consecutiveEmptyOlderRef = useRef(0);
  const consecutiveEmptyNewerRef = useRef(0);
  const MAX_CONSECUTIVE_EMPTY_CHUNKS = 4;
const [dataVersion, setDataVersion] = useState(0);

  const exchangeTimezone = React.useMemo(() => {
    if (!trade || !trade.symbol || !trade.type || !futuresSettings) return 'America/New_York';
    const upperSymbol = trade.symbol.toUpperCase();
    const specificSettings = futuresSettings
      .filter(s => s.symbol !== 'DEFAULT' && s.type === trade.type)
      .sort((a, b) => b.symbol.length - a.symbol.length);
    const matchingSetting = specificSettings.find(s => upperSymbol.startsWith(s.symbol));
    const setting = matchingSetting || futuresSettings.find(s => s.symbol === 'DEFAULT' && s.type === trade.type) || futuresSettings.find(s => s.symbol === 'DEFAULT');
    return setting?.timezone || 'America/New_York';
  }, [trade, futuresSettings]);

  // Only offer timeframes the symbol is actually set up to fetch — a
  // deselected timeframe never gets populated, so its button used to lead to
  // a chart stuck empty (or serving whatever was fetched before it was
  // disabled) with no way to know why.
  const enabledTimeframes = useMemo(() => {
    if (!trade?.symbol || !trade?.type || !Array.isArray(futuresSettings)) return ['1W', '1D', '4H', '1H', '15M', '5M', '1M'];
    const upperSymbol = trade.symbol.toUpperCase();
    const specificSettings = futuresSettings
      .filter(s => s.symbol !== 'DEFAULT' && s.type === trade.type)
      .sort((a, b) => b.symbol.length - a.symbol.length);
    const matchingSetting = specificSettings.find(s => upperSymbol.startsWith(s.symbol));
    const setting = matchingSetting || futuresSettings.find(s => s.symbol === 'DEFAULT' && s.type === trade.type) || futuresSettings.find(s => s.symbol === 'DEFAULT');
    return getEnabledTimeframesForSetting(setting?.timeframe_settings);
  }, [trade, futuresSettings]);

  // If the current timeframe (from localStorage, or the FUT/STK default)
  // turns out to be disabled for this symbol, fall back to one that's
  // actually enabled instead of silently trying to chart a timeframe that
  // will never have data.
  useEffect(() => {
    if (enabledTimeframes.length === 0 || enabledTimeframes.includes(timeframe)) return;
    // enabledTimeframes is ordered coarsest-to-finest ('1W' first, '1M'
    // last) — if the default itself isn't enabled, fall back to the finest
    // available entry (the end of the array), not the first, which used to
    // default all the way out to '1W' instead of something actually useful.
    const fallback = enabledTimeframes.includes(defaultTimeframe) ? defaultTimeframe : enabledTimeframes[enabledTimeframes.length - 1];
    selectTimeframe(fallback);
  }, [enabledTimeframes, timeframe, defaultTimeframe, selectTimeframe]);


  const DEBOUNCE_DELAY = 3000;


  const fetchChartDataLogic = useCallback(async (isInitialLoad = false) => {
    if (!showChart || !trade?.symbol || !chartContainerRef.current) {
      return;
    }

    
    // Only set loading true if it's the initial, prioritized fetch. The full history will load silently.
    if (isInitialLoad) {
      setChartLoading(true);
    }
  setError(null);
  setAwaitingData(false);

    let url = `${process.env.REACT_APP_API_URL}/api/historical/db?symbol=${encodeURIComponent(trade.symbol)}&type=${encodeURIComponent(trade.type)}&timeframe=${timeframe}`;

    // --- New logic to define the prioritized window ---
    if (isInitialLoad) {
      const BARS_PADDING = 60; // Number of bars to show before/after trade actions
      const barDurationSecs = getBarDurationInSeconds(timeframe);
      const paddingDuration = BARS_PADDING * barDurationSecs;

      if (trade.actions && trade.actions.length > 0) {
        const actionTimestamps = trade.actions.map(a => DateTime.fromISO(a.dateTime).toSeconds());
        const minTime = Math.min(...actionTimestamps);
        const maxTime = Math.max(...actionTimestamps);
        
        const startDate = DateTime.fromSeconds(minTime - paddingDuration).toISO();
        const endDate = DateTime.fromSeconds(maxTime + paddingDuration).toISO();
        
        url += `&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
      }
    } else {
      // Background "give me room to scroll out" load — bounded to a
      // generous window around the trade rather than the symbol's ENTIRE
      // history. For a heavily-backfilled 1-minute symbol that can be
      // hundreds of thousands of bars, fetching everything up front is slow
      // even after backend fixes (query+driver-parse+transfer still scales
      // with row count). Scrolling past this window loads more on demand
      // (see fetchMoreHistory and the visible-range subscription below).
      const BARS_PADDING_BACKGROUND = 5000;
      const barDurationSecs = getBarDurationInSeconds(timeframe);
      const paddingDuration = BARS_PADDING_BACKGROUND * barDurationSecs;

      if (trade.actions && trade.actions.length > 0) {
        const actionTimestamps = trade.actions.map(a => DateTime.fromISO(a.dateTime).toSeconds());
        const minTime = Math.min(...actionTimestamps);
        const maxTime = Math.max(...actionTimestamps);

        const startDate = DateTime.fromSeconds(minTime - paddingDuration).toISO();
        const endDate = DateTime.fromSeconds(maxTime + paddingDuration).toISO();

        url += `&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
      }
    }

  try {
    const guardedFetch = guardedFetchRef.current;
      const { response, data: responseData } = await guardedFetch(url, { headers: { 'x-account-id': '1' } });

      if (!response.ok) {
        throw new Error(responseData.error || responseData.message || `HTTP error! status: ${response.status}`);
      }

      // Specifically check for the "task queued" message object that the server sends with a 202 status.
      if (responseData && typeof responseData === 'object' && !Array.isArray(responseData) && responseData.message) {
        setAwaitingData(true);  // Set the awaiting data flag
        setChartLoading(true);  // KEEP the loading indicator active
        if (candlestickSeriesRef.current) {
          candlestickSeriesRef.current.setData([]); // Ensure chart is clear
        }
        setHasChartDataBars(false);
        return; // Stop further processing
      }

      if (!candlestickSeriesRef.current) {
        console.warn("[TradeView] Candlestick series ref became null during fetch, aborting update.");
        setChartLoading(false);
        setAwaitingData(false);
        return;
      }
      if (!Array.isArray(responseData)) {
        console.warn('[TradeView] Received non-array data for chart:', responseData);
        setError(`Chart data is not yet available or is in an unexpected format for ${timeframe}. Waiting for updates...`);
        setChartLoading(false);
        setAwaitingData(false);
        return;
      }

      const data = responseData;
      if (data.length === 0) {
        if (candlestickSeriesRef.current) {
          candlestickSeriesRef.current.setData([]);
        }
        setHasChartDataBars(false);
        setChartLoading(false);
        setAwaitingData(true); // Awaiting data if empty response
        return;
      }

      const targetZone = resolveDisplayZone(displayTimezone, exchangeTimezone);

      // Sort the data by time to ensure correct order. `bar.time` is always
      // a fixed-width ISO 8601 UTC string (e.g. "2024-02-01T06:00:00.000Z"),
      // which sorts correctly as plain strings — no need to parse each one
      // into a Luxon DateTime just to compare. The previous comparator
      // (`DateTime.fromISO(...).toMillis()` on both sides, called on every
      // comparison) meant a full history fetch for a heavily-backfilled
      // 1-minute symbol (e.g. ~885k bars) was making on the order of tens of
      // millions of Luxon parses just to sort — that's what was actually
      // freezing the tab for "tens of seconds" after zooming out, not the
      // payload size itself.
      data.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

      const chartDataMap = new Map();
      data.forEach(bar => {
        // Native Date parsing here instead of Luxon — same result (the
        // string's 'Z' suffix makes this parse as UTC regardless of the
        // browser's local timezone), but this runs once per bar rather than
        // twice per comparison during a sort, so the relative cost of using
        // Luxon here is much smaller — still worth avoiding at this scale.
        const timestamp = Math.floor(new Date(bar.time).getTime() / 1000);
        const existingBar = chartDataMap.get(timestamp);
        // Prioritize IBKR data: if no bar exists, or if the new bar is from IBKR and the existing one isn't.
        if (!existingBar || (bar.source === 'IBKR' && existingBar.source !== 'IBKR')) {
          chartDataMap.set(timestamp, {
            time: timestamp,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume !== undefined ? parseInt(bar.volume, 10) : undefined,
            source: bar.source,
            contractMonth: bar.contractMonth,
            isRollover: bar.isRollover || false,
          });
        }
      });

      const rawData = Array.from(chartDataMap.values());
      if (isInitialLoad) {
        // --- THIS BLOCK IS CHANGED ---
        chartDataRef.current = rawData;
        setHasChartDataBars(rawData.length > 0);
        setError(null);
        setChartLoading(false); // Allow the component to render with the initial data
        setAwaitingData(false);

        // Signal that the initial data is ready.
        setInitialDataLoaded(true); 

        // DO NOT call the next fetch here. The useEffect will handle it.
        // REMOVED: fetchChartDataLogic(false); 
        
      } else {
        // This is the full history arriving (or a later WS-triggered
        // refresh of it, e.g. new bars streaming in). MERGE into whatever's
        // already loaded rather than replacing outright — this fetch is
        // always bounded to a window around the trade (see
        // BARS_PADDING_BACKGROUND), so blindly replacing used to discard
        // anything fetchMoreHistory had already extended the view with once
        // the user panned outside that window — restoring a view that no
        // longer existed in the newly-replaced (smaller) dataset produced a
        // degenerate visible range, which looked like the chart randomly
        // snapping after panning. Merging (never removing, only adding/
        // upgrading to IBKR) keeps everything the user has scrolled to.
        const mergedMap = new Map();
        chartDataRef.current.forEach(bar => mergedMap.set(bar.time, bar));
        rawData.forEach(bar => {
          const existing = mergedMap.get(bar.time);
          if (!existing || (bar.source === 'IBKR' && existing.source !== 'IBKR')) {
            mergedMap.set(bar.time, bar);
          }
        });
        chartDataRef.current = Array.from(mergedMap.values()).sort((a, b) => a.time - b.time);
        setFullHistoryLoaded(true);
        setAwaitingData(false); // Ensure awaiting data is reset
        setDataVersion(prev => prev + 1); // Increment version
        // This will trigger the main data processing effect which will apply the new data
        // and restore the user's view. This part is correct.
      }
    } catch (err) {
      console.error('[TradeView] Error in fetchChartDataLogic:', err);
      setError(`Refresh failed for ${timeframe}: ${err.message}.`);
      setChartLoading(false);
      setAwaitingData(false);
    }
  }, [showChart, trade, timeframe, displayTimezone, exchangeTimezone, pricePrecision]);

  // Extends the loaded range further backward or forward, fetching just the
  // next chunk beyond whatever's currently loaded and merging it in — this
  // is what lets scrolling/zooming out keep working past the bounded
  // background load (BARS_PADDING_BACKGROUND above) without ever pulling a
  // symbol's entire history up front.
  const fetchMoreHistory = useCallback(async (direction) => {
    if (!trade?.symbol || isFetchingMoreRef.current || chartDataRef.current.length === 0) return;
    if (direction === 'older' && noMoreOlderDataRef.current) return;
    if (direction === 'newer' && noMoreNewerDataRef.current) return;

    isFetchingMoreRef.current = true;
    try {
      const CHUNK_BARS = 3000;
      const barDurationSecs = getBarDurationInSeconds(timeframe);
      const chunkDuration = CHUNK_BARS * barDurationSecs;
      // Fall back to the loaded data's own bounds the first time this runs
      // for a given edge (oldestRequestedTimeRef/newestRequestedTimeRef
      // start out null), then always advance from the last REQUESTED
      // boundary from here on — see the ref declarations above for why.
      const currentMin = oldestRequestedTimeRef.current ?? chartDataRef.current[0].time;
      const currentMax = newestRequestedTimeRef.current ?? chartDataRef.current[chartDataRef.current.length - 1].time;

      let startDate, endDate;
      if (direction === 'older') {
        endDate = DateTime.fromSeconds(currentMin).toISO();
        startDate = DateTime.fromSeconds(currentMin - chunkDuration).toISO();
        oldestRequestedTimeRef.current = currentMin - chunkDuration;
      } else {
        startDate = DateTime.fromSeconds(currentMax).toISO();
        endDate = DateTime.fromSeconds(currentMax + chunkDuration).toISO();
        newestRequestedTimeRef.current = currentMax + chunkDuration;
      }

      const url = `${process.env.REACT_APP_API_URL}/api/historical/db?symbol=${encodeURIComponent(trade.symbol)}&type=${encodeURIComponent(trade.type)}&timeframe=${timeframe}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
      const guardedFetch = guardedFetchRef.current;
      const { response, data: responseData } = await guardedFetch(url, { headers: { 'x-account-id': '1' } });

      if (!response.ok || !Array.isArray(responseData)) {
        // A real HTTP/parse failure — don't keep hammering it on every
        // scroll tick, but don't treat it as "reached the edge of history"
        // either (that's a data-availability fact, this is a request
        // failure); the direction stays retryable.
        return;
      }

      if (responseData.length === 0) {
        // Empty chunks are expected on their own (weekends, one-day
        // holidays) and don't mean anything by themselves — the requested
        // boundary already advanced by a full chunk above, so the next
        // attempt naturally reaches further back/forward regardless. Only a
        // *run* of consecutive empty chunks (a closure wider than one
        // chunk) is treated as reaching the real edge of history.
        const counterRef = direction === 'older' ? consecutiveEmptyOlderRef : consecutiveEmptyNewerRef;
        counterRef.current += 1;
        if (counterRef.current >= MAX_CONSECUTIVE_EMPTY_CHUNKS) {
          if (direction === 'older') noMoreOlderDataRef.current = true;
          else noMoreNewerDataRef.current = true;
        }
        return;
      }

      // Got real data — this direction is confirmed productive again.
      if (direction === 'older') consecutiveEmptyOlderRef.current = 0;
      else consecutiveEmptyNewerRef.current = 0;

      // No view snapshot taken here — the render effect captures and
      // restores the user's current view itself, synchronously right before
      // setData.

      // Same dedup-and-prefer-IBKR merge as the main fetch above, just
      // merged into the already-loaded data instead of replacing it.
      const map = new Map();
      chartDataRef.current.forEach(bar => map.set(bar.time, bar));
      responseData
        .slice()
        .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
        .forEach(bar => {
          const timestamp = Math.floor(new Date(bar.time).getTime() / 1000);
          const existing = map.get(timestamp);
          if (!existing || (bar.source === 'IBKR' && existing.source !== 'IBKR')) {
            map.set(timestamp, {
              time: timestamp,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume !== undefined ? parseInt(bar.volume, 10) : undefined,
              source: bar.source,
              contractMonth: bar.contractMonth,
              isRollover: bar.isRollover || false,
            });
          }
        });

      chartDataRef.current = Array.from(map.values()).sort((a, b) => a.time - b.time);
      setDataVersion(prev => prev + 1);
    } catch (err) {
      console.error('[TradeView] Error fetching more history:', err);
    } finally {
      isFetchingMoreRef.current = false;
    }
  }, [trade, timeframe]);

  useEffect(() => {
    if (chartLoading) {
      return;
    }

    if (showChart && candlestickSeriesRef.current && chartDataRef.current.length > 0) {
      const upColor = '#22C55E';
      const downColor = '#EF4444';

      let processedData = chartDataRef.current;
      adjustmentMapRef.current = new Map(); // Reset adjustment map

      // If back-adjustment is enabled, process the data and store the adjustment map
      if (showBackAdjustedLines) {
        const { adjustedBars, adjustmentMap } = getBackAdjustmentInfo(chartDataRef.current);
        processedData = adjustedBars;
        adjustmentMapRef.current = adjustmentMap;
      }
      
      const styledChartData = processedData.map(bar => {
        // Apply "hollow" styling for non-IBKR data
        if (bar.source !== 'IBKR') {
          const color = bar.close >= bar.open ? upColor : downColor;
          return { ...bar, color: 'transparent', borderColor: color, wickColor: color, };
        }
        return bar;
      });

      // Captured immediately before setData, synchronously, so this always
      // reflects exactly what the user is looking at right now — including
      // if they've panned into empty space past the loaded edge, which is
      // legitimate and shouldn't be fought. Only meaningful once we've
      // auto-centered at least once; on the very first load there's nothing
      // to preserve yet.
      const preSetDataRange = hasAutoFittedRef.current && chartRef.current
        ? chartRef.current.timeScale().getVisibleRange()
        : null;

      // lightweight-charts v4.x hard-locks interactive scrolling at the last
      // REAL data point, regardless of rightOffset — confirmed via testing
      // (drag/wheel gestures collapse into a zoom right at the edge instead
      // of panning past it) and matches a known upstream limitation
      // (tradingview/lightweight-charts#1605). The documented workaround is
      // "whitespace" data points — bars with only a `time`, no OHLC — which
      // extend the series' actual data domain so this region reads as
      // scrollable space rather than "past the data" needing to be refused.
      // This is what actually lets the last real bar be panned away from the
      // right edge; rightOffset alone doesn't achieve that here.
      const FUTURE_PADDING_BARS = 200;
      const lastBarTime = styledChartData.length > 0 ? styledChartData[styledChartData.length - 1].time : null;
      const barDurationSecs = getBarDurationInSeconds(timeframe);
      const whitespaceBars = [];
      if (lastBarTime != null) {
        for (let i = 1; i <= FUTURE_PADDING_BARS; i++) {
          whitespaceBars.push({ time: lastBarTime + i * barDurationSecs });
        }
      }
      candlestickSeriesRef.current.setData([...styledChartData, ...whitespaceBars]);

      // FIX: Moved declaration of allMarkers to this higher scope
        const allMarkers = [];

      if (typeof candlestickSeriesRef.current.setMarkers === 'function') {
        // 1. Action Markers (Buy/Sell)
        if (trade.actions) {
          const actionMarkers = trade.actions
            .filter(action => action.dateTime && action.price != null)
            .map(action => {
              const date = DateTime.fromISO(action.dateTime, { zone: 'utc' });
              if (!date.isValid) return null;
              
              const actionTime = Math.floor(date.setZone(resolveDisplayZone(displayTimezone, exchangeTimezone)).toUnixInteger());
              
              // Find the corresponding bar for the action time
              const barIndex = styledChartData.findIndex(bar => bar.time > actionTime);
              let barTime;
              if (barIndex === 0) barTime = styledChartData[0].time;
              else if (barIndex === -1) barTime = styledChartData[styledChartData.length - 1].time;
              else barTime = styledChartData[barIndex - 1].time;
              
              // Apply adjustment to the price if needed
              const adjustment = showBackAdjustedLines ? (adjustmentMapRef.current.get(barTime) || 0) : 0;
              const adjustedPrice = Number(action.price) + adjustment;

              return {
                time: barTime,
                position: action.type === 'BUY' ? 'belowBar' : 'aboveBar',
                color: action.type === 'BUY' ? '#FFFC33' : '#33FFFC',
                shape: action.type === 'BUY' ? 'arrowUp' : 'arrowDown',
                text: `${action.type} ${action.quantity} @ ${adjustedPrice.toFixed(pricePrecision)}`,
                size: 1,
                textColor: '#e0e2e6',
                textBackgroundColor: action.type === 'BUY' ? 'rgba(34, 197, 94, 0.7)' : 'rgba(239, 68, 68, 0.7)',
              };
            })
            .filter(marker => marker !== null);
          allMarkers.push(...actionMarkers);
        }

        // 2. Rollover Markers
        const rolloverMarkers = styledChartData
          .filter(bar => bar.isRollover)
          .map(bar => ({
            time: bar.time,
            position: 'belowBar',
            color: '#F59E0B',
            shape: 'circle',
            text: bar.contractMonth || '?',
            size: 0.4,
          }));
        allMarkers.push(...rolloverMarkers);

        // Set all markers on the chart
        allMarkers.sort((a, b) => a.time - b.time);
        candlestickSeriesRef.current.setMarkers(allMarkers);
      }

      // This block now handles both initial centering and restoring the view on reload.
      if (chartRef.current) {
        if (hasAutoFittedRef.current) {
          // Not the first load — preserve exactly what the user was looking
          // at (captured fresh above, immediately before setData), instead
          // of auto-centering again. If they've panned into empty space past
          // the loaded edge, preSetDataRange reflects that and this keeps it
          // that way rather than snapping back.
          if (preSetDataRange) {
            chartRef.current.timeScale().setVisibleRange(preSetDataRange);
          }
        } else {
          // First successful load for this chart generation — auto-center on trade actions.
          hasAutoFittedRef.current = true;

          // BUGFIX: This block implements the new auto-zoom logic.
          const actionMarkersForCentering = allMarkers.filter(m => m.shape.includes('arrow'));
          // Ensure we have a valid bar spacing, fallback to 1 day if we only have one bar.
          const barSpacing = styledChartData.length > 1 ? styledChartData[1].time - styledChartData[0].time : 86400; 

          const MINIMUM_BARS_TO_SHOW = 40;

          if (actionMarkersForCentering.length > 0) {
              const markerTimes = actionMarkersForCentering.map(m => m.time);
              const minActionTime = Math.min(...markerTimes);
              const maxActionTime = Math.max(...markerTimes);

              // Time duration spanned by the trade actions themselves
              const actionTimeSpan = maxActionTime - minActionTime;
              
              // Time duration required to display the minimum number of bars
              const minVisibleTimeSpan = (MINIMUM_BARS_TO_SHOW - 1) * barSpacing;

              // Determine the greater of the two spans, and add a small padding (e.g., 5 bars on each side)
              const baseVisibleSpan = Math.max(actionTimeSpan, minVisibleTimeSpan);
              const PADDING_BARS = 5;
              const totalPadding = PADDING_BARS * 2 * barSpacing;
              const finalVisibleSpan = baseVisibleSpan + totalPadding;
              
              // The padding to add to the action-range is half the difference between final span and action span
              const padding = (finalVisibleSpan - actionTimeSpan) / 2;

              const fromTime = minActionTime - padding;
              const toTime = maxActionTime + padding;

              chartRef.current.timeScale().setVisibleRange({ from: fromTime, to: toTime });

          } else if (styledChartData.length > 0) {
              // If there are no actions, default to showing the latest 40 bars.
              const lastBarTime = styledChartData[styledChartData.length - 1].time;
              // Calculate start time based on the last bar time minus the duration of 39 bars
              const fromTime = lastBarTime - ((MINIMUM_BARS_TO_SHOW - 1) * barSpacing);
              
              chartRef.current.timeScale().setVisibleRange({ from: fromTime, to: lastBarTime });
          }
        }
      }
    }
}, [chartLoading, fullHistoryLoaded, showBackAdjustedLines, showChart, trade, timeframe, displayTimezone, exchangeTimezone, pricePrecision, hasChartDataBars, dataVersion]);

  const debouncedFetchChartData = useMemo(
    () => debounce(fetchChartDataLogic, DEBOUNCE_DELAY),
    [fetchChartDataLogic]
  );

    useEffect(() => {
    // If the initial data is loaded, but we haven't loaded the full history yet...
    if (initialDataLoaded && !fullHistoryLoaded) {
      // Fetch the full history. This is a non-blocking background task.
      fetchChartDataLogic(false);
    }
  }, [initialDataLoaded, fullHistoryLoaded, fetchChartDataLogic]);

  // --- START: STABLE WEBSOCKET IMPLEMENTATION ---
  
  // 1. Store the message handler in a ref. This ref is updated whenever the handler's dependencies change.
  //    This allows the WebSocket to always call the latest version of the handler logic.
  useEffect(() => {
    onMessageRef.current = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Check for historical data updates from the server
        if (
          data.type === 'historicalDataUpdate' &&
          showChart &&
          trade?.symbol &&
          data.symbol.toUpperCase() === trade.symbol.toUpperCase() &&
          data.timeframe === timeframe
        ) {
          // If initial data hasn't been loaded yet (e.g., was awaiting data), treat this as initial load
          // Otherwise, treat as full history update
                fetchChartDataLogic(!initialDataLoaded);
        }
      } catch (err) {
        console.error('[TradeView] Error parsing WebSocket message:', err);
      }
    };
  }, [showChart, trade, timeframe, fetchChartDataLogic, initialDataLoaded]); // Dependencies for the handler logic

  // 2. Set up the WebSocket connection. This effect now has a stable dependency array,
  //    so it only runs when the trade symbol changes, preventing unnecessary reconnections.
  useEffect(() => {
    // Don't connect if there's no trade symbol
    if (!trade?.symbol) {
      return;
    }

    const ws = new WebSocket(getWebSocketUrl('/ws'));
    wsRef.current = ws;

    ws.onopen = () => {
    };
    
    // The onmessage handler simply calls the function stored in our ref
    ws.onmessage = (event) => {
      if(onMessageRef.current) {
        onMessageRef.current(event);
      }
    };

    ws.onclose = () => {
    };
    
    ws.onerror = (err) => {
      console.error('[TradeView] WebSocket error:', err);
    };

    // Cleanup function to close the WebSocket connection when the component unmounts or the symbol changes
    return () => {
      if (wsRef.current) {
        // Clear event handlers to prevent memory leaks and errors on a closed socket
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.onclose = null;
        
        // Close the connection if it's open or connecting
        if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
          try {
            wsRef.current.close();
          } catch (e) {
            console.warn('[TradeView] Error during explicit WebSocket close:', e);
          }
        }
        wsRef.current = null;
      }
    };
  }, [trade?.symbol]); // Stable dependency: only reconnect if the symbol changes
  
  // --- END: STABLE WEBSOCKET IMPLEMENTATION ---

useEffect(() => {
  // Prevent multiple initializations
  if (isInitializedRef.current || !trade?.symbol) return;

  const checkHistoricalDataConfig = async () => {
    isInitializedRef.current = true;

    const guardedFetch = guardedFetchRef.current;

    try {
      const historicalCheckRes = await guardedFetch(`${process.env.REACT_APP_API_URL}/api/historical/db?symbol=${encodeURIComponent(trade.symbol)}&type=${encodeURIComponent(trade.type)}&timeframe=${defaultTimeframe}`, {
        headers: { 'x-account-id': '1' },
      });

      setHasHistoricalDataConfig(historicalCheckRes.response.ok);
    } catch (err) {
      console.error('Failed to check historical data config:', err);
      setError('Failed to load configuration. Please try again.');
      setHasHistoricalDataConfig(false);
      isInitializedRef.current = false; // Reset on error
    }
  };

  checkHistoricalDataConfig();
}, [trade?.symbol, trade?.type, defaultTimeframe]);

// Add cleanup effect
useEffect(() => {
  return () => {
    isInitializedRef.current = false;
  };
}, [trade?.symbol, trade?.type]);

  useEffect(() => {
    if (showChart && trade?.symbol && chartContainerRef.current) {
      // Reset so we always auto-center on the first load for this chart generation.
      hasAutoFittedRef.current = false;
      setFullHistoryLoaded(false); // Reset full history flag
      setInitialDataLoaded(false); // *** ADD THIS RESET ***
      // New symbol/timeframe — neither edge has been confirmed exhausted yet.
      noMoreOlderDataRef.current = false;
      noMoreNewerDataRef.current = false;
      oldestRequestedTimeRef.current = null;
      newestRequestedTimeRef.current = null;
      consecutiveEmptyOlderRef.current = 0;
      consecutiveEmptyNewerRef.current = 0;

      setChartLoading(true);
      setError(null);
      setHasChartDataBars(false);
      if (candlestickSeriesRef.current) {
        candlestickSeriesRef.current.setData([]);
      }
      if (avgPriceSeriesRef.current) {
        avgPriceSeriesRef.current.setData([]);
      }
      if (avgExitPriceSeriesRef.current) {
        avgExitPriceSeriesRef.current.setData([]);
      }

      const chartOptions = {
        width: chartContainerRef.current.clientWidth,
        height: chartContainerRef.current.clientHeight,
        layout: { background: { color: '#232733' }, textColor: '#e0e2e6' },
        grid: { vertLines: { color: '#353943' }, horzLines: { color: '#353943' }, horzLinesVisible: false, vertLinesVisible: false },
        timeScale: {
          timeVisible: true,
          secondsVisible: timeframe === '1M' || timeframe === '15M' || timeframe === '5M' || timeframe === '1H',
          // lightweight-charts defaults this to 0 — zero margin past the
          // last bar, so the chart hard-clamps there and scrolling further
          // does nothing at all. This is a library default, not something
          // introduced by any of the panning/loading work — it's just never
          // been set. The user wants to be able to freely push the last bar
          // anywhere in the viewport (even to the far left, with a lot of
          // empty space to its right) — not just a small cushion — so this
          // needs to be large enough to exceed a full screen's worth of
          // visible bars in any reasonably-sized window, not the handful a
          // typical "breathing room" rightOffset would use.
          rightOffset: 200,
          // lightweight-charts defaults this to true: whenever setData() adds
          // bars and the last bar was visible, it auto-shifts the view right
          // to keep it in frame — fighting our own explicit view-preservation
          // (preSetDataRange capture/restore below) since a trade near "now"
          // has the last bar visible most of the time. We handle preserving
          // the view ourselves, so this needs to be off.
          shiftVisibleRangeOnNewBar: false,
          // Without this, the axis tick labels fall back to the library's own
          // default formatting (browser-local/UTC-ish) instead of the same
          // exchange-timezone conversion used by the crosshair's
          // localization.timeFormatter below — the two would silently disagree
          // on what time the same candle represents.
          tickMarkFormatter: (timestamp) => {
            const dt = DateTime.fromSeconds(timestamp, { zone: resolveDisplayZone(displayTimezone, exchangeTimezone) });
            return timeframe === '1D' || timeframe === '1W' ? dt.toFormat("d LLL ''yy") : dt.toFormat('HH:mm');
          },
        },
        rightPriceScale: { borderColor: '#353943' },
        crosshair: { mode: 0 },
        autoSize: true, // This enables internal ResizeObserver
      };
      if (!chartRef.current) {
        const chart = createChart(chartContainerRef.current, chartOptions);
        chartRef.current = chart;

        chart.applyOptions({
          localization: {
            timeFormatter: (timestamp) => {
              return DateTime.fromSeconds(timestamp, { zone: resolveDisplayZone(displayTimezone, exchangeTimezone) })
                .toFormat(timeframe === '1D' || timeframe === '1W' ? "d LLL ''yy" : "d LLL ''yy HH:mm");
            }
          }
        });

        const series = chart.addCandlestickSeries({
          upColor: '#22C55E',
          downColor: '#EF4444',
          borderVisible: true, // Changed from false to true to allow hollow bars to have a border
          wickUpColor: '#22C55E',
          wickDownColor: '#EF4444',
          borderUpColor: '#22C55E', // Explicitly set border color for solid bars
          borderDownColor: '#EF4444', // Explicitly set border color for solid bars
        });
        candlestickSeriesRef.current = series;
      }
      fetchChartDataLogic(true); 

      // Removed: window.addEventListener('resize', handleResize);
    } else {
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
      candlestickSeriesRef.current = null;
      setChartLoading(false);
      setError(null);
      setHasChartDataBars(false);
    }

    return () => {
      // Removed: window.removeEventListener('resize', handleResize);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
      candlestickSeriesRef.current = null;
      avgPriceSeriesRef.current = null;
      avgExitPriceSeriesRef.current = null;
      stopLossLineRef.current = null; // Clear all chart-related refs
      stopLossLineSeriesRef.current = null;
      debouncedFetchChartData.cancel();
      setChartLoading(false);
      setError(null);
      setHasChartDataBars(false);
      setHasRolloverToAdjust(false); // Reset on chart close
      debouncedFetchChartData.cancel(); // Also cancel any pending debounced calls on cleanup
    };
    // displayTimezone/exchangeTimezone deliberately excluded — they're only
    // read inside the tickMarkFormatter/timeFormatter closures below, which
    // this effect's own cleanup previously used as an excuse to destroy and
    // fully recreate the chart (and re-fetch its entire dataset) on every
    // timezone switch. For a chart with a lot of history loaded, that
    // re-fetch + re-parse froze the whole tab for a purely cosmetic label
    // change. See the dedicated effect below, which keeps the chart's own
    // time formatting in sync without tearing anything down.
  }, [showChart, trade?.symbol, timeframe]);

  // Whether to show rollover markers / the "Continuous" toggle at all —
  // checked independently of what's actually loaded into the chart. The main
  // data fetch is bounded to a window around the trade (BARS_PADDING_BACKGROUND
  // above), and for a quarterly futures contract the actual rollover date is
  // often months outside that window, so deriving this from the loaded bars
  // made it silently disappear even when the symbol genuinely has rollovers
  // elsewhere in its history. This is a cheap, separate existence check.
  useEffect(() => {
    if (!showChart || !trade?.symbol || !trade?.type || trade.type !== 'FUT') {
      setHasRolloverToAdjust(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const url = `${process.env.REACT_APP_API_URL}/api/historical/has-rollover?symbol=${encodeURIComponent(trade.symbol)}&type=${encodeURIComponent(trade.type)}&timeframe=${timeframe}`;
        const res = await fetch(url, { headers: { 'x-account-id': '1' } });
        if (cancelled || !res.ok) return;
        const data = await res.json();
        if (!cancelled) setHasRolloverToAdjust(!!data.hasRollover);
      } catch (err) {
        console.error('[TradeView] Error checking for rollover:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [showChart, trade?.symbol, trade?.type, timeframe]);

  // Triggers fetchMoreHistory once the visible range scrolls/zooms near the
  // edge of what's currently loaded — lightweight-charts' logical range is
  // bar-index based (0 = oldest loaded bar), so this is a simple, zoom-level
  // independent way to detect "approaching the edge" regardless of gaps
  // (weekends, closed markets) in the underlying data. Declared after the
  // chart-creation effect above so chartRef.current is already set by the
  // time this runs in the same commit (a fresh chart doesn't exist yet
  // during earlier effects in this same render pass).
  useEffect(() => {
    if (!showChart || !chartRef.current) return;
    const timeScale = chartRef.current.timeScale();
    const EDGE_THRESHOLD_BARS = 50;
    const handleVisibleLogicalRangeChange = (logicalRange) => {
      if (!logicalRange || chartDataRef.current.length === 0) return;
      if (logicalRange.from < EDGE_THRESHOLD_BARS) {
        fetchMoreHistory('older');
      }
      if (logicalRange.to > chartDataRef.current.length - EDGE_THRESHOLD_BARS) {
        fetchMoreHistory('newer');
      }
    };
    timeScale.subscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
    return () => {
      try {
        timeScale.unsubscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
      } catch (e) {
        // Chart may already be torn down (symbol/timeframe change) — nothing
        // to clean up in that case.
      }
    };
  }, [showChart, trade?.symbol, timeframe, fetchMoreHistory]);

  // Keeps the chart's axis/crosshair time formatting in sync with the
  // selected timezone by updating the existing chart in place — no teardown,
  // no re-fetch. This is what used to be baked into the chart-creation
  // effect above (see its comment) and froze the tab on large datasets.
  useEffect(() => {
    if (!chartRef.current) return;
    const zone = resolveDisplayZone(displayTimezone, exchangeTimezone);
    chartRef.current.applyOptions({
      timeScale: {
        // Re-asserted here defensively alongside the formatter — this effect
        // runs immediately after chart creation (and again on any zone/
        // timeframe change), and if applyOptions doesn't deep-merge the
        // timeScale sub-object the way this codebase assumed, the values set
        // at chart-creation time could get silently reset to their defaults
        // (rightOffset 0, shiftVisibleRangeOnNewBar true) right after —
        // which would explain the last bar hard-clamping to the right edge
        // regardless of what was set during createChart().
        rightOffset: 200,
        shiftVisibleRangeOnNewBar: false,
        tickMarkFormatter: (timestamp) => {
          const dt = DateTime.fromSeconds(timestamp, { zone });
          return timeframe === '1D' || timeframe === '1W' ? dt.toFormat("d LLL ''yy") : dt.toFormat('HH:mm');
        },
      },
      localization: {
        timeFormatter: (timestamp) => {
          return DateTime.fromSeconds(timestamp, { zone })
            .toFormat(timeframe === '1D' || timeframe === '1W' ? "d LLL ''yy" : "d LLL ''yy HH:mm");
        },
      },
    });
  }, [displayTimezone, exchangeTimezone, timeframe]);

  useEffect(() => { // Effect to manage average price, exit price, and stop loss lines
    if (!showChart || !chartRef.current || !candlestickSeriesRef.current || !hasChartDataBars) {
      return; // Exit if the chart isn't ready
    }
  
    // --- SETUP ---
    const chart = chartRef.current;
    const candlestickSeries = candlestickSeriesRef.current;
    const chartData = chartDataRef.current;
    const sortedActions = [...trade.actions].sort((a, b) => DateTime.fromISO(a.dateTime).toMillis() - DateTime.fromISO(b.dateTime).toMillis());
    const hasActions = sortedActions.length > 0;
    const hasStopLoss = trade.stop_loss != null && trade.stop_loss !== '' && !isNaN(parseFloat(trade.stop_loss)) && parseFloat(trade.stop_loss) !== 0;
  
    // --- UTILITY FUNCTION ---
    const findBarTimeForAction = (actionTime, data) => {
      const barIndex = data.findIndex(bar => bar.time > actionTime);
      if (barIndex === 0) return data[0]?.time;
      if (barIndex === -1) return data.length > 0 ? data[data.length - 1].time : undefined;
      return data[barIndex - 1]?.time;
    };
  
    // --- CLEANUP ALL OLD LINES ---
    if (stopLossLineRef.current && candlestickSeries) {
      candlestickSeries.removePriceLine(stopLossLineRef.current);
        stopLossLineRef.current = null;
      }
  
    // --- MANAGE STOP LOSS LINE ---
    const shouldDrawStopLoss = showAvgStopLines && hasStopLoss && hasActions;
  
    if (shouldDrawStopLoss) {
      // Create the LineSeries for the stop loss if it doesn't exist.
      if (!stopLossLineSeriesRef.current) {
        stopLossLineSeriesRef.current = chart.addLineSeries({
          color: '#EF4444',
          lineWidth: 1,
          lineStyle: 2, // Dashed
          lineType: LineType.WithSteps,
          lastValueVisible: false,
          axisLabelVisible: true,
          title: 'SL',
        });
      }
  
      // Calculate data for the stop loss line
      if (stopLossLineSeriesRef.current) {
        const firstActionTime = DateTime.fromISO(sortedActions[0].dateTime, { zone: 'utc' }).toUnixInteger();
        const lastActionTime = DateTime.fromISO(sortedActions[sortedActions.length - 1].dateTime, { zone: 'utc' }).toUnixInteger();
  
        const slStartTime = findBarTimeForAction(firstActionTime, chartData);
        const slEndTime = findBarTimeForAction(lastActionTime, chartData);
  
        if (slStartTime && slEndTime && slStartTime <= slEndTime) {
          const slPrice = parseFloat(trade.stop_loss);
          const adjMap = adjustmentMapRef.current;
          const showAdjusted = showBackAdjustedLines;
          let slData = [];
  
          if (showAdjusted) {
            // For the adjusted view, we need all intermediate points to show steps.
            slData = chartData
            .filter(bar => bar.time >= slStartTime && bar.time <= slEndTime)
            .map(bar => ({
              time: bar.time,
                value: slPrice + (adjMap.get(bar.time) || 0),
            }));
          } else {
            // FIX: For the default view, explicitly create points for each bar in the segment.
            // This prevents the line from rendering continuously across the chart.
            slData = chartData
              .filter(bar => bar.time >= slStartTime && bar.time <= slEndTime)
              .map(bar => ({
                time: bar.time,
                value: slPrice,
              }));
          }
          
          // Ensure the very first point is present, covering edge cases.
          if (slData.length === 0 || slData[0].time > slStartTime) {
              const startValue = showAdjusted ? slPrice + (adjMap.get(slStartTime) || 0) : slPrice;
              slData.unshift({ time: slStartTime, value: startValue });
          }

          stopLossLineSeriesRef.current.setData(slData);

        } else {
          stopLossLineSeriesRef.current.setData([]); // Clear data if times are invalid
        }
      }
    } else {
      // If the line should NOT be drawn, ensure the series is fully removed.
      if (stopLossLineSeriesRef.current) {
        chart.removeSeries(stopLossLineSeriesRef.current);
        stopLossLineSeriesRef.current = null;
      }
    }
  
    // --- MANAGE AVERAGE PRICE AND EXIT PRICE LINES ---
    if (showAvgStopLines && hasActions) {
      if (!avgPriceSeriesRef.current) {
        avgPriceSeriesRef.current = chart.addLineSeries({
          color: '#3B82F6', lineWidth: 1, priceLineVisible: false, lineType: LineType.WithSteps, lastValueVisible: true, axisLabelVisible: true, title: 'Avg Entry',
        });
      }
      if (!avgExitPriceSeriesRef.current) {
        avgExitPriceSeriesRef.current = chart.addLineSeries({
          color: '#F59E0B', lineWidth: 1, priceLineVisible: false, lineType: LineType.WithSteps, lastValueVisible: true, axisLabelVisible: true, title: 'Avg Exit',
        });
      }
  
      const lineData = [];
      const exitLineData = [];
      let currentQuantity = 0, currentPositionValue = 0, cumulativeExitValue = 0, cumulativeExitedQuantity = 0;
      const isLong = trade.side === 'LONG';
  
      for (const action of sortedActions) {
        const actionRawTime = DateTime.fromISO(action.dateTime, { zone: 'utc' }).toUnixInteger();
        const actionPrice = parseFloat(action.price);
        const actionQuantity = parseFloat(action.quantity);
        if (isNaN(actionPrice) || isNaN(actionQuantity)) continue;
        const barTime = findBarTimeForAction(actionRawTime, chartData);
        if (!barTime) continue;
        let avgPriceBefore = currentQuantity > 0 ? currentPositionValue / currentQuantity : null;
        if (isLong) {
          if (action.type === 'BUY') { currentPositionValue += actionPrice * actionQuantity; currentQuantity += actionQuantity; }
          else {
            if (currentQuantity > 0) {
              const sellQuantity = Math.min(actionQuantity, currentQuantity);
              cumulativeExitValue += actionPrice * sellQuantity; cumulativeExitedQuantity += sellQuantity;
              if (cumulativeExitedQuantity > 0) {
                const avgExitPrice = cumulativeExitValue / cumulativeExitedQuantity;
                if (exitLineData.length > 0 && exitLineData[exitLineData.length - 1].time === barTime) exitLineData[exitLineData.length - 1].value = avgExitPrice;
                else exitLineData.push({ time: barTime, value: avgExitPrice });
              }
              const avgCost = currentPositionValue / currentQuantity;
              currentPositionValue -= avgCost * sellQuantity; currentQuantity -= sellQuantity;
            }
          }
        } else { // SHORT
          if (action.type === 'SELL') { currentPositionValue += actionPrice * actionQuantity; currentQuantity += actionQuantity; }
          else {
            if (currentQuantity > 0) {
              const buyQuantity = Math.min(actionQuantity, currentQuantity);
              cumulativeExitValue += actionPrice * buyQuantity; cumulativeExitedQuantity += buyQuantity;
              if (cumulativeExitedQuantity > 0) {
                const avgExitPrice = cumulativeExitValue / cumulativeExitedQuantity;
                if (exitLineData.length > 0 && exitLineData[exitLineData.length - 1].time === barTime) exitLineData[exitLineData.length - 1].value = avgExitPrice;
                else exitLineData.push({ time: barTime, value: avgExitPrice });
              }
              const avgProceeds = currentPositionValue / currentQuantity;
              currentPositionValue -= avgProceeds * buyQuantity; currentQuantity -= buyQuantity;
            }
          }
        }
        if (currentQuantity > 0) {
          const avgPrice = currentPositionValue / currentQuantity;
          if (lineData.length > 0 && lineData[lineData.length - 1].time === barTime) lineData[lineData.length - 1].value = avgPrice;
          else lineData.push({ time: barTime, value: avgPrice });
        } else if (avgPriceBefore !== null) {
          if (lineData.length > 0 && lineData[lineData.length - 1].time === barTime) lineData[lineData.length - 1].value = avgPriceBefore;
          else lineData.push({ time: barTime, value: avgPriceBefore });
          currentQuantity = 0; currentPositionValue = 0;
        }
      }
  
      const latestBarTime = chartData.length > 0 ? chartData[chartData.length - 1].time : null;
      const hadOpenPosition = currentQuantity > 0;
      const isPositionOpen = hadOpenPosition || trade?.status === 'OPEN';

      if (chartData.length > 0 && lineData.length > 0) {
        const lastEntryTime = lineData[lineData.length - 1].time;
        const lastEntryValue = lineData[lineData.length - 1].value;
        const finalEntryValue = hadOpenPosition ? (currentPositionValue / currentQuantity) : lastEntryValue;

        if (isPositionOpen && latestBarTime > lastEntryTime) {
          lineData.push({ time: latestBarTime, value: finalEntryValue });
        }
      }

      if (exitLineData.length > 0 && latestBarTime != null) {
        const lastAvgExitPrice = exitLineData[exitLineData.length - 1].value;
        const lastExitTime = exitLineData[exitLineData.length - 1].time;
        const extendToTime = isPositionOpen ? latestBarTime : lastExitTime;

        if (extendToTime > lastExitTime) {
          exitLineData.push({ time: extendToTime, value: lastAvgExitPrice });
        }
      }
  
      const filterUniqueTime = (data) => {
          const uniqueData = [];
          const timeSet = new Set();
        for (let i = data.length - 1; i >= 0; i--) {
              if (!timeSet.has(data[i].time)) {
                  uniqueData.unshift(data[i]);
                  timeSet.add(data[i].time);
              }
          }
          return uniqueData;
      };
      const uniqueLineData = filterUniqueTime(lineData);
      const uniqueExitLineData = filterUniqueTime(exitLineData);
  
      if (showBackAdjustedLines) {
        const adjMap = adjustmentMapRef.current;
        avgPriceSeriesRef.current.setData(uniqueLineData.map(p => ({ ...p, value: p.value + (adjMap.get(p.time) || 0) })));
        avgExitPriceSeriesRef.current.setData(uniqueExitLineData.map(p => ({ ...p, value: p.value + (adjMap.get(p.time) || 0) })));
      } else {
        avgPriceSeriesRef.current.setData(uniqueLineData);
        avgExitPriceSeriesRef.current.setData(uniqueExitLineData);
      }
    } else {
      if (avgPriceSeriesRef.current) { chart.removeSeries(avgPriceSeriesRef.current); avgPriceSeriesRef.current = null; }
      if (avgExitPriceSeriesRef.current) { chart.removeSeries(avgExitPriceSeriesRef.current); avgExitPriceSeriesRef.current = null; }
    }
  }, [showChart, showAvgStopLines, showBackAdjustedLines, trade, hasChartDataBars, dataVersion]);


  if (!trade) return null;

  const processedAttachments = (trade.attachments || []).map(att => ({
    ...att,
    preview: att.image_base64 && att.mime_type
      ? `data:${att.mime_type};base64,${att.image_base64}`
      : undefined,
  }));

  const actions = trade.actions || [];
  const maxActionsPerLine = 4;
  const actionGroups = chunkArray(actions, maxActionsPerLine);

  const dotSpacing = 110;
  const marginPercent = 0.2;
  const minTimelineWidth = 450;
  const timelineWidth = minTimelineWidth;
  const margin = timelineWidth * marginPercent;

  const getDotLeft = (idx, groupLength) => {
    if (groupLength === 1) return `${timelineWidth / 2}px`;
    return `${margin + ((timelineWidth - 2 * margin) * (idx / (groupLength - 1)))}px`;
  };

  const confidence = trade.journal?.confidence || 0;
  const executionRating = trade.journal?.execution_rating || 0;

  const realisedPnL = getRealisedPnL(trade);
  const unrealisedPnL = trade.status === 'OPEN' ? (trade.currentReturn !== undefined && trade.currentReturn !== null ? trade.currentReturn : null) : 0;
  const totalPnL = realisedPnL + (unrealisedPnL || 0);
  const totalFees = trade.actions.reduce((sum, action) => sum + (Number(action.fee) || 0), 0);

  return (
    <div className={styles.overlay}>
      <div
        className={styles.modal}
        ref={modalRef}
        style={isMobile ? {
          width: '100vw',
          maxWidth: 'none',
          // Not 100vh — see TradeModal.jsx's identical note: mobile browsers'
          // collapsible address bar makes 100vh taller than what's actually
          // visible, which is what was pushing the close button off-screen.
          height: 'calc(var(--vh, 1vh) * 100)',
          maxHeight: 'none',
          display: 'flex',
          flexDirection: 'column',
        } : {
          width: '700px',
          maxWidth: '98vw',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className={styles.headerRow}>
          <span className={styles.title}>Trade View</span>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
            <span style={{ color: '#A5ADBA', fontSize: '0.85em', fontWeight: 500 }}>
              Timezone
            </span>
            <TimezonePicker value={displayTimezone} onChange={setDisplayTimezone} />
          </div>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        <div className={styles.tabContent} ref={contentWrapperRef}>
          <div className={styles.plRow}>
            <div className={styles.symbolAndPnl}>
              <div className={styles.symbolBadge}>
                <span>{trade.symbol || 'N/A'}</span>
                <span className={styles.symbolType}>{trade.type || 'UNKNOWN'}</span>
              </div>
              <div className={styles.pnlContainer}>
                {trade.status === 'OPEN' ? (
                  <>
                    <span
                      className={styles.plValue}
                      style={{ color: realisedPnL > 0 ? '#22C55E' : realisedPnL < 0 ? '#EF4444' : '#A5ADBA' }}
                    >
                      [R] ${Math.abs(realisedPnL).toFixed(2)}
                    </span>
                    <span
                      className={styles.plValue}
                      style={{ color: unrealisedPnL > 0 ? '#22C55E' : unrealisedPnL < 0 ? '#EF4444' : '#A5ADBA' }}
                    >
                      [U] {unrealisedPnL !== null ? `$${Math.abs(unrealisedPnL).toFixed(2)}` : 'Loading...'}
                    </span>
                  </>
                ) : (
                  <span
                    className={styles.plValue}
                    style={{ color: totalPnL > 0 ? '#22C55E' : totalPnL < 0 ? '#EF4444' : '#A5ADBA' }}
                  >
                    ${Math.abs(totalPnL).toFixed(2)}
                  </span>
                )}
              </div>
            </div>
            <div className={styles.metaBadges}>
              {trade.side && (
                <span
                  className={styles.metaBadgeGreen}
                  style={{
                    background: trade.side === 'SHORT' ? '#EF4444' : '#22C55E',
                  }}
                >
                  {trade.side}
                </span>
              )}
              {trade.status === 'OPEN' && (
                <span className={styles.metaBadgeBlue}>OPEN</span>
              )}
              {trade.status !== 'OPEN' && trade.holdTime && (
                <span className={styles.metaBadgeBlue}>{trade.holdTime.toUpperCase()}</span>
              )}
            </div>
          </div>
          <div className={styles.timelineScroll}>
            {actionGroups.map((group, groupIdx) => (
              <div
                key={groupIdx}
                className={styles.timelineBox}
                style={{ width: timelineWidth }}
              >
                <div
                  className={styles.timelineBar}
                  style={{
                    left: 0,
                    width: `${timelineWidth}px`,
                  }}
                />
                {group.map((action, idx) => {
                  const actionDateTime = DateTime.fromISO(action.dateTime, { zone: 'utc' });
                  const displayDateTime = actionDateTime.setZone(resolveDisplayZone(displayTimezone, exchangeTimezone));
                  return (
                    <div
                      key={idx}
                      className={styles.timelineDotWrap}
                      style={{
                        left: getDotLeft(idx, group.length),
                      }}
                    >
                      <div className={styles.timelineDate}>
                        {formatTimelineDate(displayDateTime, pricePrecision)}
                      </div>
                      <div className={styles.timelineDotRow}>
                        <div
                          className={
                            action.type === 'BUY'
                              ? styles.timelineDotBuy
                              : styles.timelineDotSell
                          }
                        >
                          {action.type === 'BUY' ? 'B' : 'S'}
                        </div>
                      </div>
                      <div className={styles.timelineQtyPrice}>
                        <span className={styles.timelineQty}>{action.quantity}</span>
                        <span className={styles.timelineAtSymbol}>@</span>
                        <span className={styles.timelinePrice}>${Number(action.price).toFixed(pricePrecision)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <fieldset className={styles.notesBox}>
            {(confidence > 0 || executionRating > 0) && (
              <legend className={styles.notesLegend}>
                <div className={styles.ratingsInLegend}>
                  {confidence > 0 && (
                    <div className={styles.ratingInLegendLeft}>
                      <span className={styles.ratingText}>Confidence</span>
                      <div className={styles.starsInline}>
                        {[...Array(5)].map((_, i) => (
                          <span key={i} className={styles.star}>
                            {i < confidence ? '★' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {executionRating > 0 && (
                    <div className={styles.ratingInLegendRight}>
                      <span className={styles.ratingText}>     Execution</span>
                      <div className={styles.starsInline}>
                        {[...Array(5)].map((_, i) => (
                          <span key={i} className={styles.star}>
                            {i < executionRating ? '★' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </legend>
            )}
            <div className={styles.notesWrapper}>
              {/* Notes content */}
              {trade.journal?.notes_html && (
                <div
                  className={styles.notesContent}
                  dangerouslySetInnerHTML={{ __html: sanitizeNotesHtml(trade.journal.notes_html) }}
                />
              )}

              {processedAttachments.length > 0 && (
                <div className={styles.attachmentsPreview}>
                  {processedAttachments.map((file, i) =>
                    file.preview ? (
                      <div key={file.id || i} className={styles.attachmentThumb}>
                        <img
                          src={file.preview}
                          alt={file.filename || 'screenshot'}
                          title={file.filename || 'screenshot'}
                          onClick={() => setSelectedAttachment(file.preview)}
                          style={{ cursor: 'pointer' }}
                        />
                        <span className={styles.tooltip}>{file.filename || 'Unnamed file'}</span>
                      </div>
                    ) : null
                  )}
                </div>
              )}

              {/* AI analysis written by an external tool via the external API
                  (PATCH /api/external/v1/trades/:id/ai-analysis) — plain text,
                  kept separate from the user's own notes_html above. */}
              {trade.journal?.ai_analysis && (
                <div
                  style={{
                    marginTop: '12px',
                    padding: '12px',
                    borderRadius: '8px',
                    background: 'rgba(59, 130, 246, 0.08)',
                    border: '1px solid rgba(59, 130, 246, 0.3)',
                  }}
                >
                  <div style={{ fontSize: '0.75em', color: '#8FB6FF', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                    AI Analysis{trade.journal.ai_analysis_source ? ` — ${trade.journal.ai_analysis_source}` : ''}
                    {trade.journal.ai_analysis_updated_at && (
                      <span style={{ opacity: 0.7, textTransform: 'none', fontWeight: 400 }}>
                        {' '}({DateTime.fromISO(trade.journal.ai_analysis_updated_at).toFormat('dd/MM/yyyy, HH:mm')})
                      </span>
                    )}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', color: '#e0e2e6', fontSize: '0.9em' }}>
                    {trade.journal.ai_analysis}
                  </div>
                </div>
              )}
            </div>
          </fieldset>
          <div className={styles.metaContainer}>
            <div className={styles.metaColumn}>
              {totalFees > 0 && (
                <div className={styles.metaBadge} style={{ background: 'rgba(60,154,239,0.3)' }}>
                  <span className={styles.metaLabel}>FEES</span>
                  <span className={styles.metaValue}>${totalFees.toFixed(2)}</span>
                </div>
              )}
              {trade.stop_loss != null && !isNaN(trade.stop_loss) && Number(trade.stop_loss) > 0 && (
                <div className={styles.metaBadge} style={{ background: 'rgb(29, 78, 216, 0.5)' }}>
                  <span className={styles.metaLabel}>STOP</span>
                  <span className={styles.metaValue}>${Number(trade.stop_loss).toFixed(pricePrecision)}</span>
                </div>
              )}
              {trade.rMultiple != null && !isNaN(trade.rMultiple) && (
                <div className={styles.metaBadge} style={{ background: 'rgb(124, 58, 237, 0.5)' }}>
                  <span className={styles.metaLabel}>R-MULT</span>
                  <span className={styles.metaValue}>{Number(trade.rMultiple).toFixed(2)}</span>
                </div>
              )}
              {risk !== null && (
                <div className={styles.metaBadge} style={{ background: 'rgb(234, 179, 8, 0.5)' }}>
                  <span className={styles.metaLabel}>RISK</span>
                  <span className={styles.metaValue}>${risk.toFixed(2)}</span>
                </div>
              )}
            </div>
          </div>
          {error && (
            <div className={styles.error} style={{ color: '#EF4444', marginTop: '16px' }}>
              {error}
            </div>
          )}
        </div>
        <div className={styles.footerRow}>
          <div className={styles.leftButtonGroup}>
            <BubbleButton
              circle
              color="#10B981"
              disabled={!hasSymbolSetting}
              onClick={() => setShowChart(true)}
            >
              <ChartIcon className={styles.aiIcon} />
            </BubbleButton>
          </div>
          <BubbleButton color="#3B82F6" onClick={() => onEdit && onEdit(trade)}>
            Edit
          </BubbleButton>
        </div>
      </div>
      {selectedAttachment && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.8)',
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <div
            style={{
              background: '#232733',
              borderRadius: 18,
              padding: 16,
              maxWidth: '90vw',
              maxHeight: '90vh',
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center'
            }}
          >
            <img
              src={selectedAttachment}
              alt="Full-size attachment"
              style={{
                maxWidth: '100%',
                maxHeight: '80vh',
                borderRadius: 8,
                objectFit: 'contain'
              }}
            />
            <div
              style={{
                color: '#e0e2e6',
                fontSize: '0.9em',
                marginTop: 8,
                textAlign: 'center',
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {processedAttachments.find(att => att.preview === selectedAttachment)?.filename || 'Unnamed file'}
            </div>
            <button
              onClick={() => setSelectedAttachment(null)}
              style={{
                position: 'absolute',
                top: -12,
                right: -12,
                background: '#ef4444',
                color: '#fff',
                border: 'none',
                borderRadius: '50%',
                width: 32,
                height: 32,
                fontSize: '1.2em',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                zIndex: 2,
                boxShadow: '0 2px 8px 0 rgba(0,0,0,0.22)',
                lineHeight: 1,
                padding: 0
              }}
            >
              ×
            </button>
          </div>
        </div>
      )}
      {showChart && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.8)',
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <div
            className={styles.modal}
            style={{
              width: '100vw',
              height: '100dvh',
              display: 'flex',
              flexDirection: 'column',
              position: 'relative',
              borderRadius: 0,
              margin: 0
            }}
          >
            <div className={`${styles.headerRow} ${styles.chartHeaderRow}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 26px 16px 26px' }}>
              <span className={styles.title}>{trade.symbol}</span>
              <div className={styles.chartControlsGroup} style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <button
                  onClick={() => setShowAvgStopLines(prev => !prev)}
                  style={{
                    background: showAvgStopLines ? '#3B82F6' : 'rgb(112, 113, 115)',
                    color: '#f0f2f6',
                    border: 'none',
                    borderRadius: '12px',
                    padding: '6px 12px',
                    fontSize: '0.9em',
                    cursor: 'pointer',
                    opacity: showAvgStopLines ? 1 : 0.7,
                    transition: 'all 0.2s',
                  }}
                  title={showAvgStopLines ? "Hide Avg/SL Lines" : "Show Avg/SL Lines"}
                >
                  Levels
                </button>
                {trade.type === 'FUT' && hasRolloverToAdjust && ( // Only relevant once a rollover boundary is actually present in the fetched data
                  <button
                    onClick={() => {
                      // The current view is preserved automatically by the
                      // render effect (captured fresh right before setData),
                      // no need to snapshot it here.
                      setShowBackAdjustedLines(prev => !prev);
                    }}
                    style={{
                      background: showBackAdjustedLines ? '#3B82F6' : 'rgb(112, 113, 115)',
                      color: '#f0f2f6',
                      border: 'none',
                      borderRadius: '12px',
                      padding: '6px 12px',
                      fontSize: '0.9em',
                      cursor: 'pointer',
                      opacity: showBackAdjustedLines ? 1 : 0.7,
                      transition: 'all 0.2s',
                    }}
                    title={showBackAdjustedLines ? "Show Raw Data" : "Show Back-Adjusted Data"}
                  >
                    Continuous
                  </button>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                  <span style={{ color: '#A5ADBA', fontSize: '0.85em', fontWeight: 500 }}>
                    Timezone
                  </span>
                  <TimezonePicker value={displayTimezone} onChange={setDisplayTimezone} />
                </div>
              </div>
              <button className={styles.closeBtn} onClick={() => setShowChart(false)}>×</button>
            </div>
            <div
              ref={chartContainerRef}
              className={styles.chartContainer}
              style={{ position: 'relative', flex: 1 }}
            >
              <div className={styles.timeframeSwitcher}>
                {enabledTimeframes.map(tf => (
                  <button
                    key={tf}
                    onClick={() => selectTimeframe(tf)}
                    className={`${styles.timeframeButton} ${timeframe === tf ? styles.active : ''}`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
              {chartLoading && awaitingData && (
                <div className={styles.chartMessageOverlay}>
                  <Oval height="40" width="40" color="#3B82F6" ariaLabel="loading-indicator" secondaryColor="#ccc" strokeWidth={4} strokeWidthSecondary={4} />
                  <p style={{ marginTop: '10px' }}>Awaiting data for {timeframe}...</p>
                </div>
              )}

              {chartLoading && !awaitingData && (
                <div className={styles.chartMessageOverlay}>
                  <Oval height="40" width="40" color="#3B82F6" ariaLabel="loading-indicator" />
                  <p style={{ marginTop: '10px' }}>Loading {timeframe} chart...</p>
                </div>
              )}

              {!chartLoading && !error && !hasChartDataBars && showChart && (
                <div className={styles.chartMessageOverlay}>
                  No data available for {timeframe}.
                  {hasHistoricalDataConfig ? " Population may be in progress or data source is empty." : " Initial data configuration pending."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}