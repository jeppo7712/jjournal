import React, { useContext, useMemo, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler } from 'chart.js';
import TradeList from '../TradeList/TradeList';
import { TradeContext, parseActionDate, formatDate } from '../../context/TradeContext';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import styles from './Dashboard.module.css';
import useScrollLock from '../../utils/useScrollLock';
import { computeUnrealisedSeries } from '../../utils/unrealisedSeries';
import { loadDailyCloses, missingCloses, cachedCloses } from '../../utils/dailyCloses';
import { sumByCurrency, formatTotals, toTotalsList, totalsSign } from '../../utils/currencyTotals';
import { formatMoney, currencyMark } from '../../utils/formatMoney';
import { formatNumber } from '../../utils/numberFormat';
import { DateTime } from 'luxon';
import { getRealisedPnL } from '../../context/TradeContext';


ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

// A stat tile's figure(s) at the largest size that fits: they start at
// maxPx and only shrink, to minPx at the least, when the widest line would
// run past the tile. The font size is set here (not in the style prop) so a
// re-render can't put the unfitted size back.
function FitValue({ maxPx = 20, minPx = 9, className, style, children }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      // The stylesheet's size for this screen width is the ceiling.
      el.style.fontSize = '';
      const cs = window.getComputedStyle(el);
      let size = Math.min(maxPx, parseFloat(cs.fontSize) || maxPx);
      el.style.fontSize = `${size}px`;
      const padding = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const available = el.clientWidth - padding;
      const needed = el.scrollWidth - padding;
      if (needed > available && needed > 0 && available > 0) {
        size = Math.max(minPx, Math.floor((size * available / needed) * 10) / 10);
        el.style.fontSize = `${size}px`;
      }
      // A tile with a fixed height (phones) can't grow for extra lines:
      // shrink until the figures fit its inner height. (Not the tile's
      // scrollHeight: its corner glow overflows on purpose.)
      const tile = el.parentElement;
      if (tile) {
        const tcs = window.getComputedStyle(tile);
        const inner = tile.clientHeight - (parseFloat(tcs.paddingTop) || 0) - (parseFloat(tcs.paddingBottom) || 0);
        if (inner > 0 && el.offsetHeight > inner + 1) {
          size = Math.max(minPx, Math.floor((size * inner / el.offsetHeight) * 10) / 10);
          el.style.fontSize = `${size}px`;
        }
      }
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  });
  return <div ref={ref} className={className} style={style}>{children}</div>;
}

// "-€1.16" for the P&L chart: two decimals (axis steps like -0.4 otherwise
// print as -0.4000000000000001) and the minus before the currency mark.
const signedMoney = (value, currency) => {
  const n = Number(value) || 0;
  return `${n < 0 ? '-' : ''}${currencyMark(currency)}${formatNumber(Math.abs(n), 2)}`;
};

const formatCustomDate = (date) => {
  if (!date) return '';
  const dt = typeof date === 'string' ? DateTime.fromISO(date) : DateTime.fromJSDate(date);
  if (!dt.isValid) return '';
  return dt.toFormat('dd MMM yy').toUpperCase();
};

const Dashboard = ({ onViewTrade, onEditTrade, onViewDayNote, customFilterDate, customFilterWeek }) => {
  const {
    stats,
    toggleFilter,
    setTimeFilter,
    timeFilter,
    filter,
    getTimeRange,
    customStartDate,
    customEndDate,
    setCustomStartDate,
    setCustomEndDate,
    showTrades,
    showDayNotes,
    toggleShowTrades,
    toggleShowDayNotes,
    filteredItems,
    symbolFilter,
    setSymbolFilter,
    clearSymbolFilter,
    setRestrictToActionsInRange,
    restrictToActionsInRange,
  } = useContext(TradeContext);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimeFilterMenu, setShowTimeFilterMenu] = useState(false);
  const [showOpenTrades, setShowOpenTrades] = useState(false);
  const [showGraphPopup, setShowGraphPopup] = useState(false);
  const [isGraphHidden, setIsGraphHidden] = useState(false);
  useScrollLock(showGraphPopup);
  // Whether the P&L chart panel is open (desktop/tablet). Remembered per
  // browser, so a collapsed chart stays out of the way of the trade list.
  const [chartOpen, setChartOpenState] = useState(() => {
    try { return localStorage.getItem('jj.dashboard.chartOpen') !== 'false'; } catch { return true; }
  });
  const setChartOpen = (next) => setChartOpenState(prev => {
    const value = typeof next === 'function' ? next(prev) : next;
    try { localStorage.setItem('jj.dashboard.chartOpen', String(value)); } catch { /* storage unavailable */ }
    return value;
  });
  const [pnlChartType, setPnlChartType] = useState('realised'); // 'realised' or 'unrealised'
  // Which currency the P&L chart is showing. null means "whichever comes
  // first", so a single-currency account never has to choose. Set by clicking
  // a figure in the R P&L / U P&L boxes.
  const [chartCurrency, setChartCurrency] = useState(null);
  const timeFilterRef = useRef(null);
  const menuRef = useRef(null);
  const datePickerRef = useRef(null);
  const bullseyeButtonRef = useRef(null);


  // Detect if graph is hidden based on window width
  useEffect(() => {
    const handleResize = () => {
      setIsGraphHidden(window.innerWidth <= 750);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Debug log to verify filter state
  useEffect(() => {
  }, [filter]);

  useEffect(() => {
    if (customFilterDate) {
      setTimeFilter(null);
      const start = DateTime.fromJSDate(new Date(customFilterDate), { zone: 'local' }).startOf('day');
      const end = DateTime.fromJSDate(new Date(customFilterDate), { zone: 'local' }).endOf('day');
      setCustomStartDate(start.toISO());
      setCustomEndDate(end.toISO());
      setTimeFilter('CUSTOM');
      setShowDatePicker(false);
    } else if (customFilterWeek) {
      setTimeFilter(null);
      const start = DateTime.fromJSDate(new Date(customFilterWeek.start), { zone: 'local' }).startOf('day');
      const end = DateTime.fromJSDate(new Date(customFilterWeek.end), { zone: 'local' }).endOf('day');
      setCustomStartDate(start.toISO());
      setCustomEndDate(end.toISO());
      setTimeFilter('CUSTOM');
      setShowDatePicker(false);
    }
  }, [customFilterDate, customFilterWeek, setCustomStartDate, setCustomEndDate, setTimeFilter]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target) &&
        timeFilterRef.current &&
        !timeFilterRef.current.contains(event.target)
      ) {
        setShowTimeFilterMenu(false);
      }
      if (
        datePickerRef.current &&
        !datePickerRef.current.contains(event.target) &&
        timeFilterRef.current &&
        !timeFilterRef.current.contains(event.target)
      ) {
        setShowDatePicker(false);
        setTimeFilter(null);
        setCustomStartDate(null);
        setCustomEndDate(null);
      }
    };

    if (showTimeFilterMenu || showDatePicker) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showTimeFilterMenu, showDatePicker]);

  const sortedTrades = useMemo(() => {
    return filteredItems
      .filter(item => (item.type === 'FUT' || item.type === 'STK') && (item.status === 'WIN' || item.status === 'LOSS' || item.status === 'WASH' || item.status === 'OPEN'))
      .map(trade => ({
        ...trade,
        relevantDate: trade.status === 'OPEN' ? trade.lastActionDate : trade.lastActionDate,
        realisedPnL: trade.status === 'OPEN' ? getRealisedPnL(trade) : trade.return || 0,
        side: trade.side, // Explicitly include side
      }))
      .sort((a, b) => {
        const dateA = a.relevantDate ? new Date(a.relevantDate) : new Date(0);
        const dateB = b.relevantDate ? new Date(b.relevantDate) : new Date(0);
        return dateA - dateB;
      });
  }, [filteredItems]);


  const chartLabels = sortedTrades.map(trade => formatDate(trade.relevantDate));

  // One cumulative line per currency. A single blended line would draw a
  // curve whose y-axis is in no currency at all; separate lines each stay in
  // their own. A single-currency account still renders exactly one line, in
  // the original blue, so nothing changes visually until a second currency
  // actually exists.
  const CHART_SERIES_COLORS = ['#3B82F6', '#F59E0B', '#A855F7', '#14B8A6', '#EC4899'];
  const tradeCurrency = t => String(t.currency || 'USD').toUpperCase();
  // Only currencies that have actually realised something get a line. A
  // currency whose positions are all still open has no realised curve to
  // draw, and drawing it anyway put a flat line at zero on the chart — which
  // is not harmless: the series share one y-axis, so that zero line drags the
  // axis down to include 0 and squashes the real curve into whatever height
  // is left. An account whose cumulative P&L sits well away from zero lost
  // nearly all of its vertical detail that way.
  const currenciesWithRealised = [...new Set(
    sortedTrades.filter(t => (Number(t.realisedPnL) || 0) !== 0).map(tradeCurrency)
  )];
  // USD first, then alphabetical — a stable order, so a live-updating chart
  // never swaps its series colours around mid-session.
  const byUsdFirst = (a, b) => (a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b));
  // If nothing is realised yet there is no second series to worry about, so
  // fall back to a single line and keep the chart looking as it always did.
  // Sorted before the slice, or the fallback would pick whichever currency
  // happened to come first in the trade array rather than a predictable one.
  const chartCurrencies = currenciesWithRealised.length > 0
    ? [...currenciesWithRealised].sort(byUsdFirst)
    : [...new Set(sortedTrades.map(tradeCurrency))].sort(byUsdFirst).slice(0, 1);

  // One currency on the chart at a time — see the note on the unrealised
  // chart below for why they can't share a y-axis.
  const activeChartCurrency = chartCurrencies.includes(chartCurrency)
    ? chartCurrency
    : chartCurrencies[0];

  const chartData = {
    labels: chartLabels,
    datasets: chartCurrencies
      .map((code, i) => ({ code, i }))
      .filter(({ code }) => code === activeChartCurrency)
      .map(({ code, i }) => {
      // Cumulative within this currency, carrying the running total across
      // points belonging to other currencies so every series stays aligned
      // to the shared label axis.
      let running = 0;
      const data = sortedTrades.map(trade => {
        if (tradeCurrency(trade) === code) {
          running += trade.realisedPnL || 0;
        }
        return running;
      });
      return {
        label: chartCurrencies.length > 1 ? `Realised P&L (${code})` : 'Realised P&L',
        data,
        borderColor: CHART_SERIES_COLORS[i % CHART_SERIES_COLORS.length],
        backgroundColor: i === 0 ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
        tension: 0.3,
        fill: i === 0,
        pointRadius: 0,
        pointHoverRadius: 0,
      };
      }),
  };

  // --- Unrealised P&L chart ---
  // Daily closes come from a session cache (utils/dailyCloses), prefetched
  // in the background shortly after the Dashboard opens, so the chart is
  // usually ready by the time it's asked for. The series itself
  // (utils/unrealisedSeries) is worked out after the loading state has been
  // drawn, never inside the click: the tile and chart show at once that
  // something is happening instead of the page seeming to ignore the click.
  const closeSymbols = useMemo(() => {
    const seen = new Map();
    sortedTrades.forEach(trade => {
      if (!trade.symbol) return;
      const type = trade.type === 'FUT' ? 'FUT' : 'STK';
      seen.set(`${type}:${trade.symbol}`, { symbol: trade.symbol, type });
    });
    return [...seen.values()];
  }, [sortedTrades]);

  const [historicalDataMap, setHistoricalDataMap] = useState(() => cachedCloses(closeSymbols));
  const [isFetching, setIsFetching] = useState(false);

  useEffect(() => {
    if (pnlChartType !== 'unrealised') return undefined;
    let cancelled = false;
    const missing = missingCloses(closeSymbols);
    if (missing.length === 0) {
      setHistoricalDataMap(prev => ({ ...prev, ...cachedCloses(closeSymbols) }));
      return undefined;
    }
    setIsFetching(true);
    loadDailyCloses(closeSymbols, { concurrency: 6 })
      .then(closes => { if (!cancelled) setHistoricalDataMap(prev => ({ ...prev, ...closes })); })
      .finally(() => { if (!cancelled) setIsFetching(false); });
    return () => { cancelled = true; };
  }, [pnlChartType, closeSymbols]);

  // Background prefetch, a couple of seconds after the page settles.
  useEffect(() => {
    if (closeSymbols.length === 0) return undefined;
    const timer = setTimeout(() => { loadDailyCloses(closeSymbols, { concurrency: 3 }); }, 2500);
    return () => clearTimeout(timer);
  }, [closeSymbols]);

  const unrealisedRange = useMemo(() => {
    const range = timeFilter ? getTimeRange(timeFilter, customStartDate, customEndDate) : null;
    return { start: range?.start || null, end: range?.end || null };
  }, [timeFilter, customStartDate, customEndDate, getTimeRange]);

  // Some symbol's closes not here yet (the fetch effect is about to start,
  // or is running): working out a series now would chart those positions
  // as flat zero for a moment.
  const closesPending = closeSymbols.some(({ symbol }) => !historicalDataMap[symbol]);

  const [unrealisedSeries, setUnrealisedSeries] = useState({ labels: [], seriesByCurrency: {}, ready: false });
  const [isComputingUnrealised, setIsComputingUnrealised] = useState(false);

  useEffect(() => {
    // Only worked out while the unrealised chart is the one wanted.
    if (pnlChartType !== 'unrealised' || isFetching || closesPending) return undefined;
    setIsComputingUnrealised(true);
    let timer = null;
    // Let the loading state reach the screen first, then do the work.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        const result = computeUnrealisedSeries(sortedTrades, historicalDataMap, {
          startDate: unrealisedRange.start,
          endDate: unrealisedRange.end,
          formatLabel: formatDate,
        });
        setUnrealisedSeries({ ...result, ready: true });
        setIsComputingUnrealised(false);
      }, 0);
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [pnlChartType, isFetching, closesPending, sortedTrades, historicalDataMap, unrealisedRange]);

  const { labels: unrealisedLabels, seriesByCurrency: unrealisedByCurrency } = unrealisedSeries;
  // Busy: fetching closes, or working out a series not drawn yet.
  const loadingCloses = isFetching || closesPending;
  const unrealisedBusy = pnlChartType === 'unrealised' && (loadingCloses || isComputingUnrealised || !unrealisedSeries.ready);

  // Currencies the unrealised chart could show, in the same stable order used
  // everywhere else.
  const unrealisedCurrencies = Object.keys(unrealisedByCurrency).sort(byUsdFirst);
  // The chart shows one currency at a time, picked by clicking a figure in the
  // R P&L / U P&L boxes. Mixing them on one y-axis is what made a EUR line
  // read as flat against a USD one four orders of magnitude larger: each
  // currency needs its own scale, and the clearest way to give it one is to
  // show it on its own.
  const activeUnrealisedCurrency = unrealisedCurrencies.includes(chartCurrency)
    ? chartCurrency
    : unrealisedCurrencies[0];

  const unrealisedChartData = {
    labels: unrealisedLabels,
    datasets: activeUnrealisedCurrency ? [
      {
        label: unrealisedCurrencies.length > 1
          ? `Unrealised P&L (${activeUnrealisedCurrency})`
          : 'Unrealised P&L',
        data: unrealisedByCurrency[activeUnrealisedCurrency] || [],
        borderColor: '#EF4444',
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
        tension: 0.3,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 0,
      },
    ] : [],
  };


  const displayedChartCurrency = pnlChartType === 'realised'
    ? activeChartCurrency
    : activeUnrealisedCurrency;

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    layout: {
      padding: {
        top: 18,
        bottom: 6,
        right: 60,
      },
    },
    scales: {
      x: {
        display: true,
        ticks: {
          display: false
        },
        grid: { // Added to hide x-axis grid lines
          display: false
        }
      },
      y: {
        display: true,
        ticks: {
          color: '#6B7280',
          maxTicksLimit: 4,
          font: {
            size: 11
          },
          // The axis is in whichever currency the chart is showing, so the
          // mark has to follow it rather than always saying dollars.
          callback: value => signedMoney(value, displayedChartCurrency),
        },
        grid: {
          color: 'rgba(255, 255, 255, 0.04)',
        },
        border: { display: false },
      },
    },
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
        enabled: false
      },
      verticalLine: {
        currency: displayedChartCurrency,
      },
    },
  };

  const verticalLinePlugin = {
    id: 'verticalLine',
    afterDraw: (chart) => {
      // Check if the plugin is explicitly disabled for this chart instance
      const pluginOptions = chart.options.plugins && chart.options.plugins.verticalLine;
      if (pluginOptions && pluginOptions.enabled === false) {
        return; // Do not draw if disabled
      }

      const { ctx, tooltip, scales: { x }, chartArea, data } = chart;
      if (!x) return;
      const dataset = data.datasets[0]; // Assuming you are interested in the first dataset
      const labels = data.labels;

      // Definition of the function to draw a line and labels for a given point index
      const drawLineAndLabels = (index, isRightEdgeOverride = null) => {
        if (index < 0 || index >= labels.length || !dataset.data[index]) {
          // Basic validation to prevent errors if index is out of bounds or data is missing
          return;
        }
        const xPos = x.getPixelForValue(index);
        const dateLabel = labels[index] || 'N/A';
        const pnlValue = dataset.data[index];

        // Determine text alignment:
        // 'true' for isRightEdgeOverride forces text to the left of the line (used for the first point).
        // 'false' for isRightEdgeOverride forces text to be centered on the line (used for the last point).
        // 'null' allows dynamic alignment based on position.
        const isRightEdge = isRightEdgeOverride !== null ? isRightEdgeOverride : xPos > chartArea.right - 20;

        ctx.save(); // Save context state

        // Draw vertical line
        ctx.beginPath();
        ctx.moveTo(xPos, chartArea.top);
        ctx.lineTo(xPos, chartArea.bottom);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'; // Line color
        ctx.stroke();

        // Configure text properties
        ctx.font = '11px Arial';
        ctx.fillStyle = '#F3F4F6'; // Text color
        ctx.textAlign = isRightEdge ? 'left' : 'center';
        const textXPos = isRightEdge ? xPos - 10 : xPos; // Adjust text X position based on alignment

        // Draw date label (bottom)
        ctx.textBaseline = 'top';
        const dateY = chartArea.bottom + 5;
        ctx.fillText(dateLabel, textXPos, dateY);

        // Draw P&L value (top)
        ctx.textBaseline = 'bottom';
        // The currency comes from the chart's options, not this closure:
        // Chart.js keeps the first plugin registered under an id, so a value
        // captured here would stay whatever the first render showed.
        const pnlText = signedMoney(pnlValue, pluginOptions && pluginOptions.currency);
        const pnlY = chartArea.top - 5;
        ctx.fillText(pnlText, textXPos, pnlY);

        ctx.restore(); // Restore context state
      };

      const isHovering = tooltip && tooltip._active && tooltip._active.length > 0;

      if (isHovering) {
        // Mouse is hovering over a point
        const activePoint = tooltip._active[0];
        const index = activePoint.index;

        // Determine the alignment override for the hovered point
        let alignmentOverride = null; // Default to dynamic alignment
        if (index === 0) {
          alignmentOverride = true; // Hovering the first point: text to its left
        } else if (index === labels.length - 1) {
          alignmentOverride = false; // Hovering the last point: text centered
        }

        // Draw only the hovered point's details
        if (labels && labels.length > 0 && index >= 0 && index < labels.length) {
          drawLineAndLabels(index, alignmentOverride);
        }
      } else {
        // Mouse is NOT hovering: show default first and last point labels
        if (labels && labels.length > 0) {
          drawLineAndLabels(0, true); // Draw first point (text to its left)
          if (labels.length > 1) {
            // Ensure there is more than one point to draw a distinct last point
            drawLineAndLabels(labels.length - 1, false); // Draw last point (text centered)
          }
        }
      }
    },
  };

  // Ensure this plugin is registered with ChartJS if it isn't already elsewhere
  // ChartJS.register(verticalLinePlugin); // This line is already present in your Dashboard.jsx

  ChartJS.register(verticalLinePlugin);

  const signColour = (totals) => {
    const sign = totalsSign(totals);
    if (sign === 'mixed') return '#A5ADBA';
    return sign === 'positive' ? '#22C55E' : '#EF4444';
  };

  const lineCountOf = (stat) => toTotalsList(stat.totals || {}).length;

  // A stat box is a fixed 50px with its value absolutely positioned — one
  // line fits, two do not (a second currency overflowed the box entirely).
  // So a single currency renders exactly as it always has, untouched, and
  // only two-or-more switches to a stacked, smaller variant.
  //
  // `groupLines` is the line count of the *pair* a box is rendered beside,
  // not its own: R P&L holding USD+EUR while U P&L holds only USD would
  // otherwise put a small stacked box next to a large single-line one. Both
  // take the taller one's treatment, so the pair reads as one unit and the
  // shared currency lands on the same baseline in both.
  //
  // `align` differs by box on purpose: the P&L boxes have no percentage
  // gauge so their values can sit right; the AVG boxes do, so theirs stay
  // left and capped in width to keep clear of it.
  const renderStatValue = (stat, align = 'left', groupLines = 0) => {
    const list = toTotalsList(stat.totals || {});
    // With several currencies, every money tile (AVG W/L, R/U P&L) lists the
    // same currencies in the same order, leaving a line empty where it has
    // no figure, so a currency is on the same line in every tile.
    const rows = stat.totals && list.length > 0 && tileCurrencies.length > 1 ? tileCurrencies : null;
    const lines = rows ? rows.length : Math.max(groupLines, list.length);
    if (lines <= 1) {
      return <FitValue className={styles.statValue} style={{ color: stat.color }}>{stat.value}</FitValue>;
    }
    // Several currencies: one line each, at the same full size as a single
    // figure where the width allows (the tile row grows to fit the lines),
    // smaller only when the widest one wouldn't fit.
    return (
      <FitValue
        maxPx={20}
        className={`${styles.statValue} ${styles.statValueStacked} ${align === 'right' ? styles.statValueStackedRight : styles.statValueStackedLeft}`}
        style={{ color: stat.color }}
      >
        {list.length === 0 ? <span>{stat.value}</span> : (rows || list.map(item => item.currency)).map(currency => {
          if (!(currency in (stat.totals || {}))) {
            return <span key={currency} className={styles.statLinePlaceholder} aria-hidden="true">{'\u00a0'}</span>;
          }
          const amount = Number(stat.totals[currency]) || 0;
          const text = formatMoney(stat.abs ? Math.abs(amount) : amount, currency, stat.decimals ?? 2);
          // A P&L figure is coloured by its own sign, never by the sign of
          // whichever currency happens to be listed first — that printed a
          // negative EUR total in green because the USD beside it was up.
          // AVG W / AVG L are not sign-coloured: their colour says "win" or
          // "loss", so it stays fixed.
          const ownColor = stat.signColored
            ? (amount >= 0 ? '#22C55E' : '#EF4444')
            : undefined;
          if (!stat.onCurrency) return <span key={currency} style={ownColor ? { color: ownColor } : undefined}>{text}</span>;
          // Each figure charts its own currency. Dimming the ones that are
          // not on the chart is the only cue that a choice is being made —
          // with a single currency there is no choice, so nothing is dimmed.
          const isActive = !stat.activeCurrency || stat.activeCurrency === currency;
          return (
            <span
              key={currency}
              className={`${styles.statCurrencyPick} ${isActive ? styles.statCurrencyActive : ''}`}
              onClick={event => { event.stopPropagation(); stat.onCurrency(currency); }}
              title={`Show ${currency} on the chart`}
              style={ownColor ? { color: ownColor } : undefined}
            >
              {text}
            </span>
          );
        })}
      </FitValue>
    );
  };

  // WINS/LOSSES percentages are the win and loss rate among decided trades
  // (they add up to 100%); OPEN/WASH are each a share of all trades.
  const statGrid = [
    [
      { label: 'WINS', value: stats.wins, pct: stats.winRate + '%', color: '#22C55E', onClick: () => toggleFilter('WIN'), filterValue: 'WIN' },
      { label: 'LOSSES', value: stats.losses, pct: (stats.lossRate ?? 0) + '%', color: '#EF4444', onClick: () => toggleFilter('LOSS'), filterValue: 'LOSS' },
    ],
    [
      { label: 'OPEN', value: stats.open, pct: stats.totalTrades ? Math.round((stats.open / stats.totalTrades) * 100) + '%' : '0%', color: '#60A5FA', onClick: () => toggleFilter('OPEN'), filterValue: 'OPEN' },
      { label: 'WASH', value: stats.wash, pct: stats.totalTrades ? Math.round((stats.wash / stats.totalTrades) * 100) + '%' : '0%', color: '#A5ADBA', onClick: () => toggleFilter('WASH'), filterValue: 'WASH' },
    ],
    [
      { label: 'AVG W', value: formatTotals(stats.avgWinByCurrency, { decimals: 0, abs: true, emptyCurrency: displayedChartCurrency }), totals: stats.avgWinByCurrency, decimals: 0, abs: true, pct: (stats.avgWinPct ?? 0).toFixed(0) + '%', color: '#22C55E' },
      { label: 'AVG L', value: formatTotals(stats.avgLossByCurrency, { decimals: 0, abs: true, emptyCurrency: displayedChartCurrency }), totals: stats.avgLossByCurrency, decimals: 0, abs: true, pct: (stats.avgLossPct ?? 0).toFixed(0) + '%', color: '#EF4444' },
    ],
  ].map((row) => {
    // Every row is one side-by-side pair, so both boxes in it share a line
    // count and therefore a size and alignment.
    const lines = Math.max(0, ...row.map(lineCountOf));
    return row.map((stat) => ({ ...stat, lines }));
  });

  const timeFilters = [
    { label: 'TODAY', value: 'TODAY' },
    { label: 'YESTERDAY', value: 'YESTERDAY' },
    { label: 'THIS WK', value: 'THIS_WK' },
    { label: 'LAST WK', value: 'LAST_WK' },
    { label: 'THIS MO', value: 'THIS_MO' },
    { label: 'LAST MO', value: 'LAST_MO' },
    { label: 'LAST 3 MO', value: 'LAST_3_MO' },
    { label: 'THIS YR', value: 'THIS_YR' },
    { label: 'LAST YR', value: 'LAST_YR' },
    {
      label: timeFilter === 'CUSTOM' && customStartDate && customEndDate
        ? DateTime.fromISO(customStartDate).toFormat('yyyy-MM-dd') === DateTime.fromISO(customEndDate).toFormat('yyyy-MM-dd')
          ? formatCustomDate(customStartDate)
          : `${formatCustomDate(customStartDate)} - ${formatCustomDate(customEndDate)}`
        : 'CUSTOM',
      value: 'CUSTOM',
    },
  ];

  // Per-currency ({ USD: n, EUR: m }) rather than a scalar — no FX
  // conversion happens anywhere in this app, so blending currencies would
  // produce a confident-looking number that means nothing. One currency in,
  // one value out, rendered exactly as before.
  //
  // Every currency of the trades shown gets a figure, 0 when nothing in it is
  // open right now: the unrealised chart covers each currency that had an
  // open position at any time in range, and the figure is how that chart is
  // picked. Without the 0, a currency whose positions are all closed again
  // could only be charted by first clicking it under R P&L.
  const unrealisedPnlByCurrency = useMemo(() => {
    const trades = filteredItems.filter(item => item.type === 'FUT' || item.type === 'STK');
    const totals = sumByCurrency(trades.filter(item => item.status === 'OPEN'), trade => trade.currentReturn || 0);
    trades.forEach(trade => {
      const code = String(trade.currency || 'USD').toUpperCase();
      if (!(code in totals)) totals[code] = 0;
    });
    return totals;
  }, [filteredItems]);

  // Same rule as the chart: a still-open position has realised nothing, so it
  // must not put its currency on the realised board. Without this an account
  // holding only open EUR positions printed a phantom "EUR 0.00" beside the
  // real USD figure. A partially closed position has genuinely realised part
  // of itself and still counts.
  const realisedOf = trade => (trade.status === 'OPEN' ? getRealisedPnL(trade) : (trade.return || 0));
  const totalRealisedPnlByCurrency = useMemo(() => sumByCurrency(
    filteredItems.filter(item =>
      (item.type === 'FUT' || item.type === 'STK') &&
      (item.status === 'WIN' || item.status === 'LOSS' || item.status === 'WASH' || item.status === 'OPEN') &&
      (item.status !== 'OPEN' || (Number(realisedOf(item)) || 0) !== 0)
    ),
    realisedOf
  ), [filteredItems]);

  // The dimmed figures say which currency the chart shows; with no chart
  // on screen there is nothing to point at, so every figure stays lit.
  const chartVisible = isGraphHidden ? showGraphPopup : chartOpen;
  const realisedPnlStat = {
    label: 'R P&L',
    value: formatTotals(totalRealisedPnlByCurrency, { abs: true, emptyCurrency: displayedChartCurrency }),
    totals: totalRealisedPnlByCurrency,
    abs: true,
    // Box-level colour, which with several currencies only shows through on
    // anything the figures themselves don't paint. It states nothing when the
    // currencies disagree rather than asserting the first one's sign.
    color: signColour(totalRealisedPnlByCurrency),
    signColored: true,
    onClick: () => {
      setPnlChartType('realised');
      if (isGraphHidden) setShowGraphPopup(true);
      else setChartOpen(true);
    },
    // Clicking one of the figures charts that currency specifically.
    onCurrency: code => {
      setPnlChartType('realised');
      setChartCurrency(code);
      if (isGraphHidden) setShowGraphPopup(true);
      else setChartOpen(true);
    },
    activeCurrency: chartVisible && pnlChartType === 'realised' ? activeChartCurrency : null,
  };
  const unrealisedPnlStat = {
    label: 'U P&L',
    value: formatTotals(unrealisedPnlByCurrency, { abs: true, emptyCurrency: displayedChartCurrency }),
    totals: unrealisedPnlByCurrency,
    abs: true,
    color: signColour(unrealisedPnlByCurrency),
    signColored: true,
    onClick: () => {
      setPnlChartType('unrealised');
      if (isGraphHidden) setShowGraphPopup(true);
      else setChartOpen(true);
    },
    onCurrency: code => {
      setPnlChartType('unrealised');
      setChartCurrency(code);
      if (isGraphHidden) setShowGraphPopup(true);
      else setChartOpen(true);
    },
    activeCurrency: chartVisible && pnlChartType === 'unrealised' ? activeUnrealisedCurrency : null,
  };

  // R P&L and U P&L sit side by side, so they share a line count too.
  const pnlStatLines = Math.max(lineCountOf(realisedPnlStat), lineCountOf(unrealisedPnlStat));

  // Every currency any money tile shows, USD first (see renderStatValue).
  const tileCurrencies = [...new Set([
    stats.avgWinByCurrency, stats.avgLossByCurrency, totalRealisedPnlByCurrency, unrealisedPnlByCurrency,
  ].flatMap(totals => Object.keys(totals || {})))].sort(byUsdFirst);

  const handleTimeFilterClick = (value) => {
    if (timeFilter === value) {
      setTimeFilter(null);
      setCustomStartDate(null);
      setCustomEndDate(null);
      setShowDatePicker(false);
      setRestrictToActionsInRange(false);
    } else {
      setTimeFilter(value);
      setRestrictToActionsInRange(true);
      if (value === 'CUSTOM') {
        const today = new Date();
        const defaultEnd = new Date(today);
        const defaultStart = new Date(today);
        defaultStart.setDate(today.getDate() - 30);
        defaultStart.setHours(0, 0, 0, 0);
        defaultEnd.setHours(0, 0, 0, 0);
        setCustomStartDate(defaultStart.toISOString());
        setCustomEndDate(defaultEnd.toISOString());
        setShowDatePicker(true);
      } else {
        setCustomStartDate(null);
        setCustomEndDate(null);
        setShowDatePicker(false);
      }
    }
    setShowTimeFilterMenu(false);
  };

  const handleTimeFilterButtonClick = () => {
    if (timeFilter) {
      setTimeFilter(null);
      setCustomStartDate(null);
      setCustomEndDate(null);
      setShowDatePicker(false);
      setShowTimeFilterMenu(false);
      setRestrictToActionsInRange(false);
    } else {
      setShowTimeFilterMenu(!showTimeFilterMenu);
    }
  };

  const handleBullseyeClick = () => {
    setRestrictToActionsInRange(!restrictToActionsInRange);
  };

  const handleDateRangeSelect = (dates) => {
    const [start, end] = dates;
    if (start && end) {
      const startDt = DateTime.fromJSDate(start, { zone: 'local' }).startOf('day');
      const endDt = DateTime.fromJSDate(end, { zone: 'local' }).endOf('day');
      setCustomStartDate(startDt.toISO());
      setCustomEndDate(endDt.toISO());
      setTimeFilter('CUSTOM');
      setShowDatePicker(false);
      setShowTimeFilterMenu(false);
    } else {
      setCustomStartDate(start ? DateTime.fromJSDate(start, { zone: 'local' }).startOf('day').toISO() : null);
      setCustomEndDate(end ? DateTime.fromJSDate(end, { zone: 'local' }).endOf('day').toISO() : null);
    }
  };

  const handleSymbolFilterChange = (e) => {
    setSymbolFilter(e.target.value);
  };

  const toggleShowOpenTrades = () => {
    setShowOpenTrades(!showOpenTrades);
    toggleFilter('OPEN');
  };

  const getTimeFilterLabel = () => {
    if (!timeFilter) return 'TIME FILTER';
    const filter = timeFilters.find(f => f.value === timeFilter);
    return filter ? filter.label : 'TIME FILTER';
  };

  // One tile of the overview strip. Status tiles (WINS/LOSSES/OPEN/WASH)
  // toggle that status filter: include, exclude, off.
  const renderTile = (stat, { align = 'left', lines = stat.lines, ring = true, extraClass = '' } = {}) => {
    const percentage = parseFloat(stat.pct) || 0;
    const circumference = 2 * Math.PI * 12;
    const strokeDashoffset = circumference - (Math.min(100, Math.max(0, percentage)) / 100) * circumference;
    const filterState = stat.filterValue ? filter.find(f => f.type === stat.filterValue) : null;
    const isActive = filterState?.mode === 'include';
    const isExcluded = filterState?.mode === 'exclude';
    const clickable = !!stat.onClick;
    return (
      <div
        key={stat.label}
        className={`${styles.statBox} ${extraClass} ${isActive ? styles.active : ''} ${isExcluded ? styles.excluded : ''} ${clickable ? styles.clickable : ''}`}
        style={{ color: stat.color }}
        onClick={stat.onClick}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={clickable ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stat.onClick(); } }) : undefined}
        title={stat.filterValue ? `${isActive ? 'Showing only' : isExcluded ? 'Hiding' : 'Filter'} ${stat.label.toLowerCase()} — click to ${isActive ? 'hide them' : isExcluded ? 'clear' : 'show only these'}` : stat.title}
      >
        <div className={styles.statLabel}>{stat.label}</div>
        {renderStatValue(stat, align, lines)}
        {ring && stat.pct !== undefined && (
          <div className={styles.statPctContainer}>
            <svg className={styles.progressRing} width="30" height="30" viewBox="0 0 30 30">
              <circle stroke="rgba(255,255,255,0.08)" strokeWidth="3" fill="transparent" r="12" cx="15" cy="15" />
              <circle
                stroke={stat.color}
                strokeWidth="3"
                strokeLinecap="round"
                fill="transparent"
                r="12"
                cx="15"
                cy="15"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                style={{ transform: 'rotate(-90deg)', transformOrigin: 'center', transition: 'stroke-dashoffset 0.4s ease' }}
              />
            </svg>
            <div className={styles.statPct}>{stat.pct}</div>
          </div>
        )}
        {isExcluded && <span className={styles.statFlag}>hidden</span>}
        {isActive && <span className={`${styles.statFlag} ${styles.statFlagOn}`}>only</span>}
      </div>
    );
  };

  // The P&L chart's body, in the panel and in the phone sheet alike. While
  // the unrealised series loads, a spinner sits over the plot (over the
  // previous chart, dimmed, when there is one) so the click visibly took.
  const renderPnlChart = () => {
    if (pnlChartType === 'realised') {
      return <Line data={chartData} options={chartOptions} />;
    }
    const hasChart = unrealisedSeries.ready && unrealisedLabels.length > 0;
    let body = null;
    if (hasChart) {
      body = <Line data={unrealisedChartData} options={chartOptions} />;
    } else if (!unrealisedBusy) {
      body = (
        <div className={styles.chartEmpty}>
          {sortedTrades.length === 0 ? 'No trades to chart yet' : 'No price history for the open positions yet'}
        </div>
      );
    }
    return (
      <div className={`${styles.chartStage} ${unrealisedBusy && hasChart ? styles.chartStageBusy : ''}`}>
        {body}
        {unrealisedBusy && (
          <div className={styles.chartLoading} role="status">
            <span className={styles.chartSpinner} aria-hidden="true" />
            <span>{loadingCloses ? 'Loading price history…' : 'Working out unrealised P&L…'}</span>
          </div>
        )}
      </div>
    );
  };

  const showChartPanel = !isGraphHidden && chartOpen;
  const chartToggleTitle = chartOpen ? 'Hide the P&L chart' : 'Show the P&L chart';

  return (
    <div className={styles.dashboard}>
      <div className={styles.topRow}>
        <div className={styles.statsContainer}>
          <div className={styles.statsGrid}>
            {renderTile(statGrid[0][0], { extraClass: styles.tileWins })}
            {renderTile(statGrid[0][1], { extraClass: styles.tileLosses })}
            {renderTile(statGrid[1][0], { extraClass: styles.tileOpen })}
            {renderTile(statGrid[1][1], { extraClass: styles.tileWash })}
            {renderTile(statGrid[2][0], { extraClass: styles.tileAvgWin })}
            {renderTile(statGrid[2][1], { extraClass: styles.tileAvgLoss })}
            {renderTile({ ...realisedPnlStat, title: isGraphHidden ? 'Show the realised P&L chart' : 'Chart realised P&L' }, { align: 'left', lines: pnlStatLines, ring: false, extraClass: `${styles.tilePnl} ${styles.tileRealised} ${pnlChartType === 'realised' && showChartPanel ? styles.charted : ''}` })}
            {renderTile({ ...unrealisedPnlStat, title: isGraphHidden ? 'Show the unrealised P&L chart' : 'Chart unrealised P&L' }, { align: 'left', lines: pnlStatLines, ring: false, extraClass: `${styles.tilePnl} ${styles.tileUnrealised} ${pnlChartType === 'unrealised' && showChartPanel ? styles.charted : ''} ${unrealisedBusy && (showChartPanel || showGraphPopup) ? styles.tileBusy : ''}` })}
          </div>
        </div>

        {showChartPanel && (
          <div className={styles.graphBubble}>
            <div className={styles.chartHeader}>
              <div className={styles.chartTitle}>
                {pnlChartType === 'realised' ? 'Realised P&L' : 'Unrealised P&L'}
                <span className={styles.chartSubtitle}>{pnlChartType === 'realised' ? 'cumulative, by close date' : 'open positions over time'}</span>
              </div>
              <div className={styles.chartActions}>
                <div className={styles.segmented} role="tablist" aria-label="P&L chart">
                  <button type="button" role="tab" aria-selected={pnlChartType === 'realised'} className={pnlChartType === 'realised' ? styles.segmentOn : ''} onClick={() => setPnlChartType('realised')}>Realised</button>
                  <button type="button" role="tab" aria-selected={pnlChartType === 'unrealised'} className={pnlChartType === 'unrealised' ? styles.segmentOn : ''} onClick={() => setPnlChartType('unrealised')}>Unrealised</button>
                </div>
                <button type="button" className={styles.iconButton} onClick={() => setChartOpen(false)} title="Hide the chart" aria-label="Hide the chart">
                  <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M14.77 12.79a.75.75 0 01-1.06-.02L10 8.83l-3.71 3.94a.75.75 0 11-1.08-1.04l4.25-4.5a.75.75 0 011.08 0l4.25 4.5a.75.75 0 01-.02 1.06z" clipRule="evenodd" /></svg>
                </button>
              </div>
            </div>
            <div className={styles.graphArea}>
              {renderPnlChart()}
            </div>
          </div>
        )}

        <div className={styles.filterSections}>
          <div className={styles.buttonRow}>
            <div className={styles.toggleButtonGroup} role="group" aria-label="Show">
              <button
                type="button"
                className={`${styles.toggleButton} ${showTrades ? styles.active : styles.excluded}`}
                onClick={toggleShowTrades}
                aria-pressed={showTrades}
                title={showTrades ? 'Hide trades' : 'Show trades'}
              >
                <svg className={styles.toggleIcon} viewBox="0 0 20 20" fill="currentColor"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" /></svg>
                <span className={styles.toggleText}>Trades</span>
              </button>
              <button
                type="button"
                className={`${styles.toggleButton} ${showDayNotes ? styles.active : styles.excluded}`}
                onClick={toggleShowDayNotes}
                aria-pressed={showDayNotes}
                title={showDayNotes ? 'Hide day notes' : 'Show day notes'}
              >
                <svg className={styles.toggleIcon} viewBox="0 0 20 20" fill="currentColor"><path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z" /></svg>
                <span className={styles.toggleText}>Notes</span>
              </button>
              <button
                type="button"
                className={`${styles.toggleButton} ${styles.openTradesButton} ${filter.find(f => f.type === 'OPEN')?.mode === 'include' ? styles.active : ''} ${filter.find(f => f.type === 'OPEN')?.mode === 'exclude' ? styles.excluded : ''}`}
                onClick={toggleShowOpenTrades}
                title="Open positions: only / hidden / all"
              >
                <svg className={styles.toggleIcon} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" /></svg>
                <span className={styles.toggleText}>Open</span>
              </button>
            </div>
            <div className={styles.timeFilterContainer}>
              <div className={styles.timeFilterButtonContainer}>
                <button
                  ref={timeFilterRef}
                  className={`${styles.timeFilterButton} ${timeFilter ? styles.active : ''}`}
                  onClick={handleTimeFilterButtonClick}
                  title={timeFilter ? 'Clear the time filter' : 'Filter by time'}
                >
                  <svg className={styles.toggleIcon} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" /></svg>
                  <span className={styles.timeFilterLabel}>{timeFilter ? getTimeFilterLabel() : 'All time'}</span>
                  {timeFilter && <span className={styles.clearMark} aria-hidden="true">×</span>}
                </button>
                {showTimeFilterMenu && (
                  <div ref={menuRef} className={`${styles.timeFilterMenu} ${showTimeFilterMenu ? styles.open : ''}`}>
                    {timeFilters.map((filter, idx) => (
                      <div
                        key={idx}
                        className={`${styles.timeFilterBox} ${timeFilter === filter.value ? styles.active : ''} ${filter.value === 'CUSTOM' ? styles.custom : ''}`}
                        onClick={() => handleTimeFilterClick(filter.value)}
                      >
                        {filter.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button
                ref={bullseyeButtonRef}
                className={`${styles.bullseyeButton} ${restrictToActionsInRange ? styles.active : ''} ${!timeFilter ? styles.disabled : ''}`}
                onClick={handleBullseyeClick}
                title={restrictToActionsInRange ? 'Showing only trades with a fill in the range' : 'Show only trades with a fill in the range'}
                disabled={!timeFilter}
                aria-pressed={restrictToActionsInRange}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={styles.bullseyeIcon}>
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm0-14c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 10c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
                </svg>
              </button>
            </div>
            <div className={styles.symbolFilterContainer}>
              <svg className={styles.searchIcon} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.45 4.39l3.08 3.08a.75.75 0 11-1.06 1.06l-3.08-3.08A7 7 0 012 9z" clipRule="evenodd" /></svg>
              <input
                type="text"
                className={`${styles.symbolFilterInput} ${symbolFilter.length > 0 ? styles.active : ''}`}
                placeholder="Symbol"
                value={symbolFilter}
                onChange={handleSymbolFilterChange}
                aria-label="Filter by symbol"
              />
              {symbolFilter && (
                <button
                  className={styles.clearSymbolFilter}
                  onClick={clearSymbolFilter}
                  title="Clear symbol filter"
                >
                  ×
                </button>
              )}
            </div>
            {!isGraphHidden && (
              <button
                type="button"
                className={`${styles.chartToggle} ${chartOpen ? styles.active : ''}`}
                onClick={() => setChartOpen(open => !open)}
                title={chartToggleTitle}
                aria-pressed={chartOpen}
              >
                <svg className={styles.toggleIcon} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M3 3a1 1 0 011 1v11h12a1 1 0 110 2H3a1 1 0 01-1-1V4a1 1 0 011-1zm13.7 3.3a1 1 0 010 1.4l-4 4a1 1 0 01-1.4 0L9 9.42l-2.3 2.3a1 1 0 01-1.4-1.42l3-3a1 1 0 011.4 0L12 9.58l3.3-3.3a1 1 0 011.4 0z" clipRule="evenodd" /></svg>
                <span className={styles.toggleText}>Chart</span>
              </button>
            )}
          </div>
          {showDatePicker && (
            <div ref={datePickerRef} className={styles.datePickerContainer}>
              <DatePicker
                selected={customStartDate ? new Date(customStartDate) : null}
                onChange={handleDateRangeSelect}
                startDate={customStartDate ? new Date(customStartDate) : null}
                endDate={customEndDate ? new Date(customEndDate) : null}
                selectsRange
                inline
                monthsShown={2}
                calendarClassName={styles.datePickerCalendar}
              />
            </div>
          )}
        </div>
      </div>
      <div className={styles.tradeListSection}>
        <TradeList
          onViewTrade={onViewTrade}
          onEditTrade={onEditTrade}
          onViewDayNote={onViewDayNote}
        />
      </div>
      {showGraphPopup && createPortal(
        // Phones: the chart as a sheet from the bottom, over everything
        // (rendered into <body> so the bottom bar can't cover it).
        <div className={styles.graphPopup} onMouseDown={e => { if (e.target === e.currentTarget) setShowGraphPopup(false); }}>
          <div className={styles.graphPopupContent} role="dialog" aria-modal="true" aria-label={pnlChartType === 'realised' ? 'Realised P&L chart' : 'Unrealised P&L chart'}>
            <div className={styles.graphPopupGrip} aria-hidden="true" />
            <div className={styles.graphPopupHeader}>
              <div className={styles.chartTitle}>
                {pnlChartType === 'realised' ? 'Realised P&L' : 'Unrealised P&L'}
                <span className={styles.chartSubtitle}>{pnlChartType === 'realised' ? 'cumulative, by close date' : 'open positions over time'}</span>
              </div>
              <button type="button" className={styles.graphPopupClose} onClick={() => setShowGraphPopup(false)} title="Close" aria-label="Close">
                <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
            </div>
            <div className={`${styles.segmented} ${styles.graphPopupSegmented}`} role="tablist" aria-label="P&L chart">
              <button type="button" role="tab" aria-selected={pnlChartType === 'realised'} className={pnlChartType === 'realised' ? styles.segmentOn : ''} onClick={() => setPnlChartType('realised')}>Realised</button>
              <button type="button" role="tab" aria-selected={pnlChartType === 'unrealised'} className={pnlChartType === 'unrealised' ? styles.segmentOn : ''} onClick={() => setPnlChartType('unrealised')}>Unrealised</button>
            </div>
            <div className={styles.graphPopupArea}>
              {renderPnlChart()}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default Dashboard;