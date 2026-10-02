import React, { useState, useMemo, useEffect, useRef } from 'react';
import { TradeContext } from '../../context/TradeContext';
import TradeView from '../TradeView/TradeView'; // Import TradeView
import { sanitizeNotesHtml } from '../../utils/sanitizeHtml';
import Calendar from '../Calendar/Calendar';
import { TIMEZONE_OPTIONS, loadStoredDisplayTimezone, storeDisplayTimezone, TimezonePicker } from '../../utils/timezonePreference';

// Stats aggregates trades across every symbol at once — futures on Chicago
// time, US stocks on New York, others elsewhere — so "Exchange" mode (each
// trade bucketed in its own instrument's zone) doesn't make sense here the
// way it does for a single-symbol chart: an "hour 9" bucket would silently
// mix trades from different real-world hours. Only offer a single consistent
// frame (Local or a fixed picked zone) for all the hour/day bucketing below.
const STATS_TIMEZONE_OPTIONS = TIMEZONE_OPTIONS.filter(opt => opt.value !== 'exchange');
import {
  computeGeneralStats,
  computeRiskMetrics,
  computeTradeAnalysis,
  computeSymbolStats,
  computeFeeAnalysis,
  computeBestPerformingAssets,
  computePortfolioValueSeries,
  computeReturnDistribution,
  computeWinRateSeries,
  computeTradingActivityHeatmap,
  computeOpenPositionsPie,
  computeTopTrades,
  computeFeesPnlSeries,
  computeReturnVsHoldTime,
  computeReturnPercentageSeries,
  computeExpectancy,
  computeRiskRewardRatio,
  computeRecoveryFactor,
  computeBestWorstDays,
  computeMonthlyPnLSummary,
  computeDailyPnLStats,
  computeConsecutiveStats,
  computeAvgTradesPerWeek,
  computeAvgTradesPerMonth,
  computeHourlyStats,
  computeLargestStreaks,
  computeAvgWinLoss,
  computeHoldings,
} from './statsUtils';
import styles from './Stats.module.css';
import { currencyMark } from '../../utils/formatMoney';
import { formatNumber, formatNumberText } from '../../utils/numberFormat';
import { descendantAccountIds } from '../../utils/accountTree';
import { Line, Bar, Doughnut, Scatter } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend, Filler } from 'chart.js';
import { DateTime } from 'luxon';
import { debounce } from 'lodash';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend, Filler);

class StatsErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.errorContainer}>
          <h3>Something went wrong in the Stats module.</h3>
          <p>{this.state.error?.message || 'Unknown error'}</p>
          <p>Please try refreshing or contact support.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

// Negative money drops its minus sign wherever colour already carries the
// sign — red says "down" on its own and the extra glyph is noise. Only used
// on figures that are actually coloured: where a value renders in plain
// white, the sign is the one thing telling a loss from a gain.
const absAmount = (value) => formatNumber(Math.abs(Number(value)), 2);
const pnlColor = (value) => (value === null || value === undefined || Number(value) === 0 ? undefined : Number(value) > 0 ? '#22C55E' : '#EF4444');

// Icons and one-line descriptions for the section menu and header.
const TAB_META = {
  general: { description: 'Your headline numbers, return and P&L over time.', icon: <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" /> },
  calendar: { description: 'Daily and weekly P&L at a glance. Click a day or week to filter the Dashboard.', icon: <path fillRule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clipRule="evenodd" /> },
  holdings: { description: 'What you hold now: market value, cost basis and allocation.', icon: <path d="M2 10a8 8 0 018-8v8h8a8 8 0 11-16 0z M12 2.25A8.001 8.001 0 0117.75 8H12V2.25z" /> },
  advanced: { description: 'Expectancy, streaks, daily extremes and the monthly summary.', icon: <path fillRule="evenodd" d="M3 3a1 1 0 000 2v8a2 2 0 002 2h2.586l-1.293 1.293a1 1 0 101.414 1.414L10 15.414l2.293 2.293a1 1 0 001.414-1.414L12.414 15H15a2 2 0 002-2V5a1 1 0 100-2H3zm11.707 4.707a1 1 0 00-1.414-1.414L10 9.586 8.707 8.293a1 1 0 00-1.414 0l-2 2a1 1 0 101.414 1.414L8 10.414l1.293 1.293a1 1 0 001.414 0l4-4z" clipRule="evenodd" /> },
  risk: { description: 'Drawdown and risk-adjusted ratios.', icon: <path fillRule="evenodd" d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944zM11 14a1 1 0 11-2 0 1 1 0 012 0zm0-7a1 1 0 10-2 0v3a1 1 0 102 0V7z" clipRule="evenodd" /> },
  tradeAnalysis: { description: 'Hold times, trade frequency and your best and worst trades.', icon: <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" /> },
  bestAssets: { description: 'Every symbol ranked by what it has made overall.', icon: <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /> },
  hourlyAnalysis: { description: 'How you trade by hour of the day.', icon: <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" /> },
  feeAnalysis: { description: 'What you pay in fees, by month and by symbol.', icon: <path fillRule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 4a2 2 0 100-4 2 2 0 000 4z" clipRule="evenodd" /> },
  visualizations: { description: 'Return distribution, win rate over time and return vs. hold time.', icon: <path d="M3 3a1 1 0 011 1v11h12a1 1 0 110 2H3a1 1 0 01-1-1V4a1 1 0 011-1zm13.7 3.3a1 1 0 010 1.4l-4 4a1 1 0 01-1.4 0L9 9.42l-2.3 2.3a1 1 0 01-1.4-1.42l3-3a1 1 0 011.4 0L12 9.58l3.3-3.3a1 1 0 011.4 0z" /> },
  tradeNotes: { description: 'Your journal entries, ratings and screenshots in one place.', icon: <path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z" /> },
};

// Green/red for money figures whose sign means something (P&L, expectancy,
// best/worst days); everything else stays white. Called with just the
// label when the label alone decides it (e.g. "Worst Day P&L").
const toneClass = (label, value) => {
  const l = String(label);
  if (/worst|loss size|avg l\b/i.test(l)) return styles.valueNeg;
  if (/best|win size/i.test(l)) return styles.valuePos;
  if (!/p&l|expectancy/i.test(l)) return '';
  if (value === undefined) return '';
  const text = String(value);
  if (/-\s*[$€£]?\d|[$€£]\s*-|^-/.test(text)) return styles.valueNeg;
  return /[1-9]/.test(text) ? styles.valuePos : '';
};

const TAB_GROUPS = [
  { label: 'Overview', ids: ['general', 'calendar', 'holdings'] },
  { label: 'Performance', ids: ['advanced', 'risk', 'tradeAnalysis', 'bestAssets'] },
  { label: 'Habits', ids: ['hourlyAnalysis', 'feeAnalysis', 'visualizations'] },
  { label: 'Journal', ids: ['tradeNotes'] },
];

const Stats = ({ setCurrentView, onViewTrade, setCustomFilterDate, setCustomFilterWeek }) => {
  const { filteredItems: accountFilteredItems, filter, timeFilter, symbolFilter, restrictToActionsInRange, trades: allTrades, accounts, currentAccountId, fetchProcessedTradesForAccount, filterTradeItems } = React.useContext(TradeContext) || { filteredItems: [], filter: [], timeFilter: null, symbolFilter: '', restrictToActionsInRange: false, trades: [] };

  // A parent account's stats include its sub-accounts' trades (switchable):
  // a parent like a broker's main account often holds no trades itself,
  // they're booked in sub-accounts per instrument type or strategy.
  const subAccountIds = useMemo(
    () => descendantAccountIds(accounts, currentAccountId),
    [accounts, currentAccountId]
  );
  const [includeSubAccounts, setIncludeSubAccounts] = useState(true);
  const [subAccountTrades, setSubAccountTrades] = useState([]);
  useEffect(() => {
    if (subAccountIds.length === 0 || !fetchProcessedTradesForAccount) { setSubAccountTrades([]); return; }
    let cancelled = false;
    Promise.all(subAccountIds.map(id => fetchProcessedTradesForAccount(id)))
      .then(results => { if (!cancelled) setSubAccountTrades(results.flat()); })
      .catch(() => { if (!cancelled) setSubAccountTrades([]); });
    return () => { cancelled = true; };
  }, [subAccountIds, fetchProcessedTradesForAccount]);
  const withSubAccounts = includeSubAccounts && subAccountIds.length > 0;
  // Own and sub-account trades through the same Dashboard filters.
  const filteredItems = useMemo(
    () => (withSubAccounts && filterTradeItems
      ? filterTradeItems([...(allTrades || []), ...subAccountTrades])
      : accountFilteredItems),
    [withSubAccounts, filterTradeItems, allTrades, subAccountTrades, accountFilteredItems]
  );
  const [currentTab, setCurrentTab] = useState('general');
  const [historicalDataMap, setHistoricalDataMap] = useState({});
  const [isFetching, setIsFetching] = useState(false);
  const [notesSort, setNotesSort] = useState({ key: 'firstActionDate', direction: 'desc' });
  const [viewingTrade, setViewingTrade] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  // Shared global preference with TradeView/TradeModal, but "exchange" isn't
  // a valid choice here (see STATS_TIMEZONE_OPTIONS above) — fall back to
  // local if that's what's stored, without touching the shared value itself
  // (TradeView should still see "exchange" if that's what was picked there).
  const [displayTimezone, setDisplayTimezoneState] = useState(() => {
    const stored = loadStoredDisplayTimezone();
    return stored === 'exchange' ? 'local' : stored;
  });
  const setDisplayTimezone = (value) => {
    setDisplayTimezoneState(value);
    storeDisplayTimezone(value);
  };

  // Handlers for Calendar integration
  const handleCalendarDayClick = (date, trades) => {
    if (trades.length === 1) {
      onViewTrade(trades[0]);
    } else if (trades.length > 1) {
      setCustomFilterDate(date);
      setCustomFilterWeek(null);
      setCurrentView('dashboard');
    }
  };

  const handleCalendarWeekClick = (weekStart, weekEnd) => {
    setCustomFilterWeek({ start: weekStart, end: weekEnd });
    setCustomFilterDate(null);
    setCurrentView('dashboard');
  };

  // Currencies present in the current (filtered) set, USD first.
  const availableCurrencies = useMemo(() => {
    const codes = new Set(
      (filteredItems || [])
        .filter(item => item?.type === 'FUT' || item?.type === 'STK')
        .map(t => String(t.currency || 'USD').toUpperCase())
    );
    return [...codes].sort((a, b) => (a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b)));
  }, [filteredItems]);

  // Unlike a sum, the metrics on this page (profit factor, expectancy,
  // Sharpe, Sortino, drawdown, R:R, streak P&L…) cannot be shown "per
  // currency" side by side — they're ratios and distributions over a set of
  // returns, and a set mixing EUR and USD returns has no meaningful standard
  // deviation or profit factor at all. So the page is scoped to exactly one
  // currency at a time. Scoping here, at the single point where trades enter,
  // means all ~28 compute functions in statsUtils stay untouched and
  // automatically operate within one currency.
  const [currencyScope, setCurrencyScope] = useState(null);
  const activeCurrency = (currencyScope && availableCurrencies.includes(currencyScope))
    ? currencyScope
    : (availableCurrencies[0] || 'USD');

  const trades = useMemo(() => {
    if (!filteredItems) return [];
    return filteredItems.filter(item =>
      (item?.type === 'FUT' || item?.type === 'STK') &&
      String(item.currency || 'USD').toUpperCase() === activeCurrency
    );
  }, [filteredItems, activeCurrency]);

  const tradesWithJournal = useMemo(() => {
    return trades.filter(t => t.journal && (t.journal.notes_html || t.journal.confidence || t.journal.execution_rating));
  }, [trades]);

  const sortedTradeNotes = useMemo(() => {
    const sortable = [...tradesWithJournal];
    sortable.sort((a, b) => {
      const { key, direction } = notesSort;
      let valA, valB;

      if (key === 'confidence' || key === 'execution_rating') {
        valA = a.journal?.[key] || 0;
        valB = b.journal?.[key] || 0;
      } else if (key === 'firstActionDate') {
        valA = a.firstActionDate ? DateTime.fromISO(a.firstActionDate).toMillis() : 0;
        valB = b.firstActionDate ? DateTime.fromISO(b.firstActionDate).toMillis() : 0;
      } else { // 'return'
        valA = a[key] ?? -Infinity;
        valB = b[key] ?? -Infinity;
      }

      if (valA < valB) return direction === 'asc' ? -1 : 1;
      if (valA > valB) return direction === 'asc' ? 1 : -1;
      return 0;
    });
    return sortable;
  }, [tradesWithJournal, notesSort]);


  const uniqueSymbols = useMemo(() => {
    const symbols = new Set(trades.map(t => t.symbol).filter(Boolean));
    return Array.from(symbols);
  }, [trades]);

  const fetchHistoricalData = async () => {
    const symbolsByType = trades.reduce((acc, trade) => {
      if (!trade.symbol) return acc;
      const type = trade.type === 'FUT' ? 'FUT' : 'STK';
      if (!acc[type]) acc[type] = new Set();
      acc[type].add(trade.symbol);
      return acc;
    }, {});

    const maxDays = 3 * 365;
    const threeYearsAgo = DateTime.now().minus({ days: maxDays });

    const firstTradeDate = trades.reduce((earliest, trade) => {
      if (trade.firstActionDate) {
        const tradeDate = DateTime.fromISO(trade.firstActionDate);
        if (tradeDate.isValid && tradeDate < earliest) {
          return tradeDate;
        }
      }
      return earliest;
    }, DateTime.now());

    const apiStartDate = (firstTradeDate > threeYearsAgo ? firstTradeDate : threeYearsAgo).toISODate();
    const apiEndDate = DateTime.now().toISODate();

    const fetchPromises = [];
    for (const [type, symbolSet] of Object.entries(symbolsByType)) {
      const symbols = [...symbolSet];
      const missingSymbols = symbols.filter(symbol => !historicalDataMap[symbol]);
      if (missingSymbols.length === 0) continue;

      fetchPromises.push(
        ...missingSymbols.map(symbol => (
          fetch(`${process.env.REACT_APP_API_URL}/api/historical/db?symbol=${encodeURIComponent(symbol)}&type=${type}&timeframe=1D&noRefresh=true&startDate=${apiStartDate}&endDate=${apiEndDate}`, {
            headers: { 'x-account-id': '1' }, 
          })
            .then(res => res.ok ? res.json() : [])
            .then(data => {
              const dateMap = new Map(data.map(bar => [DateTime.fromISO(bar.time).toISODate(), bar.close]));
              return [symbol, dateMap];
            })
            .catch(error => {
              console.error(`Error fetching ${symbol} (${type}):`, error);
              return [symbol, new Map()];
            })
        ))
      );
    }

    if (fetchPromises.length === 0) return;

    setIsFetching(true);
    try {
      const results = await Promise.all(fetchPromises);
      setHistoricalDataMap(prev => ({
        ...prev,
        ...Object.fromEntries(results),
      }));
    } catch (error) {
      console.error('Failed to fetch historical data:', error);
    } finally {
      setIsFetching(false);
    }
  };

  const debouncedFetchHistoricalData = useRef(debounce(fetchHistoricalData, 500));

  useEffect(() => {
    debouncedFetchHistoricalData.current();
  }, [uniqueSymbols]);

  const computedStats = useMemo(() => {
    try {
      const stats = {
        generalStats: computeGeneralStats(trades),
        riskMetrics: computeRiskMetrics(trades),
        tradeAnalysis: computeTradeAnalysis(trades),
        symbolStats: computeSymbolStats(trades),
        feeAnalysis: computeFeeAnalysis(trades),
        holdings: computeHoldings(trades),
        bestPerformingAssets: computeBestPerformingAssets(trades),
        portfolioValueSeries: computePortfolioValueSeries(trades, historicalDataMap),
        returnDistribution: computeReturnDistribution(trades),
        winRateSeries: computeWinRateSeries(trades),
        tradingActivityHeatmap: computeTradingActivityHeatmap(trades, displayTimezone),
        openPositionsPie: computeOpenPositionsPie(trades),
        topTrades: computeTopTrades(trades),
        feesPnlSeries: computeFeesPnlSeries(trades),
        returnVsHoldTime: computeReturnVsHoldTime(trades),
        returnPercentageSeries: computeReturnPercentageSeries(trades, historicalDataMap),
        // New professional metrics
        expectancy: computeExpectancy(trades),
        riskRewardRatio: computeRiskRewardRatio(trades),
        recoveryFactor: computeRecoveryFactor(trades),
        bestWorstDays: computeBestWorstDays(trades),
        monthlyPnL: computeMonthlyPnLSummary(trades),
        dailyPnLStats: computeDailyPnLStats(trades),
        consecutiveStats: computeConsecutiveStats(trades),
        avgTradesPerWeek: computeAvgTradesPerWeek(trades),
        avgTradesPerMonth: computeAvgTradesPerMonth(trades),
        hourlyStats: computeHourlyStats(trades, displayTimezone),
        largestStreaks: computeLargestStreaks(trades),
        avgWinLoss: computeAvgWinLoss(trades),
      };
      return stats;
    } catch (error) {
      console.error('Error computing stats:', error);
      return {
        generalStats: [],
        riskMetrics: [],
        tradeAnalysis: [],
        symbolStats: [],
        feeAnalysis: { totalFees: '0', avgFeesPerTrade: '0', feesPerMonth: {}, feesPerSymbol: {} },
        holdings: { rows: [], pricesPending: false, totals: { marketValue: 0, costBasis: 0, unrealizedPnl: 0, unrealizedPct: null, realizedPnl: 0, totalPnl: 0, fees: 0 } },
        bestPerformingAssets: [],
        portfolioValueSeries: { labels: [], series: [], realizedSeries: [] },
        returnDistribution: { labels: [], data: [] },
        winRateSeries: { labels: [], data: [] },
        tradingActivityHeatmap: { heatmap: [], maxValue: 0 },
        openPositionsPie: { labels: [], data: [] },
        topTrades: { topWins: [], topLosses: [] },
        feesPnlSeries: { labels: [], data: [] },
        returnVsHoldTime: { data: [] },
        returnPercentageSeries: [],
        expectancy: 'N/A',
        riskRewardRatio: 'N/A',
        recoveryFactor: 'N/A',
        bestWorstDays: { bestDay: 'N/A', worstDay: 'N/A', bestAmount: '0.00', worstAmount: '0.00' },
        monthlyPnL: [],
        dailyPnLStats: { avgDailyPnL: 'N/A', bestDailyPnL: 'N/A', worstDailyPnL: 'N/A' },
        consecutiveStats: { avgConsecutiveWins: 'N/A', avgConsecutiveLosses: 'N/A' },
        avgTradesPerWeek: '0.00',
        avgTradesPerMonth: '0.00',
        hourlyStats: [],
        largestStreaks: { largestWinStreak: 0, largestLossStreak: 0 },
        avgWinLoss: { avgWin: '0.00', avgLoss: '0.00' },
      };
    }
  }, [trades, historicalDataMap, displayTimezone]);

  const handleNotesSort = (key) => {
    setNotesSort(prevSort => {
      if (prevSort.key === key) {
        return { ...prevSort, direction: prevSort.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { key, direction: 'desc' };
    });
  };

  const handleEditTrade = (tradeToEdit) => {
    setViewingTrade(null);
  };

  const exportNotesToCSV = (notes) => {
    const headers = ['Date', 'Symbol', 'Side', 'P&L', 'Confidence', 'Execution', 'Notes'];

    const htmlToText = (html) => {
      if (!html) return '';
      try {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        return tempDiv.textContent || tempDiv.innerText || '';
      } catch (e) {
        console.error("Could not parse HTML:", e);
        return "Error parsing notes";
      }
    };

    const rows = notes.map(trade => {
      const rowData = [
        trade.openDate,
        trade.symbol,
        trade.side,
        (trade.return || 0).toFixed(2),
        trade.journal?.confidence || 0,
        trade.journal?.execution_rating || 0,
        `"${htmlToText(trade.journal?.notes_html).replace(/"/g, '""')}"`
      ];
      return rowData.join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', 'trade_notes_export.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const tabs = [
    { id: 'calendar', label: 'Calendar' },
    { id: 'general', label: 'General' },
    { id: 'holdings', label: 'Holdings' },
    { id: 'advanced', label: 'Advanced Metrics' },
    { id: 'risk', label: 'Risk Metrics' },
    { id: 'tradeAnalysis', label: 'Trade Analysis' },
    { id: 'feeAnalysis', label: 'Fee Analysis' },
    { id: 'bestAssets', label: 'Best Performing Assets' },
    { id: 'hourlyAnalysis', label: 'Hourly Analysis' },
    { id: 'visualizations', label: 'Visualizations' },
    { id: 'tradeNotes', label: 'Trade Notes' },
  ];

  const portfolioChartData = {
    labels: computedStats.portfolioValueSeries.labels,
    datasets: [
      {
        label: 'Total P&L (incl. open positions)',
        data: computedStats.portfolioValueSeries.series,
        borderColor: '#3B82F6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        tension: 0.3,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 0,
      },
      {
        label: 'Realised P&L',
        data: computedStats.portfolioValueSeries.realizedSeries,
        borderColor: '#9CA3AF',
        borderDash: [4, 4],
        tension: 0.3,
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 0,
      },
    ],
  };

  const returnPercentageChartData = {
    labels: computedStats.returnPercentageSeries.map(d => d.date),
    datasets: [
      {
        label: 'Return Percentage',
        data: computedStats.returnPercentageSeries.map(d => d.returnPercentage),
        borderColor: '#10B981',
        backgroundColor: 'rgba(16, 185, 129, 0.1)',
        tension: 0.3,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 0,
      },
    ],
  };

  const returnDistributionChartData = {
    labels: computedStats.returnDistribution.labels,
    datasets: [
      {
        label: 'Trade Returns',
        data: computedStats.returnDistribution.data,
        backgroundColor: '#10B981',
        borderColor: '#10B981',
        borderWidth: 1,
      },
    ],
  };

  const winRateChartData = {
    labels: computedStats.winRateSeries.labels,
    datasets: [
      {
        label: 'Win Rate (%)',
        data: computedStats.winRateSeries.data,
        borderColor: '#F59E0B',
        backgroundColor: 'rgba(245, 158, 11, 0.1)',
        tension: 0.3,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 0,
      },
    ],
  };

  const openPositionsPieData = {
    labels: computedStats.openPositionsPie.labels,
    datasets: [
      {
        data: computedStats.openPositionsPie.data,
        backgroundColor: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#84CC16', '#6366F1', '#A855F7', '#06B6D4'],
        borderColor: '#1e1e2e',
        borderWidth: 2,
      },
    ],
  };

  const feesPnlChartData = {
    labels: computedStats.feesPnlSeries.labels,
    datasets: [
      {
        label: 'Fees as % of P&L',
        data: computedStats.feesPnlSeries.data,
        borderColor: '#EF4444',
        backgroundColor: 'rgba(239, 68, 68, 0.1)',
        tension: 0.3,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 0,
      },
    ],
  };

  const returnVsHoldTimeChartData = {
    datasets: [
      {
        label: 'Trades',
        data: computedStats.returnVsHoldTime.data,
        backgroundColor: '#8B5CF6',
        borderColor: '#8B5CF6',
        pointRadius: 4,
        pointHoverRadius: 6,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    layout: {
      padding: {
        top: 20,
        bottom: 15,
        right: 30,
      },
    },
    scales: {
      x: {
        display: true,
        ticks: {
          maxTicksLimit: 10,
          color: '#9CA3AF',
          font: { size: 11 },
        },
        grid: { display: false },
      },
      y: {
        display: true,
        ticks: {
          color: '#9CA3AF',
          font: { size: 11 },
          callback: value => `${currencyMark(activeCurrency)}${formatNumber(value, 2)}`,
        },
        grid: { display: true, color: 'rgba(156, 163, 175, 0.1)' },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        mode: 'index',
        intersect: false,
        callbacks: {
          label: context => `${currencyMark(activeCurrency)}${formatNumber(context.parsed.y, 2)}`,
        },
      },
      verticalLine: { enabled: false },
    },
  };

  const returnPercentageChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    layout: {
      padding: {
        top: 20,
        bottom: 15,
        right: 30,
      },
    },
    scales: {
      x: {
        display: true,
        ticks: {
          maxTicksLimit: 10,
          color: '#9CA3AF',
          font: { size: 11 },
        },
        grid: { display: false },
      },
      y: {
        display: true,
        ticks: {
          color: '#9CA3AF',
          font: { size: 11 },
          callback: value => `${formatNumber(value, 2)}%`,
        },
        grid: { display: true, color: 'rgba(156, 163, 175, 0.1)' },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        mode: 'index',
        intersect: false,
        callbacks: {
          label: context => `${formatNumber(context.parsed.y, 2)}%`,
        },
      },
      verticalLine: { enabled: false },
    },
  };

  const winRateChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    layout: {
      padding: {
        top: 20,
        bottom: 15,
        right: 30,
      },
    },
    scales: {
      x: {
        display: true,
        ticks: {
          maxTicksLimit: 10,
          color: '#9CA3AF',
          font: { size: 11 },
        },
        grid: { display: false },
      },
      y: {
        display: true,
        ticks: {
          color: '#9CA3AF',
          font: { size: 11 },
          callback: value => `${formatNumber(value, 2)}%`,
        },
        grid: { display: true, color: 'rgba(156, 163, 175, 0.1)' },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        mode: 'index',
        intersect: false,
        callbacks: {
          label: context => `${formatNumber(context.parsed.y, 2)}%`,
        },
      },
      verticalLine: {
        enabled: false
      }
    },
  };

  const barChartOptions = {
    ...chartOptions,
    scales: {
      x: {
        display: true,
        ticks: {
          color: '#9CA3AF',
          font: { size: 11 },
          autoSkip: true,
          maxRotation: 45,
          minRotation: 45,
        },
        grid: { display: false },
      },
      y: {
        display: true,
        ticks: {
          color: '#9CA3AF',
          font: { size: 11 },
          callback: value => value,
        },
        grid: { display: true, color: 'rgba(156, 163, 175, 0.1)' },
      },
    },
    plugins: {
      ...chartOptions.plugins,
      tooltip: {
        callbacks: {
          label: context => `Count: ${context.parsed.y}`,
        },
      },
      verticalLine: { 
        enabled: false
      }
    },
  };

  const pieChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: 'right',
        labels: {
          color: '#9CA3AF',
          font: { size: 11 },
        },
      },
      tooltip: {
        enabled: true,
        callbacks: {
          label: context => `${currencyMark(activeCurrency)}${formatNumber(context.parsed, 2)}`,
        },
      },
    },
  };

  const feesPnlChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    layout: {
      padding: {
        top: 20,
        bottom: 15,
        right: 30,
      },
    },
    scales: {
      x: {
        display: true,
        ticks: {
          maxTicksLimit: 10,
          color: '#9CA3AF',
          font: { size: 11 },
        },
        grid: { display: false },
      },
      y: {
        display: true,
        ticks: {
          color: '#9CA3AF',
          font: { size: 11 },
          callback: value => `${formatNumber(value, 2)}%`,
        },
        grid: { display: true, color: 'rgba(156, 163, 175, 0.1)' },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        mode: 'index',
        intersect: false,
        callbacks: {
          label: context => `${formatNumber(context.parsed.y, 2)}%`,
        },
      },
      verticalLine: {
        enabled: false
      }
    },
  };

  const scatterChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        type: 'linear',
        display: true,
        title: {
          display: true,
          text: 'Hold Time (Hours)',
          color: '#9CA3AF',
          font: { size: 11 },
        },
        ticks: {
          color: '#9CA3AF',
          font: { size: 11 },
        },
        grid: { display: false },
      },
      y: {
        display: true,
        title: {
          display: true,
          text: 'Return (%)',
          color: '#9CA3AF',
          font: { size: 11 },
        },
        ticks: {
          color: '#9CA3AF',
          font: { size: 11 },
          callback: value => `${value}%`,
        },
        grid: { display: true, color: 'rgba(156, 163, 175, 0.1)' },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        callbacks: {
          label: context => `Return: ${formatNumber(context.parsed.y, 2)}%, Hold Time: ${formatNumber(context.parsed.x, 2)} hrs`,
        },
      },
      verticalLine: {
        enabled: false
      }
    },
  };

  return (
    <StatsErrorBoundary>
      <div className={styles.statsContainer}>
        <div className={styles.statsLayout}>
          {/* Section menu, grouped like the Settings page's (a scrolling bar
              on tablets; phones use the dropdown in the header). */}
          <nav className={styles.sideNav} aria-label="Stats sections">
            {TAB_GROUPS.map(group => (
              <div key={group.label} className={styles.navGroup}>
                <span className={styles.navGroupLabel}>{group.label}</span>
                {group.ids.map(id => {
                  const tab = tabs.find(t => t.id === id);
                  if (!tab) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`${styles.navButton} ${currentTab === id ? styles.navActive : ''}`}
                      onClick={() => setCurrentTab(id)}
                      aria-current={currentTab === id ? 'page' : undefined}
                    >
                      <svg className={styles.navIcon} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">{TAB_META[id].icon}</svg>
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className={styles.contentColumn}>
            <div className={styles.stickyHeader}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionHeading}>
                  <h2>{tabs.find(t => t.id === currentTab)?.label}</h2>
                  <p>{TAB_META[currentTab]?.description}</p>
                </div>
                <div className={styles.scopeControls}>
                  {/* Phones pick the section here (see .tabSelect). */}
                  <select
                    className={styles.tabSelect}
                    value={currentTab}
                    onChange={e => setCurrentTab(e.target.value)}
                    aria-label="Stats section"
                  >
                    {tabs.map(tab => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
                  </select>
                  {availableCurrencies.length > 1 && (
                    <label className={styles.scopeField}>
                      <span>Currency</span>
                      <select
                        className={styles.scopeSelect}
                        value={activeCurrency}
                        onChange={e => setCurrencyScope(e.target.value)}
                        title="These metrics are ratios and distributions over a set of returns, so they're only meaningful within a single currency. Pick which one to analyse."
                      >
                        {availableCurrencies.map(code => (
                          <option key={code} value={code}>{code}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {subAccountIds.length > 0 && (
                    <button
                      type="button"
                      className={`${styles.scopeChip} ${includeSubAccounts ? styles.scopeChipOn : ''}`}
                      onClick={() => setIncludeSubAccounts(!includeSubAccounts)}
                      aria-pressed={includeSubAccounts}
                      title="Include the trades of this account's sub-accounts"
                    >
                      Sub-accounts
                    </button>
                  )}
                  <div className={styles.scopeField} title="Applies to hour-of-day and calendar-day views (Hourly Analysis, the activity heatmap, Calendar). Trades span many symbols here, so times use this one zone rather than each instrument's own exchange.">
                    <span>Timezone</span>
                    <TimezonePicker value={displayTimezone} onChange={setDisplayTimezone} options={STATS_TIMEZONE_OPTIONS} />
                  </div>
                </div>
              </div>
              {(filter.length > 0 || timeFilter || symbolFilter || restrictToActionsInRange) && (
                <div className={styles.filterWarning}>
                  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>
                  <span><strong>Filtered.</strong> These stats only cover the trades matching the Dashboard's current filters.</span>
                </div>
              )}
            </div>
        <div className={styles.tabContent}>
          {currentTab === 'calendar' && (
            <div>
              <Calendar
                onDayClick={handleCalendarDayClick}
                onWeekClick={handleCalendarWeekClick}
                currentMonth={calendarMonth}
                setCurrentMonth={setCalendarMonth}
                zone={displayTimezone}
                items={withSubAccounts ? [...(allTrades || []), ...subAccountTrades] : undefined}
              />
            </div>
          )}
          {currentTab === 'advanced' && (
            <div>
              <div className={styles.statsGrid}>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Expectancy</div>
                  <div className={`${styles.statValue} ${toneClass('Expectancy', computedStats.expectancy)}`} title="Avg Win Rate * Avg Win - Loss Rate * Avg Loss">{currencyMark(activeCurrency)}{formatNumberText(computedStats.expectancy)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Risk/Reward Ratio</div>
                  <div className={styles.statValue} title="Average Win / Average Loss">{formatNumberText(computedStats.riskRewardRatio)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Recovery Factor</div>
                  <div className={styles.statValue} title="Total P&L / Max Drawdown">{formatNumberText(computedStats.recoveryFactor)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Trades/Week</div>
                  <div className={styles.statValue}>{formatNumberText(computedStats.avgTradesPerWeek)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Trades/Month</div>
                  <div className={styles.statValue}>{formatNumberText(computedStats.avgTradesPerMonth)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Win Size</div>
                  <div className={`${styles.statValue} ${toneClass('Avg Win Size')}`}>{currencyMark(activeCurrency)}{formatNumberText(computedStats.avgWinLoss.avgWin)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Loss Size</div>
                  <div className={`${styles.statValue} ${toneClass('Avg Loss Size')}`}>{currencyMark(activeCurrency)}{formatNumberText(computedStats.avgWinLoss.avgLoss)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Consecutive Wins</div>
                  <div className={styles.statValue}>{formatNumberText(computedStats.consecutiveStats.avgConsecutiveWins)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Consecutive Losses</div>
                  <div className={styles.statValue}>{formatNumberText(computedStats.consecutiveStats.avgConsecutiveLosses)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Largest Win Streak</div>
                  <div className={styles.statValue}>{computedStats.largestStreaks.largestWinStreak}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Largest Loss Streak</div>
                  <div className={styles.statValue}>{computedStats.largestStreaks.largestLossStreak}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Best Daily P&L</div>
                  <div className={`${styles.statValue} ${toneClass('Best Daily P&L')}`}>{currencyMark(activeCurrency)}{formatNumberText(computedStats.dailyPnLStats.bestDailyPnL)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Worst Daily P&L</div>
                  <div className={`${styles.statValue} ${toneClass('Worst Daily P&L')}`}>{currencyMark(activeCurrency)}{formatNumberText(computedStats.dailyPnLStats.worstDailyPnL)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Daily P&L</div>
                  <div className={`${styles.statValue} ${toneClass('Avg Daily P&L', computedStats.dailyPnLStats.avgDailyPnL)}`}>{currencyMark(activeCurrency)}{formatNumberText(computedStats.dailyPnLStats.avgDailyPnL)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Best Trading Day</div>
                  <div className={styles.statValue} style={{ fontSize: '14px' }}>{computedStats.bestWorstDays.bestDay}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Best Day P&L</div>
                  <div className={`${styles.statValue} ${toneClass('Best Day P&L')}`}>{currencyMark(activeCurrency)}{formatNumberText(computedStats.bestWorstDays.bestAmount)}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Worst Trading Day</div>
                  <div className={styles.statValue} style={{ fontSize: '14px' }}>{computedStats.bestWorstDays.worstDay}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Worst Day P&L</div>
                  <div className={`${styles.statValue} ${toneClass('Worst Day P&L')}`}>{currencyMark(activeCurrency)}{formatNumberText(computedStats.bestWorstDays.worstAmount)}</div>
                </div>
              </div>
              
              <div className={styles.tableSection} style={{ marginTop: '30px' }}>
                <h3>Monthly Performance Summary</h3>
                {computedStats.monthlyPnL.length > 0 ? (
                  <table className={styles.statsTable}>
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th>P&L</th>
                        <th>Wins</th>
                        <th>Losses</th>
                        <th>Total Trades</th>
                        <th>Win Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {computedStats.monthlyPnL.map((month, idx) => (
                        <tr key={idx}>
                          <td>{month.month}</td>
                          <td style={{ color: month.pnl >= 0 ? '#22C55E' : '#EF4444' }}>{currencyMark(activeCurrency)}{absAmount(month.pnl)}</td>
                          <td>{month.wins}</td>
                          <td>{month.losses}</td>
                          <td>{month.trades}</td>
                          <td>{formatNumberText(month.winRate)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p>No monthly data available.</p>
                )}
              </div>
            </div>
          )}
          {currentTab === 'hourlyAnalysis' && (
            <div>
              <p className={styles.chartExplanation} style={{ marginBottom: '20px' }}>
                This analysis shows your trading performance by hour of the day, helping you identify your most profitable trading times.
              </p>
              <div className={styles.tableSection}>
                {computedStats.hourlyStats.filter(h => h.total > 0).length > 0 ? (
                  <table className={styles.statsTable}>
                    <thead>
                      <tr>
                        <th>Hour</th>
                        <th>Trades</th>
                        <th>Wins</th>
                        <th>Losses</th>
                        <th>Win Rate</th>
                        <th>Total P&L</th>
                      </tr>
                    </thead>
                    <tbody>
                      {computedStats.hourlyStats.map((hour, idx) => (
                        hour.total > 0 && (
                          <tr key={idx}>
                            <td>{hour.hour}</td>
                            <td>{hour.total}</td>
                            <td style={{ color: '#22C55E' }}>{hour.wins}</td>
                            <td style={{ color: '#EF4444' }}>{hour.losses}</td>
                            <td>{formatNumberText(hour.winRate)}%</td>
                            <td style={{ color: hour.pnl >= 0 ? '#22C55E' : '#EF4444' }}>{currencyMark(activeCurrency)}{absAmount(hour.pnl)}</td>
                          </tr>
                        )
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p>No hourly data available.</p>
                )}
              </div>
            </div>
          )}
          {currentTab === 'general' && (
            <div>

              <div className={styles.statsGrid}>
                {computedStats.generalStats?.length > 0 ? (
                  computedStats.generalStats.map((stat, idx) => (
                    <div key={idx} className={styles.statBox}>
                      <div className={styles.statLabel}>{stat.label}</div>
                      <div className={`${styles.statValue} ${toneClass(stat.label, stat.value)}`}>{stat.value}</div>
                    </div>
                  ))
                ) : (
                  <p>No general stats available.</p>
                )}
              </div>
              <div className={styles.chartContainer}>
                <h4>Return Percentage Over Time</h4>
                <p className={styles.chartExplanation}>
                  This line chart shows the daily return percentage of the portfolio over time (max 3*365 days), calculated as (portfolio value - total deposits) / total deposits * 100%. It accounts for both cash and the market value of open positions, reflecting the overall investment performance.
                </p>
                {isFetching ? (
                  <p>Loading historical data...</p>
                ) : computedStats.returnPercentageSeries.length > 0 && computedStats.returnPercentageSeries.every(d => !isNaN(d.returnPercentage)) ? (
                  <div className={styles.chartCanvasWrapper}>
                    <Line data={returnPercentageChartData} options={returnPercentageChartOptions} />
                  </div>
                ) : (
                  <p>No valid data available for the return percentage chart.</p>
                )}
              </div>
              <div className={styles.chartContainer}>
                <h4>Cumulative P&L Over Time</h4>
                <p className={styles.chartExplanation}>
                  Cumulative P&L per day (max 3*365 days). The solid line is realised P&L (closed trades and partial sells, on the day they happened) plus the unrealised P&L of positions open at that day’s close, valued at the symbol’s daily close. The dashed line is realised P&L alone. Fees are included in both.
                </p>
                {isFetching ? (
                  <p>Loading historical data...</p>
                ) : computedStats.portfolioValueSeries.labels.length > 0 && computedStats.portfolioValueSeries.series.every(v => !isNaN(v)) ? (
                  <div className={styles.chartCanvasWrapper}>
                    <Line data={portfolioChartData} options={chartOptions} />
                  </div>
                ) : (
                  <p>No valid data available for the portfolio value chart.</p>
                )}
              </div>
            </div>
          )}
          {currentTab === 'holdings' && (() => {
            const h = computedStats.holdings;
            const mark = currencyMark(activeCurrency);
            const money = (v) => (v === null || v === undefined ? '—' : `${mark}${absAmount(v)}`);
            const pct = (v) => (v === null || v === undefined ? '—' : `${formatNumber(Math.abs(v), 2)}%`);
            return (
              <div>
                <div className={styles.statsGrid}>
                  <div className={styles.statBox}>
                    <div className={styles.statLabel}>Market Value</div>
                    <div className={styles.statValue}>{money(h.totals.marketValue)}</div>
                  </div>
                  <div className={styles.statBox}>
                    <div className={styles.statLabel}>Cost Basis</div>
                    <div className={styles.statValue}>{money(h.totals.costBasis)}</div>
                  </div>
                  <div className={styles.statBox}>
                    <div className={styles.statLabel}>Unrealised P&L</div>
                    <div className={styles.statValue} style={{ color: pnlColor(h.totals.unrealizedPnl) }}>
                      {money(h.totals.unrealizedPnl)}{h.totals.unrealizedPct !== null ? ` (${pct(h.totals.unrealizedPct)})` : ''}
                    </div>
                  </div>
                  <div className={styles.statBox}>
                    <div className={styles.statLabel}>Realised P&L</div>
                    <div className={styles.statValue} style={{ color: pnlColor(h.totals.realizedPnl) }}>{money(h.totals.realizedPnl)}</div>
                  </div>
                  <div className={styles.statBox}>
                    <div className={styles.statLabel}>Total P&L</div>
                    <div className={styles.statValue} style={{ color: pnlColor(h.totals.totalPnl) }}>{money(h.totals.totalPnl)}</div>
                  </div>
                  <div className={styles.statBox}>
                    <div className={styles.statLabel}>Fees Paid</div>
                    <div className={styles.statValue}>{money(h.totals.fees)}</div>
                  </div>
                </div>
                <p className={styles.chartExplanation}>
                  Open positions valued at the current price. Realised P&L covers closed trades and partial sells of open ones; both P&L figures are after fees. Market value, cost basis and allocation cover stocks/ETFs only — a futures position shows its unrealised P&L but its notional isn’t counted as value.
                  {h.pricesPending && ' Some current prices are still loading; those positions aren’t valued yet.'}
                </p>

                <div className={styles.tableSection}>
                  <h3>Open Positions</h3>
                  {h.rows.length > 0 ? (
                    <table className={styles.statsTable}>
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Quantity</th>
                          <th>Avg Cost</th>
                          <th>Price</th>
                          <th>Market Value</th>
                          <th>Unrealised P&L</th>
                          <th>Unrealised %</th>
                          <th>Realised P&L</th>
                          <th>Fees</th>
                          <th>Allocation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {h.rows.map(r => (
                          <tr key={r.symbol}>
                            <td>{r.symbol}</td>
                            <td>{formatNumber(r.quantity, 8, true)}</td>
                            <td>{r.avgCost === null ? '—' : formatNumber(r.avgCost, 4)}</td>
                            <td>{r.currentPrice === null ? (r.priced ? '—' : '…') : formatNumber(Number(r.currentPrice), 4)}</td>
                            <td>{money(r.marketValue)}</td>
                            <td style={{ color: pnlColor(r.unrealizedPnl) }}>{r.priced ? money(r.unrealizedPnl) : '…'}</td>
                            <td style={{ color: pnlColor(r.unrealizedPct) }}>{pct(r.unrealizedPct)}</td>
                            <td style={{ color: pnlColor(r.realizedPnl) }}>{money(r.realizedPnl)}</td>
                            <td>{money(r.fees)}</td>
                            <td>{pct(r.allocationPct)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p>No open positions.</p>
                  )}
                </div>

                <div className={styles.chartContainer}>
                  <h4>Allocation by Market Value</h4>
                  <p className={styles.chartExplanation}>
                    Share of each open stock/ETF position in the total market value (quantity × current price).
                  </p>
                  {computedStats.openPositionsPie.labels.length > 0 && computedStats.openPositionsPie.data.every(v => !isNaN(v)) ? (
                    <div className={styles.chartCanvasWrapper}>
                      <Doughnut data={openPositionsPieData} options={pieChartOptions} />
                    </div>
                  ) : (
                    <p>No priced stock/ETF positions to show.</p>
                  )}
                </div>
              </div>
            );
          })()}
          {currentTab === 'risk' && (
            <div>
              <div className={styles.statsGrid}>
                {computedStats.riskMetrics?.length > 0 ? (
                  computedStats.riskMetrics.map((stat, idx) => {
                    const isRatio = stat.label === 'Sharpe Ratio' || stat.label === 'Sortino Ratio';
                    return (
                      <div
                        key={idx}
                        className={styles.statBox}
                        title={isRatio ? 'Computed from raw per-trade P&L in the selected currency, not annualized returns — not comparable across position sizes or to standard benchmark Sharpe/Sortino figures.' : undefined}
                      >
                        <div className={styles.statLabel}>{stat.label}{isRatio ? ' *' : ''}</div>
                        <div className={styles.statValue}>{stat.value}</div>
                      </div>
                    );
                  })
                ) : (
                  <p>No risk metrics available.</p>
                )}
              </div>
              {computedStats.riskMetrics?.length > 0 && (
                <p className={styles.chartExplanation}>
                  * Sharpe and Sortino here are computed from raw dollar P&L per trade, not normalized/annualized returns.
                  They scale with your position size, so they aren't directly comparable across accounts, over time as your
                  size changes, or against standard published Sharpe/Sortino figures — treat them as a rough internal
                  consistency measure only.
                </p>
              )}
            </div>
          )}
          {currentTab === 'tradeAnalysis' && (
            <div>
              <div className={styles.statsGrid}>
                {computedStats.tradeAnalysis?.length > 0 ? (
                  computedStats.tradeAnalysis.map((stat, idx) => (
                    <div key={idx} className={styles.statBox}>
                      <div className={styles.statLabel}>{stat.label}</div>
                      <div className={styles.statValue}>{stat.value}</div>
                    </div>
                  ))
                ) : (
                  <p>No trade analysis available.</p>
                )}
              </div>
              <div className={styles.chartContainer}>
                <h4>Top Winning and Losing Trades</h4>
                <p className={styles.chartExplanation}>
                  This table lists the top 5 winning and losing trades by P&L, showing symbol, return, and closing date. It’s calculated by sorting closed trades by return, selecting the highest and lowest five to highlight extreme outcomes.
                </p>
                {computedStats.topTrades.topWins.length > 0 || computedStats.topTrades.topLosses.length > 0 ? (
                  <table className={styles.statsTable}>
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Symbol</th>
                        <th>P&L</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {computedStats.topTrades.topWins.map((trade, idx) => (
                        <tr key={`win-${idx}`}>
                          <td>Win</td>
                          <td>{trade.symbol}</td>
                          <td>{currencyMark(activeCurrency)}{formatNumber(trade.return, 2)}</td>
                          <td>{trade.date}</td>
                        </tr>
                      ))}
                      {computedStats.topTrades.topLosses.map((trade, idx) => (
                        <tr key={`loss-${idx}`}>
                          <td>Loss</td>
                          <td>{trade.symbol}</td>
                          <td>{currencyMark(activeCurrency)}{formatNumber(trade.return, 2)}</td>
                          <td>{trade.date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p>No data available for top trades.</p>
                )}
              </div>
            </div>
          )}
          {currentTab === 'feeAnalysis' && (
            <div>
              <div className={styles.statsGrid}>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Total Fees</div>
                  <div className={styles.statValue}>{currencyMark(activeCurrency)}{formatNumberText(computedStats.feeAnalysis?.totalFees || '0.00')}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Fees per Trade</div>
                  <div className={styles.statValue}>{currencyMark(activeCurrency)}{formatNumberText(computedStats.feeAnalysis?.avgFeesPerTrade || '0.00')}</div>
                </div>
              </div>
              <div className={styles.tableSection}>
                <h3>Fees per Month</h3>
                {Object.keys(computedStats.feeAnalysis?.feesPerMonth || {}).length > 0 ? (
                  <table className={styles.statsTable}>
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th>Total Fees</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(computedStats.feeAnalysis.feesPerMonth).sort().map(([month, fees]) => (
                        <tr key={month}>
                          <td>{month}</td>
                          <td>{currencyMark(activeCurrency)}{formatNumber(fees, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p>No monthly fee data available.</p>
                )}
              </div>
              <div className={styles.tableSection}>
                <h3>Fees per Symbol</h3>
                {Object.keys(computedStats.feeAnalysis?.feesPerSymbol || {}).length > 0 ? (
                  <table className={styles.statsTable}>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Total Fees</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(computedStats.feeAnalysis.feesPerSymbol).map(([symbol, fees]) => (
                        <tr key={symbol}>
                          <td>{symbol}</td>
                          <td>{currencyMark(activeCurrency)}{formatNumber(fees, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p>No symbol fee data available.</p>
                )}
              </div>
              <div className={styles.chartContainer}>
                <h4>Fees as Percentage of P&L</h4>
                <p className={styles.chartExplanation}>
                  This line chart shows fees as a percentage of absolute P&L per month. It’s calculated by summing fees (buyFee + sellFee) and absolute P&L (return) for closed trades per month, then computing (fees / P&L) * 100.
                </p>
                {computedStats.feesPnlSeries.labels.length > 0 && computedStats.feesPnlSeries.data.every(v => !isNaN(v)) ? (
                  <div className={styles.chartCanvasWrapper}>
                    <Line data={feesPnlChartData} options={feesPnlChartOptions} />
                  </div>
                ) : (
                  <p>No valid data available for the fees P&L chart.</p>
                )}
              </div>
            </div>
          )}
          {currentTab === 'bestAssets' && (
            <div>
              <h3>Best Performing Assets</h3>
              {computedStats.bestPerformingAssets?.length > 0 ? (
                <table className={styles.statsTable}>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Realised P&L</th>
                      <th>Unrealised P&L</th>
                      <th>Total P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {computedStats.bestPerformingAssets.map((asset, idx) => (
                      <tr key={idx}>
                        <td>{asset.symbol}</td>
                        <td style={{ color: pnlColor(asset.realizedPnl) }}>{currencyMark(activeCurrency)}{absAmount(asset.realizedPnl)}</td>
                        <td style={{ color: pnlColor(asset.unrealizedPnl) }}>{currencyMark(activeCurrency)}{absAmount(asset.unrealizedPnl)}</td>
                        <td style={{ color: pnlColor(asset.totalPnl) }}>{currencyMark(activeCurrency)}{absAmount(asset.totalPnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p>No best performing assets available.</p>
              )}
            </div>
          )}
          {currentTab === 'visualizations' && (
            <div>

              <div className={styles.chartContainer}>
                <h4>Distribution of Trade Returns</h4>
                <p className={styles.chartExplanation}>
                  This histogram displays the frequency of trade returns in 5% buckets from -50% to +50%. Returns are sourced from closed trades’ returnPercentage, clamped to [-50, 50] to handle outliers, showing the distribution of trade performance.
                </p>
                {computedStats.returnDistribution.labels.length > 0 && computedStats.returnDistribution.data.every(v => !isNaN(v)) ? (
                  <div className={styles.chartCanvasWrapper}>
                    <Bar data={returnDistributionChartData} options={barChartOptions} />
                  </div>
                ) : (
                  <p>No valid data available for the return distribution chart.</p>
                )}
              </div>

              <div className={styles.chartContainer}>
                <h4>Win Rate Over Time</h4>
                <p className={styles.chartExplanation}>
                  This line chart tracks the win rate (%) over a rolling window of 20 trades, plotted against the closing date of each trade. It’s calculated by counting wins (status = 'WIN') in each window, divided by 20, to show performance trends.
                </p>
                {computedStats.winRateSeries.labels.length > 0 && computedStats.winRateSeries.data.every(v => !isNaN(v)) ? (
                  <div className={styles.chartCanvasWrapper}>
                    <Line data={winRateChartData} options={winRateChartOptions} />
                  </div>
                ) : (
                  <p>No valid data available for the win rate chart.</p>
                )}
              </div>

              <div className={styles.chartContainer}>
                <h4>Trade Return vs. Hold Time</h4>
                <p className={styles.chartExplanation}>
                  This scatter plot correlates trade returns (%) with holding periods (hours). Each point represents a closed trade, with x-axis as hold time (lastActionDate - firstActionDate in hours) and y-axis as returnPercentage, identifying duration trends.
                </p>
                {computedStats.returnVsHoldTime.data.length > 0 && computedStats.returnVsHoldTime.data.every(d => !isNaN(d.x) && !isNaN(d.y)) ? (
                  <div className={styles.chartCanvasWrapper}>
                    <Scatter data={returnVsHoldTimeChartData} options={scatterChartOptions} />
                  </div>
                ) : (
                  <p>No valid data available for the return vs. hold time chart.</p>
                )}
              </div>
            </div>
          )}
          {currentTab === 'tradeNotes' && (
            <div className={styles.tradeNotesContainer}>
              <div className={styles.notesSortControls}>
                <span>Sort by:</span>
                <button onClick={() => handleNotesSort('firstActionDate')} className={notesSort.key === 'firstActionDate' ? styles.activeSort : ''}>
                  Date {notesSort.key === 'firstActionDate' && (notesSort.direction === 'asc' ? '▲' : '▼')}
                </button>
                <button onClick={() => handleNotesSort('return')} className={notesSort.key === 'return' ? styles.activeSort : ''}>
                  P&L {notesSort.key === 'return' && (notesSort.direction === 'asc' ? '▲' : '▼')}
                </button>
                <button onClick={() => handleNotesSort('confidence')} className={notesSort.key === 'confidence' ? styles.activeSort : ''}>
                  Confidence {notesSort.key === 'confidence' && (notesSort.direction === 'asc' ? '▲' : '▼')}
                </button>
                <button onClick={() => handleNotesSort('execution_rating')} className={notesSort.key === 'execution_rating' ? styles.activeSort : ''}>
                  Execution {notesSort.key === 'execution_rating' && (notesSort.direction === 'asc' ? '▲' : '▼')}
                </button>
                <button onClick={() => exportNotesToCSV(sortedTradeNotes)} className={styles.exportButton}>Export CSV</button>
              </div>
              <div className={styles.tradeNotesList}>
                {sortedTradeNotes.length > 0 ? sortedTradeNotes.map(trade => (
                  <div key={trade.id} className={styles.tradeNoteCard} onClick={() => setViewingTrade(trade)}>
                    <div className={styles.tradeNoteHeader}>
                      <div className={styles.headerLeft}>
                        <span className={styles.symbolBadge}>{trade.symbol}</span>
                        <span className={`${styles.sideBadge} ${trade.side === 'LONG' ? styles.long : styles.short}`}>{trade.side}</span>
                      </div>
                      <div className={styles.headerRight}>
                        <span className={`${styles.pnlBadge} ${trade.return >= 0 ? styles.win : styles.loss}`}>
                          {currencyMark(activeCurrency)}{formatNumber((Math.abs(trade.return) || 0), 2)}
                        </span>
                        <span className={styles.dateBadge}>{trade.openDate}</span>
                      </div>
                    </div>
                    <div className={styles.tradeNoteBody}>
                       {(trade.journal?.confidence > 0 || trade.journal?.execution_rating > 0) && (
                        <div className={styles.ratingsInNotes}>
                          {trade.journal?.confidence > 0 && (
                            <div className={styles.ratingInNotesLeft}>
                              <span className={styles.ratingText}>Confidence</span>
                              <div className={styles.starsInline}>
                                {[...Array(trade.journal.confidence)].map((_, i) => <span key={i} className={styles.star}>★</span>)}
                              </div>
                            </div>
                          )}
                          {trade.journal?.execution_rating > 0 && (
                            <div className={styles.ratingInNotesRight}>
                              <span className={styles.ratingText}>Execution</span>
                              <div className={styles.starsInline}>
                                {[...Array(trade.journal.execution_rating)].map((_, i) => <span key={i} className={styles.star}>★</span>)}
                              </div>
                            </div>
                          )}
                        </div>
                       )}
                       <div className={styles.notesContentWrapper}>
                        {trade.journal?.notes_html ? (
                          <div
                            className={styles.notesContent}
                            dangerouslySetInnerHTML={{ __html: sanitizeNotesHtml(trade.journal.notes_html) }}
                          />
                        ) : (
                          <p className={styles.noNotesText}>No notes for this trade.</p>
                        )}
                       </div>
                       {trade.attachments && trade.attachments.length > 0 && (
                          <div className={styles.attachmentsPreview}>
                            {trade.attachments.map((file, i) => (
                                file.image_base64 && file.mime_type ? (
                                    <div key={file.id || i} className={styles.attachmentThumb}>
                                        <img
                                            src={`data:${file.mime_type};base64,${file.image_base64}`}
                                            alt={file.filename || 'attachment'}
                                            title={file.filename || 'attachment'}
                                        />
                                    </div>
                                ) : null
                            ))}
                          </div>
                        )}
                    </div>
                  </div>
                )) : <p>No trades with notes match the current filters.</p>}
              </div>
            </div>
          )}
        </div>
          </div>
        </div>
        {viewingTrade && (
            <TradeView
                trade={viewingTrade}
                onClose={() => setViewingTrade(null)}
                onEdit={handleEditTrade}
            />
        )}
      </div>
    </StatsErrorBoundary>
  );
};

export default Stats;