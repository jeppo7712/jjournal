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
} from './statsUtils';
import styles from './Stats.module.css';
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

const Stats = ({ setCurrentView, onViewTrade, setCustomFilterDate, setCustomFilterWeek }) => {
  const { filteredItems, filter, timeFilter, symbolFilter, restrictToActionsInRange, trades: allTrades } = React.useContext(TradeContext) || { filteredItems: [], filter: [], timeFilter: null, symbolFilter: '', restrictToActionsInRange: false, trades: [] };
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

  const trades = useMemo(() => {
    if (!filteredItems) return [];
    return filteredItems.filter(item => item?.type === 'FUT' || item?.type === 'STK');
  }, [filteredItems]);

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
        bestPerformingAssets: [],
        portfolioValueSeries: { labels: [], series: [] },
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
        label: 'Portfolio Value',
        data: computedStats.portfolioValueSeries.series,
        borderColor: '#3B82F6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        tension: 0.3,
        fill: true,
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
        backgroundColor: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'],
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
          callback: value => `$${value.toFixed(2)}`,
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
          label: context => `$${context.parsed.y.toFixed(2)}`,
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
          callback: value => `${value.toFixed(2)}%`,
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
          label: context => `${context.parsed.y.toFixed(2)}%`,
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
          callback: value => `${value.toFixed(2)}%`,
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
          label: context => `${context.parsed.y.toFixed(2)}%`,
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
          label: context => `$${context.parsed.toFixed(2)}`,
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
          callback: value => `${value.toFixed(2)}%`,
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
          label: context => `${context.parsed.y.toFixed(2)}%`,
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
          label: context => `Return: ${context.parsed.y.toFixed(2)}%, Hold Time: ${context.parsed.x.toFixed(2)} hrs`,
        },
      },
      verticalLine: {
        enabled: false
      }
    },
  };

  return (
    <StatsErrorBoundary>
      {(filter.length > 0 || timeFilter || symbolFilter || restrictToActionsInRange) && (
        <div className={styles.filterWarning}>Stats are based on currently applied filters — results may not show your full trading history</div>
      )}

      <div className={styles.statsContainer}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#A5ADBA', fontSize: '0.85em', fontWeight: 500 }}>Timezone</span>
            <TimezonePicker value={displayTimezone} onChange={setDisplayTimezone} options={STATS_TIMEZONE_OPTIONS} />
          </div>
          <span style={{ color: '#A5ADBA', fontSize: '0.75em', opacity: 0.8, maxWidth: 420, textAlign: 'right' }}>
            Applies to hour-of-day / calendar-day views (Hourly Analysis, Trading Activity Heatmap, Calendar). Trades span many symbols here, so times use this one zone rather than each instrument's own exchange.
          </span>
        </div>
        <div className={styles.tabNavigation}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={currentTab === tab.id ? styles.activeTab : ''}
              onClick={() => setCurrentTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
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
              />
            </div>
          )}
          {currentTab === 'advanced' && (
            <div>
              <h3 style={{ marginBottom: '20px', color: '#fff' }}>Advanced Trading Metrics</h3>
              <div className={styles.statsGrid}>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Expectancy</div>
                  <div className={styles.statValue} title="Avg Win Rate * Avg Win - Loss Rate * Avg Loss">${computedStats.expectancy}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Risk/Reward Ratio</div>
                  <div className={styles.statValue} title="Average Win / Average Loss">{computedStats.riskRewardRatio}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Recovery Factor</div>
                  <div className={styles.statValue} title="Total P&L / Max Drawdown">{computedStats.recoveryFactor}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Trades/Week</div>
                  <div className={styles.statValue}>{computedStats.avgTradesPerWeek}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Trades/Month</div>
                  <div className={styles.statValue}>{computedStats.avgTradesPerMonth}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Win Size</div>
                  <div className={styles.statValue}>${computedStats.avgWinLoss.avgWin}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Loss Size</div>
                  <div className={styles.statValue}>${computedStats.avgWinLoss.avgLoss}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Consecutive Wins</div>
                  <div className={styles.statValue}>{computedStats.consecutiveStats.avgConsecutiveWins}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Consecutive Losses</div>
                  <div className={styles.statValue}>{computedStats.consecutiveStats.avgConsecutiveLosses}</div>
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
                  <div className={styles.statValue}>${computedStats.dailyPnLStats.bestDailyPnL}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Worst Daily P&L</div>
                  <div className={styles.statValue}>${computedStats.dailyPnLStats.worstDailyPnL}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Daily P&L</div>
                  <div className={styles.statValue}>${computedStats.dailyPnLStats.avgDailyPnL}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Best Trading Day</div>
                  <div className={styles.statValue} style={{ fontSize: '14px' }}>{computedStats.bestWorstDays.bestDay}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Best Day P&L</div>
                  <div className={styles.statValue}>${computedStats.bestWorstDays.bestAmount}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Worst Trading Day</div>
                  <div className={styles.statValue} style={{ fontSize: '14px' }}>{computedStats.bestWorstDays.worstDay}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Worst Day P&L</div>
                  <div className={styles.statValue}>${computedStats.bestWorstDays.worstAmount}</div>
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
                          <td style={{ color: month.pnl >= 0 ? '#22C55E' : '#EF4444' }}>${month.pnl}</td>
                          <td>{month.wins}</td>
                          <td>{month.losses}</td>
                          <td>{month.trades}</td>
                          <td>{month.winRate}%</td>
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
              <h3 style={{ marginBottom: '20px', color: '#fff' }}>Hourly Trading Analysis</h3>
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
                            <td>{hour.winRate}%</td>
                            <td style={{ color: hour.pnl >= 0 ? '#22C55E' : '#EF4444' }}>${hour.pnl}</td>
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
                      <div className={styles.statValue}>{stat.value}</div>
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
                <h4>Portfolio Value Over Time</h4>
                <p className={styles.chartExplanation}>
                  This line chart shows the cumulative portfolio value over the last year, based on realised P&L from closed trades. It’s calculated by summing the daily P&L (trade returns) from the earliest trade date or 3*365 days ago, starting with prior P&L for accuracy.
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
                        title={isRatio ? 'Computed from raw $ P&L per trade, not annualized returns — not comparable across position sizes or to standard benchmark Sharpe/Sortino figures.' : undefined}
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
                          <td>${trade.return.toFixed(2)}</td>
                          <td>{trade.date}</td>
                        </tr>
                      ))}
                      {computedStats.topTrades.topLosses.map((trade, idx) => (
                        <tr key={`loss-${idx}`}>
                          <td>Loss</td>
                          <td>{trade.symbol}</td>
                          <td>${trade.return.toFixed(2)}</td>
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
                  <div className={styles.statValue}>${computedStats.feeAnalysis?.totalFees || '0.00'}</div>
                </div>
                <div className={styles.statBox}>
                  <div className={styles.statLabel}>Avg Fees per Trade</div>
                  <div className={styles.statValue}>${computedStats.feeAnalysis?.avgFeesPerTrade || '0.00'}</div>
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
                          <td>${fees.toFixed(2)}</td>
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
                          <td>${fees.toFixed(2)}</td>
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
                      <th>Total P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {computedStats.bestPerformingAssets.map((asset, idx) => (
                      <tr key={idx}>
                        <td>{asset.symbol}</td>
                        <td>${asset.totalPnl.toFixed(2)}</td>
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
                <h4>Open Positions by Symbol</h4>
                <p className={styles.chartExplanation}>
                  This pie chart shows the allocation of open positions by symbol, based on the absolute market value (currentReturn). It’s calculated by summing the currentReturn for open trades per symbol, reflecting portfolio diversification.
                </p>
                {computedStats.openPositionsPie.labels.length > 0 && computedStats.openPositionsPie.data.every(v => !isNaN(v)) ? (
                  <div className={styles.chartCanvasWrapper}>
                    <Doughnut data={openPositionsPieData} options={pieChartOptions} />
                  </div>
                ) : (
                  <p>No valid data available for the open positions chart.</p>
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
                          ${(Math.abs(trade.return) || 0).toFixed(2)}
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